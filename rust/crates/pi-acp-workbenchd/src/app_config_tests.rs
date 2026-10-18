use super::*;
use crate::{domain::SessionState, persistence::interface::SessionPersistence};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
struct FailPreferenceCommit {
    history: HistoryStore,
    fail: Arc<AtomicBool>,
}
impl SessionPersistence for FailPreferenceCommit {
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
    async fn commit(&self, state: &SessionState, events: &[DomainEvent]) -> Result<(), String> {
        if state
            .config
            .model
            .as_ref()
            .is_some_and(|id| id.as_str() == "other")
            && self.fail.swap(false, Ordering::AcqRel)
        {
            return Err("fixture preference commit failure".into());
        }
        self.history.commit(state, events).await
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
                    model: Some(crate::domain::ModelId::new("other").unwrap()),
                    mode: None,
                },
                restore: crate::domain::session::SessionConfig {
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
            if matches!(
                events.recv().await.unwrap(),
                DomainEvent::SessionError { .. }
            ) {
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
    let fail = Arc::new(AtomicBool::new(true));
    let app = WorkbenchApp::start(config_at(&root, env.clone()), |history, mailbox| {
        Runtime::start(FailPreferenceCommit { history, fail }, mailbox)
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
    assert!(matches!(
        app.command_durable(operation.clone(), command.clone())
            .await,
        Err(DomainError::Persistence(_))
    ));
    assert_eq!(tokio::fs::read_to_string(&native).await.unwrap(), "other");
    assert!(!app.core.adapters.lock().await.contains_key(&id));
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
    let persisted = app
        .core
        .history
        .clone()
        .load(id.as_str())
        .await
        .unwrap()
        .unwrap();
    assert!(persisted.configuration_intent.is_some());
    let app = app_at_with_env(&root, env);
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
