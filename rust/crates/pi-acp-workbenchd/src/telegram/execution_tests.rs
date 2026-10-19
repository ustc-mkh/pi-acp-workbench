use super::*;
use crate::{
    domain::{Harness, Prompt, SessionId, WorkspacePath},
    persistence::format::StorageLease,
    telegram::state::InboxStatus,
};
use tokio_util::sync::CancellationToken;
async fn until(mut predicate: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[derive(serde::Deserialize)]
struct Trace {
    method: String,
    #[serde(default)]
    pid: Option<i32>,
}
async fn trace(path: &Path) -> Vec<Trace> {
    tokio::fs::read_to_string(path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[tokio::test]
async fn eight_blocked_topics_preserve_control_query_reserves_fifo_and_joined_shutdown_recovery() {
    let root = root();
    let gate = root.join("gate");
    let path = root.join("trace.ndjson");
    let app = app_with_env(
        &root,
        std::collections::HashMap::from([
            (
                "WORKBENCH_CONTRACT_CONFIG_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_TRACE".into(),
                path.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let api = Fake::default();
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    let mut ids: Vec<SessionId> = Vec::new();
    for index in 0..10 {
        let events = app
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap();
        let crate::domain::query::CommandReceipt::Created { summary: snapshot } = events else {
            panic!("create")
        };
        ids.push(snapshot.id.clone());
        context
            .store
            .bind(
                TopicKey {
                    chat: ChatId::new(-100).unwrap(),
                    thread: Some(TopicId::new(10 + index).unwrap()),
                },
                snapshot.id.clone(),
            )
            .await
            .unwrap();
    }
    let mut events = app.subscribe();
    for id in ids.iter().take(8) {
        app.command(DomainCommand::Prompt {
            session: id.clone(),
            prompt: Prompt::new("prime").unwrap(),
        })
        .await
        .unwrap();
        finished(&mut events).await;
    }
    app.command(DomainCommand::Prompt {
        session: ids[8].clone(),
        prompt: Prompt::new("permission").unwrap(),
    })
    .await
    .unwrap();
    let interaction = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(interaction) = events
                .recv()
                .await
                .unwrap()
                .view
                .and_then(|view| view.pending_interactions.into_values().next())
            {
                break interaction.id;
            }
        }
    })
    .await
    .unwrap();
    for index in 0..8 {
        api.0.lock().await.updates.push_back(update(
            1 + index,
            Some(TopicId::new(10 + index as i64).unwrap()),
            "/model other",
        ));
    }
    poll_once(&context).await.unwrap();
    let stop = CancellationToken::new();
    let task = {
        let context = context.clone();
        let stop = stop.clone();
        tokio::spawn(async move { crate::telegram::execution::run(context, stop).await })
    };
    until(async || {
        trace(&path)
            .await
            .iter()
            .filter(|record| record.method == "session/set_config_option")
            .count()
            == 8
    })
    .await;
    {
        let mut state = api.0.lock().await;
        state.updates.extend([
            update(9, Some(TopicId::new(19).unwrap()), "ordinary must wait"),
            update(10, Some(TopicId::new(10).unwrap()), "/cancel"),
            update(11, Some(TopicId::new(10).unwrap()), "/status"),
            update(
                12,
                Some(TopicId::new(18).unwrap()),
                &format!("/answer {interaction} yes"),
            ),
            update(13, Some(TopicId::new(19).unwrap()), "/help"),
            update(14, Some(TopicId::new(20).unwrap()), "/notifications off"),
            update(15, Some(TopicId::new(18).unwrap()), "/history all"),
            update(16, Some(TopicId::new(10).unwrap()), "/history all"),
        ]);
    }
    poll_once(&context).await.unwrap();
    until(async || {
        let state = context.store.snapshot().await.unwrap();
        [11, 12, 13, 14, 15].iter().all(|id| {
            matches!(
                state.inbox[&UpdateId::new(*id).unwrap()].status,
                InboxStatus::Completed(_)
            )
        })
    })
    .await;
    let state = context.store.snapshot().await.unwrap();
    for id in 1..=10 {
        assert!(matches!(
            state.inbox[&UpdateId::new(id).unwrap()].status,
            InboxStatus::Pending
        ));
    }
    assert!(
        !context
            .store
            .preferences(&TopicKey {
                chat: ChatId::new(-100).unwrap(),
                thread: Some(TopicId::new(20).unwrap()),
            })
            .await
            .unwrap()
            .notifications,
        "ordinary provider saturation must not exhaust preference control capacity"
    );
    assert!(matches!(state.inbox[&UpdateId::new(16).unwrap()].status, InboxStatus::Pending), "history export is a cursor/outbox mutation and must not jump a prior same-topic config/cancel");
    assert!(app.delivery_store().pending(u64::MAX, 128).await.unwrap().iter().any(|record| matches!(&record.event.payload, crate::domain::transition::DeliveryPayload::HistoryEntry { session, .. } if session == &ids[8])), "history uses reserved control capacity when all ordinary provider lanes are blocked");
    let untouched = context.inspect(&ids[9]).await.unwrap().unwrap();
    assert_eq!(untouched.last_entry_seq.get(), 0);
    until(async || {
        context
            .inspect(&ids[8])
            .await
            .unwrap()
            .unwrap()
            .active_turn
            .is_none()
    })
    .await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        StorageLease::lock(&root).is_err(),
        "transport drain must not release the host lease"
    );
    let state = context.store.snapshot().await.unwrap();
    for id in 1..=10 {
        assert!(matches!(
            state.inbox[&UpdateId::new(id).unwrap()].status,
            InboxStatus::Pending
        ));
    }
    app.shutdown_checked().await.unwrap();
    for record in trace(&path)
        .await
        .iter()
        .filter(|record| record.method == "boot")
    {
        assert_eq!(unsafe { libc::kill(record.pid.unwrap(), 0) }, -1);
    }
    let restarted = super::app(&root);
    let context = Context::new(restarted.clone(), api, &root.join("telegram"), config())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let task = {
        let context = context.clone();
        let stop = stop.clone();
        tokio::spawn(async move { crate::telegram::execution::run(context, stop).await })
    };
    until(async || context.store.pending(128).await.unwrap().is_empty()).await;
    until(async || {
        context
            .inspect(&ids[9])
            .await
            .unwrap()
            .unwrap()
            .active_turn
            .is_none()
    })
    .await;
    let history = restarted
        .database()
        .history(ids[9].clone(), None, None)
        .await
        .unwrap();
    let mut found = false;
    for entry in history.entries {
        if restarted
            .delivery_payloads()
            .entry(&entry.id)
            .await
            .unwrap()
            .text
            == "echo: ordinary must wait"
        {
            found = true;
        }
    }
    assert!(found);
    stop.cancel();
    task.await.unwrap().unwrap();
    restarted.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_and_sync_remain_cold_and_recheck_workspace_authorization() {
    use crate::telegram::{
        command::{ControlCommand, TelegramAction, TelegramCommand},
        state::{InboxRecord, InboxStatus},
    };
    let root = root();
    let app = app(&root);
    let created = app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap();
    let crate::domain::query::CommandReceipt::Created { summary } = created else {
        panic!("create")
    };
    let topic = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(10).unwrap()),
    };
    let context = Context::new(
        app.clone(),
        Fake::default(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    context
        .store
        .bind(topic.clone(), summary.id.clone())
        .await
        .unwrap();
    let record = |id, action| InboxRecord {
        id: UpdateId::new(id).unwrap(),
        sender: UserId::new(5).unwrap(),
        operation: crate::domain::OperationId::generate(),
        command: TelegramCommand {
            topic: topic.clone(),
            action: TelegramAction::Control(action),
        },
        callback: None,
        callback_query: None,
        status: InboxStatus::Pending,
    };
    for action in [
        ControlCommand::History {
            session: summary.id.clone(),
            all: false,
        },
        ControlCommand::Sync {
            cursor: None,
            recent: 5,
            forum: false,
        },
    ] {
        let record = record(
            if matches!(action, ControlCommand::History { .. }) {
                1
            } else {
                2
            },
            action,
        );
        context
            .store
            .admit(crate::persistence::inbox::Admission {
                id: record.id,
                sender: Some(record.sender),
                command: Some(record.command.clone()),
                callback: None,
                callback_query: None,
                expected_binding: Some(summary.id.clone()),
            })
            .await
            .unwrap();
        let reply = dispatch(&context, &record).await.unwrap().unwrap();
        assert!(
            reply.1.contains("0 new entries queued")
                || super::super::menu::Menu::decode(&reply.1).is_ok()
        );
    }
    assert!(app
        .database()
        .view(summary.id.clone())
        .await
        .unwrap()
        .provider_session
        .is_none());
    let mut restricted = config();
    restricted.workspace = WorkspacePath::new(root.to_string_lossy()).unwrap();
    let context = Context::new(
        app.clone(),
        Fake::default(),
        &root.join("telegram"),
        restricted,
    )
    .await
    .unwrap();
    for action in [
        ControlCommand::History {
            session: summary.id.clone(),
            all: true,
        },
        ControlCommand::Sync {
            cursor: None,
            recent: 5,
            forum: false,
        },
    ] {
        assert!(dispatch(&context, &record(3, action)).await.is_err());
    }
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
