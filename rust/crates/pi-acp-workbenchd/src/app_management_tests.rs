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
async fn history_search_cursor_is_filter_bound_and_clear_jobs_resume_in_bounded_batches() {
    use crate::domain::query::{QueryCommand, QueryResult, SessionFilter};
    let root = std::env::temp_dir().join(format!("clear-history-{}", uuid::Uuid::new_v4()));
    let env = HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]);
    let app = app_at_with_env(&root, env);
    let first = create(&app).await;
    let _second = create(&app).await;
    for _ in 0..10 {
        let _ = create(&app).await;
    }
    let filter = SessionFilter {
        text: "__definitely_not_present__".into(),
        harness: None,
    };
    let page = app
        .query(QueryCommand::Search {
            filter: filter.clone(),
            cursor: None,
            limit: Some(1),
        })
        .await
        .unwrap();
    assert!(
        matches!(page, QueryResult::List(ref p) if p.sessions.is_empty() && p.next_cursor.is_none())
    );
    let filter = SessionFilter {
        text: String::new(),
        harness: None,
    };
    let page = app
        .query(QueryCommand::Search {
            filter: filter.clone(),
            cursor: None,
            limit: Some(1),
        })
        .await
        .unwrap();
    let cursor = match page {
        QueryResult::List(p) => p.next_cursor.unwrap(),
        _ => panic!("search"),
    };
    assert_eq!(cursor.filter.as_ref(), Some(&filter));
    assert!(app
        .query(QueryCommand::Search {
            filter: SessionFilter {
                text: "Pi".into(),
                harness: None
            },
            cursor: Some(cursor),
            limit: Some(1)
        })
        .await
        .is_err());
    app.delivery_store()
        .enqueue(crate::domain::transition::DeliveryIntent {
            id: crate::domain::DeliveryId::generate(),
            revision: crate::domain::query::SafeInteger::new(1).unwrap(),
            target: crate::domain::transition::DeliveryTarget::Session {
                session: first.clone(),
                cwd: crate::domain::WorkspacePath::new(root.to_string_lossy()).unwrap(),
            },
            payload: crate::domain::transition::DeliveryPayload::Image {
                image: crate::domain::ImageId::generate(),
            },
        })
        .await
        .unwrap();
    let operation = OperationId::generate();
    let preview = app
        .command_durable(
            operation.clone(),
            DomainCommand::PrepareHistoryClear { filter },
        )
        .await
        .unwrap();
    let job = match preview {
        CommandReceipt::HistoryClear { report } => {
            assert!(report.preview);
            assert_eq!(report.total, 12);
            assert_eq!(report.pending_deliveries, 1);
            report.job
        }
        _ => panic!("preview"),
    };
    let batch = app
        .command_durable(
            OperationId::generate(),
            DomainCommand::ClearHistoryBatch { job: job.clone() },
        )
        .await
        .unwrap();
    assert!(
        matches!(&batch, CommandReceipt::HistoryClear { report } if !report.preview && report.remaining == 2),
        "batch receipt: {batch:?}"
    );
    let next = app
        .command_durable(
            OperationId::generate(),
            DomainCommand::ClearHistoryBatch { job },
        )
        .await
        .unwrap();
    assert!(matches!(next, CommandReceipt::HistoryClear { report } if report.remaining == 0));
    assert!(matches!(
        app.command(DomainCommand::Inspect(first)).await,
        Err(crate::domain::error::DomainError::NotFound(_))
    ));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn profile_metadata_refresh_preserves_overrides_and_a_running_session() {
    let root = std::env::temp_dir().join(format!("profile-model-live-{}", uuid::Uuid::new_v4()));
    let mut config = config_at(
        &root,
        HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]),
    );
    config.sessions.max_workers = 1;
    let app = WorkbenchApp::new(config).unwrap();
    let session = create(&app).await;
    manage(
        &app,
        &session,
        ManagementAction::Context {
            model: "default".into(),
            context_window: Some(256000),
        },
    )
    .await;
    manage(
        &app,
        &session,
        ManagementAction::Model {
            model: "default".into(),
            hidden: true,
            price: Some(Price {
                input: 3.0,
                output: 4.0,
                cache_read: 0.2,
                cache_write: 2.0,
            }),
        },
    )
    .await;
    let mut events = app.subscribe();
    prompt(&app, &session, "permission").await;
    wait_interaction(&mut events).await;
    let before = inspect_view(&app, &session).await;
    app.refresh_model_defaults().await.unwrap();
    let after = inspect_view(&app, &session).await;
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&after).unwrap()
    );
    let model = data(&app, query("model")).await.models.remove(0);
    assert_eq!(model.default_price.unwrap().input, 1.0);
    assert_eq!(model.price.unwrap().input, 3.0);
    assert_eq!(model.default_context_window, Some(200000));
    assert_eq!(model.context_window, Some(256000));
    assert!(model.hidden);
    assert_eq!(app.database().context_snapshot().await.unwrap().revision, 1);
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn profile_refresh_loads_default_prices_and_context_without_any_session() {
    let root =
        std::env::temp_dir().join(format!("initial-model-defaults-{}", uuid::Uuid::new_v4()));
    let app = app_at_with_env(
        &root,
        HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]),
    );
    assert!(app.list(None, Some(10)).await.unwrap().sessions.is_empty());
    app.refresh_model_defaults().await.unwrap();
    assert!(app.list(None, Some(10)).await.unwrap().sessions.is_empty());
    let settings = data(&app, query("model")).await;
    let model = settings
        .models
        .iter()
        .find(|m| m.model == "default")
        .unwrap();
    assert_eq!(model.default_context_window, Some(200000));
    assert_eq!(model.context_window, Some(200000));
    assert_eq!(model.default_price.as_ref().unwrap().input, 1.0);
    assert_eq!(model.default_price.as_ref().unwrap().output, 2.0);
    assert_eq!(app.database().context_snapshot().await.unwrap().revision, 0);
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
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
    assert!(restarted.core.coordinator.adapters.lock().await.is_empty());
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
        app.core.journal.status(operation.clone()).await.unwrap(),
        crate::domain::query::OperationStatus::Unknown
    ));
    assert!(matches!(
        app.command_durable(operation, command).await.unwrap(),
        CommandReceipt::Accepted { .. }
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
    assert!(restarted.core.coordinator.adapters.lock().await.is_empty());
    restarted.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn removed_session_usage_keeps_last_title_for_single_and_batch_removal_after_upgrade() {
    use crate::domain::query::SessionFilter;
    let (app, root) = app();
    let single = create(&app).await;
    let batch = create(&app).await;
    for (session, title) in [
        (&single, "旧名称"),
        (&single, "最终名称"),
        (&batch, "批量保留名称"),
    ] {
        manage(
            &app,
            session,
            ManagementAction::Rename {
                title: title.into(),
            },
        )
        .await;
    }
    app.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    // An existing 2.0.x root did not retain removal names.
    sql.execute_batch("ALTER TABLE removed_sessions DROP COLUMN title")
        .unwrap();
    for session in [&single, &batch] {
        sql.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at,input,output,cache_read,cache_write,source) VALUES(?1,?1,(SELECT created_seq FROM sessions WHERE id=?1),'Pi','default','inference',10,100,20,0,0,'fixture')",[session.as_str()]).unwrap();
    }
    drop(sql);
    let app = app_at(&root);
    let before = data(&app, query("session")).await;
    assert_eq!(before.groups[0].label.as_deref(), Some("#2 批量保留名称"));
    assert_eq!(before.groups[1].label.as_deref(), Some("#1 最终名称"));
    app.command_durable(
        OperationId::generate(),
        DomainCommand::RemoveSession(single.clone()),
    )
    .await
    .unwrap();
    let preview = app
        .command_durable(
            OperationId::generate(),
            DomainCommand::PrepareHistoryClear {
                filter: SessionFilter {
                    text: "批量保留名称".into(),
                    harness: None,
                },
            },
        )
        .await
        .unwrap();
    let CommandReceipt::HistoryClear { report } = preview else {
        panic!("preview");
    };
    app.command_durable(
        OperationId::generate(),
        DomainCommand::ClearHistoryBatch { job: report.job },
    )
    .await
    .unwrap();
    assert!(app.list(None, None).await.unwrap().sessions.is_empty());
    let after = data(&app, query("session")).await;
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&after).unwrap()
    );
    app.shutdown_checked().await.unwrap();
    let app = app_at(&root);
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&data(&app, query("session")).await).unwrap()
    );
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn statistics_sort_before_paging_by_cost_and_numeric_session_number_without_losing_ties() {
    let (app, root) = app();
    let mut sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let tx = sql.transaction().unwrap();
    for i in 0..235 {
        let model = format!("model-{i:03}");
        tx.execute(
            "INSERT INTO model_settings(harness,model,hidden,default_price) VALUES('Pi',?1,0,?2)",
            rusqlite::params![
                model,
                r#"{"input":1,"output":0,"cache_read":0,"cache_write":0}"#
            ],
        )
        .unwrap();
        // IDs deliberately oppose both the numeric session order and cost order.
        tx.execute("INSERT INTO usage_facts(id,session,session_number,harness,model,kind,occurred_at,input,output,cache_read,cache_write,source) VALUES(?1,?2,?3,'Pi',?1,'inference',10,?4,0,0,0,'fixture')", rusqlite::params![model, format!("session-{:03}",234-i), i+1, (i%7)*1_000_000]).unwrap();
    }
    tx.commit().unwrap();
    drop(sql);
    for dimension in ["model", "session"] {
        let mut q = query(dimension);
        let mut rows = vec![];
        let mut sizes = vec![];
        loop {
            let page = data(&app, q.clone()).await;
            assert_eq!(page.totals.as_ref().unwrap().calls, 235);
            sizes.push(page.groups.len());
            rows.extend(page.groups);
            let Some(cursor) = page.next_cursor else {
                break;
            };
            if q.cursor.is_none() {
                let mut changed = q.clone();
                changed.cursor = Some(cursor.clone());
                changed.from = Some(1);
                assert!(app
                    .query(QueryCommand::Management { query: changed })
                    .await
                    .is_err());
            }
            q.cursor = Some(cursor);
        }
        assert_eq!(sizes, [vec![10; 23], vec![5]].concat());
        assert_eq!(
            rows.iter()
                .map(|r| &r.key)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            235
        );
        if dimension == "model" {
            let mut expected: Vec<_> = (0..235).collect();
            expected.sort_by_key(|i| (std::cmp::Reverse(i % 7), *i));
            assert_eq!(
                rows.iter().map(|r| r.key.clone()).collect::<Vec<_>>(),
                expected
                    .iter()
                    .map(|i| format!("Pi/model-{i:03}"))
                    .collect::<Vec<_>>()
            );
            assert!(rows
                .windows(2)
                .all(|w| w[0].estimated_usd >= w[1].estimated_usd));
        } else {
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(row.key, format!("session-{i:03}"));
                assert!(row
                    .label
                    .as_ref()
                    .unwrap()
                    .starts_with(&format!("#{} ", 235 - i)));
            }
        }
    }
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
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
        assert!(page.groups.len() <= 10);
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
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
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

