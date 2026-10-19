use super::*;

#[tokio::test]
async fn export_preserves_uncheckpointed_wal_and_restores_committed_rows() {
    let root = std::env::temp_dir().join(format!("workbench-wal-export-{}", uuid::Uuid::new_v4()));
    let destination = root.with_extension("export");
    let lease = StorageLease::lock(&root).unwrap();
    let db = Database::open(root.clone(), &lease).await.unwrap();
    db.shutdown().await.unwrap();
    let mut sql = rusqlite::Connection::open(root.join("workbench.sqlite3")).unwrap();
    sql.pragma_update(None, "journal_mode", "WAL").unwrap();
    sql.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    sql.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )
    .unwrap();
    let mut view = crate::domain::tests::state();
    view.revision = Default::default();
    view.last_entry_seq = Default::default();
    crate::persistence::query::create(&mut sql, &view).unwrap();
    sql.close().unwrap();
    drop(lease);
    let wal = root.join("workbench.sqlite3-wal");
    assert!(fs::metadata(&wal).unwrap().len() > 32);
    let source_db = fs::read(root.join("workbench.sqlite3")).unwrap();
    let source_wal = fs::read(&wal).unwrap();
    let main_only = root.with_extension("main-only");
    fs::create_dir(&main_only).unwrap();
    fs::write(main_only.join("workbench.sqlite3"), &source_db).unwrap();
    let isolated = rusqlite::Connection::open(main_only.join("workbench.sqlite3")).unwrap();
    assert_eq!(
        isolated
            .query_row("SELECT count(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    isolated.close().unwrap();
    run(&[
        "export".into(),
        "--root".into(),
        root.to_str().unwrap().into(),
        "--destination".into(),
        destination.to_str().unwrap().into(),
        "--confirm".into(),
    ])
    .await
    .unwrap();
    assert_eq!(fs::read(root.join("workbench.sqlite3")).unwrap(), source_db);
    assert_eq!(fs::read(&wal).unwrap(), source_wal);
    assert_eq!(
        fs::read(destination.join("workbench.sqlite3")).unwrap(),
        source_db
    );
    assert_eq!(
        fs::read(destination.join("workbench.sqlite3-wal")).unwrap(),
        source_wal
    );
    #[derive(serde::Deserialize)]
    struct ExportManifest {
        files: Vec<Exported>,
    }
    #[derive(serde::Deserialize)]
    struct Exported {
        path: PathBuf,
        bytes: u64,
        sha256: String,
    }
    let manifest: ExportManifest =
        serde_json::from_slice(&fs::read(destination.join("EXPORT-MANIFEST.json")).unwrap())
            .unwrap();
    for entry in manifest.files {
        let bytes = fs::read(destination.join(entry.path)).unwrap();
        assert_eq!(bytes.len() as u64, entry.bytes);
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), entry.sha256);
    }
    let restored_lease = StorageLease::acquire_existing(&destination).unwrap();
    let restored = Database::open(destination.clone(), &restored_lease)
        .await
        .unwrap();
    assert_eq!(restored.view(view.id.clone()).await.unwrap().id, view.id);
    restored.shutdown().await.unwrap();
    drop(restored_lease);
    assert_eq!(fs::read(root.join("workbench.sqlite3")).unwrap(), source_db);
    assert_eq!(fs::read(&wal).unwrap(), source_wal);
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(destination).unwrap();
    fs::remove_dir_all(main_only).unwrap();
}
