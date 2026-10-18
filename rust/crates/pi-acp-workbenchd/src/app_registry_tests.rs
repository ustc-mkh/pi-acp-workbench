use super::*;
use crate::{
    domain::SessionState,
    persistence::{format::StorageLease, interface::SessionPersistence},
};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tokio::sync::Semaphore;
#[derive(Clone)]
struct Store {
    history: SessionStore,
    panic_list: Arc<AtomicBool>,
    gate_save: Arc<AtomicBool>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    pid: Arc<AtomicI32>,
    premature_terminal: Arc<AtomicBool>,
}
impl Store {
    fn new(history: SessionStore) -> Self {
        Self {
            history,
            panic_list: Arc::new(AtomicBool::new(false)),
            gate_save: Arc::new(AtomicBool::new(false)),
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            pid: Arc::new(AtomicI32::new(0)),
            premature_terminal: Arc::new(AtomicBool::new(false)),
        }
    }
}
impl SessionPersistence for Store {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        self.history.load(id).await
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        assert!(
            !self.panic_list.load(Ordering::Acquire),
            "fixture Registry IO panic"
        );
        self.history.list().await
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        if self.gate_save.load(Ordering::Acquire) {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        self.history.save(state).await
    }
    async fn commit(
        &self,
        change: crate::persistence::database::SessionCommit,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        let pid = self.pid.load(Ordering::Acquire);
        if pid != 0
            && matches!(change.next.status, SessionStatus::Idle)
            && change.deliveries.iter().any(|delivery| {
                matches!(
                    delivery.payload,
                    crate::domain::transition::DeliveryPayload::Notice { .. }
                )
            })
            && unsafe { libc::kill(pid, 0) } == 0
        {
            self.premature_terminal.store(true, Ordering::Release);
        }
        self.history.commit(change).await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.history.remove(id).await
    }
}
#[tokio::test]
async fn registry_storage_panic_propagates_to_host_joins_worker_before_terminal_and_holds_lease_until_host_cleanup(
) {
    let root =
        std::env::temp_dir().join(format!("workbench-registry-host-{}", uuid::Uuid::new_v4()));
    let trace = root.join("trace.ndjson");
    let mut fixture = None;
    let app = WorkbenchApp::start(
        config_at(
            &root,
            std::collections::HashMap::from([(
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            )]),
        ),
        |history, mailbox| {
            let store = Store::new(history);
            fixture = Some(store.clone());
            Runtime::start(store, mailbox)
        },
    )
    .unwrap();
    let store = fixture.unwrap();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "permission").await;
    wait_interaction(&mut events).await;
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        #[serde(default)]
        pid: Option<i32>,
    }
    let pid = tokio::fs::read_to_string(trace)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Trace>(line).unwrap())
        .find(|entry| entry.method == "boot")
        .unwrap()
        .pid
        .unwrap();
    store.pid.store(pid, Ordering::Release);
    store.panic_list.store(true, Ordering::Release);
    assert!(app.command(DomainCommand::ListSessions).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_secs(4), app.wait_closed())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(!store.premature_terminal.load(Ordering::Acquire));
    assert!(app.core.adapters.lock().await.is_empty());
    let saved = store.history.load(id.as_str()).await.unwrap().unwrap();
    assert!(saved.active_turn.is_none() && saved.pending_interactions.is_empty());
    assert!(StorageLease::lock(&root).is_err());
    assert!(app.shutdown_checked().await.is_err());
    assert!(StorageLease::lock(&root).is_ok());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn registry_root_abort_with_accepted_host_create_settles_io_and_journal_before_lease_release()
{
    let root = std::env::temp_dir().join(format!(
        "workbench-registry-create-{}",
        uuid::Uuid::new_v4()
    ));
    let mut fixture = None;
    let app = WorkbenchApp::start(config_at(&root, Default::default()), |history, mailbox| {
        let store = Store::new(history);
        fixture = Some(store.clone());
        Runtime::start(store, mailbox)
    })
    .unwrap();
    let store = fixture.unwrap();
    store.gate_save.store(true, Ordering::Release);
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::CreateSession {
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
    };
    let caller = {
        let app = app.clone();
        let operation = operation.clone();
        let command = command.clone();
        tokio::spawn(async move { app.command_durable(operation, command).await })
    };
    tokio::time::timeout(Duration::from_secs(3), store.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    app.runtime.abort_root();
    assert!(app.runtime.wait_closed().await.is_err());
    let mut shutdown = Box::pin(app.shutdown_checked());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut shutdown)
            .await
            .is_err()
    );
    drop(shutdown);
    assert!(StorageLease::lock(&root).is_err());
    store.gate_save.store(false, Ordering::Release);
    store.release.add_permits(1);
    let receipt = tokio::time::timeout(Duration::from_secs(3), caller)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), app.shutdown_checked())
            .await
            .unwrap()
            .is_err()
    );
    let app = app_at(&root);
    assert_eq!(app.core.history.list().await.unwrap().len(), 1);
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_string(&replay).unwrap(),
        serde_json::to_string(&receipt).unwrap()
    );
    assert_eq!(app.core.history.list().await.unwrap().len(), 1);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
