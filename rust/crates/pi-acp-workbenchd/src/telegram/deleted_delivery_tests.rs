use super::delivery_tests::topic;
use super::*;
use crate::{
    domain::{DeliveryId, ImageId},
    persistence::outbox::{DeliveryEvent, DeliveryPayload, DeliveryTarget},
    telegram::runtime::AdapterError,
};

async fn journal_files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = vec![];
    let mut directory = match tokio::fs::read_dir(root.join("journal")).await {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return files,
        Err(error) => panic!("{error}"),
    };
    while let Some(entry) = directory.next_entry().await.unwrap() {
        if entry.file_type().await.unwrap().is_file() {
            files.push((
                entry.file_name().to_string_lossy().into_owned(),
                tokio::fs::read(entry.path()).await.unwrap(),
            ));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
fn scoped_config(root: &Path) -> TelegramConfig {
    let mut config = config();
    config.workspace = crate::domain::WorkspacePath::new(root.to_str().unwrap()).unwrap();
    config
}
#[tokio::test]
async fn pending_image_after_external_source_removal_and_restart_uses_frozen_scope_without_loading_agent_or_mutating_journal(
) {
    let root = root();
    let trace = root.with_extension("deleted-peer-trace");
    let env = std::collections::HashMap::from([(
        "WORKBENCH_CONTRACT_TRACE".into(),
        trace.to_string_lossy().into_owned(),
    )]);
    let first = app_with_env(&root, env.clone());
    let api = Fake::default();
    let context = Context::new(
        first.clone(),
        api.clone(),
        &root.join("telegram"),
        scoped_config(&root),
    )
    .await
    .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    let (topic, session) = context
        .store
        .snapshot()
        .await
        .unwrap()
        .bindings
        .into_iter()
        .next()
        .unwrap();
    let mut events = first.subscribe();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, topic.thread, "image-output"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    finished(&mut events).await;
    let image = context
        .inspect(&session)
        .await
        .unwrap()
        .unwrap()
        .transcript
        .entries
        .iter()
        .find_map(|entry| entry.image.clone())
        .unwrap();
    let original = first
        .delivery_payloads()
        .image(&image)
        .await
        .unwrap()
        .bytes()
        .to_vec();
    api.0.lock().await.fail_media = true;
    deliver_once(&context).await.unwrap();
    let pending = first.delivery_store().pending(u64::MAX, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert!(
        matches!(&pending[0].event.target, DeliveryTarget::Session { session: target, cwd } if target == &session && cwd.as_str() == root.to_str().unwrap())
    );
    first
        .command(DomainCommand::RemoveSession(session.clone()))
        .await
        .unwrap();
    assert!(context.inspect(&session).await.unwrap().is_none());
    first.shutdown_checked().await.unwrap();
    let before_peer = tokio::fs::read(&trace).await.unwrap();
    let second = app_with_env(&root, env);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        scoped_config(&root),
    )
    .await
    .unwrap();
    let before_journal = journal_files(&root).await;
    second
        .delivery_store()
        .fail(&pending[0].event.id, DeliveryFailure::RateLimited, 0)
        .await
        .unwrap();
    deliver_once(&context).await.unwrap();
    deliver_once(&context).await.unwrap();
    let state = api.0.lock().await;
    assert_eq!(state.media.len(), 1);
    assert_eq!(state.media[0].asset.bytes(), original);
    assert_eq!(state.media[0].message_thread_id, topic.thread);
    assert_eq!(state.media[0].chat_id, topic.chat);
    assert!(state
        .sent
        .iter()
        .any(|message| message.text == "image caption"));
    drop(state);
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 16)
        .await
        .unwrap()
        .is_empty());
    assert!(context.inspect(&session).await.unwrap().is_none());
    assert_eq!(
        journal_files(&root).await,
        before_journal,
        "missing snapshot reads are not load/mutation operations"
    );
    assert_eq!(
        tokio::fs::read(&trace).await.unwrap(),
        before_peer,
        "deleted-source delivery must not create a peer"
    );
    assert!(
        matches!(&second.command(DomainCommand::ListSessions).await.unwrap()[0], DomainEvent::SessionsListed(sessions) if sessions.is_empty())
    );
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
    tokio::fs::remove_file(trace).await.unwrap();
}
#[tokio::test]
async fn archived_scope_does_not_authorize_outside_workspace_unbound_or_disallowed_topics_or_read_their_missing_image(
) {
    let root = root();
    let app = app(&root);
    let allowed = root.join("allowed");
    tokio::fs::create_dir_all(&allowed).await.unwrap();
    let api = Fake::default();
    let context = Context::new(
        app.clone(),
        api.clone(),
        &root.join("telegram"),
        scoped_config(&allowed),
    )
    .await
    .unwrap();
    for (index, cwd, bound, chat) in [
        (0, root.clone(), true, -100),
        (1, allowed.clone(), false, -100),
        (2, allowed.clone(), true, -999),
    ] {
        let session = crate::domain::SessionId::generate();
        let mut topic = topic(101 + index);
        topic.chat = ChatId::new(chat).unwrap();
        if bound {
            context.store.bind(topic, session.clone()).await.unwrap();
        }
        app.delivery_store()
            .enqueue(DeliveryEvent {
                id: DeliveryId::generate(),
                revision: 1,
                target: DeliveryTarget::Session {
                    session,
                    cwd: crate::domain::WorkspacePath::new(cwd.to_str().unwrap()).unwrap(),
                },
                payload: DeliveryPayload::Image {
                    image: ImageId::generate(),
                },
            })
            .await
            .unwrap();
    }
    let journal_before = journal_files(&root).await;
    deliver_once(&context).await.unwrap();
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 16)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(api.0.lock().await.media_attempts, 0);
    assert_eq!(journal_files(&root).await, journal_before);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn a_live_session_cannot_be_delivered_under_a_different_frozen_workspace_identity() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let context = Context::new(
        app.clone(),
        api.clone(),
        &root.join("telegram"),
        scoped_config(&root),
    )
    .await
    .unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(1, None, "/new"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    let (_, session) = context
        .store
        .snapshot()
        .await
        .unwrap()
        .bindings
        .into_iter()
        .next()
        .unwrap();
    let wrong = root.join("other");
    tokio::fs::create_dir_all(&wrong).await.unwrap();
    app.delivery_store()
        .enqueue(DeliveryEvent {
            id: DeliveryId::generate(),
            revision: 1,
            target: DeliveryTarget::Session {
                session,
                cwd: crate::domain::WorkspacePath::new(wrong.to_str().unwrap()).unwrap(),
            },
            payload: DeliveryPayload::Image {
                image: ImageId::generate(),
            },
        })
        .await
        .unwrap();
    assert!(
        matches!(deliver_once(&context).await, Err(AdapterError::Domain(crate::domain::error::DomainError::Persistence(message))) if message == "delivery workspace identity mismatch")
    );
    assert_eq!(api.0.lock().await.media_attempts, 0);
    assert_eq!(
        app.delivery_store()
            .pending(u64::MAX, 16)
            .await
            .unwrap()
            .len(),
        1
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
