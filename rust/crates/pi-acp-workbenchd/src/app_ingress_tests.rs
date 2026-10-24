use super::super::ingress::Request;
use super::*;
use tokio::sync::oneshot;

async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
}
async fn wait_for(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn blocked_provider_configuration_keeps_other_sessions_queries_and_owned_disconnect_recovery_live(
) {
    let root = std::env::temp_dir().join(format!("workbench-ingress-{}", uuid::Uuid::new_v4()));
    let gate = root.join("configure");
    let trace = root.join("trace.ndjson");
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([
            (
                "WORKBENCH_CONTRACT_CONFIG_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let first = create(&app).await;
    let second = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &first, "ready").await;
    wait_finished(&mut events).await;
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::SetModel {
        session: first.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    };
    let caller = {
        let app = app.clone();
        let operation = operation.clone();
        let command = command.clone();
        tokio::spawn(async move { app.command_durable(operation, command).await })
    };
    wait_for(|| gate.with_extension("started").exists()).await;
    caller.abort();
    let _ = caller.await; // accepted operation is still owned by ingress
    let (reply, mut ordered) = oneshot::channel();
    app.ingress
        .submit(Request::Command {
            operation: Some(crate::domain::OperationId::generate()),
            command: DomainCommand::SetMode {
                session: first.clone(),
                mode: crate::domain::ModeId::new("high").unwrap(),
            },
            reply,
        })
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut ordered)
            .await
            .is_err()
    );
    let pending = tokio::time::timeout(Duration::from_secs(1), inspect(&app, &first))
        .await
        .unwrap();
    assert!(pending.config.model.is_none());
    tokio::time::timeout(Duration::from_secs(1), async {
        prompt(&app, &second, "independent").await;
        wait_finished(&mut events).await;
    })
    .await
    .unwrap();
    tokio::fs::write(gate.with_extension("release"), b"release")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), &mut ordered)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let result = app
        .operation_result(&operation, &command)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let state = inspect(&app, &first).await;
    assert_eq!(state.config.model.as_ref().unwrap().as_str(), "other");
    assert_eq!(state.config.mode.as_ref().unwrap().as_str(), "high");
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        serde_json::to_string(&replay).unwrap()
    );
    assert_eq!(inspect(&app, &first).await.revision, state.revision);
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
    }
    let calls = tokio::fs::read_to_string(trace)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Trace>(line).unwrap())
        .filter(|entry| entry.method == "session/set_config_option")
        .count();
    assert_eq!(calls, 1);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn normal_pool_saturation_preserves_query_and_control_reserves_and_fifo_lanes() {
    let (app, root) = app();
    let first = create(&app).await;
    let other = create(&app).await;
    let (entered, started) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    app.ingress
        .submit(Request::Test {
            lane: Some(first.clone()),
            pool: 0,
            job: Box::pin(async move {
                let _ = entered.send(());
                let _ = wait.await;
            }),
        })
        .unwrap();
    started.await.unwrap();
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    for index in 0..63 {
        let order = order.clone();
        app.ingress
            .submit(Request::Test {
                lane: Some(first.clone()),
                pool: 0,
                job: Box::pin(async move {
                    order.lock().unwrap().push(index);
                }),
            })
            .unwrap();
    }
    assert!(matches!(
        app.command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap()
        })
        .await,
        Err(DomainError::Backpressure)
    ));
    let snapshot = tokio::time::timeout(Duration::from_secs(1), inspect(&app, &first))
        .await
        .unwrap();
    assert!(snapshot.active_turn.is_none());
    assert!(matches!(
        tokio::time::timeout(
            Duration::from_secs(1),
            app.command(DomainCommand::Cancel { session: other })
        )
        .await
        .unwrap(),
        Ok(CommandReceipt::Accepted { .. })
    ));
    assert!(order.lock().unwrap().is_empty());
    release.send(()).unwrap();
    wait_for(|| order.lock().unwrap().len() == 63).await;
    assert_eq!(*order.lock().unwrap(), (0..63).collect::<Vec<_>>());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn cancelled_shutdown_caller_does_not_detach_root_or_release_storage_early() {
    let (app, root) = app();
    let (entered, started) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    app.ingress
        .submit(Request::Test {
            lane: None,
            pool: 0,
            job: Box::pin(async move {
                let _ = entered.send(());
                let _ = wait.await;
            }),
        })
        .unwrap();
    started.await.unwrap();
    let shutdown = {
        let app = app.clone();
        tokio::spawn(async move { app.shutdown_checked().await })
    };
    wait_for(|| app.core.closed.load(Ordering::Acquire)).await;
    shutdown.abort();
    let _ = shutdown.await;
    assert!(crate::persistence::format::StorageLease::lock(&root).is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), app.shutdown_checked())
        .await
        .unwrap()
        .unwrap();
    assert!(crate::persistence::format::StorageLease::lock(&root).is_ok());
    assert!(app.command(DomainCommand::ListSessions).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn root_abort_preserves_accepted_execution_and_shutdown_retries_join_it_before_releasing_lease(
) {
    let (app, root) = app();
    let (entered, started) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let (completed, done) = oneshot::channel();
    app.ingress
        .submit(Request::Test {
            lane: None,
            pool: 0,
            job: Box::pin(async move {
                let _ = entered.send(());
                let _ = wait.await;
                let _ = completed.send(());
            }),
        })
        .unwrap();
    started.await.unwrap();
    app.ingress.abort_root().await;
    assert!(
        tokio::time::timeout(Duration::from_secs(1), app.wait_closed())
            .await
            .unwrap()
            .is_err()
    );
    let shutdown = {
        let app = app.clone();
        tokio::spawn(async move { app.shutdown_checked().await })
    };
    wait_for(|| app.core.closed.load(Ordering::Acquire)).await;
    shutdown.abort();
    let _ = shutdown.await;
    assert!(crate::persistence::format::StorageLease::lock(&root).is_err());
    release.send(()).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), app.shutdown_checked())
            .await
            .unwrap()
            .is_err()
    );
    done.await.unwrap();
    assert!(crate::persistence::format::StorageLease::lock(&root).is_ok());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn root_abort_during_adapter_drain_joins_protocol_owners_outside_map_and_settles_accepted_config(
) {
    let root = std::env::temp_dir().join(format!("workbench-drain-{}", uuid::Uuid::new_v4()));
    let gate = root.join("configure");
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_CONFIG_GATE".into(),
            gate.to_string_lossy().into_owned(),
        )]),
    );
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "ready").await;
    wait_finished(&mut events).await;
    let caller = {
        let app = app.clone();
        let id = id.clone();
        tokio::spawn(async move {
            app.command(DomainCommand::SetModel {
                session: id,
                model: crate::domain::ModelId::new("other").unwrap(),
            })
            .await
        })
    };
    wait_for(|| gate.with_extension("started").exists()).await;
    let shutdown = {
        let app = app.clone();
        tokio::spawn(async move { app.shutdown_checked().await })
    };
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if app.core.coordinator.adapters.lock().await.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    app.ingress.abort_root().await;
    assert!(tokio::time::timeout(Duration::from_secs(4), shutdown)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(caller.await.unwrap().is_err());
    assert!(crate::persistence::format::StorageLease::lock(&root).is_ok());
    let reopened = SessionStore::fixture(&root);
    let state = reopened.database().view(id.clone()).await.unwrap();
    assert!(state.active_turn.is_none());
    reopened.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn owned_task_panic_is_fatal_and_cleanup_retains_lease_until_host_shutdown() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "permission").await;
    wait_interaction(&mut events).await;
    app.ingress
        .submit(Request::Test {
            lane: None,
            pool: 0,
            job: Box::pin(async { panic!("fixture ingress task panic") }),
        })
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(4), app.wait_closed())
            .await
            .unwrap()
            .is_err()
    );
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    assert!(app.command(DomainCommand::ListSessions).await.is_err());
    assert!(crate::persistence::format::StorageLease::lock(&root).is_err());
    assert!(app.shutdown_checked().await.is_err());
    assert!(crate::persistence::format::StorageLease::lock(&root).is_ok());
    let reopened = SessionStore::fixture(&root);
    let state = reopened.database().view(id).await.unwrap();
    assert!(state.active_turn.is_none() && state.pending_interactions.is_empty());
    reopened.payloads.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn settings_after_failed_worker_commit_cold_preferences_and_resume_without_stale_mailbox() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "ready").await;
    wait_finished(&mut events).await;
    let native = inspect(&app, &id).await.provider_session;
    prompt(&app, &id, "crash").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let closed = app
                .core
                .coordinator
                .adapters
                .lock()
                .await
                .get(&id)
                .is_some_and(|handle| handle.tx.is_closed());
            if closed && matches!(inspect(&app, &id).await.status, SessionStatus::Failed(_)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    for command in [
        DomainCommand::SetModel {
            session: id.clone(),
            model: crate::domain::ModelId::new("other").unwrap(),
        },
        DomainCommand::SetMode {
            session: id.clone(),
            mode: crate::domain::ModeId::new("high").unwrap(),
        },
    ] {
        let operation = crate::domain::OperationId::generate();
        let first = app
            .command_durable(operation.clone(), command.clone())
            .await
            .unwrap();
        let replay = app.command_durable(operation, command).await.unwrap();
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(replay).unwrap()
        );
    }
    let state = inspect(&app, &id).await;
    assert_eq!(state.config.model.as_ref().unwrap().as_str(), "other");
    assert_eq!(state.config.mode.as_ref().unwrap().as_str(), "high");
    assert!(state.configuration_intent.is_none());
    assert!(app
        .core
        .coordinator
        .adapters
        .lock()
        .await
        .get(&id)
        .unwrap()
        .tx
        .is_closed());
    let mut resumed = app.subscribe();
    prompt(&app, &id, "after configuration recovery").await;
    wait_finished(&mut resumed).await;
    let state = inspect(&app, &id).await;
    assert_eq!(state.provider_session, native);
    assert_eq!(
        state.catalogue.current_model.as_ref().unwrap().as_str(),
        "other"
    );
    assert_eq!(
        state.catalogue.current_mode.as_ref().unwrap().as_str(),
        "high"
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
