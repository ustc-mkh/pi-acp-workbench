use super::*;
fn root() -> PathBuf {
    std::env::temp_dir().join(format!("workbench-outbox-{}", uuid::Uuid::new_v4()))
}
fn event() -> DeliveryEvent {
    DeliveryEvent {
        id: DeliveryId::generate(),
        revision: 1,
        target: DeliveryTarget::Session {
            session: SessionId::generate(),
            cwd: WorkspacePath::new("/tmp").unwrap(),
        },
        payload: DeliveryPayload::AgentMessage {
            entry: EntryId::generate(),
        },
    }
}
#[tokio::test]
async fn retry_and_ack_survive_restart_without_redelivery_of_acknowledged_event() {
    let root = root();
    let store = OutboxStore::new(&root, 16);
    let event = event();
    store.enqueue(event.clone()).await.unwrap();
    store
        .fail(&event.id, DeliveryFailure::RateLimited, 100)
        .await
        .unwrap();
    let restarted = OutboxStore::new(&root, 16);
    assert!(restarted.pending(99, 16).await.unwrap().is_empty());
    let pending = restarted.pending(100, 16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempt, 1);
    assert_eq!(pending[0].event, event);
    restarted.ack(&event.id).await.unwrap();
    // Crash after send but before durable ack remains Pending (at least once).
    // After durable ack, replaying the immutable projection must stay Delivered.
    let restarted = OutboxStore::new(&root, 16);
    restarted.enqueue(event.clone()).await.unwrap();
    restarted.ack(&event.id).await.unwrap();
    assert!(restarted.pending(200, 16).await.unwrap().is_empty());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn pending_events_are_bounded_and_ids_cannot_change_payload() {
    let root = root();
    let store = OutboxStore::new(&root, 1);
    let first = event();
    store.enqueue(first.clone()).await.unwrap();
    assert!(matches!(
        store.enqueue(event()).await,
        Err(DomainError::Backpressure)
    ));
    let mut conflict = first.clone();
    conflict.payload = DeliveryPayload::AgentMessage {
        entry: EntryId::generate(),
    };
    assert!(matches!(
        store.enqueue(conflict).await,
        Err(DomainError::OperationConflict)
    ));
    store.ack(&first.id).await.unwrap();
    store.enqueue(event()).await.unwrap();
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn admission_sequence_is_independent_of_domain_revisions_and_ack_tombstones_retain_high_water(
) {
    let root = root();
    let store = OutboxStore::new(&root, 16);
    let mut first = event();
    first.revision = 999;
    let mut second = event();
    second.revision = 1;
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
    let store = OutboxStore::new(&root, 16);
    store.enqueue(first).await.unwrap();
    let third = event();
    store.enqueue(third.clone()).await.unwrap();
    let records = store.pending(u64::MAX, 16).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].sequence, 3);
    assert_eq!(records[0].event.id, third.id);
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn duplicate_zero_unknown_version_and_exhausted_sequences_fail_closed() {
    let root = root();
    let store = OutboxStore::new(&root, 16);
    let first = event();
    let second = event();
    store.enqueue(first.clone()).await.unwrap();
    store.enqueue(second.clone()).await.unwrap();
    let mut record = store.load(&second.id).await.unwrap().unwrap();
    record.sequence = 1;
    io::write(&store.path(&second.id), &record).await.unwrap();
    assert!(store.pending(u64::MAX, 16).await.is_err());
    record.sequence = 0;
    io::write(&store.path(&second.id), &record).await.unwrap();
    assert!(store.ack(&second.id).await.is_err());
    record.sequence = 2;
    record.format_version = 99;
    io::write(&store.path(&second.id), &record).await.unwrap();
    assert!(store.pending(u64::MAX, 16).await.is_err());
    record.format_version = 1;
    io::write(&store.path(&second.id), &record).await.unwrap();
    let old = tokio::fs::read(store.path(&second.id)).await.unwrap();
    assert!(store.enqueue(second.clone()).await.is_err());
    assert_eq!(tokio::fs::read(store.path(&second.id)).await.unwrap(), old);
    record.format_version = 2;
    record.sequence = u64::MAX;
    io::write(&store.path(&second.id), &record).await.unwrap();
    store.ack(&second.id).await.unwrap();
    let third = event();
    assert!(
        matches!(store.enqueue(third.clone()).await, Err(DomainError::Persistence(message)) if message == "outbox sequence exhausted")
    );
    assert!(store.load(&third.id).await.unwrap().is_none());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn pre_sequence_outbox_records_are_rejected_without_migration_or_rewrite() {
    #[derive(Serialize)]
    struct OldRecord {
        event: DeliveryEvent,
        status: DeliveryStatus,
        attempt: u32,
        retry_at: u64,
        last_failure: Option<DeliveryFailure>,
    }
    let root = root();
    let store = OutboxStore::new(&root, 16);
    let event = event();
    io::write(
        &store.path(&event.id),
        &OldRecord {
            event: event.clone(),
            status: DeliveryStatus::Pending,
            attempt: 0,
            retry_at: 0,
            last_failure: None,
        },
    )
    .await
    .unwrap();
    let before = tokio::fs::read(store.path(&event.id)).await.unwrap();
    assert!(store.pending(u64::MAX, 16).await.is_err());
    assert!(store.enqueue(event.clone()).await.is_err());
    assert_eq!(
        tokio::fs::read(store.path(&event.id)).await.unwrap(),
        before
    );
    tokio::fs::remove_dir_all(root).await.unwrap();
}
#[tokio::test]
async fn failed_ack_preserves_pending_and_corrupt_records_fail_closed() {
    let root = root();
    let store = OutboxStore::new(&root, 16);
    let event = event();
    store.enqueue(event.clone()).await.unwrap();
    let backup = root.with_extension("backup");
    tokio::fs::rename(&root, &backup).await.unwrap();
    tokio::fs::write(&root, b"not a directory").await.unwrap();
    assert!(store.ack(&event.id).await.is_err());
    tokio::fs::remove_file(&root).await.unwrap();
    tokio::fs::rename(&backup, &root).await.unwrap();
    assert_eq!(store.pending(0, 16).await.unwrap().len(), 1);
    tokio::fs::write(store.path(&event.id), b"{truncated")
        .await
        .unwrap();
    assert!(store.pending(0, 16).await.is_err());
    assert!(store.enqueue(event).await.is_err());
    tokio::fs::remove_dir_all(root).await.unwrap();
}
