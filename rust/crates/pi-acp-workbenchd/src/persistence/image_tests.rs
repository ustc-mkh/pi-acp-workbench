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

#[tokio::test]
async fn payload_image_rejects_a_mismatched_descriptor_for_an_existing_id() {
    let root = Root::new();
    let (_lease, database) = open(&root.data()).await;
    let store = PayloadStore::new(database);
    let asset = ImageAsset::from_base64("image/gif", "R0lGODlhAQABAA==").unwrap();
    store.put_image(&asset).await.unwrap();
    assert_eq!(
        store.image(asset.image()).await.unwrap().bytes(),
        asset.bytes()
    );
    let mut mismatched = serde_json::to_value(asset.image()).unwrap();
    mismatched["sha256"] = "0".repeat(64).into();
    assert!(store
        .image(&serde_json::from_value(mismatched).unwrap())
        .await
        .is_err());
    store.shutdown().await;
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
