use super::*;
#[path = "output_dedup_tests.rs"]
mod output_dedup_tests;
#[path = "workflow_tests.rs"]
mod workflow_tests;
use crate::domain::{
    fork::ContentHash,
    query::{ContentKind, ContentRef, SafeInteger, SessionView},
    transcript::EntryRole,
    transition::{NewContent, NewEntry, Transition},
    ContentId, EntryId, Harness, SessionId, TurnId, WorkspacePath,
};
use crate::telegram::state::InboxRecord;
#[tokio::test]
async fn history_cursor_capacity_rolls_back_and_pre_history_schema_fails_closed() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(&first, vec![(EntryRole::User, "kept".into(), None)]).await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let original = admit(&context, 1, "/history all").await;
    let bot = context.bot_id;
    first.shutdown_checked().await.unwrap();
    let mut sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let tx = sql.transaction().unwrap();
    for thread in 5000..9096 {
        tx.execute("INSERT INTO telegram_history_cursors(bot_id,chat,thread,session,last_seq) VALUES (?1,-100,?2,?3,0)", rusqlite::params![bot, thread, session.as_str()]).unwrap();
    }
    tx.commit().unwrap();
    drop(sql);
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    assert!(matches!(
        context
            .store
            .history_reply(crate::persistence::inbox::HistoryExport {
                topic: topic(),
                update: original.id,
                session: session.clone(),
                cwd: Some(WorkspacePath::new("/tmp").unwrap()),
                all: true
            })
            .await,
        Err(crate::domain::error::DomainError::Backpressure)
    ));
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    second.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM telegram_history_cursors", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        4096
    );
    sql.execute_batch("DROP TABLE telegram_history_cursors")
        .unwrap();
    drop(sql);
    let lease = crate::persistence::format::StorageLease::lock(&root).unwrap();
    assert!(
        crate::persistence::database::Database::open(root.clone(), &lease)
            .await
            .is_err()
    );
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='telegram_history_cursors'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM entries", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(sql);
    drop(lease);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_scope_revocation_defers_without_losing_export_identity_and_restoration_resumes() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        vec![(EntryRole::User, "retained history".into(), None)],
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session).await.unwrap();
    admit(&context, 1, "/history all").await;
    execute(&context).await;
    let mut restricted = config();
    restricted.workspace = WorkspacePath::new(root.to_str().unwrap()).unwrap();
    let denied = Context::new(app.clone(), api.clone(), &root.join("telegram"), restricted)
        .await
        .unwrap();
    deliver_once(&denied).await.unwrap();
    assert!(api.0.lock().await.sent.is_empty());
    let pending = app.delivery_store().pending(u64::MAX, 128).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().any(|record| record.last_failure
        == Some(crate::persistence::outbox::DeliveryFailure::InvalidTarget)));
    for record in pending {
        app.delivery_store()
            .fail(
                &record.event.id,
                crate::persistence::outbox::DeliveryFailure::InvalidTarget,
                0,
            )
            .await
            .unwrap();
    }
    let mut restricted_chat = config();
    restricted_chat.allowed_chat_ids = vec![ChatId::new(-101).unwrap()];
    let denied_chat = Context::new(
        app.clone(),
        api.clone(),
        &root.join("telegram"),
        restricted_chat,
    )
    .await
    .unwrap();
    deliver_once(&denied_chat).await.unwrap();
    assert!(api.0.lock().await.sent.is_empty());
    for record in app.delivery_store().pending(u64::MAX, 128).await.unwrap() {
        app.delivery_store()
            .fail(
                &record.event.id,
                crate::persistence::outbox::DeliveryFailure::InvalidTarget,
                0,
            )
            .await
            .unwrap();
    }
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text == "retained history"));
    command(&context, 2, "/history all").await;
    assert_eq!(
        api.0
            .lock()
            .await
            .sent
            .iter()
            .filter(|message| message.text == "retained history")
            .count(),
        1
    );
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

