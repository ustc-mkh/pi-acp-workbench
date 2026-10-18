use super::*;
use crate::domain::{Harness, WorkspacePath};
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("workbench-journal-{}", uuid::Uuid::new_v4()))
}
fn command() -> DomainCommand {
    DomainCommand::CreateSession {
        harness: Harness::Pi,
        cwd: WorkspacePath::new("/tmp").unwrap(),
    }
}
#[tokio::test]
async fn started_is_durable_before_effect_and_is_never_reexecuted() {
    let root = root();
    let store = JournalStore::new(&root);
    let id = OperationId::generate();
    let Admission::Execute(_ticket) = store.begin(id.clone(), &command()).await.unwrap() else {
        panic!("admit")
    };
    let restarted = JournalStore::new(&root);
    assert!(matches!(
        restarted.begin(id.clone(), &command()).await,
        Err(DomainError::OperationInterrupted)
    ));
    assert!(matches!(
        restarted.begin(id, &DomainCommand::ListSessions).await,
        Err(DomainError::OperationConflict)
    ));
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn completed_and_failed_results_survive_restart_and_gc_preserves_tombstones() {
    let root = root();
    let store = JournalStore::new(&root);
    for outcome in [Ok(vec![]), Err(DomainError::Busy)] {
        let id = OperationId::generate();
        let Admission::Execute(ticket) = store.begin(id.clone(), &command()).await.unwrap() else {
            panic!("admit")
        };
        store.finish(ticket, &outcome).await.unwrap();
        let restarted = JournalStore::new(&root);
        let Admission::Replay(replayed) = restarted.begin(id.clone(), &command()).await.unwrap()
        else {
            panic!("replay")
        };
        assert_eq!(
            serde_json::to_vec(&replayed).unwrap(),
            serde_json::to_vec(&outcome).unwrap()
        );
        restarted.expire(&id).await.unwrap();
        assert!(matches!(
            store.begin(id, &command()).await,
            Err(DomainError::OperationExpired)
        ));
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn corrupt_missing_or_wrong_identity_results_fail_closed() {
    let root = root();
    let store = JournalStore::new(&root);
    for fault in 0..3 {
        let id = OperationId::generate();
        let Admission::Execute(ticket) = store.begin(id.clone(), &command()).await.unwrap() else {
            panic!("admit")
        };
        store.finish(ticket, &Ok(vec![])).await.unwrap();
        let path = store.result_path(&id);
        match fault {
            0 => tokio::fs::remove_file(&path).await.unwrap(),
            1 => tokio::fs::write(&path, b"{truncated").await.unwrap(),
            _ => io::write(
                &path,
                &OperationResult {
                    operation: OperationId::generate(),
                    fingerprint: RequestFingerprint::of(&command()).unwrap(),
                    result: Ok(vec![]),
                },
            )
            .await
            .unwrap(),
        }
        assert!(matches!(
            store.begin(id, &command()).await,
            Err(DomainError::Persistence(_))
        ));
    }
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn concurrent_duplicate_admission_has_only_one_execution_ticket() {
    let root = root();
    let store = JournalStore::new(&root);
    let id = OperationId::generate();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let store = store.clone();
        let id = id.clone();
        tasks.spawn(async move { store.begin(id, &command()).await });
    }
    let mut execute = 0;
    let mut interrupted = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(Admission::Execute(_)) => execute += 1,
            Err(DomainError::OperationInterrupted) => interrupted += 1,
            _ => panic!("unexpected admission"),
        }
    }
    assert_eq!((execute, interrupted), (1, 15));
    tokio::fs::remove_dir_all(root).await.unwrap();
}
