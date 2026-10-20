use super::*;
use crate::{
    config::{LimitsConfig, SessionsConfig, StorageConfig, WorkerConfig, WorkersConfig},
    domain::{
        query::{QueryCommand, QueryResult, SessionView, TextBody},
        Harness, Prompt, SessionStatus, WorkspacePath,
    },
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
#[path = "app_management_tests.rs"]
mod management_tests;
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
#[path = "app_workspace_review_tests.rs"]
mod workspace_review_tests;
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
    let CommandReceipt::Created { summary } = app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        })
        .await
        .unwrap()
    else {
        panic!("create receipt")
    };
    summary.id
}
async fn inspect_view(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    let QueryResult::View(view) = app
        .query(QueryCommand::Inspect {
            session: id.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("view query")
    };
    *view
}
async fn history_text(app: &WorkbenchApp, id: &SessionId) -> Vec<String> {
    let QueryResult::History(page) = app
        .query(QueryCommand::History {
            session: id.clone(),
            cursor: None,
            limit: Some(200),
        })
        .await
        .unwrap()
    else {
        panic!("history query")
    };
    assert!(
        page.next_cursor.is_none(),
        "fixture unexpectedly requires more pages"
    );
    let mut result = Vec::new();
    for entry in page.entries {
        result.push(match entry.text {
            TextBody::Inline { text } => text,
            TextBody::Archived { content } => {
                app.delivery_payloads().content(&content).await.unwrap()
            }
        });
    }
    result
}
async fn wait_finished(events: &mut broadcast::Receiver<CommitBatch>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut saw_active = false;
        loop {
            let batch = events.recv().await.unwrap();
            if let Some(view) = batch.view {
                saw_active |= view.active_turn.is_some();
                if let SessionStatus::Failed(error) = view.status {
                    panic!("session error: {error}");
                }
                if saw_active
                    && view.active_turn.is_none()
                    && matches!(view.status, SessionStatus::Idle)
                {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
}
async fn wait_interaction(
    events: &mut broadcast::Receiver<CommitBatch>,
) -> crate::domain::interaction::Interaction {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(view) = events.recv().await.unwrap().view {
                if let SessionStatus::Failed(error) = view.status {
                    panic!("interaction failed: {error}");
                }
                if let Some(interaction) = view.pending_interactions.into_values().next() {
                    break interaction;
                }
            }
        }
    })
    .await
    .unwrap()
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
    let before = inspect_view(&app, &id).await;
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
    let after = inspect_view(&restarted, &id).await;
    assert_eq!(after.provider_session, before.provider_session);
    assert_eq!(after.last_entry_seq.get(), before.last_entry_seq.get() + 2);
    assert_eq!(
        history_text(&restarted, &id)
            .await
            .iter()
            .filter(|text| *text == "echo: before restart")
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
    let view = inspect_view(&app, &id).await;
    assert!(view
        .catalogue
        .models
        .iter()
        .any(|choice| choice.id.as_str() == "other"));
    assert!(view
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
    let view = inspect_view(&app, &id).await;
    assert_eq!(view.config.model.unwrap().as_str(), "other");
    assert_eq!(view.config.mode.unwrap().as_str(), "high");
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
    assert_eq!(app.delivery_store().pending(0, 16).await.unwrap().len(), 2);
    app.shutdown().await;
    let restarted = app_at(&root);
    let all = restarted.pending_deliveries(0, 16).await.unwrap();
    assert!(all.iter().any(|record| matches!(
        &record.event.payload,
        crate::persistence::outbox::DeliveryPayload::Input { .. }
    )));
    let input_deliveries: Vec<_> = all
        .iter()
        .filter(|record| {
            matches!(
                &record.event.payload,
                crate::persistence::outbox::DeliveryPayload::Input { .. }
            )
        })
        .cloned()
        .collect();
    assert_eq!(input_deliveries.len(), 1);
    let deliveries: Vec<_> = all
        .into_iter()
        .filter(|record| {
            matches!(
                &record.event.payload,
                crate::persistence::outbox::DeliveryPayload::Turn { .. }
            )
        })
        .collect();
    assert_eq!(deliveries.len(), 1);
    assert!(matches!(
        deliveries[0].event.payload,
        crate::persistence::outbox::DeliveryPayload::Turn { .. }
    ));
    let payloads = restarted.delivery_payloads();
    let page = payloads
        .delivery_page(&deliveries[0].event.id, Default::default())
        .await
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(
        matches!(&page.entries[0].text, TextBody::Inline { text } if text == "echo: durable output")
    );
    restarted
        .command(DomainCommand::RemoveSession(session))
        .await
        .unwrap();
    let after = payloads
        .delivery_page(&deliveries[0].event.id, Default::default())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(page).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    restarted
        .delivery_store()
        .ack(&input_deliveries[0].event.id)
        .await
        .unwrap();
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
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&repeated).unwrap()
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
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(replayed).unwrap()
    );
    assert_eq!(restarted.list(None, None).await.unwrap().sessions.len(), 1);
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
    let view = inspect_view(&app, &id).await;
    assert!(matches!(view.status, SessionStatus::Idle));
    assert_eq!(view.last_entry_seq.get(), 4);
    assert_eq!(
        history_text(&app, &id)
            .await
            .iter()
            .filter(|text| text.starts_with("echo:"))
            .count(),
        2
    );
    app.shutdown().await;
    assert!(app.list(None, None).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
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
    assert!(inspect_view(&app, &id)
        .await
        .pending_interactions
        .is_empty());
    let texts = history_text(&app, &id).await;
    for expected in ["\"question_0\":\"其它\"", "\"question_0\":\"你好\""] {
        assert!(texts.iter().any(|text| text.contains(expected)));
    }
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
    let texts = history_text(&app, &id).await;
    for expected in [
        "\"question_0\":[\"a:b\",\"其它\"]",
        "\"action\":\"decline\"",
        "\"action\":\"cancel\"",
    ] {
        assert!(
            texts.iter().any(|text| text.contains(expected)),
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
    let failed = inspect_view(&app, &id).await;
    assert!(matches!(failed.status, SessionStatus::Failed(_)));
    assert!(failed.active_turn.is_none());
    prompt(&app, &id, "recovered").await;
    wait_finished(&mut events).await;
    let recovered = inspect_view(&app, &id).await;
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
    assert_eq!(app.list(None, None).await.unwrap().sessions.len(), 16);
    for id in &ids {
        assert_eq!(inspect_view(&app, id).await.pending_interactions.len(), 1);
    }
    tokio::time::timeout(Duration::from_secs(5), app.shutdown())
        .await
        .unwrap();
    let restarted = app_at(&root);
    for id in ids {
        let receipt = restarted
            .command(DomainCommand::LoadSession(id))
            .await
            .unwrap();
        let view = receipt.view().unwrap();
        assert!(view.pending_interactions.is_empty() && view.active_turn.is_none());
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
    // Consume the cancel terminal before waiting for the replacement's finish.
    while events.try_recv().is_ok() {}
    prompt(&app, &id, "after cancel").await;
    wait_finished(&mut events).await;
    assert!(matches!(
        inspect_view(&app, &id).await.status,
        SessionStatus::Idle
    ));
    assert!(history_text(&app, &id)
        .await
        .iter()
        .any(|text| text == "echo: after cancel"));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn plan_status_and_context_occupancy_are_projected_without_billing_confusion() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    for text in ["plan-report", "usage-report"] {
        prompt(&app, &id, text).await;
        wait_finished(&mut events).await;
    }
    let view = inspect_view(&app, &id).await;
    assert!(matches!(
        view.plan.items[0].status,
        crate::domain::plan::PlanStatus::Completed
    ));
    assert!(matches!(
        view.plan.items[1].status,
        crate::domain::plan::PlanStatus::InProgress
    ));
    assert_eq!(view.usage.context_used, Some(500));
    assert_eq!(view.usage.context_size, Some(200_000));
    assert_eq!(view.usage.input_tokens, 100);
    assert_eq!(view.usage.output_tokens, 20);
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
