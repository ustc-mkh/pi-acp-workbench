use super::{
    database::Database,
    payload::{NoticeContent, PayloadStore},
    sqlite_tests::{open, Root},
};
use crate::domain::{
    image::ImageAsset,
    interaction::{Interaction, InteractionKind, InteractionOption},
    transcript::{EntryRole, TranscriptEntry},
    EntryId, InteractionId, NoticeId, TurnId,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn image_archive_is_immutable_identity_checked_and_detects_corruption() {
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    let store = PayloadStore::new(database);
    let asset = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    assert!(store.image(asset.image()).await.is_err());
    store.put_image(&asset).await.unwrap();
    store.put_image(&asset).await.unwrap();
    let loaded = store.image(asset.image()).await.unwrap();
    assert_eq!(loaded.bytes(), asset.bytes());
    assert_eq!(loaded.image(), asset.image());
    let mut bytes = asset.bytes().to_vec();
    *bytes.last_mut().unwrap() ^= 1;
    let mut changed = serde_json::to_value(&asset).unwrap();
    changed["data"] = serde_json::json!(STANDARD.encode(&bytes));
    changed["image"]["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
    let changed: ImageAsset = serde_json::from_value(changed).unwrap();
    assert!(
        store.put_image(&changed).await.is_err(),
        "same ID cannot be rebound"
    );
    assert!(
        store.image(changed.image()).await.is_err(),
        "read must compare full descriptor"
    );
    store.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let committed: Vec<u8> = sql
        .query_row(
            "SELECT data FROM contents WHERE id=?1",
            [asset.image().id().as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        committed,
        asset.bytes(),
        "failed rebind must preserve exact committed BLOB"
    );
    let mut corrupt = committed.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    sql.execute(
        "UPDATE contents SET data=?1 WHERE id=?2",
        rusqlite::params![corrupt, asset.image().id().as_str()],
    )
    .unwrap();
    drop(sql);
    let restarted = PayloadStore::new(Database::open(root.data(), &lease).await.unwrap());
    assert!(restarted.image(asset.image()).await.is_err());
    restarted.shutdown().await;
}
#[tokio::test]
async fn payload_entries_notices_and_interactions_survive_physical_database_restart_without_files()
{
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    let store = PayloadStore::new(database);
    let notice = NoticeContent {
        id: NoticeId::new("n".repeat(200)).unwrap(),
        text: "通知 🌏\n\"escaped\"".into(),
    };
    let interaction = Interaction {
        question: None,
        id: InteractionId::generate(),
        kind: InteractionKind::Permission,
        title: "allow?".into(),
        detail: "typed immutable request".into(),
        fields: vec![],
        options: vec![InteractionOption {
            id: "allow".into(),
            label: "Allow".into(),
        }],
        expires_at: None,
    };
    let entry = TranscriptEntry {
        id: EntryId::new("e".repeat(200)).unwrap(),
        turn: TurnId::generate(),
        role: EntryRole::Agent,
        text: "长文本 中🌏\\\"\n".repeat(2000),
        message: None,
        image: None,
    };
    store.put_notice(&notice).await.unwrap();
    store.put_interaction(&interaction).await.unwrap();
    store.put_entry(&entry).await.unwrap();
    store.put_entry(&entry).await.unwrap();
    let mut conflicting = notice.clone();
    conflicting.text = "rebound".into();
    assert!(store.put_notice(&conflicting).await.is_err());
    let mut conflicting = interaction.clone();
    conflicting.detail = "rebound".into();
    assert!(store.put_interaction(&conflicting).await.is_err());
    let mut conflicting = entry.clone();
    conflicting.text = "rebound".into();
    assert!(store.put_entry(&conflicting).await.is_err());
    store.shutdown().await;
    let restarted = PayloadStore::new(Database::open(root.data(), &lease).await.unwrap());
    assert_eq!(
        restarted.notice(&notice.id).await.unwrap().text,
        notice.text
    );
    assert_eq!(
        serde_json::to_vec(&restarted.interaction(&interaction.id).await.unwrap()).unwrap(),
        serde_json::to_vec(&interaction).unwrap()
    );
    assert_eq!(
        serde_json::to_vec(&restarted.entry(&entry.id).await.unwrap()).unwrap(),
        serde_json::to_vec(&entry).unwrap()
    );
    restarted.shutdown().await;
    for file in std::fs::read_dir(root.data()).unwrap() {
        let name = file.unwrap().file_name();
        assert!(
            [
                ".workbench.lock",
                "storage-format.json",
                "workbench.sqlite3",
                "workbench.sqlite3-wal",
                "workbench.sqlite3-shm",
                "workbench.sqlite3-journal"
            ]
            .contains(&name.to_str().unwrap()),
            "no independent payload file/directory: {name:?}"
        );
    }
}
#[tokio::test]
async fn payload_text_insert_rolls_back_when_entry_insert_aborts() {
    let root = Root::new();
    let (lease, database) = open(&root.data()).await;
    database.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT,'test archive failure'); END").unwrap();
    drop(sql);
    let store = PayloadStore::new(Database::open(root.data(), &lease).await.unwrap());
    let entry = TranscriptEntry {
        id: EntryId::generate(),
        turn: TurnId::generate(),
        role: EntryRole::Agent,
        text: "must not become orphaned content".into(),
        message: None,
        image: None,
    };
    assert!(store.put_entry(&entry).await.is_err());
    assert!(store.entry(&entry.id).await.is_err());
    store.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM contents", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM entries", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn payload_entry_archive_conflict_rolls_back_new_text_and_missing_images_are_not_referenced()
{
    let root = Root::new();
    let (_lease, database) = open(&root.data()).await;
    let store = PayloadStore::new(database);
    let mut entry = TranscriptEntry {
        id: EntryId::generate(),
        turn: TurnId::generate(),
        role: EntryRole::Agent,
        text: "original".into(),
        message: None,
        image: None,
    };
    store.put_entry(&entry).await.unwrap();
    entry.turn = TurnId::generate();
    assert!(store.put_entry(&entry).await.is_err());
    let mut absent = entry.clone();
    absent.id = EntryId::generate();
    absent.image = Some(
        ImageAsset::from_base64("image/gif", "R0lGODlhAQABAA==")
            .unwrap()
            .image()
            .clone(),
    );
    assert!(store.put_entry(&absent).await.is_err());
    assert!(store.entry(&absent.id).await.is_err());
    assert_eq!(store.entry(&entry.id).await.unwrap().text, "original");
    store.shutdown().await;
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM entries", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM contents", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
