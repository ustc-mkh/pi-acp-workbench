use super::*;
use crate::domain::{
    management::ManagementAction, query::OperationStatus, ModeId, ModelId, OperationId,
};

#[tokio::test]
async fn local_noops_seal_receipts_without_revisions_or_batches_and_survive_source_removal() {
    let (app, root) = app();
    let id = create(&app).await;
    let commands = vec![
        DomainCommand::SetModel {
            session: id.clone(),
            model: ModelId::new("default").unwrap(),
        },
        DomainCommand::SetMode {
            session: id.clone(),
            mode: ModeId::new("high").unwrap(),
        },
        DomainCommand::Manage {
            session: id.clone(),
            action: ManagementAction::Rename {
                title: "same title".into(),
            },
        },
        DomainCommand::Manage {
            session: id.clone(),
            action: ManagementAction::Model {
                model: "default".into(),
                hidden: false,
                price: None,
            },
        },
        DomainCommand::Manage {
            session: id.clone(),
            action: ManagementAction::Visibility {
                models: vec!["default".into()],
                hidden: false,
                reset: false,
            },
        },
        DomainCommand::Manage {
            session: id.clone(),
            action: ManagementAction::Naming {
                policy: "off".into(),
                model: None,
            },
        },
    ];
    let mut receipts = Vec::new();
    for command in commands {
        app.command_durable(OperationId::generate(), command.clone())
            .await
            .unwrap();
        let before = inspect_view(&app, &id).await;
        let mut batches = app.subscribe();
        for _ in 0..2 {
            let operation = OperationId::generate();
            let receipt = app
                .command_durable(operation.clone(), command.clone())
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(&receipt).unwrap(),
                serde_json::to_value(CommandReceipt::Accepted {
                    session: id.clone(),
                    revision: before.revision
                })
                .unwrap()
            );
            assert!(matches!(
                app.core.journal.status(operation.clone()).await.unwrap(),
                OperationStatus::Completed { .. }
            ));
            assert_eq!(inspect_view(&app, &id).await.revision, before.revision);
            assert!(matches!(
                batches.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
            receipts.push((operation, command.clone(), receipt));
        }
    }
    app.command(DomainCommand::RemoveSession(id.clone()))
        .await
        .unwrap();
    app.shutdown().await;
    let reopened = app_at(&root);
    for (operation, command, receipt) in receipts {
        let replay = reopened
            .command_durable(operation.clone(), command)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(replay).unwrap(),
            serde_json::to_value(receipt).unwrap()
        );
        assert!(matches!(
            reopened
                .core
                .journal
                .status(operation.clone())
                .await
                .unwrap(),
            OperationStatus::Completed { .. }
        ));
        assert!(matches!(
            reopened
                .command_durable(
                    operation,
                    DomainCommand::SetModel {
                        session: id.clone(),
                        model: ModelId::new("different").unwrap()
                    }
                )
                .await,
            Err(DomainError::OperationConflict)
        ));
    }
    reopened.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn worker_capacity_failure_is_task_state_not_a_failed_prompt_receipt() {
    let root = std::env::temp_dir().join(format!("workbench-p0-capacity-{}", uuid::Uuid::new_v4()));
    let mut config = config_at(&root, Default::default());
    config.sessions.max_workers = 1;
    let app = WorkbenchApp::new(config).unwrap();
    let first = create(&app).await;
    let second = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &first, "occupy slot").await;
    wait_finished(&mut events).await;
    let operation = OperationId::generate();
    let command = DomainCommand::Prompt {
        session: second.clone(),
        prompt: Prompt::new("accepted before capacity failure").unwrap(),
    };
    let receipt = app
        .command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    assert!(matches!(receipt, CommandReceipt::Accepted { .. }));
    let view = inspect_view(&app, &second).await;
    assert!(
        matches!(view.status, SessionStatus::Failed(ref reason) if reason.contains("worker capacity exhausted"))
    );
    assert!(matches!(
        app.core.journal.status(operation.clone()).await.unwrap(),
        OperationStatus::Completed { .. }
    ));
    let replay = app.command_durable(operation, command).await.unwrap();
    assert_eq!(
        serde_json::to_value(replay).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    app.shutdown().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
