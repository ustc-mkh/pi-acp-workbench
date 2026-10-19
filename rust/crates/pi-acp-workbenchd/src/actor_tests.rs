use crate::{
    actor::{OwnerReply, Runtime},
    domain::{
        command::AgentEvent,
        query::{CommandReceipt, SessionView, TextBody},
        DomainCommand, Harness, Prompt, SessionId, SessionStatus, WorkspacePath,
    },
    persistence::SessionStore,
};
fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("workbench-actor-{}", uuid::Uuid::new_v4()))
}
async fn create(runtime: &Runtime) -> SessionId {
    match runtime
        .registry
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap()
    {
        OwnerReply::Receipt(CommandReceipt::Created { summary }) => summary.id,
        _ => panic!("creation receipt"),
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
async fn prompt(runtime: &Runtime, id: &SessionId, text: &str) -> crate::domain::TurnId {
    runtime
        .registry
        .command(DomainCommand::Prompt {
            session: id.clone(),
            prompt: Prompt::new(text).unwrap(),
        })
        .await
        .unwrap()
        .view()
        .unwrap()
        .active_turn
        .clone()
        .unwrap()
}
async fn close(runtime: Runtime, store: SessionStore, root: std::path::PathBuf) {
    runtime.shutdown_checked().await.unwrap();
    store.database().shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn cancelled_worker_epoch_cannot_publish_a_late_crash_before_or_after_replacement() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    runtime
        .registry
        .worker_started(id.clone(), 1)
        .await
        .unwrap();
    prompt(&runtime, &id, "first").await;
    runtime
        .registry
        .command(DomainCommand::Cancel {
            session: id.clone(),
        })
        .await
        .unwrap();
    let mut events = runtime.events.subscribe();
    runtime
        .registry
        .worker_event(
            id.clone(),
            1,
            AgentEvent::Crashed {
                reason: "late closed".into(),
            },
        )
        .await
        .unwrap();
    let idle = view(&runtime, &id).await;
    assert!(matches!(idle.status, SessionStatus::Idle));
    assert_eq!(idle.revision.get(), 2);
    assert!(events.try_recv().is_err());
    runtime
        .registry
        .worker_started(id.clone(), 2)
        .await
        .unwrap();
    prompt(&runtime, &id, "next").await;
    events.recv().await.unwrap();
    runtime
        .registry
        .worker_event(
            id.clone(),
            1,
            AgentEvent::Crashed {
                reason: "obsolete".into(),
            },
        )
        .await
        .unwrap();
    assert!(events.try_recv().is_err());
    let running = view(&runtime, &id).await;
    assert!(matches!(running.status, SessionStatus::Running));
    assert!(running.active_turn.is_some());
    close(runtime, store, root).await;
}
#[tokio::test]
async fn failed_commit_does_not_publish_or_replace_owned_state() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let mut events = runtime.events.subscribe();
    store
        .database()
        .set_session_commit_failure(id.clone(), true)
        .await
        .unwrap();
    assert!(matches!(
        runtime
            .registry
            .command(DomainCommand::Prompt {
                session: id.clone(),
                prompt: Prompt::new("hello").unwrap()
            })
            .await,
        Err(crate::domain::error::DomainError::Persistence(_))
    ));
    assert_eq!(view(&runtime, &id).await.revision.get(), 0);
    assert!(events.try_recv().is_err());
    store
        .database()
        .set_session_commit_failure(id.clone(), false)
        .await
        .unwrap();
    assert!(store
        .database()
        .view(id.clone())
        .await
        .unwrap()
        .active_turn
        .is_none());
    prompt(&runtime, &id, "retry").await;
    close(runtime, store, root).await;
}
#[tokio::test]
async fn durable_cancelling_state_fences_notifications_and_worker_reattachment_until_terminal_commit(
) {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let turn = prompt(&runtime, &id, "hello").await;
    runtime
        .registry
        .worker_started(id.clone(), 7)
        .await
        .unwrap();
    runtime
        .registry
        .command(DomainCommand::RequestCancel {
            session: id.clone(),
        })
        .await
        .unwrap();
    let cancellation = view(&runtime, &id).await;
    assert!(matches!(cancellation.status, SessionStatus::Cancelling));
    assert_eq!(cancellation.active_turn.as_ref(), Some(&turn));
    let mut events = runtime.events.subscribe();
    for event in [
        AgentEvent::Finished { turn },
        AgentEvent::Crashed {
            reason: "late crash".into(),
        },
    ] {
        runtime
            .registry
            .worker_event(id.clone(), 7, event)
            .await
            .unwrap();
        assert!(events.try_recv().is_err());
    }
    assert!(runtime
        .registry
        .worker_started(id.clone(), 8)
        .await
        .is_err());
    runtime
        .registry
        .command(DomainCommand::Cancel {
            session: id.clone(),
        })
        .await
        .unwrap();
    runtime.registry.worker_started(id, 8).await.unwrap();
    close(runtime, store, root).await;
}
#[tokio::test]
async fn load_does_not_replace_live_owner_and_restart_interrupts_turn() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    prompt(&runtime, &id, "hello").await;
    let loaded = runtime
        .registry
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    assert!(matches!(
        loaded.view().unwrap().status,
        SessionStatus::Running
    ));
    let mut crash_prefix = view(&runtime, &id).await;
    runtime.shutdown_checked().await.unwrap();
    crash_prefix.revision = store
        .database()
        .view(id.clone())
        .await
        .unwrap()
        .revision
        .next()
        .unwrap();
    store.database().shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
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
    let store = SessionStore::fixture(&root);
    let restarted = Runtime::start(store.clone(), 8);
    let loaded = restarted
        .registry
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    assert!(matches!(
        loaded.view().unwrap().status,
        SessionStatus::Failed(_)
    ));
    assert!(store
        .database()
        .view(id)
        .await
        .unwrap()
        .active_turn
        .is_none());
    close(restarted, store, root).await;
}
#[tokio::test]
async fn removal_is_durable_and_shutdown_rejects_late_commands() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    prompt(&runtime, &id, "hello").await;
    let mut events = runtime.events.subscribe();
    runtime
        .registry
        .command(DomainCommand::RemoveSession(id.clone()))
        .await
        .unwrap();
    let cancel = events.recv().await.unwrap();
    let removed = events.recv().await.unwrap();
    assert!(removed.removed);
    assert_eq!(removed.revision, cancel.revision.next().unwrap());
    assert!(store.database().view(id.clone()).await.is_err());
    assert!(runtime
        .registry
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .is_err());
    runtime.shutdown_checked().await.unwrap();
    assert!(runtime
        .registry
        .command(DomainCommand::LoadSession(id))
        .await
        .is_err());
    store.database().shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn list_and_inspect_expose_bounded_committed_projection_without_workers() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    prompt(&runtime, &id, "你好").await;
    let live = view(&runtime, &id).await;
    assert_eq!(live.last_entry_seq.get(), 1);
    assert_eq!(live.revision.get(), 1);
    assert!(live.active_turn.is_some());
    let page = store
        .database()
        .history(id.clone(), None, None)
        .await
        .unwrap();
    assert!(matches!(&page.entries[0].text, TextBody::Inline { text } if text == "你好"));
    runtime.shutdown_checked().await.unwrap();
    let cold = Runtime::start(store.clone(), 8);
    let OwnerReply::Listed(page) = cold
        .registry
        .command(DomainCommand::ListSessions)
        .await
        .unwrap()
    else {
        panic!("list")
    };
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].id, id);
    let before = serde_json::to_value(store.database().view(id.clone()).await.unwrap()).unwrap();
    assert_eq!(view(&cold, &id).await.last_entry_seq.get(), 1);
    assert_eq!(
        serde_json::to_value(store.database().view(id.clone()).await.unwrap()).unwrap(),
        before
    );
    assert!(matches!(
        cold.registry
            .command(DomainCommand::Prompt {
                session: id,
                prompt: Prompt::new("must load explicitly").unwrap()
            })
            .await,
        Err(crate::domain::error::DomainError::NotFound(_))
    ));
    close(cold, store, root).await;
}
#[tokio::test]
async fn independent_sessions_accept_one_hundred_commands() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 128);
    let mut ids = vec![];
    for _ in 0..16 {
        ids.push(create(&runtime).await);
    }
    let mut tasks = tokio::task::JoinSet::new();
    for index in 0..100 {
        let registry = runtime.registry.clone();
        let session = ids[index % ids.len()].clone();
        tasks.spawn(async move {
            registry
                .command(DomainCommand::SetModel {
                    session,
                    model: crate::domain::ModelId::new(format!("model-{index}")).unwrap(),
                })
                .await
        });
    }
    let mut completed = 0;
    while let Some(result) = tasks.join_next().await {
        result.unwrap().unwrap();
        completed += 1;
    }
    assert_eq!(completed, 100);
    let OwnerReply::Listed(page) = runtime
        .registry
        .command(DomainCommand::ListSessions)
        .await
        .unwrap()
    else {
        panic!("list")
    };
    assert_eq!(page.sessions.len(), 16);
    assert_eq!(
        page.sessions
            .iter()
            .map(|summary| summary.revision.get())
            .sum::<u64>(),
        100
    );
    close(runtime, store, root).await;
}
#[tokio::test]
async fn replacement_worker_fences_late_events_and_obsolete_attachments() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    let turn = prompt(&runtime, &id, "hello").await;
    runtime
        .registry
        .worker_started(id.clone(), 10)
        .await
        .unwrap();
    runtime
        .registry
        .worker_started(id.clone(), 11)
        .await
        .unwrap();
    assert!(runtime
        .registry
        .worker_started(id.clone(), 10)
        .await
        .is_err());
    let mut events = runtime.events.subscribe();
    for event in [
        AgentEvent::Text {
            turn: turn.clone(),
            text: "stale".into(),
            message: None,
        },
        AgentEvent::Crashed {
            reason: "old EOF".into(),
        },
    ] {
        runtime
            .registry
            .worker_event(id.clone(), 10, event)
            .await
            .unwrap();
        assert!(events.try_recv().is_err());
    }
    runtime
        .registry
        .worker_event(
            id.clone(),
            11,
            AgentEvent::Text {
                turn,
                text: "current".into(),
                message: None,
            },
        )
        .await
        .unwrap();
    let batch = events.recv().await.unwrap();
    assert!(matches!(&batch.entries[0].text, TextBody::Inline { text } if text == "current"));
    assert_eq!(view(&runtime, &id).await.last_entry_seq.get(), 2);
    assert!(matches!(
        view(&runtime, &id).await.status,
        SessionStatus::Running
    ));
    close(runtime, store, root).await;
}
#[tokio::test]
async fn checked_shutdown_commits_cancellation_and_reports_failed_final_write() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 8);
    let id = create(&runtime).await;
    prompt(&runtime, &id, "hello").await;
    runtime.shutdown_checked().await.unwrap();
    let final_state = store.database().view(id.clone()).await.unwrap();
    assert!(final_state.active_turn.is_none());
    assert!(matches!(final_state.status, SessionStatus::Idle));
    let runtime = Runtime::start(store.clone(), 8);
    runtime
        .registry
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    prompt(&runtime, &id, "second").await;
    store
        .database()
        .set_session_commit_failure(id, true)
        .await
        .unwrap();
    assert!(matches!(
        runtime.shutdown_checked().await,
        Err(crate::domain::error::DomainError::Persistence(_))
    ));
    store.database().shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn registry_owns_session_and_routes_commands() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 4);
    let id = create(&runtime).await;
    let turn = prompt(&runtime, &id, "hello").await;
    assert_eq!(view(&runtime, &id).await.active_turn.as_ref(), Some(&turn));
    close(runtime, store, root).await;
}
#[tokio::test]
async fn agent_events_update_owned_state() {
    let root = root();
    let store = SessionStore::fixture(&root);
    let runtime = Runtime::start(store.clone(), 4);
    let id = create(&runtime).await;
    let turn = prompt(&runtime, &id, "hello").await;
    let OwnerReply::Committed(batch) = runtime
        .registry
        .command(DomainCommand::Agent {
            session: id,
            event: AgentEvent::Text {
                turn,
                text: "world".into(),
                message: None,
            },
        })
        .await
        .unwrap()
    else {
        panic!("commit")
    };
    assert!(matches!(&batch.entries[0].text, TextBody::Inline { text } if text == "world"));
    close(runtime, store, root).await;
}
