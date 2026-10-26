use super::*;

async fn discover(app: &WorkbenchApp, id: &SessionId) {
    app.command(DomainCommand::Discover {
        session: id.clone(),
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retention_capacity_uses_user_input_not_discovery_and_resumes_native_history() {
    let root = std::env::temp_dir().join(format!("wb-retention-{}", uuid::Uuid::new_v4()));
    let mut config = config_at(
        &root,
        std::collections::HashMap::from([
            ("WORKBENCH_CONTRACT_AUTONOMOUS".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_NATIVE_STATE".into(),
                root.join("native").to_string_lossy().into_owned(),
            ),
        ]),
    );
    config.sessions.max_workers = 2;
    let app = WorkbenchApp::new(config).unwrap();
    let first = create(&app).await;
    let second = create(&app).await;
    let third = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &first, "first input").await;
    wait_finished(&mut events).await;
    let native = inspect_view(&app, &first).await.provider_session;
    prompt(&app, &second, "second input").await;
    wait_finished(&mut events).await;
    let order = app.core.coordinator.adapters.lock().await[&first]
        .last_used
        .load(Ordering::Relaxed);
    discover(&app, &first).await;
    assert_eq!(
        app.core.coordinator.adapters.lock().await[&first]
            .last_used
            .load(Ordering::Relaxed),
        order
    );
    let saved = history_text(&app, &first).await;
    discover(&app, &third).await;
    {
        let adapters = app.core.coordinator.adapters.lock().await;
        assert_eq!(adapters.len(), 2);
        assert!(
            !adapters.contains_key(&first),
            "viewing must not make the oldest input recent"
        );
        assert!(adapters.contains_key(&second));
    }
    assert_eq!(history_text(&app, &first).await, saved);
    prompt(&app, &first, "resume once").await;
    wait_finished(&mut events).await;
    assert_eq!(inspect_view(&app, &first).await.provider_session, native);
    let history = history_text(&app, &first).await;
    assert_eq!(
        history
            .iter()
            .filter(|s| s.as_str() == "resume once")
            .count(),
        1
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn retention_top_eight_expire_at_four_days_others_one_and_busy_is_protected() {
    let (app, root) = app();
    let mut events = app.subscribe();
    let mut ids = Vec::new();
    for _ in 0..9 {
        let id = create(&app).await;
        prompt(&app, &id, "retain me").await;
        wait_finished(&mut events).await;
        ids.push(id);
    }
    let now = super::super::worker_retention::now();
    for handle in app.core.coordinator.adapters.lock().await.values_mut() {
        handle.last_user_input_at = now - 2 * 86400;
    }
    {
        let _admission = app.core.coordinator.admission.lock().await;
        app.core.reclaim_workers(None, true).await.unwrap();
    }
    assert_eq!(app.core.coordinator.adapters.lock().await.len(), 8);
    assert!(!app
        .core
        .coordinator
        .adapters
        .lock()
        .await
        .contains_key(&ids[0]));
    // A real permission blocks retirement even after its retention deadline.
    prompt(&app, &ids[1], "permission").await;
    wait_interaction(&mut events).await;
    for handle in app.core.coordinator.adapters.lock().await.values_mut() {
        handle.last_user_input_at = now - 5 * 86400;
    }
    {
        let _admission = app.core.coordinator.admission.lock().await;
        app.core.reclaim_workers(None, true).await.unwrap();
    }
    assert_eq!(app.core.coordinator.adapters.lock().await.len(), 1);
    assert!(app
        .core
        .coordinator
        .adapters
        .lock()
        .await
        .contains_key(&ids[1]));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn retention_default_sixteen_allows_seventeenth_without_deleting_sessions() {
    let (app, root) = app();
    let mut ids = Vec::new();
    for _ in 0..17 {
        let id = create(&app).await;
        discover(&app, &id).await;
        ids.push(id);
    }
    let adapters = app.core.coordinator.adapters.lock().await;
    assert_eq!(adapters.len(), 16);
    assert!(!adapters.contains_key(&ids[0]));
    assert!(adapters.contains_key(&ids[16]));
    drop(adapters);
    assert!(inspect_view(&app, &ids[0]).await.provider_session.is_some());
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn new_session_discovery_applies_global_model_and_thinking_after_restart() {
    let root = std::env::temp_dir().join(format!("wb-global-prefs-{}", uuid::Uuid::new_v4()));
    let env =
        std::collections::HashMap::from([("WORKBENCH_CONTRACT_TYPED_SETTINGS".into(), "1".into())]);
    let app = app_at_with_env(&root, env.clone());
    let id = create(&app).await;
    discover(&app, &id).await;
    app.command(DomainCommand::SetModel {
        session: id.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetOption {
        session: id,
        id: "thought_level".into(),
        value: "high".into(),
    })
    .await
    .unwrap();
    app.shutdown().await;
    let app = app_at_with_env(&root, env);
    let id = create(&app).await;
    let before = inspect_view(&app, &id).await;
    assert_eq!(before.config.model.as_ref().unwrap().as_str(), "other");
    assert_eq!(
        before
            .config
            .options
            .get("thought_level")
            .map(String::as_str),
        Some("high")
    );
    discover(&app, &id).await;
    let view = inspect_view(&app, &id).await;
    assert_eq!(
        view.catalogue.current_model.as_ref().unwrap().as_str(),
        "other"
    );
    assert_eq!(
        view.catalogue
            .selects
            .iter()
            .find(|s| s.id == "thought_level")
            .unwrap()
            .current_value,
        "high"
    );
    assert!(view.active_turn.is_none());
    assert!(
        history_text(&app, &id).await.is_empty(),
        "loading preferences must not send a prompt"
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn retirement_owner_fence_protects_new_turns_and_rejects_late_worker_events() {
    let (app, root) = app();
    let id = create(&app).await;
    discover(&app, &id).await;
    let epoch = app.core.coordinator.adapters.lock().await[&id].epoch;
    let turn = crate::domain::TurnId::generate();
    app.runtime
        .registry
        .worker_event(id.clone(), epoch, AgentEvent::AutonomousStarted { turn })
        .await
        .unwrap();
    assert!(matches!(
        app.runtime
            .registry
            .retire_idle_worker(id.clone(), epoch)
            .await,
        Err(DomainError::Busy)
    ));
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    discover(&app, &id).await;
    let next = app.core.coordinator.adapters.lock().await[&id].epoch;
    assert_ne!(next, epoch);
    assert!(app
        .runtime
        .registry
        .retire_idle_worker(id.clone(), epoch)
        .await
        .is_err());
    app.runtime
        .registry
        .retire_idle_worker(id.clone(), next)
        .await
        .unwrap();
    let revision = inspect_view(&app, &id).await.revision;
    app.runtime
        .registry
        .worker_event(
            id.clone(),
            next,
            AgentEvent::AutonomousStarted {
                turn: crate::domain::TurnId::generate(),
            },
        )
        .await
        .unwrap();
    let view = inspect_view(&app, &id).await;
    assert!(view.active_turn.is_none());
    assert_eq!(
        view.revision, revision,
        "late events from the retired epoch are ignored"
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn viewing_an_old_session_does_not_replace_global_last_work_preferences() {
    let (app, root) = app();
    let old = create(&app).await;
    discover(&app, &old).await;
    let recent = create(&app).await;
    discover(&app, &recent).await;
    app.command(DomainCommand::SetModel {
        session: recent,
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    discover(&app, &old).await;
    let inherited = create(&app).await;
    assert_eq!(
        inspect_view(&app, &inherited)
            .await
            .config
            .model
            .as_ref()
            .unwrap()
            .as_str(),
        "other"
    );
    let mut events = app.subscribe();
    prompt(&app, &old, "actually work with the default model").await;
    wait_finished(&mut events).await;
    let after = create(&app).await;
    assert_eq!(
        inspect_view(&app, &after)
            .await
            .config
            .model
            .as_ref()
            .unwrap()
            .as_str(),
        "default"
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn retention_restores_input_time_from_durable_records_without_refreshing_it() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "durable activity").await;
    wait_finished(&mut events).await;
    let activity = app.core.database.worker_activity(id.clone()).await.unwrap();
    assert!(activity.0 > 0 && activity.1 > 0);
    app.shutdown().await;
    let app = app_at(&root);
    discover(&app, &id).await;
    let adapters = app.core.coordinator.adapters.lock().await;
    assert_eq!(adapters[&id].last_user_input_at, activity.0);
    assert_eq!(adapters[&id].last_used.load(Ordering::Relaxed), activity.1);
    drop(adapters);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_residency_is_live_cold_short_long_then_released() {
    let (app, root) = app();
    let id = create(&app).await;
    assert_eq!(
        app.list(None, None).await.unwrap().sessions[0].retention_days,
        Some(0)
    );
    discover(&app, &id).await;
    assert_eq!(
        app.list(None, None).await.unwrap().sessions[0].retention_days,
        Some(1)
    );
    let mut events = app.subscribe();
    prompt(&app, &id, "real user input").await;
    wait_finished(&mut events).await;
    assert_eq!(
        app.list(None, None).await.unwrap().sessions[0].retention_days,
        Some(4)
    );
    let saved = history_text(&app, &id).await;
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    assert_eq!(
        app.list(None, None).await.unwrap().sessions[0].retention_days,
        Some(0)
    );
    assert_eq!(history_text(&app, &id).await, saved);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
