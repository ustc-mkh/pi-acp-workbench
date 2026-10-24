use super::*;
use crate::domain::query::{CommandReceipt, QueryCommand, QueryResult};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    process::Command,
};
#[tokio::test]
async fn workspace_net_diff_survives_restart_and_durable_undo_restores_added_deleted_text_and_mode()
{
    let root = std::env::temp_dir().join(format!("workbench-review-flow-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&workspace)
        .status()
        .unwrap()
        .success());
    let modified = workspace.join("modified.txt");
    let deleted = workspace.join("deleted.txt");
    fs::write(&modified, "before\n").unwrap();
    fs::write(&deleted, "delete me\n").unwrap();
    fs::set_permissions(&modified, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Command::new("git")
        .args(["add", "modified.txt", "deleted.txt"])
        .current_dir(&workspace)
        .status()
        .unwrap()
        .success());
    let mut env = HashMap::new();
    env.insert(
        "WORKBENCH_CONTRACT_WORKSPACE_FILE".into(),
        modified.to_string_lossy().into_owned(),
    );
    env.insert(
        "WORKBENCH_CONTRACT_WORKSPACE_DELETE".into(),
        deleted.to_string_lossy().into_owned(),
    );
    env.insert(
        "WORKBENCH_CONTRACT_WORKSPACE_ADD".into(),
        workspace.join("added.txt").to_string_lossy().into_owned(),
    );
    let storage = root.join("storage");
    let app = app_at_with_env(&storage, env.clone());
    let session = match app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new(workspace.to_string_lossy()).unwrap(),
        })
        .await
        .unwrap()
    {
        CommandReceipt::Created { summary } => summary.id,
        _ => panic!("create"),
    };
    let mut events = app.subscribe();
    prompt(&app, &session, "workspace-write").await;
    wait_finished(&mut events).await;
    let history = match app
        .query(QueryCommand::History {
            session: session.clone(),
            cursor: None,
            limit: Some(200),
        })
        .await
        .unwrap()
    {
        QueryResult::History(page) => page,
        _ => panic!("history"),
    };
    let turn = history
        .entries
        .iter()
        .find(|e| e.role == crate::domain::transcript::EntryRole::User)
        .unwrap()
        .turn
        .clone();
    let diff = match app
        .query(QueryCommand::TurnDiff {
            session: session.clone(),
            turn: turn.clone(),
            offset: 0,
        })
        .await
        .unwrap()
    {
        QueryResult::TurnDiff(diff) => diff,
        _ => panic!("diff"),
    };
    assert_eq!(diff.status, crate::workspace_review::DiffStatus::Complete);
    assert_eq!(diff.files.len(), 3);
    let modified_index = diff
        .files
        .iter()
        .position(|f| f.path == "modified.txt")
        .unwrap();
    let before = match app
        .query(QueryCommand::TurnDiffContent {
            session: session.clone(),
            turn: turn.clone(),
            file: modified_index,
            after: false,
            offset: crate::domain::query::SafeInteger::new(0).unwrap(),
        })
        .await
        .unwrap()
    {
        QueryResult::TurnDiffContent(content) => content.bytes,
        _ => panic!("before content"),
    };
    let after = match app
        .query(QueryCommand::TurnDiffContent {
            session: session.clone(),
            turn: turn.clone(),
            file: modified_index,
            after: true,
            offset: crate::domain::query::SafeInteger::new(0).unwrap(),
        })
        .await
        .unwrap()
    {
        QueryResult::TurnDiffContent(content) => content.bytes,
        _ => panic!("after content"),
    };
    assert_eq!(before, "before\n");
    assert_eq!(after, "after\n");
    assert!(diff
        .files
        .iter()
        .any(|f| f.path == "modified.txt" && f.before.is_none() && f.after.is_none()));
    assert!(diff.files.iter().any(
        |f| f.path == "deleted.txt" && f.status == crate::workspace_review::FileStatus::Deleted
    ));
    assert!(diff
        .files
        .iter()
        .any(|f| f.path == "added.txt" && f.status == crate::workspace_review::FileStatus::Added));
    // An idle provider in a nested workspace must still fence undo. It
    // could emit autonomous/background effects even with no active turn.
    let nested = workspace.join("nested");
    fs::create_dir(&nested).unwrap();
    let other = match app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new(nested.to_string_lossy()).unwrap(),
        })
        .await
        .unwrap()
    {
        CommandReceipt::Created { summary } => summary.id,
        _ => panic!("create nested"),
    };
    app.discover_session(other.clone()).await.unwrap();
    assert!(matches!(
        app.command(DomainCommand::UndoTurn {
            session: session.clone(),
            turn: turn.clone(),
            files: None
        })
        .await,
        Err(crate::domain::error::DomainError::Busy)
    ));
    assert_eq!(fs::read_to_string(&modified).unwrap(), "after\n");
    app.command(DomainCommand::RemoveSession(other))
        .await
        .unwrap();
    app.shutdown_checked().await.unwrap();
    let restarted = app_at_with_env(&storage, env);
    let persisted = match restarted
        .query(QueryCommand::TurnDiff {
            session: session.clone(),
            turn: turn.clone(),
            offset: 0,
        })
        .await
        .unwrap()
    {
        QueryResult::TurnDiff(diff) => diff,
        _ => panic!("cold diff"),
    };
    assert_eq!(persisted.files.len(), 3);
    assert!(restarted.core.coordinator.adapters.lock().await.is_empty());
    let operation = crate::domain::OperationId::generate();
    let receipt = restarted
        .command_durable(
            operation.clone(),
            DomainCommand::UndoTurn {
                session: session.clone(),
                turn: turn.clone(),
                files: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(receipt, CommandReceipt::UndoCompleted { .. }));
    assert_eq!(fs::read_to_string(&modified).unwrap(), "before\n");
    assert_eq!(fs::metadata(&modified).unwrap().mode() & 0o777, 0o644);
    assert_eq!(fs::read_to_string(deleted).unwrap(), "delete me\n");
    assert!(!workspace.join("added.txt").exists());
    assert!(matches!(
        restarted
            .command_durable(
                operation,
                DomainCommand::UndoTurn {
                    session: session.clone(),
                    turn: turn.clone(),
                    files: None
                }
            )
            .await
            .unwrap(),
        CommandReceipt::UndoCompleted { .. }
    ));
    assert_eq!(fs::read_to_string(&modified).unwrap(), "before\n");
    restarted
        .command(DomainCommand::RemoveSession(session.clone()))
        .await
        .unwrap();
    let removed = restarted
        .query(QueryCommand::TurnDiff {
            session,
            turn,
            offset: 0,
        })
        .await
        .unwrap();
    assert!(
        matches!(removed, QueryResult::TurnDiff(diff) if diff.status == crate::workspace_review::DiffStatus::Unavailable)
    );
    assert_eq!(fs::read_to_string(&modified).unwrap(), "before\n");
    restarted.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn undo_receipt_loss_stays_uncertain_and_never_replays_after_restart() {
    let root = std::env::temp_dir().join(format!("review-receipt-loss-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&workspace)
        .status()
        .unwrap();
    let file = workspace.join("a");
    fs::write(&file, "before").unwrap();
    let before = crate::workspace_review::Snapshot::capture(&workspace).unwrap();
    fs::write(&file, "after").unwrap();
    let diff = before.diff(&crate::workspace_review::Snapshot::capture(&workspace).unwrap());
    let storage = root.join("storage");
    let app = app_at(&storage);
    let session = match app
        .command(DomainCommand::CreateSession {
            harness: Harness::Pi,
            cwd: WorkspacePath::new(workspace.to_string_lossy()).unwrap(),
        })
        .await
        .unwrap()
    {
        CommandReceipt::Created { summary } => summary.id,
        _ => panic!("create"),
    };
    let turn = crate::domain::TurnId::generate();
    app.core
        .database
        .save_turn_diff(session.clone(), turn.clone(), diff)
        .await
        .unwrap();
    // A real SQLite failure after filesystem publication, not a mocked undo.
    // This has the same durable Started boundary as host loss before settlement.
    let sql = rusqlite::Connection::open(storage.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_undo_settlement BEFORE UPDATE ON operations BEGIN SELECT RAISE(FAIL, 'settlement unavailable'); END;").unwrap();
    let operation = crate::domain::OperationId::generate();
    let command = DomainCommand::UndoTurn {
        session,
        turn,
        files: None,
    };
    assert!(app
        .command_durable(operation.clone(), command.clone())
        .await
        .is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "before");
    sql.execute_batch("DROP TRIGGER fail_undo_settlement")
        .unwrap();
    drop(sql);
    app.shutdown_checked().await.unwrap();
    // If replay were attempted, it would now succeed and change 'after' back
    // to 'before'. The immutable uncertain receipt must prohibit that.
    fs::write(&file, "after").unwrap();
    let restarted = app_at(&storage);
    assert!(matches!(
        restarted.command_durable(operation.clone(), command).await,
        Err(crate::domain::error::DomainError::OperationInterrupted)
    ));
    assert_eq!(fs::read_to_string(&file).unwrap(), "after");
    assert!(matches!(
        restarted
            .query(QueryCommand::Operation { operation })
            .await
            .unwrap(),
        QueryResult::Operation(crate::domain::query::OperationStatus::Uncertain)
    ));
    restarted.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn partial_capture_is_queryable_but_cannot_enter_undo() {
    let root =
        std::env::temp_dir().join(format!("workbench-review-partial-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let partial = crate::workspace_review::Snapshot::unavailable(
        root.clone(),
        "synthetic bounded capture failure".into(),
    );
    let unchanged = crate::workspace_review::Snapshot::unavailable(
        root.clone(),
        "synthetic bounded capture failure".into(),
    );
    let diff = partial.diff(&unchanged);
    assert_eq!(diff.status, crate::workspace_review::DiffStatus::Partial);
    assert!(crate::workspace_undo::undo(&root, &diff, false).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn shell_changes_are_captured_after_cancel_and_provider_crash() {
    for action in ["workspace-write-wait", "workspace-write-crash"] {
        let root = std::env::temp_dir().join(format!("review-terminal-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(&workspace)
            .status()
            .unwrap()
            .success());
        let file = workspace.join("a.txt");
        fs::write(&file, "before\n").unwrap();
        let mut env = HashMap::new();
        env.insert(
            "WORKBENCH_CONTRACT_WORKSPACE_FILE".into(),
            file.to_string_lossy().into_owned(),
        );
        let storage = root.join("storage");
        let app = app_at_with_env(&storage, env.clone());
        let session = match app
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: WorkspacePath::new(workspace.to_string_lossy()).unwrap(),
            })
            .await
            .unwrap()
        {
            CommandReceipt::Created { summary } => summary.id,
            _ => panic!("create"),
        };
        prompt(&app, &session, action).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while fs::read_to_string(&file).unwrap() != "after\n" {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if action.ends_with("wait") {
            app.command(DomainCommand::Cancel {
                session: session.clone(),
            })
            .await
            .unwrap();
        }
        let turn = match app
            .query(QueryCommand::History {
                session: session.clone(),
                cursor: None,
                limit: Some(200),
            })
            .await
            .unwrap()
        {
            QueryResult::History(page) => page
                .entries
                .iter()
                .find(|e| e.role == crate::domain::transcript::EntryRole::User)
                .unwrap()
                .turn
                .clone(),
            _ => panic!("history"),
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let QueryResult::TurnDiff(diff) = app
                    .query(QueryCommand::TurnDiff {
                        session: session.clone(),
                        turn: turn.clone(),
                        offset: 0,
                    })
                    .await
                    .unwrap()
                {
                    if diff.status == crate::workspace_review::DiffStatus::Complete {
                        assert_eq!(diff.files[0].path, "a.txt");
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        app.shutdown_checked().await.unwrap();
        let restarted = app_at_with_env(&storage, env);
        assert!(matches!(
            restarted
                .query(QueryCommand::ValidateUndo {
                    session: session.clone(),
                    turn: turn.clone(),
                    files: None
                })
                .await
                .unwrap(),
            QueryResult::ValidateUndo(_)
        ));
        assert!(restarted.core.coordinator.adapters.lock().await.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "after\n");
        let revision = match restarted
            .query(QueryCommand::Inspect {
                session: session.clone(),
            })
            .await
            .unwrap()
        {
            QueryResult::View(view) => view.revision,
            _ => panic!("view"),
        };
        let summary = restarted
            .delivery_payloads()
            .completion(session.clone(), revision)
            .await
            .unwrap()
            .unwrap();
        assert!(
            summary.contains(if action.ends_with("wait") {
                "Turn cancelled."
            } else {
                "Turn failed."
            }),
            "{summary}"
        );
        assert!(
            summary.contains("Workspace Diff complete") && summary.contains("1 files"),
            "{summary}"
        );
        restarted
            .command(DomainCommand::RemoveSession(session.clone()))
            .await
            .unwrap();
        assert_eq!(
            restarted
                .delivery_payloads()
                .completion(session, revision)
                .await
                .unwrap(),
            Some(summary)
        );
        restarted.shutdown_checked().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
