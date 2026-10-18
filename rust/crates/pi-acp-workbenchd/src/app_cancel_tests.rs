use super::*;
use crate::{
    domain::SessionState,
    persistence::{interface::SessionPersistence, outbox::DeliveryPayload},
};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct CancelFault {
    history: SessionStore,
    fail: Arc<AtomicBool>,
    final_commit: bool,
}
impl SessionPersistence for CancelFault {
    async fn load(&self, id: &str) -> Result<Option<SessionState>, String> {
        self.history.load(id).await
    }
    async fn list(&self) -> Result<Vec<SessionState>, String> {
        self.history.list().await
    }
    async fn save(&self, state: &SessionState) -> Result<(), String> {
        self.history.save(state).await
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        self.history.remove(id).await
    }
    async fn commit(
        &self,
        change: crate::persistence::database::SessionCommit,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        let state = &change.next;
        let target = if self.final_commit {
            matches!(state.status, SessionStatus::Idle)
                && change
                    .deliveries
                    .iter()
                    .any(|delivery| matches!(delivery.payload, DeliveryPayload::Notice { .. }))
        } else {
            matches!(state.status, SessionStatus::Cancelling)
        };
        if target && self.fail.swap(false, Ordering::AcqRel) {
            return Err("fixture cancellation commit failure".into());
        }
        self.history.commit(change).await
    }
}
async fn inspect(app: &WorkbenchApp, id: &SessionId) -> crate::domain::session::SessionSnapshot {
    let events = app
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    snapshot.clone()
}
async fn pid(trace: &std::path::Path) -> i32 {
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        #[serde(default)]
        pid: Option<i32>,
    }
    tokio::fs::read_to_string(trace)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Trace>(line).unwrap())
        .find(|entry| entry.method == "boot")
        .unwrap()
        .pid
        .unwrap()
}
#[tokio::test]
async fn cold_load_commits_recovery_notices_and_acknowledgments_survive_restart_without_workers() {
    for cancelling in [false, true] {
        let root = std::env::temp_dir().join(format!(
            "workbench-recovery-notice-{}",
            uuid::Uuid::new_v4()
        ));
        let trace = root.join("trace.ndjson");
        let env = std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]);
        let app = app_at_with_env(&root, env.clone());
        let id = create(&app).await;
        let mut events = app.subscribe();
        prompt(&app, &id, "permission").await;
        wait_interaction(&mut events).await;
        if cancelling {
            app.runtime
                .registry
                .command(DomainCommand::RequestCancel {
                    session: id.clone(),
                })
                .await
                .unwrap();
        }
        let mut crash_prefix = app.core.history.load(id.as_str()).await.unwrap().unwrap();
        app.shutdown().await;
        let app = app_at_with_env(&root, env.clone());
        crash_prefix.revision = app
            .core
            .history
            .load(id.as_str())
            .await
            .unwrap()
            .unwrap()
            .revision
            + 1;
        crash_prefix.status = if cancelling {
            SessionStatus::Cancelling
        } else {
            SessionStatus::Running
        };
        app.core.history.save(&crash_prefix).await.unwrap();
        app.shutdown().await;
        let app = app_at_with_env(&root, env.clone());
        let recovered = app
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        assert!(recovered.iter().any(|event| if cancelling {
            matches!(event, DomainEvent::TurnCancelled { .. })
        } else {
            matches!(event, DomainEvent::SessionError { .. })
        }));
        assert!(inspect(&app, &id).await.active_turn.is_none());
        let expected = if cancelling {
            "cancelled"
        } else {
            "daemon restarted during active turn"
        };
        let mut recovered_notice = None;
        for record in app.pending_deliveries(0, 100).await.unwrap() {
            if let DeliveryPayload::Notice { content: notice } = &record.event.payload {
                if app
                    .delivery_payloads()
                    .content(notice)
                    .await
                    .unwrap()
                    .contains(expected)
                {
                    let notice = notice.clone();
                    recovered_notice = Some((record.event, notice));
                    break;
                }
            }
        }
        let (event, notice) = recovered_notice.expect("durable recovery notice");
        app.delivery_store().ack(&event.id).await.unwrap();
        assert!(app.core.adapters.lock().await.is_empty());
        app.shutdown().await;
        let app = app_at_with_env(&root, env);
        assert!(!app
            .pending_deliveries(0, 100)
            .await
            .unwrap()
            .iter()
            .any(|record| record.event.id == event.id));
        app.command(DomainCommand::RemoveSession(id)).await.unwrap();
        assert!(app
            .delivery_payloads()
            .content(&notice)
            .await
            .unwrap()
            .contains(expected));
        assert_eq!(
            tokio::fs::read_to_string(trace)
                .await
                .unwrap()
                .lines()
                .filter(|line| line.contains("\"method\":\"boot\""))
                .count(),
            1
        );
        app.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_and_removal_terminal_publication_follow_physical_worker_join() {
    for remove in [false, true] {
        let root =
            std::env::temp_dir().join(format!("workbench-cancel-order-{}", uuid::Uuid::new_v4()));
        let trace = root.join("trace.ndjson");
        let app = app_at_with_env(
            &root,
            std::collections::HashMap::from([(
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            )]),
        );
        let id = create(&app).await;
        let mut events = app.subscribe();
        prompt(&app, &id, "permission").await;
        wait_interaction(&mut events).await;
        let pid = pid(&trace).await;
        let command = if remove {
            DomainCommand::RemoveSession(id.clone())
        } else {
            DomainCommand::Cancel {
                session: id.clone(),
            }
        };
        let caller = {
            let app = app.clone();
            tokio::spawn(async move { app.command(command).await })
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if matches!(
                    events.recv().await.unwrap(),
                    DomainEvent::TurnCancelled { .. }
                ) {
                    assert_eq!(
                        unsafe { libc::kill(pid, 0) },
                        -1,
                        "terminal event preceded physical worker join"
                    );
                    break;
                }
            }
        })
        .await
        .unwrap();
        caller.await.unwrap().unwrap();
        let trace = tokio::fs::read_to_string(trace).await.unwrap();
        assert!(trace.contains("session/cancel") && trace.contains("cancelled"));
        if remove {
            assert!(app.core.history.load(id.as_str()).await.unwrap().is_none());
        } else {
            assert!(matches!(
                inspect(&app, &id).await.status,
                SessionStatus::Idle
            ));
        }
        let notices = app.pending_deliveries(0, 100).await.unwrap();
        let mut found = false;
        for record in notices {
            if let DeliveryPayload::Notice { content: notice } = record.event.payload {
                found |= app
                    .delivery_payloads()
                    .content(&notice)
                    .await
                    .unwrap()
                    .contains("cancelled");
            }
        }
        assert!(found);
        app.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