fn topic() -> TopicKey {
    TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(101).unwrap()),
    }
}
async fn seed(
    app: &WorkbenchApp,
    values: Vec<(EntryRole, String, Option<crate::domain::image::ImageAsset>)>,
) -> SessionId {
    let mut view = SessionView::new(Harness::Pi, WorkspacePath::new("/tmp").unwrap());
    let id = view.id.clone();
    app.database().create(view.clone()).await.unwrap();
    let turn = TurnId::generate();
    let append: Vec<_> = values
        .into_iter()
        .map(|(role, text, image)| NewEntry {
            id: EntryId::generate(),
            turn: turn.clone(),
            role,
            message: None,
            text: NewContent {
                content: ContentRef {
                    id: ContentId::generate(),
                    sha256: ContentHash::of(&text),
                    bytes: SafeInteger::new(text.len() as u64).unwrap(),
                    kind: ContentKind::Text,
                },
                text,
            },
            image,
        })
        .collect();
    view.revision = SafeInteger::new(1).unwrap();
    view.last_entry_seq = SafeInteger::new(append.len() as u64).unwrap();
    app.database()
        .commit(Transition {
            operation: None,
            expected_revision: SafeInteger::default(),
            next: view,
            contents: vec![],
            append,
            tool_updates: vec![],
            deliveries: vec![],
        })
        .await
        .unwrap();
    id
}
async fn admit(context: &Context<Fake>, id: u64, text: &str) -> InboxRecord {
    context
        .api
        .0
        .lock()
        .await
        .updates
        .push_back(update(id, topic().thread, text));
    poll_once(context).await.unwrap();
    context
        .store
        .pending(128)
        .await
        .unwrap()
        .into_iter()
        .find(|record| record.id.get() == id)
        .unwrap()
}
async fn command(context: &Context<Fake>, id: u64, text: &str) {
    admit(context, id, text).await;
    execute(context).await;
    for _ in 0..110 {
        deliver_once(context).await.unwrap();
    }
}

