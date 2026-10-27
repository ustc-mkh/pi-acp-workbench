use super::*;
use crate::domain::interaction::{InteractionAnswer, InteractionResponse};

async fn inspect(app: &WorkbenchApp, id: &SessionId) -> SessionView {
    inspect_view(app, id).await
}

#[tokio::test]
async fn committed_answer_with_missing_or_full_adapter_fails_turn_joins_adapter_and_replays_acceptance(
) {
    for full in [false, true] {
        let (app, root) = app();
        let id = create(&app).await;
        let mut events = app.subscribe();
        prompt(&app, &id, "permission").await;
        let interaction = wait_interaction(&mut events).await;
        let old = app
            .core
            .coordinator
            .adapters
            .lock()
            .await
            .remove(&id)
            .unwrap();
        old.stop().await;
        let answer = InteractionAnswer {
            interaction: interaction.id,
            response: InteractionResponse::Permission {
                option: "yes".into(),
            },
        };
        if full {
            let (tx, rx) = mpsc::channel(1);
            tx.try_send(AdapterCommand::Answer(answer.clone()))
                .unwrap_or_else(|_| panic!("fixture queue"));
            let stop = CancellationToken::new();
            let task_stop = stop.clone();
            let task = app
                .core
                .coordinator
                .tasks
                .spawn(async move {
                    task_stop.cancelled().await;
                    drop(rx);
                })
                .unwrap();
            app.core.coordinator.adapters.lock().await.insert(
                id.clone(),
                super::super::AdapterHandle {
                    registry: app.runtime.registry.clone(),
                    session: id.clone(),
                    epoch: 1,
                    _workspace_lease: None,
                    tx,
                    stop,
                    worker_completion: task.clone(),
                    resumable: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    background_safe: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    pins: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                    last_used: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                    last_user_input_at: 0,
                    resident_since: 0,
                    context_revision: None,
                    task,
                },
            );
        }
        let operation = crate::domain::OperationId::generate();
        let command = DomainCommand::AnswerInteraction {
            session: id.clone(),
            answer,
        };
        let accepted = app
            .command_durable(operation.clone(), command.clone())
            .await
            .unwrap();
        assert!(matches!(accepted, CommandReceipt::Accepted { .. }));
        assert!(!app.core.coordinator.adapters.lock().await.contains_key(&id));
        let failed = inspect(&app, &id).await;
        assert!(matches!(failed.status, SessionStatus::Failed(_)));
        assert!(failed.active_turn.is_none());
        assert!(failed.pending_interactions.is_empty());
        assert!(matches!(
            app.command_durable(operation, command).await.unwrap(),
            CommandReceipt::Accepted { .. }
        ));
        assert_eq!(inspect(&app, &id).await.revision, failed.revision);
        let mut saw_failure = false;
        while let Ok(event) = events.try_recv() {
            saw_failure |= event
                .view
                .is_some_and(|view| matches!(view.status, SessionStatus::Failed(_)));
        }
        assert!(saw_failure);
        prompt(&app, &id, "replacement after failed answer").await;
        wait_finished(&mut events).await;
        app.shutdown().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}

#[tokio::test]
async fn provider_rpc_error_description_cannot_escape_into_domain_or_persisted_history() {
    let (app, root) = app();
    let id = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &id, "rpc-error-secret").await;
    let error = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(view) = events.recv().await.unwrap().view {
                if let SessionStatus::Failed(error) = view.status {
                    break error;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(error.contains("session/prompt"));
    assert!(!error.contains("SENSITIVE_PROVIDER_DESCRIPTION"));
    let persisted = inspect_view(&app, &id).await;
    assert!(!serde_json::to_string(&persisted)
        .unwrap()
        .contains("SENSITIVE_PROVIDER_DESCRIPTION"));
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
