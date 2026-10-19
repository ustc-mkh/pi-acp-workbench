use crate::{
    actor::{OwnerReply, Runtime},
    domain::{
        command::{AgentEvent, DomainCommand},
        error::DomainError,
        query::{CommitBatch, SessionView},
        Harness, Prompt, SessionId, SessionStatus, WorkspacePath,
    },
    persistence::{interface::SessionPersistence, SessionStore},
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
#[derive(Clone)]
struct FaultStore {
    history: SessionStore,
    root: PathBuf,
    next_failure: Arc<AtomicU8>,
    next_image_failure: Arc<AtomicU8>,
}
impl FaultStore {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("workbench-actor-spy-{}", uuid::Uuid::new_v4()));
        Self {
            history: SessionStore::fixture(&root),
            root,
            next_failure: Arc::new(AtomicU8::new(0)),
            next_image_failure: Arc::new(AtomicU8::new(0)),
        }
    }
    async fn close(&self) {
        self.history.database().shutdown().await.unwrap();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
impl SessionPersistence for FaultStore {
    crate::persistence::interface_test_helpers::delegate_session_queries!();
    async fn commit(
        &self,
        change: crate::domain::transition::Transition,
    ) -> Result<CommitBatch, String> {
        match self.next_failure.swap(0, Ordering::SeqCst) {
            1 => return Err("injected commit failure".into()),
            2 => panic!("injected session store panic"),
            _ => {}
        }
        if self.next_image_failure.swap(0, Ordering::SeqCst) == 1 {
            return Err("injected image archive failure".into());
        }
        self.history.commit(change).await
    }
}
async fn create(runtime: &Runtime) -> SessionId {
    let OwnerReply::Receipt(crate::domain::query::CommandReceipt::Created { summary }) = runtime
        .registry
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap()
    else {
        panic!("created")
    };
    summary.id
}
fn prompt(id: &SessionId) -> DomainCommand {
    DomainCommand::Prompt {
        session: id.clone(),
        prompt: Prompt::new("test").unwrap(),
    }
}
async fn view(runtime: &Runtime, id: &SessionId) -> SessionView {
    runtime
        .registry
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap()
        .view()
        .unwrap()
        .clone()
}
#[tokio::test]
async fn actor_commits_through_trait_and_failed_commit_keeps_state_and_intent_unchanged() {
    let store = FaultStore::new();
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let mut events = runtime.events.subscribe();
    store.next_failure.store(1, Ordering::SeqCst);
    assert!(runtime.registry.command(prompt(&id)).await.is_err());
    let unchanged = view(&runtime, &id).await;
    assert!(matches!(unchanged.status, SessionStatus::Idle));
    assert_eq!(unchanged.last_entry_seq.get(), 0);
    assert_eq!(unchanged.revision.get(), 0);
    assert!(events.try_recv().is_err());
    assert!(store
        .history
        .outbox
        .pending(0, 10)
        .await
        .unwrap()
        .is_empty());
    let OwnerReply::Committed(batch) = runtime.registry.command(prompt(&id)).await.unwrap() else {
        panic!("commit")
    };
    assert_eq!(batch.entries.len(), 1);
    assert_eq!(batch.revision.get(), 1);
    assert_eq!(
        serde_json::to_value(events.recv().await.unwrap()).unwrap(),
        serde_json::to_value(batch).unwrap()
    );
    assert!(events.try_recv().is_err());
    runtime.registry.shutdown().await;
    store.close().await;
}
#[tokio::test]
async fn image_archive_failure_never_commits_or_publishes_a_dangling_reference() {
    use crate::domain::image::ImageAsset;
    let store = FaultStore::new();
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let started = runtime.registry.command(prompt(&id)).await.unwrap();
    let turn = started.view().unwrap().active_turn.clone().unwrap();
    let before = view(&runtime, &id).await;
    let mut events = runtime.events.subscribe();
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    let command = DomainCommand::Agent {
        session: id.clone(),
        event: AgentEvent::Image {
            turn: turn.clone(),
            asset: asset.clone(),
            message: None,
        },
    };
    for image_fault in [true, false] {
        if image_fault {
            store.next_image_failure.store(1, Ordering::SeqCst);
        } else {
            store.next_failure.store(1, Ordering::SeqCst);
        }
        assert!(matches!(
            runtime.registry.command(command.clone()).await,
            Err(DomainError::Persistence(_))
        ));
        assert_eq!(
            serde_json::to_value(view(&runtime, &id).await).unwrap(),
            serde_json::to_value(&before).unwrap()
        );
        assert!(store.history.payloads.image(asset.image()).await.is_err());
        assert!(events.try_recv().is_err());
    }
    let OwnerReply::Committed(batch) = runtime.registry.command(command).await.unwrap() else {
        panic!("image commit")
    };
    assert_eq!(batch.entries[0].image.as_ref().unwrap(), asset.image());
    assert_eq!(
        store
            .history
            .payloads
            .image(asset.image())
            .await
            .unwrap()
            .bytes(),
        asset.bytes()
    );
    assert_eq!(events.recv().await.unwrap().revision, batch.revision);
    let late = runtime
        .registry
        .command(DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Image {
                turn: crate::domain::TurnId::generate(),
                asset: asset.clone(),
                message: None,
            },
        })
        .await
        .unwrap();
    assert!(matches!(late, OwnerReply::Receipt(_)));
    assert_eq!(view(&runtime, &id).await.revision, batch.revision);
    assert!(events.try_recv().is_err());
    // Old worker epochs are rejected before tool/header/archive reads or writes.
    runtime
        .registry
        .worker_started(id.clone(), 2)
        .await
        .unwrap();
    let prior = view(&runtime, &id).await;
    runtime
        .registry
        .worker_event(
            id.clone(),
            1,
            AgentEvent::Text {
                turn,
                text: "obsolete".into(),
                message: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(view(&runtime, &id).await.revision, prior.revision);
    assert!(events.try_recv().is_err());
    runtime.registry.shutdown().await;
    store.close().await;
}
#[tokio::test]
async fn session_actor_panic_is_isolated_and_committed_state_can_be_reloaded() {
    let store = FaultStore::new();
    let runtime = Runtime::start(store.clone(), 8);
    let first = create(&runtime).await;
    let second = create(&runtime).await;
    store.next_failure.store(2, Ordering::SeqCst);
    assert!(runtime.registry.command(prompt(&first)).await.is_err());
    runtime
        .registry
        .command(DomainCommand::Inspect(second))
        .await
        .unwrap();
    let loaded = runtime
        .registry
        .command(DomainCommand::LoadSession(first))
        .await
        .unwrap();
    let view = loaded.view().unwrap();
    assert!(matches!(view.status, SessionStatus::Idle));
    assert!(view.active_turn.is_none());
    runtime.registry.shutdown().await;
    store.close().await;
}