#[tokio::test]
async fn history_recent_then_all_drains_over_200_entries_without_resending_across_restart_or_loading_provider(
) {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(
        &first,
        (0..305)
            .map(|n| {
                (
                    if n % 2 == 0 {
                        EntryRole::User
                    } else {
                        EntryRole::Agent
                    },
                    format!("entry-{n:03}"),
                    None,
                )
            })
            .collect(),
    )
    .await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    command(&context, 1, "/notifications off").await;
    command(&context, 2, "/history").await;
    let bodies = || async {
        api.0
            .lock()
            .await
            .sent
            .iter()
            .filter(|message| message.text.starts_with("entry-"))
            .map(|message| message.text.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        bodies().await,
        (285..305)
            .map(|n| format!("entry-{n:03}"))
            .collect::<Vec<_>>()
    );
    command(&context, 3, "/history all").await;
    assert_eq!(bodies().await.len(), 120);
    first.shutdown_checked().await.unwrap();
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    command(&context, 4, "/history all").await;
    command(&context, 5, "/history all").await;
    command(&context, 6, "/history all").await;
    command(&context, 7, "/history all").await;
    command(&context, 8, "/history").await;
    let actual = bodies().await;
    assert_eq!(actual.len(), 305);
    assert_eq!(
        actual
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        305
    );
    assert_eq!(
        &actual[20..],
        &(0..285)
            .map(|n| format!("entry-{n:03}"))
            .collect::<Vec<_>>()
    );
    let replay = context
        .store
        .history_reply(crate::persistence::inbox::HistoryExport {
            topic: topic(),
            update: UpdateId::new(3).unwrap(),
            session: session.clone(),
            cwd: None,
            all: true,
        })
        .await
        .unwrap();
    assert!(
        replay.contains("100 new entries queued"),
        "old request returns its original batch receipt, not a later cursor result"
    );
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    assert!(second.journal_snapshot().await.unwrap().is_empty());
    assert!(context
        .inspect(&session)
        .await
        .unwrap()
        .unwrap()
        .provider_session
        .is_none());
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_receipt_insert_failure_rolls_back_cursor_and_every_outbox_intent() {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(&first, vec![(EntryRole::User, "kept".into(), None)]).await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let original = admit(&context, 1, "/history all").await;
    first.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_history_receipt BEFORE INSERT ON contents BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;").unwrap();
    drop(sql);
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    assert!(matches!(
        super::super::execution::execute_record(&context, &original).await,
        Err(crate::domain::error::DomainError::Persistence(_))
    ));
    assert!(second
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(context.store.pending(128).await.unwrap().len(), 1);
    second.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM telegram_history_cursors", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    sql.execute_batch("DROP TRIGGER reject_history_receipt")
        .unwrap();
    drop(sql);
    let third = app(&root);
    let context = Context::new(third.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    execute(&context).await;
    deliver_once(&context).await.unwrap();
    assert!(api
        .0
        .lock()
        .await
        .sent
        .iter()
        .any(|message| message.text == "kept"));
    assert!(context.store.pending(128).await.unwrap().is_empty());
    assert!(matches!(
        context
            .store
            .history_reply(crate::persistence::inbox::HistoryExport {
                topic: topic(),
                update: original.id,
                session,
                cwd: None,
                all: false
            })
            .await,
        Err(crate::domain::error::DomainError::OperationConflict)
    ));
    third.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_streams_full_unicode_and_images_and_recovers_after_source_removal_and_inbox_completion_failure(
) {
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let long = "汉😀コード".repeat(15_000);
    let image = crate::domain::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    let session = seed(
        &first,
        vec![
            (EntryRole::User, "question".into(), None),
            (EntryRole::Agent, long.clone(), None),
            (EntryRole::Thought, "PRIVATE THOUGHT".into(), None),
            (EntryRole::Tool, "PRIVATE TOOL".into(), None),
            (
                EntryRole::Tool,
                "PRIVATE TOOL IMAGE TEXT".into(),
                Some(image.clone()),
            ),
            (EntryRole::Agent, "tail".into(), None),
        ],
    )
    .await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let original = admit(&context, 1, "/history all").await;
    first.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_history_complete BEFORE UPDATE OF status ON telegram_inbox WHEN NEW.status='Completed' BEGIN SELECT RAISE(ABORT, 'synthetic completion failure'); END;").unwrap();
    drop(sql);
    let second = app(&root);
    let context = Context::new(
        second.clone(),
        api.clone(),
        &root.join("telegram"),
        config(),
    )
    .await
    .unwrap();
    assert!(super::super::execution::execute_record(&context, &original)
        .await
        .is_err());
    api.0.lock().await.fail_media = true;
    for _ in 0..8 {
        deliver_once(&context).await.unwrap();
    }
    assert_eq!(api.0.lock().await.media_attempts, 1);
    second
        .command(DomainCommand::RemoveSession(session.clone()))
        .await
        .unwrap();
    let journal = second.journal_snapshot().await.unwrap();
    second.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.execute_batch("DROP TRIGGER reject_history_complete")
        .unwrap();
    drop(sql);
    let third = app(&root);
    let context = Context::new(third.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    execute(&context).await;
    for record in third.delivery_store().pending(u64::MAX, 128).await.unwrap() {
        third
            .delivery_store()
            .fail(
                &record.event.id,
                crate::persistence::outbox::DeliveryFailure::RateLimited,
                0,
            )
            .await
            .unwrap();
    }
    for _ in 0..8 {
        deliver_once(&context).await.unwrap();
    }
    let state = api.0.lock().await;
    let text: String = state
        .sent
        .iter()
        .filter(|message| {
            message.text.starts_with('汉')
                || message.text.starts_with('😀')
                || message.text.starts_with('コ')
                || message.text.starts_with('ー')
                || message.text.starts_with('ド')
        })
        .map(|message| message.text.as_str())
        .collect();
    assert_eq!(text, long);
    assert!(state
        .sent
        .iter()
        .all(|message| message.text.encode_utf16().count() <= 4000
            && !message.text.contains("PRIVATE")));
    assert_eq!(state.media.len(), 1);
    assert!(state.media[0].disable_notification);
    assert!(state
        .sent
        .iter()
        .filter(|message| !message.text.starts_with("History export"))
        .all(|message| message.disable_notification));
    assert_eq!(state.media[0].asset.bytes(), image.bytes());
    drop(state);
    assert!(context.store.pending(128).await.unwrap().is_empty());
    assert!(third
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(third.journal_snapshot().await.unwrap(), journal);
    third.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn history_scans_bounded_records_even_when_the_window_is_only_thoughts() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        (0..405)
            .map(|_| (EntryRole::Thought, "PRIVATE".into(), None))
            .collect(),
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session).await.unwrap();
    for id in 1..=3 {
        command(&context, id, "/history all").await;
    }
    let state = api.0.lock().await;
    assert!(state
        .sent
        .iter()
        .any(|message| message.text.contains("405 committed records examined")));
    assert!(state
        .sent
        .iter()
        .any(|message| message.text.contains("Reached the committed history end")));
    assert!(state
        .sent
        .iter()
        .all(|message| !message.text.contains("PRIVATE")));
    drop(state);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
