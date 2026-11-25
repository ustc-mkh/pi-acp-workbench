use crate::{
    domain::WorkspacePath,
    persistence::{
        database::Database,
        inbox::{Admission, TelegramStore},
        sqlite_tests::{open, Root},
    },
    telegram::{
        command::{parse_text, TelegramCommand},
        types::{ChatId, TopicId, TopicKey, TopicPreference, TopicPreferences, UpdateId, UserId},
    },
};
fn topic(thread: i64) -> TopicKey {
    TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: Some(TopicId::new(thread).unwrap()),
    }
}
async fn admit(store: &TelegramStore, id: u64, topic: &TopicKey, text: &str) -> UpdateId {
    let id = UpdateId::new(id).unwrap();
    let workspace = WorkspacePath::new("/tmp").unwrap();
    store
        .admit(Admission {
            workspace: workspace.clone(),
            id,
            sender: Some(UserId::new(5).unwrap()),
            command: Some(TelegramCommand {
                topic: topic.clone(),
                action: parse_text(None, text, &workspace, 1).unwrap(),
            }),
            callback: None,
            callback_query: None,
            expected_binding: None,
        })
        .await
        .unwrap();
    id
}
#[tokio::test]
async fn preference_and_immutable_reply_roll_back_together_and_replay_cannot_overwrite_newer_settings(
) {
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    let store = TelegramStore::new(database.clone(), 16);
    store.claim_bot(UserId::new(99).unwrap()).await.unwrap();
    let a = topic(1);
    let off_id = admit(&store, 1, &a, "/notifications off").await;
    let off = TopicPreference::Notifications(Some(false));
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_preference_reply BEFORE INSERT ON contents BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;").unwrap();
    drop(sql);
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    assert!(store.preference_reply(&a, off_id, off).await.is_err());
    assert_eq!(
        store.preferences(&a).await.unwrap(),
        TopicPreferences::default()
    );
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let rows: i64 = sql
        .query_row(
            "SELECT count(*) FROM telegram_topic_preferences",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 0);
    sql.execute_batch("DROP TRIGGER reject_preference_reply")
        .unwrap();
    drop(sql);
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    let reply = store.preference_reply(&a, off_id, off).await.unwrap();
    assert!(reply.starts_with("Notifications: off"));

    let query_id = admit(&store, 2, &a, "/silent").await;
    let query = TopicPreference::Silent(None);
    let query_reply = store.preference_reply(&a, query_id, query).await.unwrap();
    assert!(query_reply.starts_with("Silent: off"));

    let silent_id = admit(&store, 3, &a, "/silent on").await;
    store
        .preference_reply(&a, silent_id, TopicPreference::Silent(Some(true)))
        .await
        .unwrap();
    let on_id = admit(&store, 4, &a, "/notifications on").await;
    store
        .preference_reply(&a, on_id, TopicPreference::Notifications(Some(true)))
        .await
        .unwrap();

    database.shutdown().await.unwrap();
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    assert_eq!(
        store.preference_reply(&a, query_id, query).await.unwrap(),
        query_reply
    );
    assert_eq!(
        store.preference_reply(&a, off_id, off).await.unwrap(),
        reply
    );
    assert_eq!(
        store.preferences(&a).await.unwrap(),
        TopicPreferences {
            notifications: true,
            silent: true
        }
    );
    assert!(store
        .preference_reply(&a, off_id, TopicPreference::Silent(Some(false)))
        .await
        .is_err());
    assert!(store
        .preference_reply(&topic(2), off_id, off)
        .await
        .is_err());
    assert_eq!(
        store.preferences(&topic(2)).await.unwrap(),
        TopicPreferences::default()
    );
    database.shutdown().await.unwrap();
}

#[tokio::test]
async fn older_preferences_schema_is_rejected_without_migration_or_root_reset() {
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    database.shutdown().await.unwrap();
    let sentinel = root.data().join("do-not-delete.txt");
    std::fs::write(&sentinel, "preserved").unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("DROP TABLE telegram_topic_preferences; CREATE TABLE telegram_topic_preferences (bot_id INTEGER, chat INTEGER, thread INTEGER, notifications INTEGER);").unwrap();
    drop(sql);
    assert!(Database::open(root.data(), &lease).await.is_err());
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "preserved");
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(sql.query_row("SELECT count(*) FROM pragma_table_info('telegram_topic_preferences') WHERE name='silent'", [], |row| row.get::<_, i64>(0)).unwrap(), 0, "startup must not silently migrate a pre-cutover root");
}

#[tokio::test]
async fn preference_rows_are_bounded_and_resetting_to_defaults_releases_capacity() {
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    let store = TelegramStore::new(database.clone(), 8);
    store.claim_bot(UserId::new(99).unwrap()).await.unwrap();
    database.shutdown().await.unwrap();
    let mut sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let tx = sql.transaction().unwrap();
    for thread in 1..=4096 {
        tx.execute(
            "INSERT INTO telegram_topic_preferences VALUES (99,-100,?1,0,0)",
            [thread],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    drop(sql);
    let database = Database::open(root.data(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 8);
    let a = topic(4097);
    let silent_id = admit(&store, 1, &a, "/silent on").await;
    let silent = TopicPreference::Silent(Some(true));
    assert!(store.preference_reply(&a, silent_id, silent).await.is_err());
    assert_eq!(
        store.preferences(&a).await.unwrap(),
        TopicPreferences::default()
    );
    let reset_id = admit(&store, 2, &topic(1), "/notifications on").await;
    store
        .preference_reply(
            &topic(1),
            reset_id,
            TopicPreference::Notifications(Some(true)),
        )
        .await
        .unwrap();
    store.preference_reply(&a, silent_id, silent).await.unwrap();
    assert!(store.preferences(&a).await.unwrap().silent);
    assert_eq!(
        store.preferences(&topic(1)).await.unwrap(),
        TopicPreferences::default()
    );
    database.shutdown().await.unwrap();
}
