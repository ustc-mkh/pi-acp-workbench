use super::*;
use crate::persistence::interface::SessionPersistence;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct FailPreferenceCommit {
    history: SessionStore,
    fail: Arc<AtomicBool>,
}
impl SessionPersistence for FailPreferenceCommit {
    crate::persistence::interface_test_helpers::delegate_session_queries!();
    async fn commit(
        &self,
        change: crate::domain::transition::Transition,
    ) -> Result<crate::domain::query::CommitBatch, String> {
        if change
            .next
            .config
            .model
            .as_ref()
            .is_some_and(|id| id.as_str() == "other")
            && self.fail.swap(false, Ordering::AcqRel)
        {
            return Err("fixture preference commit failure".into());
        }
        self.history.commit(change).await
    }
}
async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
}
#[tokio::test]
async fn rejected_restore_retains_intent_and_never_dispatches_prompt_until_recovery_succeeds() {
    let root = std::env::temp_dir().join(format!("workbench-reconcile-{}", uuid::Uuid::new_v4()));
    let native = root.join("native-model");
    let trace = root.join("trace.ndjson");
    let mut env = std::collections::HashMap::from([
        (
            "WORKBENCH_CONTRACT_MODEL_STATE".into(),
            native.to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
    ]);
    let app = app_at_with_env(&root, env.clone());
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "ready").await;
    wait_finished(&mut events).await;
    // Synthetic crash prefix: durable intent exists, external native setting
    // changed, but the desired preference has not committed. The other test
    // exercises this exact prefix through a real RPC + injected commit fault.
    app.runtime
        .registry
        .command(DomainCommand::PrepareConfiguration {
            session: id.clone(),
            intent: crate::domain::session::ConfigurationIntent {
                requested: crate::domain::session::SessionConfig {
                    options: Default::default(),
                    model: Some(crate::domain::ModelId::new("other").unwrap()),
                    mode: None,
                },
                restore: crate::domain::session::SessionConfig {
                    options: Default::default(),
                    model: Some(crate::domain::ModelId::new("default").unwrap()),
                    mode: None,
                },
            },
        })
        .await
        .unwrap();
    app.shutdown().await;
    tokio::fs::write(&native, b"other").await.unwrap();
    env.insert("WORKBENCH_CONTRACT_REJECT_MODEL".into(), "default".into());
    let app = app_at_with_env(&root, env.clone());
    app.command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = app.subscribe();
    prompt(&app, &id, "must not reach peer").await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if events
                .recv()
                .await
                .unwrap()
                .view
                .is_some_and(|view| matches!(view.status, SessionStatus::Failed(_)))
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let failed = inspect(&app, &id).await;
    assert!(failed.active_turn.is_none() && failed.configuration_intent.is_some());
    assert_eq!(tokio::fs::read_to_string(&native).await.unwrap(), "other");
    assert!(!tokio::fs::read_to_string(&trace)
        .await
        .unwrap()
        .contains("must not reach peer"));
    app.shutdown().await;
    env.remove("WORKBENCH_CONTRACT_REJECT_MODEL");
    let app = app_at_with_env(&root, env);
    app.command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = app.subscribe();
    prompt(&app, &id, "recovered").await;
    wait_finished(&mut events).await;
    assert!(inspect(&app, &id).await.configuration_intent.is_none());
    assert_eq!(tokio::fs::read_to_string(&native).await.unwrap(), "default");
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn successful_remote_setting_with_failed_local_commit_retains_intent_and_restores_before_resumed_prompt(
) {
    let root = std::env::temp_dir().join(format!("workbench-config-{}", uuid::Uuid::new_v4()));
    let native = root.join("native-model");
    let trace = root.join("trace.ndjson");
    let env = std::collections::HashMap::from([
        (
            "WORKBENCH_CONTRACT_MODEL_STATE".into(),
            native.to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
    ]);
    let fail = Arc::new(AtomicBool::new(false));
    let app = WorkbenchApp::start(config_at(&root, env.clone()), |history, mailbox| {
        Runtime::start(
            FailPreferenceCommit {
                history,
                fail: fail.clone(),
            },
            mailbox,
        )
    })
    .unwrap();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "ready").await;
    wait_finished(&mut events).await;
    let original = inspect(&app, &id).await;
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::SetModel {
        session: id.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    };
    fail.store(true, Ordering::Release);
    assert!(matches!(
        app.command_durable(operation.clone(), command.clone())
            .await,
        Err(DomainError::Persistence(_))
    ));
    assert_eq!(tokio::fs::read_to_string(&native).await.unwrap(), "other");
    assert!(!app.core.coordinator.adapters.lock().await.contains_key(&id));
    let pending = inspect(&app, &id).await;
    assert_eq!(pending.config, original.config);
    assert_eq!(
        pending
            .configuration_intent
            .as_ref()
            .unwrap()
            .restore
            .model
            .as_ref()
            .unwrap()
            .as_str(),
        "default"
    );
    let revision = pending.revision;
    assert!(app
        .command_durable(operation.clone(), command.clone())
        .await
        .is_err());
    assert_eq!(inspect(&app, &id).await.revision, revision);
    app.shutdown().await;
    let app = app_at_with_env(&root, env.clone());
    let persisted = inspect_view(&app, &id).await;
    assert!(persisted.configuration_intent.is_some());
    app.command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = app.subscribe();
    prompt(&app, &id, "after reconciliation").await;
    wait_finished(&mut events).await;
    let recovered = inspect(&app, &id).await;
    assert_eq!(recovered.provider_session, original.provider_session);
    assert_eq!(recovered.config, original.config);
    assert!(recovered.configuration_intent.is_none());
    assert_eq!(
        recovered.catalogue.current_model.as_ref().unwrap().as_str(),
        "default"
    );
    assert_eq!(tokio::fs::read_to_string(&native).await.unwrap(), "default");
    assert!(app.command_durable(operation, command).await.is_err());
    #[derive(serde::Deserialize)]
    struct Trace {
        method: String,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        text: Option<String>,
    }
    let records: Vec<Trace> = tokio::fs::read_to_string(trace)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let settings: Vec<&str> = records
        .iter()
        .filter(|entry| entry.method == "session/set_config_option")
        .map(|entry| entry.value.as_deref().unwrap())
        .collect();
    assert_eq!(settings, ["other", "default"]);
    let restored = records
        .iter()
        .position(|entry| entry.value.as_deref() == Some("default"))
        .unwrap();
    let resumed = records
        .iter()
        .position(|entry| entry.text.as_deref() == Some("after reconciliation"))
        .unwrap();
    assert!(restored < resumed);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
