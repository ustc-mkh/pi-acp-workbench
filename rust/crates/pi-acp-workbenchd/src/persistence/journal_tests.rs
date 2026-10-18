use super::*;
use crate::{
    domain::{Harness, WorkspacePath},
    persistence::format::StorageLease,
};
use std::{
    ffi::{CStr, CString},
    path::{Path, PathBuf},
};

struct Fixture {
    root: PathBuf,
    lease: Option<StorageLease>,
    database: Database,
}
impl Fixture {
    async fn new() -> Self {
        let template = CString::new(
            std::env::temp_dir()
                .join("workbench-journal-XXXXXX")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        let mut bytes = template.into_bytes_with_nul();
        // SAFETY: writable, nul-terminated mkdtemp template, copied before use.
        let pointer = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
        assert!(!pointer.is_null());
        // SAFETY: mkdtemp returned the valid nul-terminated template buffer.
        let root = PathBuf::from(unsafe { CStr::from_ptr(pointer) }.to_str().unwrap());
        std::fs::create_dir(root.join("home")).unwrap();
        let lease = StorageLease::lock(&root.join("data")).unwrap();
        let database = Database::open(root.join("data"), &lease).await.unwrap();
        Self {
            root,
            lease: Some(lease),
            database,
        }
    }
    fn path(&self) -> PathBuf {
        self.root.join("data/workbench.sqlite3")
    }
    fn store(&self) -> JournalStore {
        JournalStore::new(self.database.clone())
    }
    async fn close(&mut self) {
        self.database.shutdown().await.unwrap();
        self.lease.take();
    }
    async fn restart(&mut self) {
        self.close().await;
        let lease = StorageLease::lock(&self.root.join("data")).unwrap();
        self.database = Database::open(self.root.join("data"), &lease)
            .await
            .unwrap();
        self.lease = Some(lease);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Preserve an isolated failed-test root for diagnosis rather than
        // panicking again during unwinding or deleting an open SQLite database.
        if self.lease.is_none() {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
fn command() -> DomainCommand {
    DomainCommand::CreateSession {
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
    }
}
fn stored(path: &Path, id: &OperationId) -> (String, Option<Vec<u8>>, Option<String>) {
    let db = Connection::open(path).unwrap();
    db.query_row(
        "SELECT status,result,checksum FROM operations WHERE operation=?1",
        [id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap()
}
#[tokio::test]
async fn started_is_durable_before_effect_and_is_never_reexecuted() {
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    let Admission::Execute(_ticket) = fixture.store().begin(id.clone(), &command()).await.unwrap()
    else {
        panic!("admit")
    };
    fixture.restart().await;
    let restarted = fixture.store();
    assert!(matches!(
        restarted.begin(id.clone(), &command()).await,
        Err(DomainError::OperationInterrupted)
    ));
    assert!(matches!(
        restarted
            .begin(id.clone(), &DomainCommand::ListSessions)
            .await,
        Err(DomainError::OperationConflict)
    ));
    assert!(matches!(
        restarted.expire(&id).await,
        Err(DomainError::OperationInterrupted)
    ));
    fixture.close().await;
    assert_eq!(stored(&fixture.path(), &id), ("Started".into(), None, None));
}
#[tokio::test]
async fn completed_and_failed_results_survive_restart_and_gc_preserves_tombstones() {
    let mut fixture = Fixture::new().await;
    for outcome in [Ok(vec![]), Err(DomainError::Busy)] {
        let id = OperationId::generate();
        let Admission::Execute(ticket) =
            fixture.store().begin(id.clone(), &command()).await.unwrap()
        else {
            panic!("admit")
        };
        fixture.store().finish(ticket, &outcome).await.unwrap();
        fixture.close().await;
        let (_, original, checksum) = stored(&fixture.path(), &id);
        assert_eq!(
            original.as_ref().unwrap(),
            &serde_json::to_vec(&outcome).unwrap()
        );
        assert_eq!(
            checksum.unwrap(),
            format!("{:x}", Sha256::digest(original.as_ref().unwrap()))
        );
        fixture.restart().await;
        let restarted = fixture.store();
        let Admission::Replay(replayed) = restarted.begin(id.clone(), &command()).await.unwrap()
        else {
            panic!("replay")
        };
        assert_eq!(
            serde_json::to_vec(&replayed).unwrap(),
            serde_json::to_vec(&outcome).unwrap()
        );
        assert!(restarted
            .lookup(&OperationId::generate(), &command())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            serde_json::to_vec(&restarted.lookup(&id, &command()).await.unwrap().unwrap()).unwrap(),
            original.clone().unwrap()
        );
        fixture.close().await;
        assert_eq!(
            stored(&fixture.path(), &id).1,
            original,
            "lookup must not reconstruct/rewrite stored result bytes"
        );
        fixture.restart().await;
        fixture.store().expire(&id).await.unwrap();
        fixture.restart().await;
        assert!(matches!(
            fixture.store().begin(id.clone(), &command()).await,
            Err(DomainError::OperationExpired)
        ));
        assert!(matches!(
            fixture
                .store()
                .begin(id.clone(), &DomainCommand::ListSessions)
                .await,
            Err(DomainError::OperationConflict)
        ));
        fixture.close().await;
        assert_eq!(
            stored(&fixture.path(), &id),
            ("Tombstone".into(), None, None)
        );
        fixture.restart().await;
    }
    fixture.close().await;
}
#[tokio::test]
async fn corrupt_missing_or_wrong_identity_results_fail_closed() {
    let mut fixture = Fixture::new().await;
    for fault in 0..4 {
        let id = OperationId::generate();
        let Admission::Execute(ticket) =
            fixture.store().begin(id.clone(), &command()).await.unwrap()
        else {
            panic!("admit")
        };
        fixture.store().finish(ticket, &Ok(vec![])).await.unwrap();
        fixture.close().await;
        let db = Connection::open(fixture.path()).unwrap();
        match fault {
            0 => {
                // A missing terminal BLOB violates the schema. Even bypassing
                // CHECK during corruption must be rejected at the next open.
                db.execute_batch("PRAGMA ignore_check_constraints=ON")
                    .unwrap();
                db.execute(
                    "UPDATE operations SET result=NULL WHERE operation=?1",
                    [id.as_str()],
                )
                .unwrap();
                let lease = StorageLease::lock(&fixture.root.join("data")).unwrap();
                assert!(Database::open(fixture.root.join("data"), &lease)
                    .await
                    .is_err());
                drop(lease);
                // Repair only this synthetic corruption so the other cases run.
                db.execute(
                    "UPDATE operations SET result=?2 WHERE operation=?1",
                    params![id.as_str(), b"{\"Ok\":[]}".as_slice()],
                )
                .unwrap();
            }
            1 => {
                db.execute(
                    "UPDATE operations SET result=?2 WHERE operation=?1",
                    params![id.as_str(), b"{truncated".as_slice()],
                )
                .unwrap();
            }
            2 => {
                db.execute(
                    "UPDATE operations SET fingerprint=?2 WHERE operation=?1",
                    params![
                        id.as_str(),
                        RequestFingerprint::of(&DomainCommand::ListSessions)
                            .unwrap()
                            .0
                    ],
                )
                .unwrap();
            }
            _ => {
                db.execute(
                    "UPDATE operations SET status='Failed' WHERE operation=?1",
                    [id.as_str()],
                )
                .unwrap();
            }
        }
        drop(db);
        fixture.restart().await;
        if fault > 0 {
            assert!(matches!(
                fixture.store().begin(id, &command()).await,
                Err(DomainError::Persistence(_) | DomainError::OperationConflict)
            ));
        }
    }
    fixture.close().await;
}
#[tokio::test]
async fn concurrent_duplicate_admission_has_only_one_execution_ticket() {
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        // Independent facades share one Database, not a facade-local mutex.
        let store = fixture.store();
        let id = id.clone();
        tasks.spawn(async move { store.begin(id, &command()).await });
    }
    let (mut execute, mut interrupted) = (0, 0);
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(Admission::Execute(_)) => execute += 1,
            Err(DomainError::OperationInterrupted) => interrupted += 1,
            _ => panic!("unexpected admission"),
        }
    }
    assert_eq!((execute, interrupted), (1, 15));
    fixture.close().await;
}
#[tokio::test]
async fn finish_fault_rolls_back_terminal_status_bytes_and_checksum_together() {
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command()).await.unwrap()
    else {
        panic!("admit")
    };
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("CREATE TRIGGER test_abort_journal_finish AFTER UPDATE OF result ON operations BEGIN SELECT RAISE(ABORT,'test fault after terminal update'); END;").unwrap();
    drop(db);
    fixture.restart().await;
    assert!(matches!(
        fixture.store().finish(ticket, &Ok(vec![])).await,
        Err(DomainError::Persistence(_))
    ));
    fixture.close().await;
    assert_eq!(stored(&fixture.path(), &id), ("Started".into(), None, None));
    fixture.restart().await;
    assert!(matches!(
        fixture.store().begin(id, &command()).await,
        Err(DomainError::OperationInterrupted)
    ));
    fixture.close().await;
}
#[tokio::test]
async fn abandoned_finish_observer_still_commits_before_shutdown_returns() {
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command()).await.unwrap()
    else {
        panic!("admit")
    };
    let (reply, observer) = oneshot::channel();
    drop(observer);
    fixture
        .store()
        .submit(Request::Finish {
            ticket,
            result: Err(DomainError::Busy),
            reply,
        })
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(stored(&fixture.path(), &id).0, "Failed");
    fixture.restart().await;
    let Admission::Replay(result) = fixture.store().begin(id, &command()).await.unwrap() else {
        panic!("replay")
    };
    assert!(matches!(result, Err(DomainError::Busy)));
    fixture.close().await;
}
#[tokio::test]
async fn independent_lookup_does_not_allocate_or_change_a_receipt() {
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    assert!(fixture
        .store()
        .lookup(&id, &command())
        .await
        .unwrap()
        .is_none());
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM operations", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(db);
    let names: Vec<_> = std::fs::read_dir(fixture.root.join("data"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|name| name == ".workbench.lock"
            || name == "storage-format.json"
            || name.starts_with("workbench.sqlite3")),
        "no journal/results JSON files: {names:?}"
    );
}
