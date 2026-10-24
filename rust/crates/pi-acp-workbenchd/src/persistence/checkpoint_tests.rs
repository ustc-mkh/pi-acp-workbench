use super::*;
use crate::persistence::sqlite_tests::Root;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

fn fixture(root: &Root) -> Connection {
    let db = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts(id INTEGER PRIMARY KEY,value BLOB NOT NULL); INSERT INTO facts VALUES(0,x'01'); PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    db.busy_timeout(NORMAL_BUSY_WAIT).unwrap();
    db
}

fn fill(db: &Connection) {
    db.execute_batch("WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<2300) INSERT INTO facts SELECT n,zeroblob(8192) FROM numbers").unwrap();
}

fn normal_timeout(db: &Connection) {
    assert_eq!(
        db.pragma_query_value(None, "busy_timeout", |r| r.get::<_, u32>(0))
            .unwrap(),
        5000
    );
}

#[test]
fn pinned_reader_checkpoint_is_bounded_then_reuses_wal_without_losing_commits() {
    let root = Root::new();
    let db = fixture(&root);
    let reader = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM facts").unwrap();
    fill(&db);
    let mut policy = Checkpoint::new(&root.data());
    let now = Instant::now();
    let high_water = std::fs::metadata(&policy.wal).unwrap().len();
    assert!(high_water > WAL_REUSE_BYTES);
    let pinned = policy
        .poll(&db, now + Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert!(pinned.busy);
    assert!(pinned.checkpointed_frames < pinned.log_frames);
    normal_timeout(&db);
    assert_eq!(
        db.query_row("SELECT count(*) FROM facts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2301
    );
    assert_eq!(
        reader
            .query_row("SELECT count(*) FROM facts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    // No unbounded busy retry inside a call, nor on every accepted request.
    assert!(policy
        .poll(&db, now + Duration::from_millis(2500))
        .unwrap()
        .is_none());
    reader.execute_batch("COMMIT").unwrap();
    let ready = policy
        .poll(&db, now + Duration::from_secs(4))
        .unwrap()
        .unwrap();
    assert!(!ready.busy);
    assert_eq!(ready.checkpointed_frames, ready.log_frames);
    normal_timeout(&db);
    db.execute("INSERT INTO facts VALUES(2301,x'02')", [])
        .unwrap();
    assert!(std::fs::metadata(&policy.wal).unwrap().len() <= high_water);
    assert!(policy
        .poll(&db, now + Duration::from_secs(6))
        .unwrap()
        .is_none());
    drop(reader);
    db.close().unwrap();
    let reopened = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        reopened
            .query_row("SELECT count(*) FROM facts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2302
    );
    eprintln!(
        "pinned checkpoint wait {:?}; released checkpoint {:?}; WAL high-water {high_water}",
        pinned.elapsed, ready.elapsed
    );
}

#[test]
fn checkpoint_error_restores_normal_write_timeout_and_does_not_erase_facts() {
    let root = Root::new();
    let db = fixture(&root);
    fill(&db);
    db.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Pragma {
            pragma_name: "wal_checkpoint",
            pragma_value: Some("RESTART"),
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }))
    .unwrap();
    let mut policy = Checkpoint::new(&root.data());
    let now = Instant::now();
    assert!(policy.poll(&db, now + Duration::from_secs(2)).is_err());
    normal_timeout(&db);
    db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .unwrap();
    assert!(
        !policy
            .poll(&db, now + Duration::from_secs(4))
            .unwrap()
            .unwrap()
            .busy
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM facts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2301
    );
}

#[test]
fn small_wal_does_not_run_sql_checkpoint() {
    let root = Root::new();
    let db = fixture(&root);
    db.execute("INSERT INTO facts VALUES(1,x'02')", []).unwrap();
    db.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Pragma {
            pragma_name: "wal_checkpoint",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }))
    .unwrap();
    let mut policy = Checkpoint::new(&root.data());
    assert!(policy
        .poll(&db, Instant::now() + Duration::from_secs(2))
        .unwrap()
        .is_none());
    normal_timeout(&db);
}
