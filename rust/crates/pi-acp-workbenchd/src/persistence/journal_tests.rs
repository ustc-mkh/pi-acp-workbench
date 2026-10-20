use super::*;
#[path = "journal_local_tests.rs"]
mod local_tests;
use crate::{
    domain::{Harness, SessionId, WorkspacePath},
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
    for outcome in [
        Ok(crate::domain::query::CommandReceipt::Removed {
            session: SessionId::generate(),
        }),
        Err(DomainError::Busy),
    ] {
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
        fixture
            .store()
            .finish(
                ticket,
                &Ok(crate::domain::query::CommandReceipt::Removed {
                    session: SessionId::generate(),
                }),
            )
            .await
            .unwrap();
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
        fixture
            .store()
            .finish(
                ticket,
                &Ok(crate::domain::query::CommandReceipt::Removed {
                    session: SessionId::generate()
                })
            )
            .await,
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

#[tokio::test]
async fn status_is_narrow_read_only_and_preserves_uncertainty_across_restart() {
    use crate::domain::query::OperationStatus as S;
    let mut fixture = Fixture::new().await;
    let id = OperationId::generate();
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Unknown
    ));
    assert!(fixture.store().snapshot().await.unwrap().is_empty());
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command()).await.unwrap()
    else {
        panic!("admit")
    };
    let before = fixture.store().snapshot().await.unwrap();
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Uncertain
    ));
    assert_eq!(before, fixture.store().snapshot().await.unwrap());
    fixture
        .store()
        .finish(
            ticket,
            &Ok(CommandReceipt::Removed {
                session: SessionId::generate(),
            }),
        )
        .await
        .unwrap();
    fixture.restart().await;
    let before = fixture.store().snapshot().await.unwrap();
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Completed {
            receipt: CommandReceipt::Removed { .. }
        }
    ));
    assert_eq!(before, fixture.store().snapshot().await.unwrap());
    fixture.store().expire(&id).await.unwrap();
    assert!(matches!(
        fixture.store().status(id).await.unwrap(),
        S::Expired
    ));
    let id = OperationId::generate();
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command()).await.unwrap()
    else {
        panic!("admit")
    };
    fixture
        .store()
        .finish(ticket, &Err(DomainError::Busy))
        .await
        .unwrap();
    assert!(matches!(
        fixture.store().status(id).await.unwrap(),
        S::Failed { .. }
    ));
    let id = OperationId::generate();
    fixture.store().begin(id.clone(), &command()).await.unwrap();
    fixture.restart().await;
    assert!(matches!(
        fixture.store().status(id).await.unwrap(),
        S::Uncertain
    ));
    fixture.close().await;
}

#[tokio::test]
async fn local_create_receipt_failure_rolls_back_session_and_identity_then_replays_one_result() {
    use crate::domain::query::OperationStatus as S;
    let mut fixture = Fixture::new().await;
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("CREATE TRIGGER reject_create_receipt BEFORE UPDATE ON operations WHEN NEW.status='Completed' BEGIN SELECT RAISE(ABORT,'test terminal receipt failure'); END;").unwrap();
    drop(db);
    fixture.restart().await;
    let id = OperationId::generate();
    let cwd = WorkspacePath::new("/tmp").unwrap();
    assert!(fixture
        .store()
        .create_local(id.clone(), Harness::Pi, cwd.clone())
        .await
        .is_err());
    assert!(fixture
        .database
        .list(None, None)
        .await
        .unwrap()
        .sessions
        .is_empty());
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Unknown
    ));
    assert!(fixture.store().snapshot().await.unwrap().is_empty());
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("DROP TRIGGER reject_create_receipt;")
        .unwrap();
    drop(db);
    fixture.restart().await;
    let receipt = fixture
        .store()
        .create_local(id.clone(), Harness::Pi, cwd.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture
            .database
            .list(None, None)
            .await
            .unwrap()
            .sessions
            .len(),
        1
    );
    let before = fixture.store().snapshot().await.unwrap();
    fixture.restart().await;
    let replayed = fixture
        .store()
        .create_local(id.clone(), Harness::Pi, cwd)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&receipt).unwrap(),
        serde_json::to_vec(&replayed).unwrap()
    );
    assert_eq!(before, fixture.store().snapshot().await.unwrap());
    assert_eq!(
        fixture
            .database
            .list(None, None)
            .await
            .unwrap()
            .sessions
            .len(),
        1
    );
    assert!(matches!(
        fixture
            .store()
            .create_local(id, Harness::Pi, WorkspacePath::new("/other").unwrap())
            .await,
        Err(DomainError::OperationConflict)
    ));
    fixture.close().await;
}

