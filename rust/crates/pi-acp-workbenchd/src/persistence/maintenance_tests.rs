use super::*;
use crate::{
    domain::{
        interaction::{InteractionAnswer, InteractionResponse},
        DeliveryId, InteractionId, SessionId,
    },
    persistence::inbox::{Admission, TelegramStore},
    telegram::{
        command::{TelegramAction, TelegramCommand},
        state::InboxOutcome,
        types::{CallbackBinding, CallbackKey, ChatId, TopicKey, UpdateId, UserId},
    },
};
fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("workbench-maintenance-{}", uuid::Uuid::new_v4()));
    let lease = StorageLease::lock(&root).unwrap();
    // Explicit marker-only fixture for reset, never a production initializer.
    fs::write(
        root.join("storage-format.json"),
        br#"{"format_version":3,"storage_kind":"pi-acp-workbench"}"#,
    )
    .unwrap();
    drop(lease);
    root
}
fn args(command: &str, root: &Path) -> Vec<String> {
    vec![
        command.into(),
        "--root".into(),
        root.to_str().unwrap().into(),
        "--confirm".into(),
    ]
}
#[tokio::test]
async fn explicit_gc_atomically_preserves_pending_callbacks_offset_and_replay() {
    let root = std::env::temp_dir().join(format!(
        "workbench-maintenance-sql-{}",
        uuid::Uuid::new_v4()
    ));
    let lease = StorageLease::lock(&root).unwrap();
    let database = Database::open(root.clone(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    store.claim_bot(UserId::new(1).unwrap()).await.unwrap();
    let topic = TopicKey {
        chat: ChatId::new(-100).unwrap(),
        thread: None,
    };
    let session = SessionId::generate();
    store.bind(topic.clone(), session.clone()).await.unwrap();
    let mut keys = vec![];
    for i in 0..4 {
        let key = CallbackKey::for_option(&DeliveryId::generate(), 0);
        keys.push(key.clone());
        let answer = InteractionAnswer {
            interaction: InteractionId::generate(),
            response: InteractionResponse::Permission {
                option: "yes".into(),
            },
        };
        store
            .register_callback(
                key.clone(),
                CallbackBinding {
                    topic: topic.clone(),
                    action: crate::telegram::types::CallbackAction::Answer {
                        session: session.clone(),
                        answer: answer.clone(),
                    },
                    expires_at: if i == 3 {
                        crate::domain::query::MAX_SAFE_INTEGER
                    } else {
                        0
                    },
                    used_by: None,
                },
            )
            .await
            .unwrap();
        if i == 2 {
            continue;
        } // unused expired callback
        let id = UpdateId::new(i + 1).unwrap();
        store
            .admit(Admission {
                id,
                sender: Some(UserId::new(5).unwrap()),
                command: Some(TelegramCommand {
                    topic: topic.clone(),
                    action: TelegramAction::Answer {
                        session: session.clone(),
                        answer,
                        card: None,
                    },
                }),
                callback: Some(key),
                callback_query: Some(format!("query-{i}")),
                expected_binding: Some(session.clone()),
            })
            .await
            .unwrap();
        if i != 1 {
            store.complete(id, InboxOutcome::Applied).await.unwrap();
        }
    }
    let before = serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap();
    assert!(run(&args("gc", &root)).await.is_err());
    assert_eq!(
        serde_json::to_vec(&store.snapshot().await.unwrap()).unwrap(),
        before
    );
    database.shutdown().await.unwrap();
    drop(lease);
    run(&args("gc", &root)).await.unwrap();
    let lease = StorageLease::acquire_existing(&root).unwrap();
    let database = Database::open(root.clone(), &lease).await.unwrap();
    let store = TelegramStore::new(database.clone(), 16);
    let state = store.snapshot().await.unwrap();
    assert_eq!(state.offset, 5);
    assert_eq!(state.inbox.len(), 1);
    assert_eq!(state.callbacks.len(), 2);
    assert!(state.callbacks.contains_key(&keys[1])); // expired, still Pending
    assert!(state.callbacks.contains_key(&keys[3])); // consumed but unexpired
    assert_eq!(
        state.callbacks[&keys[3]].used_by,
        Some(UpdateId::new(4).unwrap())
    );
    assert_eq!(store.compact(100).await.unwrap(), (0, 0));
    assert_eq!(store.snapshot().await.unwrap().offset, 5);
    database.shutdown().await.unwrap();
    drop(lease);
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn gc_dry_run_is_read_only_and_confirmed_gc_removes_only_orphan_content() {
    let root = std::env::temp_dir().join(format!("workbench-gc-roots-{}", uuid::Uuid::new_v4()));
    let lease = StorageLease::lock(&root).unwrap();
    let database = Database::open(root.clone(), &lease).await.unwrap();
    database.shutdown().await.unwrap();
    drop(lease);
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    for index in 0..501 {
        let id = format!("orphan-{index:04}");
        sql.execute("INSERT INTO contents(id,kind,sha256,bytes,data,image_ref_json) VALUES(?1,'Text',?2,1,x'61',NULL)", rusqlite::params![id, "0".repeat(64)]).unwrap();
    }
    drop(sql);
    let mut dry = args("gc", &root);
    dry.retain(|arg| arg != "--confirm");
    dry.push("--dry-run".into());
    run(&dry).await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let count: u32 = sql
        .query_row(
            "SELECT count(*) FROM contents WHERE id LIKE 'orphan-%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 501, "dry-run must not compact even Telegram state");
    drop(sql);
    run(&args("gc", &root)).await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let count: u32 = sql
        .query_row(
            "SELECT count(*) FROM contents WHERE id LIKE 'orphan-%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "one confirmed pass is limited to 500 objects");
    drop(sql);
    run(&args("gc", &root)).await.unwrap();
    let sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    let count: u32 = sql
        .query_row(
            "SELECT count(*) FROM contents WHERE id LIKE 'orphan-%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    drop(sql);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn reset_retains_lock_inode_so_waiting_hosts_cannot_obtain_a_second_lease() {
    use std::os::unix::fs::MetadataExt;
    let root = root();
    let inode = fs::metadata(root.join(".workbench.lock")).unwrap().ino();
    run(&args("reset", &root)).await.unwrap();
    assert!(!root.join("storage-format.json").exists());
    assert!(StorageLease::acquire_existing(&root).is_err());
    let host = StorageLease::lock(&root).unwrap();
    assert_eq!(
        fs::metadata(root.join(".workbench.lock")).unwrap().ino(),
        inode
    );
    assert!(StorageLease::lock(&root).is_err());
    drop(host);
    fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn maintenance_never_initializes_unversioned_storage_or_follows_symlinks() {
    let root = root();
    fs::remove_file(root.join("storage-format.json")).unwrap();
    fs::write(root.join("legacy"), b"retain").unwrap();
    for command in ["gc", "reset"] {
        assert!(run(&args(command, &root)).await.is_err());
    }
    assert_eq!(fs::read(root.join("legacy")).unwrap(), b"retain");
    assert!(!root.join("storage-format.json").exists());
    fs::remove_dir_all(root).unwrap();
}
