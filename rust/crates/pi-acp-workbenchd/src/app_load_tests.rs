//! Bounded mixed-load regression, not a long-duration or real-provider soak.
use super::*;
use crate::{
    domain::{
        interaction::{InteractionAnswer, InteractionResponse},
        OperationId,
    },
    persistence::interface::SessionPersistence,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::task::JoinSet;
type Fault = Arc<StdMutex<Option<SessionId>>>;
#[derive(Clone)]
struct Store {
    history: SessionStore,
    reject_cancel: Fault,
}
impl SessionPersistence for Store {
    crate::persistence::interface_test_helpers::delegate_session_queries!();
    async fn commit(
        &self,
        change: crate::domain::transition::Transition,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        let state = &change.next;
        let reject = {
            let mut target = self.reject_cancel.lock().unwrap();
            if matches!(state.status, SessionStatus::Cancelling)
                && target.as_ref() == Some(&state.id)
            {
                target.take();
                true
            } else {
                false
            }
        };
        if reject {
            return Err("mixed-load injected cancellation prepare failure".into());
        }
        self.history.commit(change).await
    }
}
fn host(root: &std::path::Path, trace: &std::path::Path, reject_cancel: &Fault) -> WorkbenchApp {
    let config = config_at(
        root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        )]),
    );
    WorkbenchApp::start(config, |history, mailbox| {
        Runtime::start(
            Store {
                history,
                reject_cancel: reject_cancel.clone(),
            },
            mailbox,
        )
    })
    .unwrap()
}
async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
}
async fn states(
    app: &WorkbenchApp,
    ids: &[SessionId],
    predicate: impl Fn(&SessionView) -> bool,
) -> Vec<SessionView> {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let mut snapshots = Vec::new();
            for id in ids {
                snapshots.push(inspect(app, id).await);
            }
            if snapshots.iter().all(&predicate) {
                return snapshots;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn prompts(app: &WorkbenchApp, ids: &[SessionId], text: &str) {
    let mut tasks = JoinSet::new();
    for id in ids {
        let app = app.clone();
        let id = id.clone();
        let text = text.to_owned();
        tasks.spawn(async move { prompt(&app, &id, &text).await });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
}
#[derive(serde::Deserialize)]
struct Trace {
    method: String,
    #[serde(default)]
    pid: Option<i32>,
}
async fn trace(path: &std::path::Path) -> Vec<Trace> {
    tokio::fs::read_to_string(path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
async fn live_workers(path: &std::path::Path) -> usize {
    trace(path)
        .await
        .iter()
        .filter(|record| {
            record.method == "boot" && unsafe { libc::kill(record.pid.unwrap(), 0) } == 0
        })
        .count()
}
#[tokio::test]
async fn mixed_three_restart_cycles_sixteen_workers_hundred_queries_thirty_two_interactions_and_storage_faults(
) {
    let root = std::env::temp_dir().join(format!("workbench-mixed-load-{}", uuid::Uuid::new_v4()));
    let trace_path = root.join("trace.ndjson");
    let reject = Fault::default();
    let mut app = host(&root, &trace_path, &reject);
    let mut ids = Vec::new();
    for _ in 0..16 {
        ids.push(create(&app).await);
    }
    let mut native = BTreeMap::new();
    for round in 0..3 {
        prompts(&app, &ids, "permissions:2").await;
        let waiting = states(&app, &ids, |state| {
            matches!(state.status, SessionStatus::Waiting) && state.pending_interactions.len() == 2
        })
        .await;
        assert_eq!(
            waiting
                .iter()
                .map(|state| state.pending_interactions.len())
                .sum::<usize>(),
            32
        );
        assert_eq!(live_workers(&trace_path).await, 16);
        for state in &waiting {
            if round == 0 {
                native.insert(state.id.clone(), state.provider_session.clone().unwrap());
            } else {
                assert_eq!(state.provider_session.as_ref(), native.get(&state.id));
            }
        }
        let calls = trace(&trace_path).await.len();
        let mut queries = JoinSet::new();
        for lane in 0..16 {
            let app = app.clone();
            let ids = ids.clone();
            queries.spawn(async move {
                let mut count = 0;
                for index in (lane..100).step_by(16) {
                    let snapshot = inspect(&app, &ids[index % ids.len()]).await;
                    assert_eq!(snapshot.pending_interactions.len(), 2);
                    count += 1;
                }
                count
            });
        }
        let mut count = 0;
        while let Some(result) = queries.join_next().await {
            count += result.unwrap();
        }
        assert_eq!(count, 100);
        assert_eq!(
            trace(&trace_path).await.len(),
            calls,
            "queries must not run agent work"
        );
        *reject.lock().unwrap() = Some(ids[0].clone());
        let operation = OperationId::generate();
        let cancel = DomainCommand::Cancel {
            session: ids[0].clone(),
        };
        assert!(app
            .command_durable(operation.clone(), cancel.clone())
            .await
            .is_err());
        assert!(app.command_durable(operation, cancel).await.is_err());
        assert_eq!(inspect(&app, &ids[0]).await.pending_interactions.len(), 2);
        assert_eq!(
            live_workers(&trace_path).await,
            16,
            "failed prepare must not stop a live peer"
        );
        let mut controls = JoinSet::new();
        for (index, state) in waiting.into_iter().enumerate() {
            let app = app.clone();
            controls.spawn(async move {
                if index % 2 == 0 {
                    app.command(DomainCommand::Cancel { session: state.id })
                        .await
                        .unwrap();
                } else {
                    for interaction in state.pending_interactions.into_keys() {
                        app.command(DomainCommand::AnswerInteraction {
                            session: state.id.clone(),
                            answer: InteractionAnswer {
                                interaction,
                                response: InteractionResponse::Permission {
                                    option: "yes".into(),
                                },
                            },
                        })
                        .await
                        .unwrap();
                    }
                }
            });
        }
        while let Some(result) = controls.join_next().await {
            result.unwrap();
        }
        states(&app, &ids, |state| {
            state.active_turn.is_none() && state.pending_interactions.is_empty()
        })
        .await;
        let crash: Vec<_> = ids.iter().skip(1).step_by(2).cloned().collect();
        prompts(&app, &crash, "crash").await;
        states(&app, &crash, |state| {
            matches!(state.status, SessionStatus::Failed(_)) && state.active_turn.is_none()
        })
        .await;
        // A large Unicode prompt exercises frame/history growth and turn
        // replacement without treating a short regression as a sustained soak.
        let text = format!("round-{round}: {}", "🦀中文e\u{301}\n".repeat(2048));
        prompts(&app, &ids, &text).await;
        let complete = states(&app, &ids, |state| {
            matches!(state.status, SessionStatus::Idle) && state.active_turn.is_none()
        })
        .await;
        for state in complete {
            assert!(history_text(&app, &state.id)
                .await
                .iter()
                .any(|entry| entry == &format!("echo: {text}")));
        }
        prompts(&app, &ids, "permissions:2").await;
        states(&app, &ids, |state| state.pending_interactions.len() == 2).await;
        // Preserve committed running hot fields to model crash recovery after
        // joining real children. SQL archives and delivery tombstones stay intact;
        // the synthetic state is written with a fresh revision in this test root.
        let mut prefix = BTreeMap::new();
        for id in &ids {
            prefix.insert(id.clone(), inspect_view(&app, id).await);
        }
        app.shutdown_checked().await.unwrap();
        assert_eq!(live_workers(&trace_path).await, 0);
        let database = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
        for state in prefix.values() {
            let mut crash = state.clone();
            let revision: crate::domain::query::SafeInteger = database
                .query_row(
                    "SELECT revision FROM sessions WHERE id=?1",
                    [crash.id.as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            crash.revision = revision.next().unwrap();
            database
                .execute(
                    "UPDATE sessions SET revision=?2,status_json=?3,hot_state_json=?4 WHERE id=?1",
                    rusqlite::params![
                        crash.id.as_str(),
                        crash.revision,
                        serde_json::to_string(&crash.status).unwrap(),
                        serde_json::to_string(&crash).unwrap()
                    ],
                )
                .unwrap();
        }
        drop(database);
        let boots = trace(&trace_path)
            .await
            .iter()
            .filter(|entry| entry.method == "boot")
            .count();
        if round == 1 {
            // Corrupt only one hot row offline. A bad session must fail closed
            // without preventing the remaining sessions from recovering.
            let database = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
            let original: String = database
                .query_row(
                    "SELECT hot_state_json FROM sessions WHERE id=?1",
                    [ids[0].as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            database
                .execute(
                    "UPDATE sessions SET hot_state_json='{}' WHERE id=?1",
                    [ids[0].as_str()],
                )
                .unwrap();
            database.close().unwrap();
            let failed = host(&root, &trace_path, &reject);
            assert!(failed
                .command(DomainCommand::LoadSession(ids[0].clone()))
                .await
                .is_err());
            assert!(failed
                .command(DomainCommand::Inspect(ids[0].clone()))
                .await
                .is_err());
            for id in ids.iter().skip(1) {
                failed
                    .command(DomainCommand::LoadSession(id.clone()))
                    .await
                    .unwrap();
            }
            failed.shutdown_checked().await.unwrap();
            let database = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
            let damaged: String = database
                .query_row(
                    "SELECT hot_state_json FROM sessions WHERE id=?1",
                    [ids[0].as_str()],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(damaged, "{}");
            database
                .execute(
                    "UPDATE sessions SET hot_state_json=?2 WHERE id=?1",
                    rusqlite::params![ids[0].as_str(), original],
                )
                .unwrap();
            database.close().unwrap();
        }
        app = host(&root, &trace_path, &reject);
        for id in &ids {
            app.command(DomainCommand::LoadSession(id.clone()))
                .await
                .unwrap();
        }
        let recovered = states(&app, &ids, |state| {
            matches!(state.status, SessionStatus::Failed(_))
                && state.active_turn.is_none()
                && state.pending_interactions.is_empty()
        })
        .await;
        for state in recovered {
            assert_eq!(state.provider_session.as_ref(), native.get(&state.id));
        }
        assert_eq!(
            trace(&trace_path)
                .await
                .iter()
                .filter(|entry| entry.method == "boot")
                .count(),
            boots,
            "cold recovery must not run a provider"
        );
        assert_eq!(live_workers(&trace_path).await, 0);
    }
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn thirty_two_pending_interactions_are_supported_and_thirty_three_fail_closed() {
    let (app, root) = app();
    let id = create(&app).await;
    prompt(&app, &id, "permissions:32").await;
    states(&app, std::slice::from_ref(&id), |state| {
        state.pending_interactions.len() == 32 && matches!(state.status, SessionStatus::Waiting)
    })
    .await;
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    assert!(inspect(&app, &id).await.pending_interactions.is_empty());
    prompt(&app, &id, "permissions:33").await;
    states(&app, std::slice::from_ref(&id), |state| {
        matches!(state.status, SessionStatus::Failed(_))
            && state.pending_interactions.is_empty()
            && state.active_turn.is_none()
    })
    .await;
    prompt(&app, &id, "recovered after interaction overflow").await;
    states(&app, &[id], |state| {
        matches!(state.status, SessionStatus::Idle) && state.active_turn.is_none()
    })
    .await;
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