#[tokio::test]
async fn local_model_and_mode_receipt_failures_roll_back_configuration() {
    use crate::domain::{
        query::{OperationStatus as S, SessionView},
        reducer::{transition, TransitionContext},
    };
    for model in [false, true] {
        let mut fixture = Fixture::new().await;
        let mut view = SessionView::new(Harness::Pi, WorkspacePath::new("/tmp").unwrap());
        view.catalogue.models = vec![crate::domain::catalogue::ModelChoice {
            id: crate::domain::ModelId::new("fixture-model").unwrap(),
            name: "Fixture model".into(),
        }];
        view.catalogue.modes = vec![crate::domain::catalogue::ModeChoice {
            id: crate::domain::ModeId::new("fixture-mode").unwrap(),
            name: "Fixture mode".into(),
        }];
        // Fixture capabilities are explicit; production only accepts observed choices.
        let command = if model {
            DomainCommand::SetModel {
                session: view.id.clone(),
                model: view.catalogue.models[0].id.clone(),
            }
        } else {
            DomainCommand::SetMode {
                session: view.id.clone(),
                mode: view.catalogue.modes[0].id.clone(),
            }
        };
        fixture.database.create(view.clone()).await.unwrap();
        let id = OperationId::generate();
        let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command).await.unwrap()
        else {
            panic!("admit")
        };
        let mut change = transition(&view, command.clone(), &TransitionContext::default(), 0)
            .unwrap()
            .unwrap();
        change.operation = Some(ticket);
        fixture.close().await;
        let sql = Connection::open(fixture.path()).unwrap();
        sql.execute_batch("CREATE TRIGGER reject_config_receipt BEFORE UPDATE ON operations WHEN NEW.status='Completed' BEGIN SELECT RAISE(ABORT,'test config receipt failure'); END;").unwrap();
        drop(sql);
        fixture.restart().await;
        assert!(fixture.database.commit(change.clone()).await.is_err());
        let unchanged = fixture.database.view(view.id.clone()).await.unwrap();
        assert_eq!(unchanged.revision, view.revision);
        assert_eq!(unchanged.config, view.config);
        assert!(matches!(
            fixture.store().status(id.clone()).await.unwrap(),
            S::Uncertain
        ));
        fixture.close().await;
        let sql = Connection::open(fixture.path()).unwrap();
        sql.execute_batch("DROP TRIGGER reject_config_receipt")
            .unwrap();
        drop(sql);
        fixture.restart().await;
        let committed = fixture.database.commit(change).await.unwrap();
        fixture.restart().await;
        assert_eq!(
            fixture
                .database
                .view(view.id.clone())
                .await
                .unwrap()
                .revision,
            committed.revision
        );
        assert!(
            matches!(fixture.store().begin(id, &command).await.unwrap(), Admission::Replay(Ok(CommandReceipt::Accepted { revision, .. })) if revision == committed.revision)
        );
        fixture.close().await;
    }
}

