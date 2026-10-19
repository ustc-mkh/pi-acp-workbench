//! End-to-end persistence boundaries for Telegram workflows.
use super::*;

#[tokio::test]
async fn sync_activity_pages_sort_recently_updated_with_a_stable_watermark() {
    let root = root();
    let first_app = app(&root);
    let mut ids = Vec::new();
    for _ in 0..3 {
        if let crate::domain::query::CommandReceipt::Created { summary } = first_app
            .command(DomainCommand::CreateSession {
                harness: Harness::Pi,
                cwd: WorkspacePath::new("/tmp").unwrap(),
            })
            .await
            .unwrap()
        {
            ids.push(summary.id);
        } else {
            panic!("expected created session");
        }
    }
    first_app.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    for (id, activity) in ids.iter().zip([10_i64, 30, 20]) {
        sql.execute(
            "UPDATE sessions SET activity_seq=?2 WHERE id=?1",
            rusqlite::params![id.as_str(), activity],
        )
        .unwrap();
    }
    sql.execute(
        "UPDATE store_meta SET value=30 WHERE key='activity_seq'",
        [],
    )
    .unwrap();
    drop(sql);
    let app = app(&root);
    let first = app.list_activity(None, Some(2)).await.unwrap();
    assert_eq!(
        first
            .sessions
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        vec![ids[1].clone(), ids[2].clone()]
    );
    let second = app.list_activity(first.next_cursor, Some(2)).await.unwrap();
    assert_eq!(
        second
            .sessions
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        vec![ids[0].clone()]
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn queue_barrier_is_frozen_scoped_and_atomic_across_restart() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(&first, vec![]).await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let a = admit(&context, 1, "/prompt A").await;
    let b = admit(&context, 2, "/prompt B").await;
    let stop = admit(&context, 3, "/stop").await;
    let later = admit(&context, 4, "/prompt later").await;
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_barrier BEFORE INSERT ON contents BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    assert!(context.store.queue_barrier(stop.id).await.is_err());
    assert_eq!(context.store.pending(128).await.unwrap().len(), 4);
    sql.execute_batch("DROP TRIGGER fail_barrier").unwrap();
    drop(sql);
    assert_eq!(
        context.store.queue_barrier(stop.id).await.unwrap(),
        vec![a.id, b.id]
    );
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(second.clone(), api, &root.join("telegram"), config())
        .await
        .unwrap();
    assert_eq!(
        context.store.queue_barrier(stop.id).await.unwrap(),
        vec![a.id, b.id]
    );
    let pending = context.store.pending(128).await.unwrap();
    assert_eq!(
        pending.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![stop.id, later.id]
    );
    second.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let rows: Vec<String> = sql
        .prepare(
            "SELECT outcome_json FROM telegram_inbox WHERE update_id IN (1,2) ORDER BY update_id",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|row| row.contains("Cancelled") && row.contains('3')));
    drop(sql);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn private_sync_freezes_watermark_and_recovers_without_provider_or_second_export() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(
        &first,
        vec![
            (EntryRole::User, "中😀 input".into(), None),
            (EntryRole::Agent, "```rust\nanswer\n```".into(), None),
        ],
    )
    .await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let record = admit(&context, 1, "/sync").await;
    let reply = crate::telegram::sync::run(&context, &record, &None, 5, false)
        .await
        .unwrap();
    assert!(reply.contains("Sync:"));
    assert_eq!(
        first
            .delivery_store()
            .pending(u64::MAX, 128)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(api.0.lock().await.topics, 0);
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(second.clone(), api, &root.join("telegram"), config())
        .await
        .unwrap();
    let recovered = crate::telegram::sync::run(&context, &record, &None, 5, false)
        .await
        .unwrap();
    assert!(recovered.contains("original export recovered"));
    assert_eq!(
        second
            .delivery_store()
            .pending(u64::MAX, 128)
            .await
            .unwrap()
            .len(),
        2
    );
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_reassembles_adjacent_provider_message_fragments_as_one_export() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(
        &first,
        vec![
            (EntryRole::User, "question".into(), None),
            (EntryRole::Agent, "```rust\n".into(), None),
            (EntryRole::Agent, "let answer = 42;\n".into(), None),
            (EntryRole::Agent, "```".into(), None),
        ],
    )
    .await;
    first.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute("UPDATE entries SET message='provider-message-1',metadata_json=json_set(metadata_json,'$.message','provider-message-1') WHERE entry_id IN (SELECT entry_id FROM session_entries WHERE session=?1 AND seq BETWEEN 2 AND 4)", [session.as_str()]).unwrap();
    drop(sql);
    let app = app(&root);
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session).await.unwrap();
    command(&context, 1, "/history all").await;
    let sent = api.0.lock().await.sent.clone();
    let combined: Vec<_> = sent
        .iter()
        .filter(|m| m.text == "```rust\nlet answer = 42;\n```")
        .collect();
    assert_eq!(
        combined.len(),
        1,
        "provider message fragments combine into one Telegram message"
    );
    assert!(!sent
        .iter()
        .any(|m| m.text == "```rust\n" || m.text == "let answer = 42;\n"));
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
