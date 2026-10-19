use super::*;
use crate::{
    domain::{
        transition::{DeliveryIntent, DeliveryPayload, DeliveryTarget},
        DeliveryId,
    },
    telegram::{delivery::deliver_record, types::TopicKey},
};
use tokio_util::sync::CancellationToken;

async fn enqueue_turn(
    app: &WorkbenchApp,
    session: &SessionId,
) -> crate::persistence::outbox::DeliveryRecord {
    let page = app
        .database()
        .history(session.clone(), None, Some(1))
        .await
        .unwrap();
    let turn = page.entries[0].turn.clone();
    let last = page.entries[0].seq;
    let id = DeliveryId::new(format!("turn-{turn}")).unwrap();
    app.delivery_store()
        .enqueue(DeliveryIntent {
            id: id.clone(),
            revision: SafeInteger::new(1).unwrap(),
            target: DeliveryTarget::Session {
                session: session.clone(),
                cwd: WorkspacePath::new("/tmp").unwrap(),
            },
            payload: DeliveryPayload::Turn {
                session: session.clone(),
                turn,
                first_seq: SafeInteger::new(1).unwrap(),
                last_seq: last,
            },
        })
        .await
        .unwrap();
    app.delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .into_iter()
        .find(|record| record.event.id == id)
        .unwrap()
}
fn image() -> crate::domain::image::ImageAsset {
    crate::domain::image::ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap()
}
async fn sql(root: &std::path::Path, statement: &'static str) {
    let path = root.join("workbench.sqlite3");
    tokio::task::spawn_blocking(move || {
        rusqlite::Connection::open(path)
            .unwrap()
            .execute_batch(statement)
            .unwrap()
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn completed_automatic_output_is_not_reexported_after_restart_but_another_topic_receives_it()
{
    let root = root();
    let first = app(&root);
    let api = Fake::default();
    let session = seed(
        &first,
        vec![
            (EntryRole::User, "question".into(), None),
            (EntryRole::Agent, "answer".into(), None),
            (EntryRole::Agent, "caption".into(), Some(image())),
        ],
    )
    .await;
    let context = Context::new(first.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    enqueue_turn(&first, &session).await;
    deliver_once(&context).await.unwrap();
    assert_eq!(api.0.lock().await.media.len(), 1);
    let before = api.0.lock().await.sent.len();
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
    command(&context, 1, "/history all").await;
    let state = api.0.lock().await;
    assert!(state.sent[before..]
        .iter()
        .any(|message| message.text == "question"));
    assert!(state.sent[before..]
        .iter()
        .all(|message| !message.text.contains("answer") && !message.text.contains("caption")));
    assert_eq!(state.media.len(), 1);
    drop(state);
    let replacement = seed(&second, vec![]).await;
    context.store.bind(topic(), replacement).await.unwrap();
    let other = TopicKey {
        chat: topic().chat,
        thread: Some(TopicId::new(202).unwrap()),
    };
    context.store.bind(other.clone(), session).await.unwrap();
    api.0
        .lock()
        .await
        .updates
        .push_back(update(2, other.thread, "/history all"));
    poll_once(&context).await.unwrap();
    execute(&context).await;
    for _ in 0..8 {
        deliver_once(&context).await.unwrap();
    }
    let state = api.0.lock().await;
    assert!(state
        .sent
        .iter()
        .any(|message| message.message_thread_id == other.thread && message.text == "answer"));
    assert_eq!(state.media.len(), 2);
    drop(state);
    assert!(second.journal_snapshot().await.unwrap().is_empty());
    second.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn prior_history_ack_filters_multiple_full_automatic_pages_but_keeps_reliable_completion() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        (0..305)
            .map(|n| (EntryRole::Agent, format!("output-{n}"), None))
            .collect(),
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    for id in 1..=4 {
        command(&context, id, "/history all").await;
    }
    let before = api.0.lock().await.sent.len();
    assert_eq!(
        api.0
            .lock()
            .await
            .sent
            .iter()
            .filter(|message| message.text.starts_with("output-"))
            .count(),
        305
    );
    enqueue_turn(&app, &session).await;
    deliver_once(&context).await.unwrap();
    let state = api.0.lock().await;
    assert_eq!(state.sent.len(), before + 1);
    assert_eq!(
        state.sent[before].text,
        "Turn completed. Output already exported in this topic."
    );
    drop(state);
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn fully_filtered_pages_do_not_hide_the_unexported_tail_and_later_history_skips_that_tail() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        (0..205)
            .map(|n| (EntryRole::Agent, format!("part-{n:03}"), None))
            .collect(),
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    command(&context, 1, "/history all").await;
    command(&context, 2, "/history all").await;
    let before = api.0.lock().await.sent.len();
    enqueue_turn(&app, &session).await;
    deliver_once(&context).await.unwrap();
    let state = api.0.lock().await;
    assert_eq!(state.sent.len(), before + 1);
    assert_eq!(
        state.sent[before].text,
        (200..205)
            .map(|n| format!("part-{n:03}"))
            .collect::<String>()
    );
    drop(state);
    command(&context, 3, "/history all").await;
    let state = api.0.lock().await;
    assert!(state
        .sent
        .last()
        .unwrap()
        .text
        .contains("0 new entries queued"));
    assert_eq!(state.sent.len(), before + 2);
    drop(state);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn export_reserved_before_automatic_ack_rechecks_at_delivery_head_without_replaying_body_or_image(
) {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        vec![(
            EntryRole::Agent,
            "pending automatic body".into(),
            Some(image()),
        )],
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    enqueue_turn(&app, &session).await;
    admit(&context, 1, "/history all").await;
    execute(&context).await;
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .iter()
        .any(|record| matches!(&record.event.payload, DeliveryPayload::HistoryEntry { .. })));
    for _ in 0..6 {
        deliver_once(&context).await.unwrap();
    }
    let state = api.0.lock().await;
    assert_eq!(state.media.len(), 1);
    assert_eq!(
        state
            .sent
            .iter()
            .filter(|message| message.text == "pending automatic body")
            .count(),
        1
    );
    assert!(!state
        .sent
        .iter()
        .any(|message| message.text.starts_with("History ·")));
    assert!(state
        .sent
        .last()
        .unwrap()
        .text
        .starts_with("History export"));
    drop(state);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn muted_automatic_ack_is_not_evidence_of_delivery_and_history_still_sends_text_and_image() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(
        &app,
        vec![(EntryRole::Agent, "not yet delivered".into(), Some(image()))],
    )
    .await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    command(&context, 1, "/notifications off").await;
    enqueue_turn(&app, &session).await;
    deliver_once(&context).await.unwrap();
    assert!(api.0.lock().await.media.is_empty());
    command(&context, 2, "/history all").await;
    let state = api.0.lock().await;
    assert_eq!(state.media.len(), 1);
    assert!(state
        .sent
        .iter()
        .any(|message| message.text == "not yet delivered"));
    drop(state);
    app.shutdown_checked().await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn sent_destination_and_ack_are_atomic_and_cached_ack_keeps_original_topic_after_rebind() {
    let root = root();
    let app = app(&root);
    let api = Fake::default();
    let session = seed(&app, vec![(EntryRole::Agent, "atomic".into(), None)]).await;
    let context = Context::new(app.clone(), api.clone(), &root.join("telegram"), config())
        .await
        .unwrap();
    context.store.bind(topic(), session.clone()).await.unwrap();
    let record = enqueue_turn(&app, &session).await;
    sql(&root, "CREATE TRIGGER reject_sent_receipt BEFORE INSERT ON telegram_turn_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;").await;
    assert!(
        deliver_record(&context, &record, &Some(topic()), &CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(api.0.lock().await.sent.len(), 1);
    assert_eq!(
        app.delivery_store()
            .pending(u64::MAX, 128)
            .await
            .unwrap()
            .len(),
        1
    );
    let replacement = seed(&app, vec![]).await;
    context.store.bind(topic(), replacement).await.unwrap();
    let other = TopicKey {
        chat: topic().chat,
        thread: Some(TopicId::new(202).unwrap()),
    };
    context.store.bind(other.clone(), session).await.unwrap();
    sql(&root, "DROP TRIGGER reject_sent_receipt").await;
    deliver_record(&context, &record, &Some(other), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        api.0.lock().await.sent.len(),
        1,
        "ack-only recovery must not resend in another topic"
    );
    assert!(app
        .delivery_store()
        .pending(u64::MAX, 128)
        .await
        .unwrap()
        .is_empty());
    app.shutdown_checked().await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT thread FROM telegram_turn_receipts", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        101
    );
    sql.execute_batch("DROP TABLE telegram_turn_receipts")
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
        sql.query_row("SELECT count(*) FROM entries", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='telegram_turn_receipts'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(sql);
    drop(lease);
    tokio::fs::remove_dir_all(root).await.unwrap();
}
