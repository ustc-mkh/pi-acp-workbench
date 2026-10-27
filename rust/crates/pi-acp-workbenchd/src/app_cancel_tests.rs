use super::*;
use crate::persistence::{interface::SessionPersistence, outbox::DeliveryPayload};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct CancelFault {
    history: SessionStore,
    fail: Arc<AtomicBool>,
    final_commit: bool,
}
impl SessionPersistence for CancelFault {
    crate::persistence::interface_test_helpers::delegate_session_queries!();
    async fn commit(
        &self,
        change: crate::domain::transition::Transition,
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
async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
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
        let mut crash_prefix = inspect_view(&app, &id).await;
        app.shutdown().await;
        let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
        let revision: crate::domain::query::SafeInteger = sql
            .query_row(
                "SELECT revision FROM sessions WHERE id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        crash_prefix.revision = revision.next().unwrap();
        crash_prefix.status = if cancelling {
            SessionStatus::Cancelling
        } else {
            SessionStatus::Running
        };
        sql.execute(
            "UPDATE sessions SET revision=?2,status_json=?3,hot_state_json=?4 WHERE id=?1",
            rusqlite::params![
                id.as_str(),
                crash_prefix.revision,
                serde_json::to_string(&crash_prefix.status).unwrap(),
                serde_json::to_string(&crash_prefix).unwrap()
            ],
        )
        .unwrap();
        drop(sql);
        let app = app_at_with_env(&root, env.clone());
        let recovered = app
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        let recovered = recovered.view().unwrap();
        assert!(if cancelling {
            matches!(recovered.status, SessionStatus::Idle)
        } else {
            matches!(recovered.status, SessionStatus::Failed(_))
        });
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
        assert!(app.core.coordinator.adapters.lock().await.is_empty());
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
                if events.recv().await.unwrap().view.is_some_and(|view| {
                    view.active_turn.is_none() && matches!(view.status, SessionStatus::Idle)
                }) {
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
            assert!(matches!(
                app.core.database.view(id.clone()).await,
                Err(crate::persistence::database::StoreError::NotFound)
            ));
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
            assert!(!app.core.coordinator.adapters.lock().await.contains_key(&id));
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

#[tokio::test]
async fn background_interrupt_prepare_failure_never_sends_native_cancel() {
    let root = std::env::temp_dir().join(format!("wb-background-prepare-{}", uuid::Uuid::new_v4()));
    let trace = root.join("trace");
    let gate = root.join("wake");
    let config = config_at(
        &root,
        std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_AUTONOMOUS".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_WAKE_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let app = WorkbenchApp::start(config, |history, mailbox| {
        Runtime::start(
            CancelFault {
                history,
                fail: Arc::new(AtomicBool::new(true)),
                final_commit: false,
            },
            mailbox,
        )
    })
    .unwrap();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "autonomous-arm").await;
    wait_finished(&mut events).await;
    tokio::fs::write(&gate, "wake").await.unwrap();
    wait_interaction(&mut events).await;
    let original = inspect(&app, &id).await;
    let process = pid(&trace).await;
    assert!(matches!(
        app.command(DomainCommand::Cancel {
            session: id.clone()
        })
        .await,
        Err(DomainError::Persistence(_))
    ));
    let current = inspect(&app, &id).await;
    assert_eq!(current.revision, original.revision);
    assert_eq!(current.active_turn, original.active_turn);
    assert!(matches!(current.status, SessionStatus::Waiting));
    assert_eq!(unsafe { libc::kill(process, 0) }, 0);
    assert!(!tokio::fs::read_to_string(&trace)
        .await
        .unwrap()
        .contains("session/cancel"));
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    assert!(inspect(&app, &id).await.active_turn.is_none());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
