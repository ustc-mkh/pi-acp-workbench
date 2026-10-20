use super::*;
use crate::domain::{
    management::*,
    query::{QueryCommand, QueryResult},
    OperationId,
};
use std::{collections::HashMap, fs};
fn query(group: &str) -> ManagementQuery {
    ManagementQuery {
        group: Some(group.into()),
        from: None,
        to: None,
        session: None,
        model: None,
        cursor: None,
    }
}
async fn data(app: &WorkbenchApp, q: ManagementQuery) -> ManagementData {
    match app
        .query(QueryCommand::Management { query: q })
        .await
        .unwrap()
    {
        QueryResult::Management(data) => data,
        _ => panic!("management"),
    }
}
async fn manage(app: &WorkbenchApp, session: &SessionId, action: ManagementAction) {
    app.command_durable(
        OperationId::generate(),
        DomainCommand::Manage {
            session: session.clone(),
            action,
        },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn management_prices_stats_missing_usage_filters_and_restart_are_cold_and_durable() {
    let root = std::env::temp_dir().join(format!("management-{}", uuid::Uuid::new_v4()));
    let env = HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]);
    let app = app_at_with_env(&root, env.clone());
    let session = create(&app).await;
    manage(
        &app,
        &session,
        ManagementAction::Naming {
            policy: "off".into(),
            model: None,
        },
    )
    .await;
    manage(&app, &session, ManagementAction::RefreshModels).await;
    manage(
        &app,
        &session,
        ManagementAction::Context {
            model: "default".into(),
            context_window: Some(256000),
        },
    )
    .await;
    assert_eq!(
        data(&app, query("model")).await.models[0].context_window,
        Some(256000)
    );
    let mut events = app.subscribe();
    prompt(&app, &session, "usage-complete").await;
    wait_finished(&mut events).await;
    let before = data(&app, query("model")).await;
    let total = before.totals.unwrap();
    assert_eq!(
        (
            total.calls,
            total.input,
            total.output,
            total.cache_read,
            total.cache_write
        ),
        (1, 100, 20, 50, 5)
    );
    assert_eq!(total.missing, 0);
    assert_eq!(total.cache_missing, 0);
    assert!((total.estimated_usd - 0.0001525).abs() < 1e-12);
    let operation = OperationId::generate();
    let command = DomainCommand::Manage {
        session: session.clone(),
        action: ManagementAction::Model {
            model: "default".into(),
            hidden: true,
            price: Some(Price {
                input: 3.0,
                output: 4.0,
                cache_read: 0.2,
                cache_write: 2.0,
            }),
        },
    };
    app.command_durable(operation.clone(), command.clone())
        .await
        .unwrap();
    app.command_durable(operation, command).await.unwrap();
    assert!(
        (data(&app, query("model"))
            .await
            .totals
            .unwrap()
            .estimated_usd
            - 0.0004)
            .abs()
            < 1e-12
    );
    prompt(&app, &session, "missing-usage").await;
    wait_finished(&mut events).await;
    manage(
        &app,
        &session,
        ManagementAction::Rename {
            title: "手动名称".into(),
        },
    )
    .await;
    let filtered = data(
        &app,
        ManagementQuery {
            session: Some(session.clone()),
            ..query("day")
        },
    )
    .await;
    let total = filtered.totals.unwrap();
    assert_eq!(total.calls, 2);
    assert_eq!(total.missing, 1);
    assert_eq!(total.cache_missing, 1);
    assert_eq!(
        data(
            &app,
            ManagementQuery {
                from: Some(0),
                to: Some(1),
                ..query("model")
            }
        )
        .await
        .totals
        .unwrap()
        .calls,
        0
    );
    app.shutdown_checked().await.unwrap();
    let restarted = app_at_with_env(&root, env);
    assert_eq!(
        data(&restarted, query("session"))
            .await
            .totals
            .unwrap()
            .calls,
        2
    );
    let QueryResult::List(list) = restarted
        .query(QueryCommand::List {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("list")
    };
    assert_eq!(list.sessions[0].title.as_deref(), Some("手动名称"));
    assert!(restarted.core.adapters.lock().await.is_empty());
    restarted
        .command(DomainCommand::LoadSession(session.clone()))
        .await
        .unwrap();
    assert_eq!(
        data(&restarted, query("model")).await.totals.unwrap().calls,
        2
    );
    restarted.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn isolated_title_does_not_block_next_prompt_or_overwrite_manual_name_and_counts_once() {
    let root = std::env::temp_dir().join(format!("title-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let gate = root.join("title-release");
    let app = app_at_with_env(
        &root,
        HashMap::from([
            ("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_TITLE_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
        ]),
    );
    let session = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &session, "usage-complete").await;
    wait_finished(&mut events).await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        prompt(&app, &session, "second prompt while title is pending").await;
        wait_finished(&mut events).await;
    })
    .await
    .unwrap();
    manage(
        &app,
        &session,
        ManagementAction::Rename {
            title: "Manual wins".into(),
        },
    )
    .await;
    fs::write(gate, "release").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if data(&app, query("model")).await.totals.unwrap().input == 110 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let stats = data(&app, query("model")).await;
    assert_eq!(stats.totals.unwrap().input, 110);
    let QueryResult::List(list) = app
        .query(QueryCommand::List {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("list")
    };
    assert_eq!(list.sessions[0].title.as_deref(), Some("Manual wins"));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn failed_local_settings_transaction_never_publishes_without_its_receipt() {
    let (app, root) = app();
    let session = create(&app).await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_settings_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(FAIL,'receipt failure'); END;").unwrap();
    let operation = OperationId::generate();
    let command = DomainCommand::Manage {
        session: session.clone(),
        action: ManagementAction::Rename {
            title: "must roll back".into(),
        },
    };
    assert!(app
        .command_durable(operation.clone(), command.clone())
        .await
        .is_err());
    let count: i64 = sql
        .query_row(
            "SELECT count(*) FROM session_metadata WHERE session=?1",
            [session.as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    sql.execute_batch("DROP TRIGGER reject_settings_receipt")
        .unwrap();
    drop(sql);
    assert!(matches!(
        app.command_durable(operation, command).await,
        Err(crate::domain::error::DomainError::OperationInterrupted)
    ));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn provider_context_settlement_loss_is_uncertain_and_never_reissued() {
    let root = std::env::temp_dir().join(format!("context-uncertain-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let trace = root.join("trace");
    let env = HashMap::from([
        ("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into()),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
    ]);
    let app = app_at_with_env(&root, env.clone());
    let session = create(&app).await;
    manage(&app, &session, ManagementAction::RefreshModels).await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER lose_context_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(FAIL,'settlement failure'); END;").unwrap();
    let operation = OperationId::generate();
    let command = DomainCommand::Manage {
        session: session.clone(),
        action: ManagementAction::Context {
            model: "default".into(),
            context_window: Some(256000),
        },
    };
    assert!(app
        .command_durable(operation.clone(), command.clone())
        .await
        .is_err());
    sql.execute_batch("DROP TRIGGER lose_context_receipt")
        .unwrap();
    drop(sql);
    assert_eq!(
        data(&app, query("model")).await.models[0].context_window,
        Some(256000)
    );
    app.shutdown_checked().await.unwrap();
    let before = fs::read(&trace).unwrap();
    let restarted = app_at_with_env(&root, env);
    assert!(matches!(
        restarted.command_durable(operation, command).await,
        Err(crate::domain::error::DomainError::OperationInterrupted)
    ));
    assert_eq!(fs::read(&trace).unwrap(), before);
    assert!(restarted.core.adapters.lock().await.is_empty());
    restarted.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn statistics_keyset_pages_keep_filtered_totals_without_hydrating_records() {
    let (app, root) = app();
    let session = create(&app).await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    for i in 0..205 {
        sql.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at,input,output,cache_read,cache_write,source) VALUES(?1,?2,1,'Pi',?1,'inference',10,1,2,3,4,'fixture')",rusqlite::params![format!("model-{i:03}"),session.as_str()]).unwrap();
    }
    drop(sql);
    let mut q = query("model");
    let mut keys = vec![];
    loop {
        let page = data(&app, q.clone()).await;
        assert!(page.groups.len() <= 100);
        assert_eq!(page.totals.unwrap().calls, 205);
        keys.extend(page.groups.into_iter().map(|g| g.key));
        if let Some(cursor) = page.next_cursor {
            q.cursor = Some(cursor)
        } else {
            break;
        }
    }
    assert_eq!(keys.len(), 205);
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
    assert!(app.core.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn native_fork_and_native_load_do_not_duplicate_inherited_usage() {
    let root = std::env::temp_dir().join(format!("stats-fork-{}", uuid::Uuid::new_v4()));
    let app = WorkbenchApp::new(super::fork_tests::native_config(&root)).unwrap();
    let source = create(&app).await;
    let mut events = app.subscribe();
    prompt(&app, &source, "streamed-message").await;
    wait_finished(&mut events).await;
    let QueryResult::History(page) = app
        .query(QueryCommand::History {
            session: source.clone(),
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("history")
    };
    let receipt = app
        .command(DomainCommand::Fork {
            session: source.clone(),
            request: crate::domain::fork::ForkRequest {
                entry: page.entries.last().unwrap().id.clone(),
            },
        })
        .await
        .unwrap();
    let CommandReceipt::Forked { summary } = receipt else {
        panic!("fork")
    };
    assert_eq!(data(&app, query("model")).await.totals.unwrap().calls, 1);
    app.command(DomainCommand::LoadSession(summary.id.clone()))
        .await
        .unwrap();
    assert_eq!(data(&app, query("model")).await.totals.unwrap().calls, 1);
    prompt(&app, &summary.id, "usage-complete").await;
    wait_finished(&mut events).await;
    assert_eq!(data(&app, query("model")).await.totals.unwrap().calls, 2);
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
