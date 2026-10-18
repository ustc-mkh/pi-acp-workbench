use super::*;
use crate::{
    config::{LimitsConfig, SessionsConfig, StorageConfig, WorkerConfig, WorkersConfig},
    domain::{Harness, Prompt, SessionStatus, WorkspacePath},
};
use std::{path::PathBuf, time::Duration};

#[path = "app_cancel_tests.rs"]
mod cancel_tests;
#[path = "app_config_tests.rs"]
mod config_tests;
#[path = "app_fault_tests.rs"]
mod fault_tests;
#[path = "app_fork_cancel_tests.rs"]
mod fork_cancel_tests;
#[path = "app_fork_tests.rs"]
mod fork_tests;
#[path = "app_image_tests.rs"]
mod image_tests;
#[path = "app_ingress_tests.rs"]
mod ingress_tests;
#[path = "app_load_tests.rs"]
mod load_tests;
#[path = "app_pi_sdk_tests.rs"]
mod pi_sdk_tests;
#[path = "app_provider_tests.rs"]
mod provider_tests;
#[path = "app_query_tests.rs"]
mod query_tests;
#[path = "app_registry_tests.rs"]
mod registry_tests;
#[path = "app_replay_tests.rs"]
mod replay_tests;

fn app() -> (WorkbenchApp, PathBuf) {
    let root = std::env::temp_dir().join(format!("workbench-app-{}", uuid::Uuid::new_v4()));
    (app_at(&root), root)
}
fn app_at(root: &std::path::Path) -> WorkbenchApp {
    app_at_with_env(root, Default::default())
}
fn app_at_with_env(
    root: &std::path::Path,
    env: std::collections::HashMap<String, String>,
) -> WorkbenchApp {
    WorkbenchApp::new(config_at(root, env)).unwrap()
}
fn config_at(root: &std::path::Path, env: std::collections::HashMap<String, String>) -> Config {
    let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/contract-agent.mjs");
    Config {
        workers: WorkersConfig {
            pi: Some(WorkerConfig {
                command: "node".into(),
                args: vec![peer.to_string_lossy().into_owned()],
                env,
            }),
            ..Default::default()
        },
        sessions: SessionsConfig {
            mailbox: 128,
            max_workers: 16,
        },
        telegram: None,
        storage: StorageConfig {
            root: root.to_path_buf(),
        },
        limits: LimitsConfig {
            pending_interactions: 32,
        },
    }
}
async fn create(app: &WorkbenchApp) -> SessionId {
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
    snapshot.id.clone()
}
async fn wait_finished(events: &mut broadcast::Receiver<DomainEvent>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.unwrap() {
                DomainEvent::TurnFinished { .. } => break,
                DomainEvent::SessionError { error, .. } => panic!("session error: {error}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
}
async fn prompt(app: &WorkbenchApp, session: &SessionId, text: &str) {
    app.command(DomainCommand::Prompt {
        session: session.clone(),
        prompt: Prompt::new(text).unwrap(),
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn restart_loads_same_provider_session_without_replaying_history() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "before restart").await;
    wait_finished(&mut events).await;
    let store = app.core.history.clone();
    let before = store.load(id.as_str()).await.unwrap().unwrap();
    assert!(before.provider_session.is_some());
    app.shutdown().await;
    let restarted = app_at(&root);
    restarted
        .command(DomainCommand::LoadSession(id.clone()))
        .await
        .unwrap();
    let mut events = restarted.subscribe();
    prompt(&restarted, &id, "after restart").await;
    wait_finished(&mut events).await;
    let after = store.load(id.as_str()).await.unwrap().unwrap();
    assert_eq!(after.provider_session, before.provider_session);
    assert_eq!(
        after.transcript.entries.len(),
        before.transcript.entries.len() + 2
    );
    assert_eq!(
        after
            .transcript
            .entries
            .iter()
            .filter(|entry| entry.text == "echo: before restart")
            .count(),
        1
    );
    restarted.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn provider_catalogue_is_exposed_and_live_settings_are_validated() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "catalogue").await;
    wait_finished(&mut events).await;
    let snapshots = app
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &snapshots[0] else {
        panic!("inspect")
    };
    assert!(snapshot
        .catalogue
        .models
        .iter()
        .any(|choice| choice.id.as_str() == "other"));
    assert!(snapshot
        .catalogue
        .modes
        .iter()
        .any(|choice| choice.id.as_str() == "high"));
    app.command(DomainCommand::SetModel {
        session: id.clone(),
        model: crate::domain::ModelId::new("other").unwrap(),
    })
    .await
    .unwrap();
    app.command(DomainCommand::SetMode {
        session: id.clone(),
        mode: crate::domain::ModeId::new("high").unwrap(),
    })
    .await
    .unwrap();
    assert!(app
        .command(DomainCommand::SetModel {
            session: id.clone(),
            model: crate::domain::ModelId::new("invalid-model").unwrap()
        })
        .await
        .is_err());
    prompt(&app, &id, "after settings").await;
    wait_finished(&mut events).await;
    let snapshots = app.command(DomainCommand::Inspect(id)).await.unwrap();
    assert!(matches!(&snapshots[0], DomainEvent::SessionLoaded(snapshot)
        if snapshot.config.model.as_ref().unwrap().as_str() == "other" && snapshot.config.mode.as_ref().unwrap().as_str() == "high"));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn committed_delivery_recovers_without_agent_reexecution_and_survives_session_removal() {
    let (app, root) = app();
    let session = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &session, "durable output").await;
    wait_finished(&mut events).await;
    // No delivery poll has run: simulate stopping between history commit and projection.
    assert!(app
        .delivery_store()
        .pending(0, 16)
        .await
        .unwrap()
        .is_empty());
    app.shutdown().await;
    let restarted = app_at(&root);
    let deliveries = restarted.pending_deliveries(0, 16).await.unwrap();
    assert_eq!(deliveries.len(), 1);
    let crate::persistence::outbox::DeliveryPayload::Entries { entries, .. } =
        &deliveries[0].event.payload
    else {
        panic!("completion reference");
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(
        restarted
            .delivery_payloads()
            .entry(&entries[0])
            .await
            .unwrap()
            .text,
        "echo: durable output"
    );
    restarted
        .command(DomainCommand::RemoveSession(session))
        .await
        .unwrap();
    assert_eq!(
        restarted
            .delivery_payloads()
            .entry(&entries[0])
            .await
            .unwrap()
            .text,
        "echo: durable output"
    );
    restarted
        .delivery_store()
        .ack(&deliveries[0].event.id)
        .await
        .unwrap();
    assert!(restarted
        .pending_deliveries(0, 16)
        .await
        .unwrap()
        .is_empty());
    restarted.shutdown().await;
    let again = app_at(&root);
    assert!(again.pending_deliveries(0, 16).await.unwrap().is_empty());
    again.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn durable_create_replays_original_receipt_after_restart_without_side_effects() {
    let (app, root) = app();
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::CreateSession {
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
    };
    let first = app
        .command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    let repeated = app
        .command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&repeated).unwrap()
    );
    assert!(matches!(
        app.command_durable(operation.clone(), DomainCommand::ListSessions)
            .await,
        Err(DomainError::OperationConflict)
    ));
    app.shutdown().await;
    let restarted = app_at(&root);
    let replayed = restarted.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&replayed).unwrap()
    );
    let events = restarted
        .command(DomainCommand::ListSessions)
        .await
        .unwrap();
    assert!(matches!(&events[0], DomainEvent::SessionsListed(sessions) if sessions.len() == 1));
    restarted.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn app_initializes_worker_and_persists_two_consecutive_turns() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    for text in ["你好", "second"] {
        prompt(&app, &id, text).await;
        wait_finished(&mut events).await;
    }
    let events = app
        .command(DomainCommand::Inspect(id.clone()))
        .await
        .unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    assert!(matches!(snapshot.status, SessionStatus::Idle));
    assert_eq!(
        snapshot
            .transcript
            .entries
            .iter()
            .filter(|entry| entry.text.starts_with("echo:"))
            .count(),
        2
    );
    let history = app
        .core
        .history
        .clone()
        .load(id.as_str())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history.transcript.entries.len(), 4);
    app.shutdown().await;
    assert!(app.command(DomainCommand::ListSessions).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}

