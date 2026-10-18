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
        let DomainEvent::SessionCreated(snapshot) = &events[0] else {
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
            if let DomainEvent::InteractionRequested { interaction, .. } =
                events.recv().await.unwrap()
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
        ]);
    }
    poll_once(&context).await.unwrap();
    until(async || {
        let state = context.store.snapshot().await.unwrap();
        [11, 12, 13].iter().all(|id| {
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
    let untouched = context.inspect(&ids[9]).await.unwrap().unwrap();
    assert!(untouched.transcript.entries.is_empty());
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
        StorageLease::acquire(&root).is_err(),
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
    assert!(context
        .inspect(&ids[9])
        .await
        .unwrap()
        .unwrap()
        .transcript
        .entries
        .iter()
        .any(|entry| entry.text == "echo: ordinary must wait"));
    stop.cancel();
    task.await.unwrap().unwrap();
    restarted.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
