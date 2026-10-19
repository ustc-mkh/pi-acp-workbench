use super::*;

async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
}
async fn wait_failed(events: &mut broadcast::Receiver<CommitBatch>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(view) = events.recv().await.unwrap().view {
                match view.status {
                    SessionStatus::Failed(_) => break,
                    SessionStatus::Idle if view.active_turn.is_none() => {
                        panic!("foreign notification was accepted as successful turn")
                    }
                    _ => {}
                }
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn load_drains_three_thousand_replay_updates_and_cancels_old_interactions_before_new_prompt()
{
    let root = std::env::temp_dir().join(format!("workbench-replay-{}", uuid::Uuid::new_v4()));
    let trace = root.join("trace.ndjson");
    let env = std::collections::HashMap::from([
        ("WORKBENCH_CONTRACT_REPLAY_UPDATES".into(), "1000".into()),
        ("WORKBENCH_CONTRACT_REPLAY_INTERACTION".into(), "1".into()),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
    ]);
    let first = app_at_with_env(&root, env.clone());
    let id = create(&first).await;
    let mut events = first.subscribe();
    prompt(&first, &id, "before replay").await;
    wait_finished(&mut events).await;
    let before = inspect(&first, &id).await;
    first.shutdown().await;
    let second = app_at_with_env(&root, env);
    second
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = second.subscribe();
    prompt(&second, &id, "after replay").await;
    wait_finished(&mut events).await;
    let after = inspect(&second, &id).await;
    assert_eq!(before.provider_session, after.provider_session);
    assert_eq!(after.last_entry_seq.get(), before.last_entry_seq.get() + 2);
    assert!(!history_text(&second, &id)
        .await
        .iter()
        .any(|text| text.starts_with("replayed") || text.starts_with("old user")));
    assert!(after.pending_interactions.is_empty());
    assert!(after.plan.items.is_empty());
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        id: Option<String>,
        outcome: Option<String>,
        action: Option<String>,
    }
    let records: Vec<Trace> = tokio::fs::read_to_string(trace)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        records
            .iter()
            .filter(|record| record.method == "session/prompt")
            .count(),
        2
    );
    assert!(records
        .iter()
        .any(|record| record.id.as_deref() == Some("replay-permission")
            && record.outcome.as_deref() == Some("cancelled")));
    assert!(records
        .iter()
        .any(|record| record.id.as_deref() == Some("replay-form")
            && record.action.as_deref() == Some("cancel")));
    second.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn load_omission_and_empty_replay_preserve_catalogue_even_through_pre_prompt_configuration() {
    for policy in ["omit", "empty"] {
        let root =
            std::env::temp_dir().join(format!("workbench-catalogue-{}", uuid::Uuid::new_v4()));
        let first = app_at(&root);
        let id = create(&first).await;
        let mut events = first.subscribe();
        prompt(&first, &id, "catalogue-update").await;
        wait_finished(&mut events).await;
        let before = inspect(&first, &id).await;
        assert_eq!(before.catalogue.models.len(), 2);
        assert_eq!(before.catalogue.commands[0].name, "review");
        first.shutdown().await;
        let second = app_at_with_env(
            &root,
            std::collections::HashMap::from([(
                "WORKBENCH_CONTRACT_LOAD_CATALOGUE".into(),
                policy.into(),
            )]),
        );
        second
            .command(DomainCommand::LoadSession(id.clone()))
            .await
            .unwrap();
        let mut events = second.subscribe();
        prompt(&second, &id, "resumed").await;
        wait_finished(&mut events).await;
        let after = inspect(&second, &id).await;
        assert_eq!(after.catalogue.models, before.catalogue.models);
        assert_eq!(after.catalogue.modes, before.catalogue.modes);
        assert_eq!(after.catalogue.commands, before.catalogue.commands);
        second.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn live_metadata_and_idle_configuration_notifications_preserve_unrelated_fields_but_clear_explicit_lists(
) {
    let root =
        std::env::temp_dir().join(format!("workbench-live-catalogue-{}", uuid::Uuid::new_v4()));
    let app = app_at_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_METADATA_NOTIFICATIONS".into(),
            "1".into(),
        )]),
    );
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "catalogue-update").await;
    wait_finished(&mut events).await;
    let before = inspect(&app, &id).await;
    assert_eq!(
        before.catalogue.current_mode.as_ref().unwrap().as_str(),
        "high"
    );
    assert!(before.config.mode.is_none()); // observation is not a user preference
    assert_eq!(
        before.catalogue.commands[0].input_hint.as_deref(),
        Some("PATH")
    );
    app.command(DomainCommand::SetMode {
        session: id.clone(),
        mode: crate::domain::ModeId::new("low").unwrap(),
    })
    .await
    .unwrap();
    let idle = inspect(&app, &id).await;
    assert_eq!(
        idle.catalogue.current_mode.as_ref().unwrap().as_str(),
        "low"
    );
    assert_eq!(idle.config.mode.as_ref().unwrap().as_str(), "low");
    assert_eq!(idle.catalogue.models, before.catalogue.models);
    assert_eq!(idle.catalogue.commands, before.catalogue.commands);
    prompt(&app, &id, "catalogue-clear").await;
    wait_finished(&mut events).await;
    let cleared = inspect(&app, &id).await;
    assert!(cleared.catalogue.models.is_empty());
    assert!(cleared.catalogue.current_model.is_none());
    assert!(cleared.catalogue.commands.is_empty());
    assert_eq!(cleared.catalogue.modes, before.catalogue.modes);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn foreign_native_session_notification_cannot_append_to_turn_and_worker_can_be_replaced() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "wrong-session").await;
    wait_failed(&mut events).await;
    let failed = inspect(&app, &id).await;
    assert!(matches!(failed.status, SessionStatus::Failed(_)));
    assert!(!history_text(&app, &id)
        .await
        .iter()
        .any(|text| text == "must-not-enter-history"));
    prompt(&app, &id, "recovered").await;
    wait_finished(&mut events).await;
    assert_eq!(
        inspect(&app, &id).await.provider_session,
        failed.provider_session
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn foreign_native_session_notification_during_load_is_rejected_before_dispatching_prompt() {
    let (first, root) = app();
    let id = create(&first).await;
    let mut events = first.subscribe();
    prompt(&first, &id, "original").await;
    wait_finished(&mut events).await;
    let before = inspect(&first, &id).await;
    first.shutdown().await;
    let second = app_at_with_env(
        &root,
        std::collections::HashMap::from([(
            "WORKBENCH_CONTRACT_WRONG_LOAD_SESSION".into(),
            "1".into(),
        )]),
    );
    second
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = second.subscribe();
    prompt(&second, &id, "must not dispatch").await;
    wait_failed(&mut events).await;
    let after = inspect(&second, &id).await;
    assert_eq!(after.provider_session, before.provider_session);
    assert_eq!(after.catalogue, before.catalogue);
    assert_eq!(after.last_entry_seq.get(), before.last_entry_seq.get() + 1);
    second.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