#[tokio::test]
async fn remove_state_tombstone_and_receipt_share_one_commit_boundary() {
    use crate::domain::query::{OperationStatus as S, SessionView};
    let mut fixture = Fixture::new().await;
    let view = SessionView::new(Harness::Pi, WorkspacePath::new("/tmp").unwrap());
    fixture.database.create(view.clone()).await.unwrap();
    let id = OperationId::generate();
    let command = DomainCommand::RemoveSession(view.id.clone());
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command).await.unwrap()
    else {
        panic!("admit")
    };
    fixture.close().await;
    let sql = Connection::open(fixture.path()).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_remove_receipt BEFORE UPDATE ON operations WHEN NEW.status='Completed' BEGIN SELECT RAISE(ABORT,'test remove receipt failure'); END;").unwrap();
    drop(sql);
    fixture.restart().await;
    assert!(fixture
        .database
        .remove(view.id.clone(), Some(ticket.clone()))
        .await
        .is_err());
    assert_eq!(
        fixture
            .database
            .view(view.id.clone())
            .await
            .unwrap()
            .revision,
        view.revision
    );
    let sql = Connection::open(fixture.path()).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM removed_sessions", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(sql);
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Uncertain
    ));
    fixture.close().await;
    let sql = Connection::open(fixture.path()).unwrap();
    sql.execute_batch("DROP TRIGGER reject_remove_receipt")
        .unwrap();
    drop(sql);
    fixture.restart().await;
    fixture
        .database
        .remove(view.id.clone(), Some(ticket))
        .await
        .unwrap();
    assert!(matches!(
        fixture.database.view(view.id.clone()).await,
        Err(super::super::database::StoreError::NotFound)
    ));
    fixture.restart().await;
    assert!(
        matches!(fixture.store().begin(id.clone(), &command).await.unwrap(), Admission::Replay(Ok(CommandReceipt::Removed { session })) if session == view.id)
    );
    assert!(matches!(
        fixture
            .store()
            .begin(id, &DomainCommand::ListSessions)
            .await,
        Err(DomainError::OperationConflict)
    ));
    fixture.close().await;
}

#[tokio::test]
async fn prompt_input_turn_delivery_and_receipt_share_one_commit_boundary() {
    use crate::domain::{
        query::{OperationStatus as S, SessionView},
        reducer::{transition, TransitionContext},
        Prompt,
    };
    let mut fixture = Fixture::new().await;
    let view = SessionView::new(Harness::Pi, WorkspacePath::new("/tmp").unwrap());
    fixture.database.create(view.clone()).await.unwrap();
    let id = OperationId::generate();
    let command = DomainCommand::Prompt {
        session: view.id.clone(),
        prompt: Prompt::new("preserved intent").unwrap(),
    };
    let Admission::Execute(ticket) = fixture.store().begin(id.clone(), &command).await.unwrap()
    else {
        panic!("admit")
    };
    let mut change = transition(&view, command.clone(), &TransitionContext::default(), 0)
        .unwrap()
        .unwrap();
    change.operation = Some(ticket);
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("CREATE TRIGGER reject_prompt_receipt BEFORE UPDATE ON operations WHEN NEW.status='Completed' BEGIN SELECT RAISE(ABORT,'test prompt receipt failure'); END;").unwrap();
    drop(db);
    fixture.restart().await;
    assert!(fixture.database.commit(change.clone()).await.is_err());
    let unchanged = fixture.database.view(view.id.clone()).await.unwrap();
    assert_eq!(unchanged.revision, view.revision);
    assert!(unchanged.active_turn.is_none());
    assert!(fixture
        .database
        .history(view.id.clone(), None, None)
        .await
        .unwrap()
        .entries
        .is_empty());
    assert!(matches!(
        fixture.store().status(id.clone()).await.unwrap(),
        S::Uncertain
    ));
    fixture.close().await;
    let db = Connection::open(fixture.path()).unwrap();
    db.execute_batch("DROP TRIGGER reject_prompt_receipt;")
        .unwrap();
    drop(db);
    fixture.restart().await;
    let batch = fixture.database.commit(change).await.unwrap();
    assert_eq!(batch.entries.len(), 1);
    assert!(
        matches!(fixture.store().status(id.clone()).await.unwrap(), S::Completed { receipt: CommandReceipt::Accepted { revision, .. } } if revision == batch.revision)
    );
    fixture.restart().await;
    assert_eq!(
        fixture
            .database
            .history(view.id.clone(), None, None)
            .await
            .unwrap()
            .entries
            .len(),
        1
    );
    assert!(fixture
        .database
        .view(view.id)
        .await
        .unwrap()
        .active_turn
        .is_some());
    assert!(matches!(
        fixture.store().begin(id, &command).await.unwrap(),
        Admission::Replay(Ok(CommandReceipt::Accepted { .. }))
    ));
    fixture.close().await;
}
