use super::*;
use crate::{
    domain::{EntryId, SessionId, WorkspacePath},
    persistence::{
        format::StorageLease,
        sqlite_tests::{open, Root},
    },
};
fn at(value: u64) -> SafeInteger {
    SafeInteger::new(value).unwrap()
}
fn event() -> DeliveryEvent {
    DeliveryEvent {
        id: DeliveryId::generate(),
        revision: at(1),
        target: DeliveryTarget::Session {
            session: SessionId::generate(),
            cwd: WorkspacePath::new("/tmp").unwrap(),
        },
        payload: DeliveryPayload::Entry {
            entry: EntryId::generate(),
        },
    }
}
#[tokio::test]
async fn retry_and_ack_survive_restart_without_redelivery_of_acknowledged_event() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let store = OutboxStore::new(db.clone(), 16);
    let event = event();
    store.enqueue(event.clone()).await.unwrap();
    store
        .fail(&event.id, DeliveryFailure::RateLimited, 100)
        .await
        .unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let restarted = OutboxStore::new(db.clone(), 16);
    assert!(restarted.pending(99, 16).await.unwrap().is_empty());
    let pending = restarted.pending(100, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempt, 1);
    assert_eq!(pending[0].event, event);
    restarted.ack(&event.id).await.unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let restarted = OutboxStore::new(db.clone(), 16);
    restarted.enqueue(event.clone()).await.unwrap();
    restarted.ack(&event.id).await.unwrap();
    assert!(restarted.pending(200, 16).await.unwrap().is_empty());
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn pending_read_window_is_bounded_admission_is_not_and_ids_cannot_change_payload() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    let store = OutboxStore::new(db.clone(), 1);
    let first = event();
    store.enqueue(first.clone()).await.unwrap();
    let second = event();
    store.enqueue(second.clone()).await.unwrap();
    assert_eq!(store.pending(0, 16).await.unwrap().len(), 1);
    assert!(store.pending(MAX_SAFE_INTEGER + 1, 1).await.is_err());
    assert!(store
        .fail(&first.id, DeliveryFailure::Transport, MAX_SAFE_INTEGER + 1)
        .await
        .is_err());
    assert_eq!(store.pending(0, 16).await.unwrap()[0].attempt, 0);
    let mut conflict = first.clone();
    conflict.payload = DeliveryPayload::Entry {
        entry: EntryId::generate(),
    };
    assert!(matches!(
        store.enqueue(conflict).await,
        Err(DomainError::OperationConflict)
    ));
    store.ack(&first.id).await.unwrap();
    let rows = store.pending(0, 16).await.unwrap();
    assert_eq!(rows[0].event, second);
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn admission_sequence_is_independent_of_domain_revisions_and_ack_tombstones_retain_high_water(
) {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let store = OutboxStore::new(db.clone(), 16);
    let mut first = event();
    first.revision = at(999);
    let second = event();
    store.enqueue(first.clone()).await.unwrap();
    store.enqueue(second.clone()).await.unwrap();
    let records = store.pending(u64::MAX, 16).await.unwrap();
    assert_eq!(
        records
            .iter()
            .map(|record| (&record.event.id, record.sequence))
            .collect::<Vec<_>>(),
        [(&first.id, 1), (&second.id, 2)]
    );
    store.ack(&first.id).await.unwrap();
    store.ack(&second.id).await.unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let store = OutboxStore::new(db.clone(), 16);
    store.enqueue(first).await.unwrap();
    let third = event();
    store.enqueue(third.clone()).await.unwrap();
    let records = store.pending(u64::MAX, 16).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].sequence, 3);
    assert_eq!(records[0].event.id, third.id);
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn duplicate_zero_unknown_status_and_exhausted_sequences_fail_closed() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let store = OutboxStore::new(db.clone(), 16);
    let first = event();
    let second = event();
    store.enqueue(first.clone()).await.unwrap();
    store.enqueue(second.clone()).await.unwrap();
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    for statement in [
        "UPDATE deliveries SET order_seq=1",
        "UPDATE deliveries SET order_seq=0",
        "UPDATE deliveries SET status='Future'",
    ] {
        assert!(sql.execute(statement, []).is_err(), "{statement}");
    }
    sql.execute(
        "UPDATE store_meta SET value=9007199254740991 WHERE key='delivery_seq'",
        [],
    )
    .unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    let store = OutboxStore::new(db.clone(), 16);
    store.ack(&second.id).await.unwrap();
    assert!(
        matches!(store.enqueue(event()).await, Err(DomainError::Persistence(message)) if message.contains("sequence exhausted"))
    );
    assert_eq!(
        store.pending(u64::MAX, 16).await.unwrap()[0].event.id,
        first.id
    );
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn obsolete_payload_layout_is_rejected_without_migration_or_rewrite() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let event = event();
    OutboxStore::new(db.clone(), 16)
        .enqueue(event.clone())
        .await
        .unwrap();
    db.shutdown().await.unwrap();
    let file = root.data().join("workbench.sqlite3");
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute(
        "UPDATE deliveries SET payload_json=?1",
        [r#"{"SessionCompleted":{"turn":"old","entries":[]}}"#],
    )
    .unwrap();
    drop(sql);
    let before = std::fs::read(&file).unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let store = OutboxStore::new(db.clone(), 16);
    assert!(store.pending(u64::MAX, 16).await.is_err());
    assert!(store.enqueue(event).await.is_err());
    db.shutdown().await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), before);
}
#[tokio::test]
async fn failed_ack_preserves_pending_and_corrupt_records_fail_closed() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let event = event();
    let store = OutboxStore::new(db.clone(), 16);
    store.enqueue(event.clone()).await.unwrap();
    db.shutdown().await.unwrap();
    let file = root.data().join("workbench.sqlite3");
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_ack BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT,'test ack failure'); END").unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    let store = OutboxStore::new(db.clone(), 16);
    assert!(store.ack(&event.id).await.is_err());
    assert_eq!(store.pending(0, 16).await.unwrap().len(), 1);
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("DROP TRIGGER reject_ack").unwrap();
    sql.execute("UPDATE deliveries SET target_key='tampered'", [])
        .unwrap();
    drop(sql);
    let before = std::fs::read(&file).unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let store = OutboxStore::new(db.clone(), 16);
    assert!(store.pending(0, 16).await.is_err());
    assert!(store.enqueue(event).await.is_err());
    db.shutdown().await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), before);
    drop(lease);
    drop(StorageLease::lock(&root.data()).unwrap());
}
