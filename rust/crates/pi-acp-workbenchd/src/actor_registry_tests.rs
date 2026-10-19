use super::*;
use crate::{
    domain::{
        query::{ListCursor, ListPage, SessionSummary},
        Harness, Prompt,
    },
    persistence::SessionStore,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Semaphore;
#[derive(Clone)]
struct Store {
    history: SessionStore,
    mode: Arc<AtomicU8>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    loads: Arc<AtomicUsize>,
}
impl Store {
    fn new() -> (Self, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("workbench-registry-{}", uuid::Uuid::new_v4()));
        (
            Self {
                history: SessionStore::fixture(&root),
                mode: Arc::new(AtomicU8::new(0)),
                entered: Arc::new(Semaphore::new(0)),
                release: Arc::new(Semaphore::new(0)),
                loads: Arc::new(AtomicUsize::new(0)),
            },
            root,
        )
    }
    async fn gate(&self, mode: u8) {
        if self.mode.load(Ordering::Acquire) == mode {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
    }
    async fn entered(&self, count: u32) {
        tokio::time::timeout(Duration::from_secs(3), self.entered.acquire_many(count))
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    fn release(&self, count: usize) {
        self.mode.store(0, Ordering::Release);
        self.release.add_permits(count);
    }
}
impl SessionPersistence for Store {
    crate::persistence::interface_test_helpers::delegate_session_aux!();
    async fn load(&self, id: &SessionId) -> Result<Option<SessionView>, String> {
        self.loads.fetch_add(1, Ordering::AcqRel);
        self.gate(3).await;
        SessionPersistence::load(&self.history, id).await
    }
    async fn list(
        &self,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> Result<ListPage, String> {
        assert_ne!(
            self.mode.load(Ordering::Acquire),
            2,
            "fixture registry IO panic"
        );
        self.gate(1).await;
        SessionPersistence::list(&self.history, cursor, limit).await
    }
    async fn create(&self, state: &SessionView) -> Result<SessionSummary, String> {
        self.gate(4).await;
        SessionPersistence::create(&self.history, state).await
    }
    async fn commit(
        &self,
        change: crate::domain::transition::Transition,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        if change.next.active_turn.is_some() {
            self.gate(5).await;
        } else if matches!(change.next.status, SessionStatus::Idle)
            && change.deliveries.iter().any(|delivery| {
                matches!(
                    delivery.payload,
                    crate::domain::transition::DeliveryPayload::Notice { .. }
                )
            })
        {
            self.gate(7).await;
        }
        self.history.commit(change).await
    }
    async fn remove(&self, id: &SessionId) -> Result<CommitBatch, String> {
        self.gate(6).await;
        SessionPersistence::remove(&self.history, id).await
    }
}
fn submit(
    runtime: &Runtime,
    command: DomainCommand,
) -> oneshot::Receiver<Result<OwnerReply, DomainError>> {
    let (reply, wait) = oneshot::channel();
    runtime
        .registry
        .tx
        .try_send(RegistryCommand::Command { command, reply })
        .unwrap_or_else(|_| panic!("fixture admission"));
    wait
}
fn create() -> DomainCommand {
    DomainCommand::CreateSession {
        harness: Harness::Pi,
        cwd: crate::domain::WorkspacePath::new("/tmp").unwrap(),
    }
}
async fn id(runtime: &Runtime) -> SessionId {
    let events = runtime.registry.command(create()).await.unwrap();
    let OwnerReply::Receipt(CommandReceipt::Created { summary }) = events else {
        panic!("created")
    };
    summary.id
}
fn prompt(id: &SessionId) -> DomainCommand {
    DomainCommand::Prompt {
        session: id.clone(),
        prompt: Prompt::new("accepted").unwrap(),
    }
}
#[tokio::test]
async fn sixteen_blocked_store_queries_are_bounded_without_blocking_live_actor_routing() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    let id = id(&runtime).await;
    store.mode.store(1, Ordering::Release);
    let mut blocked = Vec::new();
    for _ in 0..16 {
        blocked.push(submit(&runtime, DomainCommand::ListSessions));
    }
    store.entered(16).await;
    assert!(matches!(
        runtime.registry.command(DomainCommand::ListSessions).await,
        Err(DomainError::Backpressure)
    ));
    tokio::time::timeout(
        Duration::from_secs(1),
        runtime.registry.command(prompt(&id)),
    )
    .await
    .unwrap()
    .unwrap();
    let inspected = tokio::time::timeout(
        Duration::from_secs(1),
        runtime.registry.command(DomainCommand::Inspect(id)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(inspected.view().unwrap().active_turn.is_some());
    blocked.pop(); // dropping a reply observer must not cancel its store future
    store.release(16);
    for wait in blocked {
        wait.await.unwrap().unwrap();
    }
    runtime.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn concurrent_loads_share_one_owner_and_commands_queued_behind_load_remain_fifo() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    let id = id(&runtime).await;
    runtime.shutdown_checked().await.unwrap();
    let runtime = Runtime::start(store.clone(), 128);
    store.mode.store(3, Ordering::Release);
    let first = submit(&runtime, DomainCommand::LoadSession(id.clone()));
    store.entered(1).await;
    let second = submit(&runtime, DomainCommand::LoadSession(id.clone()));
    let accepted = submit(&runtime, prompt(&id));
    store.release(1);
    first.await.unwrap().unwrap();
    let loaded = second.await.unwrap().unwrap();
    assert!(loaded.view().unwrap().active_turn.is_none());
    accepted.await.unwrap().unwrap();
    let inspected = runtime
        .registry
        .command(DomainCommand::Inspect(id))
        .await
        .unwrap();
    assert!(inspected
        .view()
        .is_some_and(|view| view.revision.get() == 1 && view.last_entry_seq.get() == 1));
    assert_eq!(store.loads.load(Ordering::Acquire), 1);
    runtime.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn pending_load_lane_is_bounded_and_caller_disconnect_does_not_skip_accepted_fifo_commands() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 4);
    let cold_id = id(&runtime).await;
    let other = id(&runtime).await;
    runtime.shutdown_checked().await.unwrap();
    let runtime = Runtime::start(store.clone(), 4);
    runtime
        .registry
        .command(DomainCommand::LoadSession(other.clone()))
        .await
        .unwrap();
    store.mode.store(3, Ordering::Release);
    let load = submit(&runtime, DomainCommand::LoadSession(cold_id.clone()));
    store.entered(1).await;
    let mut waits = Vec::new();
    for index in 0..4 {
        let (reply, wait) = oneshot::channel();
        runtime
            .registry
            .tx
            .send(RegistryCommand::Command {
                command: DomainCommand::SetModel {
                    session: cold_id.clone(),
                    model: crate::domain::ModelId::new(format!("slot-{index}")).unwrap(),
                },
                reply,
            })
            .await
            .unwrap_or_else(|_| panic!("fixture admission"));
        waits.push(wait);
    }
    let (reply, wait) = oneshot::channel();
    runtime
        .registry
        .tx
        .send(RegistryCommand::Command {
            command: DomainCommand::SetMode {
                session: cold_id.clone(),
                mode: crate::domain::ModeId::new("overflow").unwrap(),
            },
            reply,
        })
        .await
        .unwrap_or_else(|_| panic!("fixture admission"));
    assert!(matches!(
        wait.await.unwrap(),
        Err(DomainError::Backpressure)
    ));
    tokio::time::timeout(
        Duration::from_secs(1),
        runtime.registry.command(DomainCommand::Inspect(other)),
    )
    .await
    .unwrap()
    .unwrap();
    drop(waits.remove(0));
    store.release(1);
    load.await.unwrap().unwrap();
    for wait in waits {
        wait.await.unwrap().unwrap();
    }
    let events = runtime
        .registry
        .command(DomainCommand::Inspect(cold_id))
        .await
        .unwrap();
    assert!(events.view().is_some_and(|view| view.revision.get() == 4
        && view.config.model.as_ref().unwrap().as_str() == "slot-3"
        && view.config.mode.is_none()));
    runtime.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn root_abort_preserves_accepted_create_io_across_cancelled_shutdown_observer() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    store.mode.store(4, Ordering::Release);
    let accepted = submit(&runtime, create());
    store.entered(1).await;
    runtime.abort_root();
    assert!(runtime.wait_closed().await.is_err());
    let mut shutdown = Box::pin(runtime.shutdown_checked());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    drop(shutdown);
    store.release(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), runtime.shutdown_checked())
            .await
            .unwrap()
            .is_err()
    );
    let events = accepted.await.unwrap().unwrap();
    let OwnerReply::Receipt(CommandReceipt::Created { summary }) = events else {
        panic!("accepted create settled")
    };
    assert!(store.history.database().view(summary.id).await.is_ok());
    assert_eq!(
        store
            .history
            .database()
            .list(None, None)
            .await
            .unwrap()
            .sessions
            .len(),
        1
    );
    assert!(runtime.shutdown_checked().await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn root_abort_during_actor_shutdown_preserves_join_and_final_persistence() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    let id = id(&runtime).await;
    runtime.registry.command(prompt(&id)).await.unwrap();
    store.mode.store(7, Ordering::Release);
    let shutdown = {
        let runtime = runtime.clone();
        tokio::spawn(async move { runtime.shutdown_checked().await })
    };
    store.entered(1).await;
    runtime.abort_root();
    assert!(runtime.wait_closed().await.is_err());
    shutdown.abort();
    let _ = shutdown.await;
    store.release(1);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), runtime.shutdown_checked())
            .await
            .unwrap()
            .is_err()
    );
    assert!(store
        .history
        .database()
        .view(id.clone())
        .await
        .unwrap()
        .active_turn
        .is_none());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn storage_job_panic_is_fatal_but_other_accepted_actor_commit_is_drained_not_aborted() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    let id = id(&runtime).await;
    store.mode.store(5, Ordering::Release);
    let accepted = submit(&runtime, prompt(&id));
    store.entered(1).await;
    store.mode.store(2, Ordering::Release);
    assert!(runtime
        .registry
        .command(DomainCommand::ListSessions)
        .await
        .is_err());
    assert!(runtime.wait_closed().await.is_err());
    let mut shutdown = Box::pin(runtime.shutdown_checked());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    store.release(1);
    assert!(shutdown.await.is_err());
    accepted.await.unwrap().unwrap();
    let state = store.history.database().view(id.clone()).await.unwrap();
    assert_eq!(state.last_entry_seq.get(), 1);
    assert!(state.active_turn.is_none());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn removal_io_owner_outside_map_is_still_joined_after_root_abort() {
    let (store, root) = Store::new();
    let runtime = Runtime::start(store.clone(), 128);
    let id = id(&runtime).await;
    runtime.registry.command(prompt(&id)).await.unwrap();
    store.mode.store(6, Ordering::Release);
    let removed = submit(&runtime, DomainCommand::RemoveSession(id.clone()));
    store.entered(1).await;
    runtime.abort_root();
    assert!(runtime.wait_closed().await.is_err());
    let mut shutdown = Box::pin(runtime.shutdown_checked());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    store.release(1);
    assert!(shutdown.await.is_err());
    removed.await.unwrap().unwrap();
    assert!(store.history.database().view(id.clone()).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