#[tokio::test]
async fn management_model_config_defaults_multiplier_context_and_restart() {
    let root = std::env::temp_dir().join(format!("model-config-{}", uuid::Uuid::new_v4()));
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
    let mut events = app.subscribe();
    prompt(&app, &session, "usage-complete").await;
    wait_finished(&mut events).await;
    let original = data(&app, query("model"))
        .await
        .totals
        .unwrap()
        .estimated_usd;
    manage(
        &app,
        &session,
        ManagementAction::ModelConfig {
            model: "default".into(),
            hidden: true,
            price: Some(Price {
                input: 3.0,
                output: 4.0,
                cache_read: 0.2,
                cache_write: 2.0,
            }),
            multiplier: 0.5,
            context_window: Some(512000),
            apply_context: true,
        },
    )
    .await;
    let read = data(&app, query("model")).await;
    assert!((read.totals.unwrap().estimated_usd - 0.0002).abs() < 1e-12);
    let model = read.models.iter().find(|m| m.model == "default").unwrap();
    assert_eq!(model.context_override, Some(512000));
    assert_eq!(model.context_window, Some(512000));
    assert_eq!(model.multiplier, 0.5);
    app.shutdown_checked().await.unwrap();
    let app = app_at_with_env(&root, env);
    manage(&app, &session, ManagementAction::RefreshModels).await;
    let read = data(&app, query("model")).await;
    let model = read.models.iter().find(|m| m.model == "default").unwrap();
    assert_eq!(model.default_context_window, Some(200000));
    assert_eq!(model.context_window, Some(512000));
    assert_eq!(model.price.as_ref().unwrap().input, 3.0);
    assert_eq!(model.multiplier, 0.5);
    assert!(model.hidden);
    assert!((read.totals.unwrap().estimated_usd - 0.0002).abs() < 1e-12);
    manage(
        &app,
        &session,
        ManagementAction::ModelConfig {
            model: "default".into(),
            hidden: false,
            price: None,
            multiplier: 1.0,
            context_window: None,
            apply_context: true,
        },
    )
    .await;
    let read = data(&app, query("model")).await;
    let model = read.models.iter().find(|m| m.model == "default").unwrap();
    assert_eq!(model.context_override, None);
    assert_eq!(model.context_window, Some(200000));
    assert!(model.price.is_none());
    assert!((read.totals.unwrap().estimated_usd - original).abs() < 1e-12);
    for multiplier in [-1.0, f64::INFINITY, f64::NAN, 1000001.0] {
        assert!(!ManagementAction::ModelConfig {
            model: "default".into(),
            hidden: false,
            price: None,
            multiplier,
            context_window: None,
            apply_context: false
        }
        .validate());
    }
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn management_alias_defaults_and_additive_existing_root_upgrade() {
    let root =
        std::env::temp_dir().join(format!("model-defaults-upgrade-{}", uuid::Uuid::new_v4()));
    let app = app_at(&root);
    let session = create(&app).await;
    app.database()
        .model_defaults(
            session.clone(),
            ProviderModels {
                context_ack: None,
                models: vec![
                    ProviderModel {
                        model: "openai/GPT-6.1 Sol".into(),
                        price: Some(Price {
                            input: 2.0,
                            output: 12.0,
                            cache_read: 0.2,
                            cache_write: 0.0,
                        }),
                        context_window: Some(272000),
                    },
                    ProviderModel {
                        model: "wwzz/gpt-6.1-sol".into(),
                        price: None,
                        context_window: None,
                    },
                    ProviderModel {
                        model: "wwzz/gpt-6.1-sol-mini".into(),
                        price: None,
                        context_window: None,
                    },
                ],
            },
        )
        .await
        .unwrap();
    manage(
        &app,
        &session,
        ManagementAction::Model {
            model: "wwzz/gpt-6.1-sol".into(),
            hidden: true,
            price: Some(Price {
                input: 5.0,
                output: 15.0,
                cache_read: 0.5,
                cache_write: 0.0,
            }),
        },
    )
    .await;
    let read = data(&app, query("model")).await;
    let alias = read
        .models
        .iter()
        .find(|m| m.model == "wwzz/gpt-6.1-sol")
        .unwrap();
    assert_eq!(alias.price.as_ref().unwrap().input, 5.0);
    assert_eq!(alias.default_price.as_ref().unwrap().input, 2.0);
    assert_eq!(alias.context_window, Some(272000));
    let mini = read
        .models
        .iter()
        .find(|m| m.model.ends_with("mini"))
        .unwrap();
    assert!(mini.default_price.is_none());
    assert!(mini.context_window.is_none());
    app.database()
        .title_result(
            session.clone(),
            TitleResponse {
                title: String::new(),
                records: [
                    "wwzz/gpt-6.1-sol",
                    "proxy/GPT_6.1 Sol",
                    "proxy/gpt-6.1-sol-mini",
                ]
                .iter()
                .map(|m| TitleUsage {
                    input: 100,
                    output: 20,
                    cache_read: 0,
                    cache_write: 0,
                    model: (*m).into(),
                })
                .collect(),
            },
        )
        .await
        .unwrap();
    let totals = data(&app, query("model")).await.totals.unwrap();
    assert_eq!(totals.unpriced, 1);
    assert!((totals.estimated_usd - 0.00124).abs() < 1e-12);
    app.shutdown_checked().await.unwrap();
    // Emulate an otherwise-valid installed 2.0.x root, retaining every old setting.
    let db = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    db.execute_batch("ALTER TABLE model_settings DROP COLUMN price_multiplier; ALTER TABLE model_settings DROP COLUMN context_override; DROP TABLE model_context_intents; DROP TABLE model_context_clock; PRAGMA application_id=0;").unwrap();
    drop(db);
    let app = app_at(&root);
    let read = data(&app, query("model")).await;
    let alias = read
        .models
        .iter()
        .find(|m| m.model == "wwzz/gpt-6.1-sol")
        .unwrap();
    assert_eq!(alias.price.as_ref().unwrap().input, 5.0);
    assert!(alias.hidden);
    assert_eq!(alias.multiplier, 1.0);
    assert_eq!(alias.context_window, Some(272000));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn context_intents_survive_restart_and_stale_settlement_cannot_clear_latest() {
    let root =
        std::env::temp_dir().join(format!("context-intent-restart-{}", uuid::Uuid::new_v4()));
    let env = HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]);
    let app = app_at_with_env(&root, env.clone());
    let session = create(&app).await;
    let first = app
        .database()
        .context_stage(
            session.clone(),
            ManagementAction::Context {
                model: "default".into(),
                context_window: Some(256000),
            },
        )
        .await
        .unwrap();
    let second = app
        .database()
        .context_stage(
            session.clone(),
            ManagementAction::Context {
                model: "default".into(),
                context_window: Some(512000),
            },
        )
        .await
        .unwrap();
    assert!(app
        .database()
        .context_settle(first.revision, None)
        .await
        .is_err());
    let row = data(&app, query("model")).await.models.remove(0);
    assert_eq!(row.context_state.as_deref(), Some("pending"));
    assert_eq!(row.context_window, Some(512000));
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    app.shutdown_checked().await.unwrap();
    let app = app_at_with_env(&root, env);
    let row = data(&app, query("model")).await.models.remove(0);
    assert_eq!(row.context_state.as_deref(), Some("pending"));
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    app.command(DomainCommand::Discover {
        session: session.clone(),
    })
    .await
    .unwrap();
    let snapshot = app.database().context_snapshot().await.unwrap();
    assert_eq!(snapshot.revision, second.revision);
    assert!(snapshot.pending.is_empty());
    let row = data(&app, query("model"))
        .await
        .models
        .into_iter()
        .find(|m| m.model == "default")
        .unwrap();
    assert_eq!(row.context_state.as_deref(), Some("applied"));
    assert_eq!(row.context_override, Some(512000));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn context_projection_settlement_failure_remains_pending_until_provider_use() {
    let root = std::env::temp_dir().join(format!(
        "context-projection-settle-{}",
        uuid::Uuid::new_v4()
    ));
    let env = HashMap::from([("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into())]);
    let app = app_at_with_env(&root, env.clone());
    let session = create(&app).await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER lose_context_applied BEFORE UPDATE ON model_context_intents WHEN NEW.state='applied' BEGIN SELECT RAISE(FAIL,'context settlement lost'); END;").unwrap();
    let operation = OperationId::generate();
    let command = DomainCommand::Manage {
        session: session.clone(),
        action: ManagementAction::Context {
            model: "default".into(),
            context_window: Some(768000),
        },
    };
    assert!(app
        .command_durable(operation.clone(), command.clone())
        .await
        .is_err());
    let row = data(&app, query("model"))
        .await
        .models
        .into_iter()
        .find(|m| m.model == "default")
        .unwrap();
    assert_eq!(row.context_state.as_deref(), Some("pending"));
    assert_eq!(row.context_override, Some(768000));
    app.shutdown_checked().await.unwrap();
    sql.execute_batch("DROP TRIGGER lose_context_applied")
        .unwrap();
    drop(sql);
    let app = app_at_with_env(&root, env);
    assert!(app.command_durable(operation, command).await.is_err());
    assert!(app.core.coordinator.adapters.lock().await.is_empty());
    manage(&app, &session, ManagementAction::RefreshModels).await;
    let row = data(&app, query("model"))
        .await
        .models
        .into_iter()
        .find(|m| m.model == "default")
        .unwrap();
    assert_eq!(row.context_state.as_deref(), Some("applied"));
    assert_eq!(row.context_override, Some(768000));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn context_saves_from_two_workspaces_are_serialized_before_file_effects() {
    let root =
        std::env::temp_dir().join(format!("context-cross-workspace-{}", uuid::Uuid::new_v4()));
    let gate = root.join("release");
    let trace = root.join("trace");
    let env = HashMap::from([
        ("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into()),
        (
            "WORKBENCH_CONTRACT_CONTEXT_GATE".into(),
            gate.to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
        (
            "WORKBENCH_CONTRACT_CONTEXT_FILE".into(),
            root.join("shared-context").to_string_lossy().into_owned(),
        ),
    ]);
    let app = app_at_with_env(&root, env);
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    let mut sessions = vec![];
    for dir in ["a", "b"] {
        let CommandReceipt::Created { summary } = app
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: WorkspacePath::new(root.join(dir).to_string_lossy()).unwrap(),
            })
            .await
            .unwrap()
        else {
            panic!("create")
        };
        sessions.push(summary.id);
    }
    let a = app.clone();
    let first = sessions[0].clone();
    let task_a = tokio::spawn(async move {
        a.command_durable(
            OperationId::generate(),
            DomainCommand::Manage {
                session: first,
                action: ManagementAction::Context {
                    model: "default".into(),
                    context_window: Some(256000),
                },
            },
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if fs::read_to_string(&trace)
                .unwrap_or_default()
                .contains("contextProjection")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let b = app.clone();
    let second = sessions[1].clone();
    let operation = OperationId::generate();
    let op = operation.clone();
    let task_b = tokio::spawn(async move {
        b.command_durable(
            op,
            DomainCommand::Manage {
                session: second,
                action: ManagementAction::Context {
                    model: "default".into(),
                    context_window: Some(1024000),
                },
            },
        )
        .await
    });
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let found: bool = sql
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM operations WHERE operation=?1)",
                    [operation.as_str()],
                    |r| r.get(0),
                )
                .unwrap();
            if found {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!task_b.is_finished());
    assert_eq!(app.database().context_snapshot().await.unwrap().revision, 1);
    fs::write(&gate, "go").unwrap();
    task_a.await.unwrap().unwrap();
    task_b.await.unwrap().unwrap();
    let snapshot = app.database().context_snapshot().await.unwrap();
    assert_eq!(snapshot.revision, 2);
    assert!(snapshot.pending.is_empty());
    assert_eq!(
        fs::read_to_string(root.join("shared-context")).unwrap(),
        "1024000"
    );
    app.command(DomainCommand::Discover {
        session: sessions[0].clone(),
    })
    .await
    .unwrap();
    assert_eq!(
        app.core
            .coordinator
            .adapters
            .lock()
            .await
            .get(&sessions[0])
            .unwrap()
            .context_revision,
        Some(2)
    );
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn blocked_context_refresh_does_not_hold_profile_lock_or_confirm_a_stale_revision() {
    let root = std::env::temp_dir().join(format!(
        "context-refresh-isolation-{}",
        uuid::Uuid::new_v4()
    ));
    let gate = root.join("refresh-release");
    let trace = root.join("trace");
    let app = app_at_with_env(
        &root,
        HashMap::from([
            ("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into()),
            (
                "WORKBENCH_CONTRACT_MODELS_GATE".into(),
                gate.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_TRACE".into(),
                trace.to_string_lossy().into_owned(),
            ),
            (
                "WORKBENCH_CONTRACT_CONTEXT_FILE".into(),
                root.join("shared-context").to_string_lossy().into_owned(),
            ),
        ]),
    );
    let mut sessions = vec![];
    for dir in ["a", "b"] {
        fs::create_dir_all(root.join(dir)).unwrap();
        let CommandReceipt::Created { summary } = app
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: WorkspacePath::new(root.join(dir).to_string_lossy()).unwrap(),
            })
            .await
            .unwrap()
        else {
            panic!("create")
        };
        sessions.push(summary.id);
    }
    manage(
        &app,
        &sessions[0],
        ManagementAction::Context {
            model: "default".into(),
            context_window: Some(256000),
        },
    )
    .await;
    // B has a current catalogue. A needs a read-only refresh.
    app.command(DomainCommand::Discover {
        session: sessions[1].clone(),
    })
    .await
    .unwrap();
    app.core
        .coordinator
        .adapters
        .lock()
        .await
        .get_mut(&sessions[0])
        .unwrap()
        .context_revision = None;
    fs::write(
        gate.with_extension("workspace"),
        root.join("a").to_string_lossy().as_bytes(),
    )
    .unwrap();
    let a = app.clone();
    let first = sessions[0].clone();
    let refresh = tokio::spawn(async move { a.core.ensure_model_context(&first).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !fs::read_to_string(&trace)
            .unwrap_or_default()
            .contains("models_refresh_blocked")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!refresh.is_finished());
    // Neither using a current worker nor a new profile save waits on A's RPC.
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        app.core.ensure_model_context(&sessions[1]),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        manage(
            &app,
            &sessions[1],
            ManagementAction::Context {
                model: "default".into(),
                context_window: Some(512000),
            },
        ),
    )
    .await
    .unwrap();
    fs::write(&gate, "go").unwrap();
    assert!(matches!(refresh.await.unwrap(), Err(DomainError::Busy)));
    assert_eq!(
        app.core
            .coordinator
            .adapters
            .lock()
            .await
            .get(&sessions[0])
            .unwrap()
            .context_revision,
        None
    );
    app.core.ensure_model_context(&sessions[0]).await.unwrap();
    assert_eq!(
        app.core
            .coordinator
            .adapters
            .lock()
            .await
            .get(&sessions[0])
            .unwrap()
            .context_revision,
        Some(2)
    );
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn context_projection_marker_rejects_lost_intent_tables_instead_of_resetting_state() {
    let root = std::env::temp_dir().join(format!("context-lost-schema-{}", uuid::Uuid::new_v4()));
    let app = app_at(&root);
    let _session = create(&app).await;
    app.shutdown_checked().await.unwrap();
    let db = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    for statement in [
        "DROP TABLE model_context_intents",
        "DROP TABLE model_context_clock",
    ] {
        db.execute_batch(statement).unwrap();
        assert!(WorkbenchApp::new(config_at(&root, Default::default())).is_err());
    }
    drop(db);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn context_projection_requires_capability_before_any_provider_write() {
    let root = std::env::temp_dir().join(format!("context-no-capability-{}", uuid::Uuid::new_v4()));
    let trace = root.join("trace");
    let env = HashMap::from([
        ("WORKBENCH_CONTRACT_MANAGEMENT".into(), "1".into()),
        ("WORKBENCH_CONTRACT_CONTEXT_PROJECTION".into(), "0".into()),
        (
            "WORKBENCH_CONTRACT_TRACE".into(),
            trace.to_string_lossy().into_owned(),
        ),
    ]);
    let app = app_at_with_env(&root, env);
    let session = create(&app).await;
    assert!(app
        .command_durable(
            OperationId::generate(),
            DomainCommand::Manage {
                session: session.clone(),
                action: ManagementAction::Context {
                    model: "default".into(),
                    context_window: Some(256000)
                }
            }
        )
        .await
        .is_err());
    let calls = fs::read_to_string(&trace).unwrap();
    assert!(!calls.contains("_pi_workbench/models"));
    let row = data(&app, query("model")).await.models.remove(0);
    assert_eq!(row.context_state.as_deref(), Some("pending"));
    assert!(row.context_error.unwrap().contains("negotiate"));
    app.shutdown_checked().await.unwrap();
    fs::remove_dir_all(root).unwrap();
}