async fn wait_interaction(
    events: &mut broadcast::Receiver<DomainEvent>,
) -> crate::domain::interaction::Interaction {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.unwrap() {
                DomainEvent::InteractionRequested { interaction, .. } => break interaction,
                DomainEvent::SessionError { error, .. } => panic!("interaction failed: {error}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn permission_and_form_answers_round_trip_through_domain() {
    use crate::domain::interaction::{InteractionAnswer, InteractionResponse};
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    for (text, answer) in [
        ("permission", "yes"),
        ("elicitation", "其它"),
        ("elicitation-text", "你好"),
    ] {
        prompt(&app, &id, text).await;
        let interaction = wait_interaction(&mut events).await;
        app.command(DomainCommand::AnswerInteraction {
            session: id.clone(),
            answer: InteractionAnswer {
                interaction: interaction.id,
                response: InteractionResponse::Text(answer.into()),
            },
        })
        .await
        .unwrap();
        wait_finished(&mut events).await;
    }
    let events = app.command(DomainCommand::Inspect(id)).await.unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    assert!(snapshot.pending_interactions.is_empty());
    assert!(snapshot
        .transcript
        .entries
        .iter()
        .any(|entry| entry.text.contains("\"question_0\":\"其它\"")));
    assert!(snapshot
        .transcript
        .entries
        .iter()
        .any(|entry| entry.text.contains("\"question_0\":\"你好\"")));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn multiselect_decline_and_cancel_form_responses_are_typed() {
    use crate::domain::interaction::{FieldValue, InteractionAnswer, InteractionResponse};
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    for response in [
        InteractionResponse::Form {
            fields: std::collections::BTreeMap::from([
                (
                    "question_0".into(),
                    FieldValue::Selected(vec!["a:b".into(), "其它".into()]),
                ),
                ("question_1".into(), FieldValue::Text("text".into())),
            ]),
        },
        InteractionResponse::Decline,
        InteractionResponse::Cancel,
    ] {
        prompt(&app, &id, "elicitation-multi").await;
        let interaction = wait_interaction(&mut events).await;
        app.command(DomainCommand::AnswerInteraction {
            session: id.clone(),
            answer: InteractionAnswer {
                interaction: interaction.id,
                response,
            },
        })
        .await
        .unwrap();
        wait_finished(&mut events).await;
    }
    let events = app.command(DomainCommand::Inspect(id)).await.unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    for expected in [
        "\"question_0\":[\"a:b\",\"其它\"]",
        "\"action\":\"decline\"",
        "\"action\":\"cancel\"",
    ] {
        assert!(
            snapshot
                .transcript
                .entries
                .iter()
                .any(|entry| entry.text.contains(expected)),
            "{expected}"
        );
    }
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn worker_crash_is_persisted_and_replacement_resumes_native_session() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "crash").await;
    tokio::time::timeout(Duration::from_secs(5), async {
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
    let store = app.core.history.clone();
    let failed = store.load(id.as_str()).await.unwrap().unwrap();
    assert!(matches!(failed.status, SessionStatus::Failed(_)));
    assert!(failed.active_turn.is_none());
    prompt(&app, &id, "recovered").await;
    wait_finished(&mut events).await;
    let recovered = store.load(id.as_str()).await.unwrap().unwrap();
    assert_eq!(recovered.provider_session, failed.provider_session);
    assert!(matches!(recovered.status, SessionStatus::Idle));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn sixteen_workers_hold_independent_interactions_and_shutdown_joins_them() {
    let (app, root) = app();
    let mut ids = vec![];
    let mut events = app.subscribe();
    for _ in 0..16 {
        let id = create(&app).await;
        prompt(&app, &id, "permission").await;
        wait_interaction(&mut events).await;
        ids.push(id);
    }
    let states = app.command(DomainCommand::ListSessions).await.unwrap();
    let DomainEvent::SessionsListed(states) = &states[0] else {
        panic!("list")
    };
    assert_eq!(states.len(), 16);
    assert!(states
        .iter()
        .all(|state| state.pending_interactions.len() == 1));
    tokio::time::timeout(Duration::from_secs(5), app.shutdown())
        .await
        .unwrap();
    // New intake is closed. On next load, interrupted turns and their interactions
    // are resolved without replaying the permission side effect.
    let restarted = app_at(&root);
    for id in ids {
        let events = restarted
            .command(DomainCommand::LoadSession(id))
            .await
            .unwrap();
        assert!(matches!(&events[0], DomainEvent::SessionLoaded(state)
            if state.pending_interactions.is_empty() && state.active_turn.is_none()));
    }
    restarted.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn cancel_stops_worker_and_next_prompt_uses_replacement() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "wait").await;
    app.command(DomainCommand::Cancel {
        session: id.clone(),
    })
    .await
    .unwrap();
    prompt(&app, &id, "after cancel").await;
    wait_finished(&mut events).await;
    let events = app.command(DomainCommand::Inspect(id)).await.unwrap();
    assert!(matches!(&events[0], DomainEvent::SessionLoaded(snapshot)
        if matches!(snapshot.status, SessionStatus::Idle)
            && snapshot.transcript.entries.iter().any(|entry| entry.text == "echo: after cancel")));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn plan_status_and_context_occupancy_are_projected_without_billing_confusion() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "plan-report").await;
    wait_finished(&mut events).await;
    prompt(&app, &id, "usage-report").await;
    wait_finished(&mut events).await;
    let events = app.command(DomainCommand::Inspect(id)).await.unwrap();
    let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
        panic!("inspect")
    };
    assert!(matches!(
        snapshot.plan.items[0].status,
        crate::domain::plan::PlanStatus::Completed
    ));
    assert!(matches!(
        snapshot.plan.items[1].status,
        crate::domain::plan::PlanStatus::InProgress
    ));
    assert_eq!(snapshot.usage.context_used, Some(500));
    assert_eq!(snapshot.usage.context_size, Some(200_000));
    assert_eq!(snapshot.usage.input_tokens, 100);
    assert_eq!(snapshot.usage.output_tokens, 20);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
