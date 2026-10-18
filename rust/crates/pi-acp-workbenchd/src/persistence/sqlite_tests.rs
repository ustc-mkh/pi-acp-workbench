//! Isolated SQLite integration proofs, including a real killed transaction.
use super::{
    database::{Database, SessionCommit, StoreError, StoreRequest},
    format::StorageLease,
    query,
};
use crate::domain::{
    fork::ContentHash,
    query::{ContentKind, ContentRef, SafeInteger, SessionView},
    transcript::EntryRole,
    transition::{DeliveryIntent, DeliveryPayload, DeliveryTarget, NewContent, NewEntry},
    ContentId, DeliveryId, EntryId, SessionId, TurnId,
};
use rusqlite::{params, Connection};
use std::{
    ffi::{CStr, CString},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

type TestReply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum TestRequest {
    RejectJournalAdmission {
        operation: crate::domain::OperationId,
        reply: TestReply<()>,
    },
    Pause {
        entered: oneshot::Sender<()>,
        resume: std::sync::mpsc::Receiver<()>,
    },
    Rollback {
        commit: Box<SessionCommit>,
        reply: TestReply<()>,
    },
    Hold {
        commit: Box<SessionCommit>,
        ready: PathBuf,
    },
    Seed {
        session: SessionId,
        count: u64,
        reply: TestReply<()>,
    },
}
pub(super) fn execute(db: &mut Connection, request: TestRequest) {
    match request {
        TestRequest::RejectJournalAdmission { operation, reply } => {
            let result = (|| -> Result<(), StoreError> {
                db.execute_batch(
                    "CREATE TEMP TABLE IF NOT EXISTS test_rejected_operations(operation TEXT PRIMARY KEY);
                     CREATE TEMP TRIGGER IF NOT EXISTS test_reject_journal_admission BEFORE INSERT ON main.operations
                     WHEN EXISTS(SELECT 1 FROM test_rejected_operations WHERE operation=NEW.operation)
                     BEGIN SELECT RAISE(ABORT,'test journal admission failure'); END;",
                )?;
                db.execute(
                    "INSERT INTO test_rejected_operations(operation) VALUES (?1)",
                    [operation.as_str()],
                )?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        TestRequest::Pause { entered, resume } => {
            let _ = entered.send(());
            resume.recv().unwrap();
        }
        TestRequest::Rollback { commit, reply } => {
            let result = (|| {
                let tx = db.transaction()?;
                query::apply_commit(&tx, &commit)?;
                Err(StoreError::Invalid("test transaction fault before commit"))
            })();
            let _ = reply.send(result);
        }
        TestRequest::Hold { commit, ready } => {
            let tx = db.transaction().unwrap();
            query::apply_commit(&tx, &commit).unwrap();
            fs::write(ready, b"transaction open").unwrap();
            // Parent really SIGKILLs this process; no synthetic rollback/restore.
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        TestRequest::Seed {
            session,
            count,
            reply,
        } => {
            let _ = reply.send(seed(db, &session, count));
        }
    }
}
fn seed(db: &mut Connection, session: &SessionId, count: u64) -> Result<(), StoreError> {
    let tx = db.transaction()?;
    let mut view = query::view(&tx, session)?;
    for i in 1..=count {
        let entry = entry(&format!("seed-{i}"), "Unicode 中🌏\n\"escaped\"\\");
        super::content::put_entry(&tx, &entry)?;
        tx.execute(
            "INSERT INTO session_entries(session,seq,entry_id) VALUES (?1,?2,?3)",
            params![session.as_str(), SafeInteger::new(i)?, entry.id.as_str()],
        )?;
    }
    view.last_entry_seq = SafeInteger::new(count)?;
    view.revision = view.revision.next()?;
    tx.execute(
        "UPDATE sessions SET revision=?2,last_entry_seq=?3,hot_state_json=?4 WHERE id=?1",
        params![
            session.as_str(),
            view.revision,
            view.last_entry_seq,
            super::database::encode(&view)?
        ],
    )?;
    query::put_delivery(&tx, &delivery(&view, "seed-delivery"))?;
    tx.commit()?;
    Ok(())
}
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let template = CString::new(
            std::env::temp_dir()
                .join("workbench-sqlite-XXXXXX")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        let mut bytes = template.into_bytes_with_nul();
        // SAFETY: writable nul-terminated mkdtemp template, copied before use.
        let pointer = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
        assert!(!pointer.is_null());
        // SAFETY: mkdtemp returned the valid nul-terminated template buffer.
        let path = PathBuf::from(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap());
        fs::create_dir(path.join("home")).unwrap();
        // Keep HOME separate without leaving an unrelated entry in the data root.
        fs::create_dir(path.join("data")).unwrap();
        Self(path)
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn initial() -> SessionView {
    #[derive(serde::Deserialize)]
    struct Fixture {
        view: SessionView,
    }
    let mut view = serde_json::from_str::<Fixture>(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
    .view;
    view.revision = SafeInteger::default();
    view.last_entry_seq = SafeInteger::default();
    view
}
fn entry(id: &str, text: &str) -> NewEntry {
    NewEntry {
        id: EntryId::new(id).unwrap(),
        turn: TurnId::new("turn-1").unwrap(),
        role: EntryRole::Agent,
        message: None,
        text: NewContent {
            content: ContentRef {
                id: ContentId::new(format!("text-{id}")).unwrap(),
                sha256: ContentHash::of(text),
                bytes: SafeInteger::new(text.len() as u64).unwrap(),
                kind: ContentKind::Text,
            },
            text: text.into(),
        },
        image: None,
    }
}
fn delivery(view: &SessionView, id: &str) -> DeliveryIntent {
    DeliveryIntent {
        id: DeliveryId::new(id).unwrap(),
        target: DeliveryTarget::Session {
            session: view.id.clone(),
            cwd: view.cwd.clone(),
        },
        payload: DeliveryPayload::Turn {
            session: view.id.clone(),
            turn: TurnId::new("turn-1").unwrap(),
            first_seq: SafeInteger::new(1).unwrap(),
            last_seq: view.last_entry_seq,
        },
    }
}
fn update(mut view: SessionView, id: &str, text: &str) -> SessionCommit {
    let expected_revision = view.revision;
    view.revision = view.revision.next().unwrap();
    view.last_entry_seq = view.last_entry_seq.next().unwrap();
    SessionCommit {
        expected_revision,
        deliveries: vec![delivery(&view, &format!("delivery-{id}"))],
        next: view,
        append: vec![entry(id, text)],
        tool_updates: vec![],
        view_changed: true,
    }
}
async fn open(root: &Path) -> (StorageLease, Database) {
    let lease = StorageLease::lock(root).unwrap();
    let db = Database::open(root, &lease).await.unwrap();
    (lease, db)
}
async fn pause(db: &Database) -> std::sync::mpsc::Sender<()> {
    let (entered, ready) = oneshot::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    db.enqueue(StoreRequest::Test(TestRequest::Pause {
        entered,
        resume: wait,
    }))
    .await
    .unwrap();
    ready.await.unwrap();
    resume
}
fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn sqlite_atomic_commit_conflicts_hash_and_restart() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let created = db.create(initial()).await.unwrap();
    assert_eq!(created.created_seq.get(), 1);
    let change = update(initial(), "entry-1", "你好🌏\n\"quoted\"\\");
    let batch = db.commit(change.clone()).await.unwrap();
    assert_eq!(batch.revision.get(), 1);
    assert_eq!(batch.entries.len(), 1);
    assert!(matches!(
        db.commit(change.clone()).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        db.content(change.append[0].text.content.clone())
            .await
            .unwrap(),
        change.append[0].text.text
    );
    let mut bad_ref = change.append[0].text.content.clone();
    bad_ref.sha256 = ContentHash::of("forged");
    assert!(db.content(bad_ref).await.is_err());
    let mut conflict = update(change.next.clone(), "entry-2", "different text");
    conflict.append[0].text.content.id = change.append[0].text.content.id.clone();
    assert!(matches!(
        db.commit(conflict).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(db.view(created.id.clone()).await.unwrap().revision.get(), 1);
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    assert_eq!(
        db.history(created.id.clone(), None, None)
            .await
            .unwrap()
            .entries
            .len(),
        1
    );
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(count(&sql, "entries"), 1);
    assert_eq!(count(&sql, "contents"), 1);
    assert_eq!(count(&sql, "deliveries"), 1);
    let integrity: String = sql
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}
#[tokio::test]
async fn sqlite_rollback_discards_session_entries_contents_and_delivery_together() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let (reply, result) = oneshot::channel();
    db.enqueue(StoreRequest::Test(TestRequest::Rollback {
        commit: Box::new(update(initial(), "failed", "not committed")),
        reply,
    }))
    .await
    .unwrap();
    assert!(result.await.unwrap().is_err());
    assert_eq!(db.view(initial().id).await.unwrap().revision.get(), 0);
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    for table in ["entries", "contents", "session_entries", "deliveries"] {
        assert_eq!(count(&sql, table), 0, "{table}");
    }
}
#[tokio::test]
async fn sqlite_dropped_observer_is_not_write_cancellation_and_shutdown_drains() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let resume = pause(&db).await;
    let (reply, result) = oneshot::channel();
    drop(result);
    db.enqueue(StoreRequest::Commit {
        commit: Box::new(update(initial(), "accepted", "durable")),
        reply,
    })
    .await
    .unwrap();
    let closing = db.clone();
    let shutdown = tokio::spawn(async move { closing.shutdown().await });
    tokio::task::yield_now().await;
    assert!(
        !shutdown.is_finished(),
        "shutdown must wait for the physical write thread"
    );
    resume.send(()).unwrap();
    shutdown.await.unwrap().unwrap();
    assert!(matches!(
        db.view(initial().id).await,
        Err(StoreError::Closed)
    ));
    let db = Database::open(root.data(), &lease).await.unwrap();
    assert_eq!(db.view(initial().id).await.unwrap().revision.get(), 1);
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sqlite_queue_is_bounded_to_256_and_one_executor_per_lease() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    assert!(Database::open(root.data(), &lease).await.is_err());
    let resume = pause(&db).await;
    for _ in 0..super::database::STORE_QUEUE_CAPACITY {
        let (reply, result) = oneshot::channel();
        drop(result);
        db.enqueue(StoreRequest::View {
            session: initial().id,
            reply,
        })
        .await
        .unwrap();
    }
    let (reply, _result) = oneshot::channel();
    assert!(tokio::time::timeout(
        Duration::from_millis(20),
        db.enqueue(StoreRequest::View {
            session: initial().id,
            reply
        })
    )
    .await
    .is_err());
    resume.send(()).unwrap();
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sqlite_lease_survives_caller_drop_until_database_closes() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    drop(lease);
    assert!(StorageLease::lock(&root.data()).is_err());
    db.shutdown().await.unwrap();
    StorageLease::lock(&root.data()).unwrap();
}
#[tokio::test]
async fn sqlite_old_corrupt_and_unmarked_roots_fail_before_database_creation() {
    let root = Root::new();
    let path = root.data();
    let lease = StorageLease::lock(&path).unwrap();
    let marker = path.join("storage-format.json");
    let old = br#"{"format_version":2,"storage_kind":"pi-acp-workbench"}"#;
    fs::write(&marker, old).unwrap();
    assert!(Database::open(&path, &lease).await.is_err());
    assert_eq!(fs::read(&marker).unwrap(), old);
    assert!(!path.join("workbench.sqlite3").exists());
    fs::write(&marker, b"{corrupt").unwrap();
    assert!(Database::open(&path, &lease).await.is_err());
    assert!(!path.join("workbench.sqlite3").exists());
    fs::remove_file(&marker).unwrap();
    fs::write(path.join("unknown"), b"real data").unwrap();
    assert!(Database::open(&path, &lease).await.is_err());
    assert!(!path.join("workbench.sqlite3").exists());
    assert_eq!(fs::read(path.join("unknown")).unwrap(), b"real data");
}
#[tokio::test]
async fn sqlite_interrupted_initialization_is_not_a_completed_format_and_is_recoverable() {
    let root = Root::new();
    let path = root.data();
    let lease = StorageLease::lock(&path).unwrap();
    let marker = br#"{"format_version":3,"storage_kind":"pi-acp-workbench"}"#;
    fs::write(path.join("storage-format.pending"), marker).unwrap();
    fs::write(path.join("workbench.sqlite3"), b"not a SQLite database").unwrap();
    assert!(Database::open(&path, &lease).await.is_err());
    assert!(!path.join("storage-format.json").exists());
    assert_eq!(
        fs::read(path.join("workbench.sqlite3")).unwrap(),
        b"not a SQLite database"
    );
    // Fixture-owned intervention only, not automatic production deletion.
    fs::remove_file(path.join("workbench.sqlite3")).unwrap();
    let db = Database::open(&path, &lease).await.unwrap();
    db.create(initial()).await.unwrap();
    db.shutdown().await.unwrap();
    fs::rename(
        path.join("storage-format.json"),
        path.join("storage-format.pending"),
    )
    .unwrap();
    let db = Database::open(&path, &lease).await.unwrap();
    assert_eq!(db.view(initial().id).await.unwrap().revision.get(), 0);
    db.shutdown().await.unwrap();
    assert!(path.join("storage-format.json").exists());
    assert!(!path.join("storage-format.pending").exists());
}
#[tokio::test]
async fn sqlite_symlink_database_and_wrong_root_lease_fail_closed() {
    let root = Root::new();
    let path = root.data();
    let lease = StorageLease::lock(&path).unwrap();
    let other = Root::new();
    assert!(Database::open(other.data(), &lease).await.is_err());
    let marker = br#"{"format_version":3,"storage_kind":"pi-acp-workbench"}"#;
    fs::write(path.join("storage-format.pending"), marker).unwrap();
    let victim = other.0.join("victim");
    fs::write(&victim, b"untouched").unwrap();
    std::os::unix::fs::symlink(&victim, path.join("workbench.sqlite3")).unwrap();
    assert!(Database::open(&path, &lease).await.is_err());
    assert_eq!(fs::read(victim).unwrap(), b"untouched");
}
#[tokio::test]
async fn sqlite_100k_indexed_pagination_no_duplicates_or_missing_rows() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let (reply, result) = oneshot::channel();
    db.enqueue(StoreRequest::Test(TestRequest::Seed {
        session: initial().id,
        count: 100_000,
        reply,
    }))
    .await
    .unwrap();
    result.await.unwrap().unwrap();
    let mut cursor = None;
    let mut expected_last = 100_000;
    let mut total = 0;
    loop {
        let page = db.history(initial().id, cursor, Some(100)).await.unwrap();
        assert!(
            crate::domain::query::json_bytes(&page, crate::domain::query::MAX_QUERY_BYTES).is_ok()
        );
        for row in page.entries.iter().rev() {
            assert_eq!(row.seq.get(), expected_last);
            expected_last -= 1;
            total += 1;
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(total, 100_000);
    assert_eq!(expected_last, 0);
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let plans: Vec<String> = sql
        .prepare(&format!("EXPLAIN QUERY PLAN {}", query::HISTORY_SQL))
        .unwrap()
        .query_map(
            params![initial().id.as_str(), 100_000i64, 50_001i64, 100i64],
            |r| r.get(3),
        )
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        plans.iter().any(|p| p.contains("SEARCH se USING")
            && p.contains("session=?")
            && p.contains("seq<?")),
        "{plans:?}"
    );
    assert!(!plans.iter().any(|p| p.contains("SCAN se")), "{plans:?}");
    assert_eq!(count(&sql, "deliveries"), 1);
}
#[tokio::test]
async fn sqlite_pagination_freezes_append_boundary_and_lists_only_summaries() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let first = update(initial(), "first", "one");
    db.commit(first.clone()).await.unwrap();
    let second = update(first.next, "second", "two");
    db.commit(second.clone()).await.unwrap();
    let page = db.history(initial().id, None, Some(1)).await.unwrap();
    assert_eq!(page.entries[0].seq.get(), 2);
    db.commit(update(second.next, "third", "three"))
        .await
        .unwrap();
    let next = db
        .history(initial().id, page.next_cursor, Some(1))
        .await
        .unwrap();
    assert_eq!(next.entries[0].seq.get(), 1);
    assert!(next.next_cursor.is_none());
    let wire = super::database::encode(&db.list(None, None).await.unwrap()).unwrap();
    assert!(!wire.contains("text"));
    assert!(!wire.contains("transcript"));
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sqlite_schema_constraints_and_corrupt_content_are_not_hidden() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let change = update(initial(), "entry", "original");
    db.commit(change.clone()).await.unwrap();
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert!(sql.execute("UPDATE sessions SET revision=-1", []).is_err());
    assert!(sql
        .execute("UPDATE sessions SET revision=9007199254740992", [])
        .is_err());
    assert!(sql
        .execute("UPDATE sessions SET status_json='\"Unknown\"'", [])
        .is_err());
    assert!(sql
        .execute("UPDATE sessions SET status_json='{}'", [])
        .is_err());
    assert!(sql
        .execute("UPDATE deliveries SET status='Discarded'", [])
        .is_err());
    assert!(sql.execute("UPDATE contents SET bytes=-1", []).is_err());
    assert!(sql
        .execute("UPDATE contents SET sha256=?1", ["z".repeat(64)])
        .is_err());
    sql.execute("UPDATE contents SET data=?1", [b"modified".as_slice()])
        .unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    assert!(db
        .content(change.append[0].text.content.clone())
        .await
        .is_err());
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sqlite_images_large_text_tools_and_intents_commit_atomically() {
    use crate::domain::{
        image::ImageAsset,
        query::{TextBody, ToolBody, ToolHeader},
        tool::{ToolKind, ToolStatus},
        transition::ToolUpdate,
        ToolCallId,
    };
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    let large = "中🌏\n\"\\".repeat(10_000);
    let mut change = update(initial(), "large", &large);
    let image = ImageAsset::from_base64("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=").unwrap();
    change.append[0].image = Some(image.clone());
    let mut tool_content = entry("tool", "large tool text").text;
    tool_content.content.kind = ContentKind::ToolText;
    change.tool_updates.push(ToolUpdate {
        header: ToolHeader {
            id: ToolCallId::new("tool/1").unwrap(),
            turn: TurnId::new("turn-1").unwrap(),
            status: ToolStatus::Completed,
            kind: Some(ToolKind::Read),
            title: "read".into(),
            name: None,
            locations: vec![],
            content: vec![ToolBody::Text {
                content: tool_content.content.clone(),
            }],
        },
        contents: vec![tool_content],
    });
    let (reply, result) = oneshot::channel();
    db.enqueue(StoreRequest::Test(TestRequest::Rollback {
        commit: Box::new(change.clone()),
        reply,
    }))
    .await
    .unwrap();
    assert!(result.await.unwrap().is_err());
    assert_eq!(db.view(initial().id).await.unwrap().revision.get(), 0);
    let batch = db.commit(change.clone()).await.unwrap();
    assert!(matches!(batch.entries[0].text, TextBody::Archived { .. }));
    assert_eq!(batch.entries[0].image.as_ref(), Some(image.image()));
    assert!(crate::domain::query::json_bytes(&batch, 4096).is_ok());
    let page = db.history(initial().id, None, None).await.unwrap();
    assert!(matches!(page.entries[0].text, TextBody::Archived { .. }));
    assert_eq!(
        db.content(change.append[0].text.content.clone())
            .await
            .unwrap(),
        large
    );
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(count(&sql, "contents"), 3);
    assert_eq!(count(&sql, "tools"), 1);
    assert_eq!(count(&sql, "deliveries"), 1);
    let raw: Vec<u8> = sql
        .query_row(
            "SELECT data FROM contents WHERE id=?1 AND kind='Image'",
            [image.image().id().as_str()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw, image.bytes());
    let allowed = [
        ".workbench.lock",
        "storage-format.json",
        "workbench.sqlite3",
        "workbench.sqlite3-wal",
        "workbench.sqlite3-shm",
        "workbench.sqlite3-journal",
    ];
    for file in fs::read_dir(root.data()).unwrap() {
        assert!(allowed.contains(&file.unwrap().file_name().to_str().unwrap()));
    }
}
#[tokio::test]
async fn sqlite_real_second_process_cannot_take_live_database_lease() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "persistence::sqlite_tests::sqlite_crash_child",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root.0.join("home"))
        .env("WORKBENCH_SQLITE_CRASH_ROOT", root.data())
        .output()
        .unwrap();
    assert!(!child.status.success());
    assert!(String::from_utf8_lossy(&child.stderr)
        .contains("storage already owned by another workbench host"));
    assert!(!root.0.join("transaction-ready").exists());
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sqlite_crash_child() {
    let Some(root) = std::env::var_os("WORKBENCH_SQLITE_CRASH_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let (_lease, db) = open(&root).await;
    db.enqueue(StoreRequest::Test(TestRequest::Hold {
        commit: Box::new(update(initial(), "uncommitted", "must roll back")),
        ready: root.parent().unwrap().join("transaction-ready"),
    }))
    .await
    .unwrap();
    // The write thread owns the open transaction until the real parent kill.
    std::future::pending::<()>().await;
}
#[tokio::test]
async fn sqlite_real_sigkill_rolls_back_revision_entries_and_delivery_intent() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.create(initial()).await.unwrap();
    db.shutdown().await.unwrap();
    drop(db);
    drop(lease);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "persistence::sqlite_tests::sqlite_crash_child",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root.0.join("home"))
        .env("WORKBENCH_SQLITE_CRASH_ROOT", root.data())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !root.0.join("transaction-ready").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("SQLite crash child exited before transaction ready: {status}");
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("SQLite crash child did not open a transaction");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    child.kill().unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    let (_lease, db) = open(&root.data()).await;
    assert_eq!(db.view(initial().id).await.unwrap().revision.get(), 0);
    assert!(db
        .history(initial().id, None, None)
        .await
        .unwrap()
        .entries
        .is_empty());
    db.shutdown().await.unwrap();
    let sql = Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    for table in ["entries", "contents", "session_entries", "deliveries"] {
        assert_eq!(count(&sql, table), 0, "{table}");
    }
    let integrity: String = sql
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}