#[tokio::test]
async fn cancellation_prepare_failure_keeps_live_turn_and_final_failure_keeps_fenced_recoverable_intent(
) {
    for final_commit in [false, true] {
        let root =
            std::env::temp_dir().join(format!("workbench-cancel-fault-{}", uuid::Uuid::new_v4()));
        let trace = root.join("trace.ndjson");
        let config = config_at(
            &root,
            std::collections::HashMap::from([(
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            )]),
        );
        let app = WorkbenchApp::start(config, |history, mailbox| {
            Runtime::start(
                CancelFault {
                    history,
                    fail: Arc::new(AtomicBool::new(true)),
                    final_commit,
                },
                mailbox,
            )
        })
        .unwrap();
        let id = create(&app).await;
        let mut events = app.subscribe();
        prompt(&app, &id, "permission").await;
        wait_interaction(&mut events).await;
        let pid = pid(&trace).await;
        let operation = crate::domain::OperationId::generate();
        let command = DomainCommand::Cancel {
            session: id.clone(),
        };
        assert!(matches!(
            app.command_durable(operation.clone(), command.clone())
                .await,
            Err(DomainError::Persistence(_))
        ));
        let pending = inspect(&app, &id).await;
        assert!(pending.active_turn.is_some());
        assert!(!pending.pending_interactions.is_empty());
        if final_commit {
            assert!(matches!(pending.status, SessionStatus::Cancelling));
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert!(!app.core.adapters.lock().await.contains_key(&id));
            assert!(matches!(
                app.command(DomainCommand::Prompt {
                    session: id.clone(),
                    prompt: Prompt::new("cannot replace cancelling turn").unwrap()
                })
                .await,
                Err(DomainError::Busy)
            ));
        } else {
            assert!(matches!(pending.status, SessionStatus::Waiting));
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
            assert!(!tokio::fs::read_to_string(&trace)
                .await
                .unwrap()
                .contains("session/cancel"));
        }
        assert!(app
            .command_durable(operation.clone(), command.clone())
            .await
            .is_err());
        assert_eq!(inspect(&app, &id).await.revision, pending.revision);
        app.command(command.clone()).await.unwrap(); // explicit new operation after storage recovers
        let finished = inspect(&app, &id).await;
        assert!(matches!(finished.status, SessionStatus::Idle));
        assert!(finished.active_turn.is_none() && finished.pending_interactions.is_empty());
        assert!(app.command_durable(operation, command).await.is_err());
        assert_eq!(inspect(&app, &id).await.revision, finished.revision);
        app.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
