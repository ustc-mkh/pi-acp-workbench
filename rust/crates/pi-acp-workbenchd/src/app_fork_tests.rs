use super::*;
use crate::{
    domain::{fork::ForkRequest, session::SessionSnapshot, OperationId, SessionState},
    persistence::interface::SessionPersistence,
};
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) fn native_config(root: &std::path::Path) -> Config {
    let mut config = config_at(
        root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_NATIVE_STATE".into(),
            root.join("native-fixture").to_string_lossy().into_owned(),
        )]),
    );
    config.sessions.max_workers = 1;
    config
}
pub(super) async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionSnapshot {
    let events = app
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    snapshot.clone()
}
pub(super) async fn setup(app: &WorkbenchApp) -> SessionId {
    let id = create(app).await;
    let mut events = app.subscribe();
    prompt(app, &id, "fork source").await;
    wait_finished(&mut events).await;
    app.command(DomainCommand::SetModel {
        session: id.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetMode {
        session: id.clone(),
        mode: crate::domain::ModeId::new("high").unwrap(),
    })
    .await
    .unwrap();
    prompt(app, &id, "future content").await;
    wait_finished(&mut events).await;
    id
}
#[tokio::test]
async fn streamed_message_fork_keeps_immutable_deltas_and_matches_the_complete_native_message() {
    use crate::domain::transcript::EntryRole;
    let root = std::env::temp_dir().join(format!("workbench-stream-fork-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let source = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &source, "streamed-message").await;
    wait_finished(&mut events).await;
    let before = inspect(&app, &source).await;
    assert_eq!(before.transcript.entries.len(), 4);
    let message = before.transcript.entries[2].message.clone().unwrap();
    for row in &before.transcript.entries[1..] {
        assert_eq!(row.message.as_ref(), Some(&message));
    }
    let payloads = app.delivery_payloads();
    for row in before
        .transcript
        .entries
        .iter()
        .filter(|row| matches!(row.role, EntryRole::Agent))
    {
        assert_eq!(
            serde_json::to_vec(&payloads.entry(&row.id).await.unwrap()).unwrap(),
            serde_json::to_vec(row).unwrap()
        );
    }
    let native_path = root.join("native-fixture").join(format!(
        "{}.json",
        before.provider_session.as_ref().unwrap()
    ));
    let native_before = tokio::fs::read(&native_path).await.unwrap();
    let native: serde_json::Value = serde_json::from_slice(&native_before).unwrap();
    assert_eq!(native["entries"][1]["text"], "hello 世界");
    assert!(
        app.command(DomainCommand::Fork {
            session: source.clone(),
            request: ForkRequest {
                entry: before.transcript.entries[2].id.clone()
            },
        })
        .await
        .is_err(),
        "a partial row is not a native cut"
    );
    assert_eq!(tokio::fs::read(&native_path).await.unwrap(), native_before);
    app.shutdown_checked().await.unwrap();

    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    assert_eq!(
        serde_json::to_vec(&inspect(&app, &source).await.transcript).unwrap(),
        serde_json::to_vec(&before.transcript).unwrap()
    );
    assert!(
        app.core.adapters.lock().await.is_empty(),
        "cold inspect must not spawn a peer"
    );
    let receipt = app
        .command(DomainCommand::Fork {
            session: source.clone(),
            request: ForkRequest {
                entry: before.transcript.entries[3].id.clone(),
            },
        })
        .await
        .unwrap();
    let [DomainEvent::SessionCreated(branch)] = receipt.as_slice() else {
        panic!("branch")
    };
    assert_eq!(
        serde_json::to_vec(&branch.transcript.entries).unwrap(),
        serde_json::to_vec(&before.transcript.entries).unwrap()
    );
    assert_eq!(
        branch
            .transcript
            .origin
            .as_ref()
            .unwrap()
            .target
            .entry
            .as_str(),
        native["entries"][1]["id"].as_str().unwrap()
    );
    assert_ne!(
        branch
            .transcript
            .origin
            .as_ref()
            .unwrap()
            .target
            .entry
            .as_str(),
        message.as_str()
    );
    for row in before
        .transcript
        .entries
        .iter()
        .filter(|row| matches!(row.role, EntryRole::Agent))
    {
        assert_eq!(
            serde_json::to_vec(&app.delivery_payloads().entry(&row.id).await.unwrap()).unwrap(),
            serde_json::to_vec(row).unwrap()
        );
    }
    assert_eq!(tokio::fs::read(&native_path).await.unwrap(), native_before);
    assert!(app.core.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn native_fork_is_actor_projected_durable_independent_and_replays_after_source_removal() {
    let root = std::env::temp_dir().join(format!("workbench-host-fork-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let native_path = root.join("native-fixture").join(format!(
        "{}.json",
        before.provider_session.as_ref().unwrap()
    ));
    let native_before = tokio::fs::read(&native_path).await.unwrap();
    let command = DomainCommand::Fork {
        session: source.clone(),
        request: ForkRequest {
            entry: before.transcript.entries[0].id.clone(),
        },
    };
    let operation = OperationId::generate();
    let receipt = app
        .command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    let [DomainEvent::SessionCreated(branch)] = receipt.as_slice() else {
        panic!("adopted fork")
    };
    let branch = branch.clone();
    assert_ne!(branch.id, source);
    assert_ne!(branch.provider_session, before.provider_session);
    assert_eq!(branch.transcript.entries.len(), 1);
    assert!(branch.transcript.tools.is_empty());
    assert_eq!(branch.transcript.origin.as_ref().unwrap().session, source);
    assert!(branch.config.model.is_none() && branch.config.mode.is_none());
    assert!(branch.catalogue.models.is_empty());
    assert_eq!(
        serde_json::to_vec(&inspect(&app, &source).await).unwrap(),
        serde_json::to_vec(&before).unwrap()
    );
    assert_eq!(tokio::fs::read(&native_path).await.unwrap(), native_before);
    assert!(
        app.core.adapters.lock().await.is_empty(),
        "idle source capacity must be released"
    );
    let mut events = app.subscribe();
    prompt(&app, &branch.id, "branch continuation").await;
    wait_finished(&mut events).await;
    let continued = inspect(&app, &branch.id).await;
    assert_eq!(continued.transcript.entries.len(), 3);
    assert_eq!(
        continued.catalogue.current_model.as_ref().unwrap().as_str(),
        "default"
    );
    assert_eq!(
        continued.catalogue.current_mode.as_ref().unwrap().as_str(),
        "low"
    );
    assert!(continued.config.model.is_none() && continued.config.mode.is_none());
    assert!(!continued
        .transcript
        .entries
        .iter()
        .any(|entry| entry.text.contains("future content")));
    assert_eq!(tokio::fs::read(&native_path).await.unwrap(), native_before);
    app.command(DomainCommand::RemoveSession(source.clone()))
        .await
        .unwrap();
    app.shutdown_checked().await.unwrap();
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&replay).unwrap(),
        serde_json::to_vec(&receipt).unwrap()
    );
    assert!(matches!(
        app.command(DomainCommand::Inspect(source)).await,
        Err(DomainError::NotFound(_))
    ));
    app.command(DomainCommand::LoadSession(branch.id.clone()))
        .await
        .unwrap();
    let mut events = app.subscribe();
    prompt(&app, &branch.id, "branch after restart").await;
    wait_finished(&mut events).await;
    let restored = inspect(&app, &branch.id).await;
    assert_eq!(restored.provider_session, branch.provider_session);
    assert_eq!(restored.transcript.entries.len(), 5);
    assert_eq!(tokio::fs::read(&native_path).await.unwrap(), native_before);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn fork_busy_and_unknown_targets_do_not_touch_a_live_turn_or_start_replacement_peers() {
    let root = std::env::temp_dir().join(format!("workbench-fork-busy-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(native_config(&root)).unwrap();
    let source = setup(&app).await;
    let entry = inspect(&app, &source).await.transcript.entries[0]
        .id
        .clone();
    let mut events = app.subscribe();
    prompt(&app, &source, "permission").await;
    wait_interaction(&mut events).await;
    let before = inspect(&app, &source).await;
    assert!(matches!(
        app.command(DomainCommand::Fork {
            session: source.clone(),
            request: ForkRequest { entry }
        })
        .await,
        Err(DomainError::Busy)
    ));
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&inspect(&app, &source).await).unwrap()
    );
    app.command(DomainCommand::Cancel {
        session: source.clone(),
    })
    .await
    .unwrap();
    assert!(app
        .command(DomainCommand::Fork {
            session: source,
            request: ForkRequest {
                entry: crate::domain::EntryId::generate()
            }
        })
        .await
        .is_err());
    assert!(app.core.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn shutdown_during_uncertain_native_fork_joins_peer_and_replays_failure_without_forking_again(
) {
    let root = std::env::temp_dir().join(format!("workbench-fork-stop-{}", uuid::Uuid::new_v4()));
    let gate = root.join("fork-gate");
    let trace_path = root.join("trace.ndjson");
    let mut config = native_config(&root);
    config.workers.pi.as_mut().unwrap().env.extend([
        (
            "WORKBENCH_CONTRACT_FORK_GATE".into(),
            gate.to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace_path.to_string_lossy().into_owned(),
        ),
    ]);
    let app = WorkbenchApp::new(config.clone()).unwrap();
    let source = setup(&app).await;
    let before = inspect(&app, &source).await;
    let operation = OperationId::generate();
    let command = DomainCommand::Fork {
        session: source.clone(),
        request: ForkRequest {
            entry: before.transcript.entries[0].id.clone(),
        },
    };
    let caller = {
        let app = app.clone();
        let operation = operation.clone();
        let command = command.clone();
        tokio::spawn(async move { app.command_durable(operation, command).await })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !gate.with_extension("started").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), app.shutdown_checked())
        .await
        .unwrap()
        .unwrap();
    assert!(caller.await.unwrap().is_err());
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        #[serde(default)]
        pid: Option<i32>,
    }
    let records: Vec<Trace> = tokio::fs::read_to_string(&trace_path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        records
            .iter()
            .filter(|record| record.method == "_pi_workbench/fork")
            .count(),
        1
    );
    for record in records.iter().filter(|record| record.method == "boot") {
        assert_eq!(unsafe { libc::kill(record.pid.unwrap(), 0) }, -1);
    }
    let app = WorkbenchApp::new(config).unwrap();
    assert!(app.command_durable(operation, command).await.is_err());
    assert_eq!(
        serde_json::to_vec(&inspect(&app, &source).await).unwrap(),
        serde_json::to_vec(&before).unwrap()
    );
    assert_eq!(
        tokio::fs::read_to_string(trace_path)
            .await
            .unwrap()
            .lines()
            .filter(|line| line.contains("_pi_workbench/fork"))
            .count(),
        1
    );
    assert!(
        matches!(&app.command(DomainCommand::ListSessions).await.unwrap()[0], DomainEvent::SessionsListed(snapshots) if snapshots.len() == 1)
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[derive(Clone)]
struct FaultStore {
    history: HistoryStore,
    fail: Arc<AtomicBool>,
    after_write: bool,
}
impl SessionPersistence for FaultStore {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        self.history.load(id).await
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        self.history.list().await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.history.remove(id).await
    }
    async fn commit(&self, state: &SessionState, events: &[DomainEvent]) -> Result<(), String> {
        self.history.commit(state, events).await
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        if state.transcript.origin.is_some() && self.fail.swap(false, Ordering::AcqRel) {
            if self.after_write {
                self.history.save(state).await?;
            }
            return Err("injected branch adoption failure".into());
        }
        self.history.save(state).await
    }
}
#[tokio::test]
async fn adoption_failure_before_or_after_write_never_repeats_remote_fork_and_never_changes_source()
{
    for after_write in [false, true] {
        let root =
            std::env::temp_dir().join(format!("workbench-fork-fault-{}", uuid::Uuid::new_v4()));
        let app = WorkbenchApp::start(native_config(&root), |history, mailbox| {
            Runtime::start(
                FaultStore {
                    history,
                    fail: Arc::new(AtomicBool::new(true)),
                    after_write,
                },
                mailbox,
            )
        })
        .unwrap();
        let source = setup(&app).await;
        let before = inspect(&app, &source).await;
        let operation = OperationId::generate();
        let command = DomainCommand::Fork {
            session: source.clone(),
            request: ForkRequest {
                entry: before.transcript.entries[0].id.clone(),
            },
        };
        let failed = app
            .command_durable(operation.clone(), command.clone())
            .await
            .unwrap_err();
        let DomainError::NativeForkUnadopted { native: orphan, .. } = &failed else {
            panic!("known remote result must survive in the failed receipt")
        };
        assert!(root
            .join("native-fixture")
            .join(format!("{orphan}.json"))
            .exists());
        let mut native = tokio::fs::read_dir(root.join("native-fixture"))
            .await
            .unwrap();
        let mut count = 0;
        while native.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 2, "confirmed remote branch remains; never delete native data to hide a failed local adoption");
        let replay = app.command_durable(operation, command).await.unwrap_err();
        assert_eq!(
            serde_json::to_vec(&replay).unwrap(),
            serde_json::to_vec(&failed).unwrap()
        );
        let mut native = tokio::fs::read_dir(root.join("native-fixture"))
            .await
            .unwrap();
        let mut count = 0;
        while native.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 2, "failed receipt must not call native fork again");
        assert_eq!(
            serde_json::to_vec(&before).unwrap(),
            serde_json::to_vec(&inspect(&app, &source).await).unwrap()
        );
        let listed = app.command(DomainCommand::ListSessions).await.unwrap();
        assert!(
            matches!(&listed[0], DomainEvent::SessionsListed(snapshots) if snapshots.len() == if after_write { 2 } else { 1 })
        );
        app.shutdown_checked().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
