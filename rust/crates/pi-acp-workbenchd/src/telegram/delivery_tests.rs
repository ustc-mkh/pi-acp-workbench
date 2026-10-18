use super::*;
use crate::{
    domain::{DeliveryId, NoticeId},
    persistence::{
        outbox::{DeliveryEvent, DeliveryPayload, DeliveryTarget},
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
            revision,
            target: DeliveryTarget::Telegram(topic.clone()),
            payload: DeliveryPayload::Notice { notice: notice.id },
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
        .fail(&head, DeliveryFailure::RateLimited, u64::MAX)
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
