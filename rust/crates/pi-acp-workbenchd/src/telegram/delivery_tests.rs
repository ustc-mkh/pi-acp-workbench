use super::*;
use crate::{
    domain::{DeliveryId, NoticeId},
    persistence::{
        outbox::{DeliveryEvent, DeliveryPayload},
        payload::NoticeContent,
    },
};

pub(super) async fn notice(
    app: &WorkbenchApp,
    topic: &TopicKey,
    text: String,
    revision: u64,
) -> DeliveryId {
    let notice = NoticeContent {
        id: NoticeId::generate(),
        text,
    };
    app.delivery_payloads().put_notice(&notice).await.unwrap();
    let id = DeliveryId::generate();
    app.delivery_store()
        .enqueue(DeliveryEvent {
            id: id.clone(),
            revision: crate::domain::query::SafeInteger::new(revision).unwrap(),
            target: topic.delivery_target(99, config().workspace),
            payload: DeliveryPayload::Notice {
                content: crate::persistence::payload::PayloadStore::notice_ref(&notice).unwrap(),
            },
        })
        .await
        .unwrap();
    id
}
pub(super) fn topic(thread: i64) -> TopicKey {
    TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(thread).unwrap()),
    }
}

#[tokio::test]
async fn direct_topic_intents_check_frozen_bot_and_workspace_before_reading_missing_archive() {
    use crate::{
        domain::{error::DomainError, query::SafeInteger, ImageId, WorkspacePath},
        telegram::runtime::AdapterError,
    };
    for wrong_bot in [true, false] {
        let root = root();
        let app = app(&root);
        let api = Fake::default();
        let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
            .await
            .unwrap();
        let journal = app.journal_snapshot().await.unwrap();
        let destination = topic(101).delivery_target(
            if wrong_bot { 98 } else { 99 },
            if wrong_bot {
                config().workspace
            } else {
                WorkspacePath::new("/").unwrap()
            },
        );
        app.delivery_store()
            .enqueue(DeliveryEvent {
                id: DeliveryId::generate(),
                revision: SafeInteger::new(1).unwrap(),
                target: destination,
                payload: DeliveryPayload::Image {
                    image: ImageId::generate(),
                },
            })
            .await
            .unwrap();
        let result = deliver_once(&context).await;
        if wrong_bot {
            assert!(
                matches!(result, Err(AdapterError::Domain(DomainError::Persistence(message))) if message == "delivery bot identity mismatch")
            );
            assert_eq!(
                app.delivery_store()
                    .pending(u64::MAX, 16)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        } else {
            result.unwrap();
            assert!(app
                .delivery_store()
                .pending(u64::MAX, 16)
                .await
                .unwrap()
                .is_empty());
        }
        assert!(api.0.lock().await.sent.is_empty());
        assert!(api.0.lock().await.media.is_empty());
        assert_eq!(app.journal_snapshot().await.unwrap(), journal);
        app.shutdown_checked().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn deferred_head_survives_restart_blocks_its_topic_but_does_not_hide_a_topic_after_sixty_four_records(
) {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let a = topic(101);
    let b = topic(102);
    let head = notice(&first, &a, "A:0".into(), 9999).await;
    first
        .delivery_store()
        .fail(
            &head,
            DeliveryFailure::RateLimited,
            crate::domain::query::MAX_SAFE_INTEGER,
        )
        .await
        .unwrap();
    for i in 1..70 {
        notice(&first, &a, format!("A:{i}"), 70 - i).await;
    }
    notice(&first, &b, "B:0".into(), 0).await;
    deliver_once(&context).await.unwrap();
    assert_eq!(api.0.lock().await.sequence, ["text:B:0"]);
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(api.0.lock().await.sequence, ["text:B:0"]);
    assert_eq!(
        second
            .delivery_store()
            .pending(u64::MAX, 1024)
            .await
            .unwrap()
            .len(),
        70
    );
    second
        .delivery_store()
        .fail(&head, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    let mut expected = vec!["text:B:0".to_owned()];
    expected.extend((0..70).map(|i| format!("text:A:{i}")));
    assert_eq!(api.0.lock().await.sequence, expected);
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 1024)
        .await
        .unwrap()
        .is_empty());
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn a_new_send_failure_blocks_later_same_topic_records_in_the_current_pass() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let a = topic(101);
    let b = topic(102);
    let head = notice(&app, &a, "A:0".into(), 500).await;
    notice(&app, &a, "A:1".into(), 1).await;
    notice(&app, &b, "B:0".into(), 0).await;
    // Independent topics race by design; fail this exact FIFO head, not
    // whichever concurrent send happens to acquire the fake API mutex first.
    api.0.lock().await.fail_text = Some("A:0".into());
    deliver_once(&context).await.unwrap();
    assert_eq!(api.0.lock().await.sequence, ["text:B:0"]);
    let pending = app.delivery_store().pending(u64::MAX, 1024).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].event.id, head);
    assert!(matches!(
        pending[0].last_failure,
        Some(DeliveryFailure::RateLimited)
    ));
    app.delivery_store()
        .fail(&head, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    assert_eq!(
        api.0.lock().await.sequence,
        ["text:B:0", "text:A:0", "text:A:1"]
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
