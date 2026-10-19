//! SQL delivery invariants, isolated from the still-file-backed outbox facade.
use super::{
    database::{Database, StoreError, StoreRequest},
    delivery::{Failure, Request, MAX_DELIVERY_WINDOW},
    sqlite_tests::{open, Root},
};
use crate::domain::{
    query::SafeInteger,
    transition::{DeliveryIntent, DeliveryPayload, DeliveryTarget},
    DeliveryId, EntryId, WorkspacePath,
};

fn intent(thread: i64) -> DeliveryIntent {
    DeliveryIntent {
        id: DeliveryId::generate(),
        revision: at(1),
        target: DeliveryTarget::Telegram {
            bot_id: 1,
            chat: -100,
            thread,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        },
        payload: DeliveryPayload::Entry {
            entry: EntryId::generate(),
        },
    }
}
fn at(value: u64) -> SafeInteger {
    SafeInteger::new(value).unwrap()
}
#[tokio::test]
async fn sql_delivery_retry_ack_replay_and_sequence_survive_physical_restart() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let first = intent(101);
    db.enqueue_delivery(first.clone()).await.unwrap();
    db.fail_delivery(first.id.clone(), Failure::RateLimited, at(100))
        .await
        .unwrap();
    assert!(db
        .delivery_target_heads(at(99), 16)
        .await
        .unwrap()
        .is_empty());
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let rows = db.delivery_target_heads(at(100), 16).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].intent.id, first.id);
    assert_eq!(rows[0].intent.revision, first.revision);
    assert_eq!(rows[0].order.get(), 1);
    assert_eq!(rows[0].attempt, 1);
    assert_eq!(rows[0].last_failure, Some(Failure::RateLimited));
    db.ack_delivery(first.id.clone()).await.unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    db.enqueue_delivery(first.clone()).await.unwrap();
    db.ack_delivery(first.id.clone()).await.unwrap();
    db.fail_delivery(first.id.clone(), Failure::Transport, at(1000))
        .await
        .unwrap();
    let mut changed_revision = first.clone();
    changed_revision.revision = at(2);
    assert!(matches!(
        db.enqueue_delivery(changed_revision).await,
        Err(StoreError::Conflict)
    ));
    let mut changed = first.clone();
    changed.payload = DeliveryPayload::Entry {
        entry: EntryId::generate(),
    };
    assert!(matches!(
        db.enqueue_delivery(changed).await,
        Err(StoreError::Conflict)
    ));
    let next = intent(101);
    db.enqueue_delivery(next.clone()).await.unwrap();
    let rows = db.delivery_target_heads(at(0), 1).await.unwrap();
    assert_eq!(rows[0].intent.id, next.id);
    assert_eq!(
        rows[0].order.get(),
        2,
        "ack tombstones do not reset admission order"
    );
    assert!(matches!(
        db.ack_delivery(DeliveryId::generate()).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        db.fail_delivery(DeliveryId::generate(), Failure::Transport, at(0))
            .await,
        Err(StoreError::NotFound)
    ));
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sql_delivery_deferred_head_blocks_successors_but_not_other_target_beyond_1024_backlog() {
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    let first = intent(101);
    db.enqueue_delivery(first.clone()).await.unwrap();
    let mut second = None;
    for _ in 0..1100 {
        let next = intent(101);
        if second.is_none() {
            second = Some(next.id.clone());
        }
        db.enqueue_delivery(next).await.unwrap();
    }
    db.fail_delivery(first.id.clone(), Failure::RateLimited, at(100))
        .await
        .unwrap();
    let other = intent(102);
    db.enqueue_delivery(other.clone()).await.unwrap();
    let rows = db
        .delivery_target_heads(at(99), MAX_DELIVERY_WINDOW)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].intent.id, other.id,
        "filter target heads before applying the bounded window"
    );
    let rows = db.delivery_target_heads(at(100), 1).await.unwrap();
    assert_eq!(rows[0].intent.id, first.id);
    let rows = db
        .delivery_target_heads(at(100), MAX_DELIVERY_WINDOW)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].order < rows[1].order);
    db.ack_delivery(first.id).await.unwrap();
    let rows = db.delivery_target_heads(at(0), 1).await.unwrap();
    assert_eq!(Some(rows[0].intent.id.clone()), second);
    assert!(db.delivery_target_heads(at(0), 0).await.is_err());
    assert!(db
        .delivery_target_heads(at(0), MAX_DELIVERY_WINDOW + 1)
        .await
        .is_err());
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM deliveries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1102,
        "the read window is not an admission cap"
    );
}
#[tokio::test]
async fn sql_delivery_insert_abort_rolls_back_order_and_abandoned_reply_still_commits() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'test delivery failure'); END").unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    assert!(db.enqueue_delivery(intent(101)).await.is_err());
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    assert_eq!(
        sql.query_row(
            "SELECT value FROM store_meta WHERE key='delivery_seq'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        sql.query_row("SELECT count(*) FROM deliveries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    sql.execute_batch("DROP TRIGGER reject_delivery").unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    let accepted = intent(101);
    let (reply, result) = tokio::sync::oneshot::channel();
    drop(result);
    db.enqueue(StoreRequest::Delivery(Box::new(Request::Enqueue {
        intent: accepted.clone(),
        reply,
    })))
    .await
    .unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    let rows = db.delivery_target_heads(at(0), 1).await.unwrap();
    assert_eq!(rows[0].intent.id, accepted.id);
    assert_eq!(rows[0].order.get(), 1);
    db.shutdown().await.unwrap();
}
#[tokio::test]
async fn sql_delivery_invalid_scope_range_notice_and_unsafe_target_never_allocate_order() {
    use crate::domain::{
        fork::ContentHash,
        query::{ContentKind, ContentRef},
        ContentId, SessionId, TurnId,
    };
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    for target in [
        (-1, -100, 1),
        (1, -100, -1),
        (i64::MAX, -100, 1),
        (1, i64::MIN, 1),
        (1, -100, i64::MAX),
    ] {
        let mut event = intent(101);
        event.target = DeliveryTarget::Telegram {
            bot_id: target.0,
            chat: target.1,
            thread: target.2,
            cwd: WorkspacePath::new("/tmp").unwrap(),
        };
        assert!(db.enqueue_delivery(event).await.is_err());
    }
    let source = SessionId::generate();
    for (session, first_seq, last_seq) in [
        (source.clone(), at(0), at(1)),
        (source.clone(), at(2), at(1)),
        (SessionId::generate(), at(1), at(1)),
    ] {
        let mut event = intent(101);
        event.target = DeliveryTarget::Session {
            session: source.clone(),
            cwd: WorkspacePath::new("/tmp").unwrap(),
        };
        event.payload = DeliveryPayload::Turn {
            session,
            turn: TurnId::generate(),
            first_seq,
            last_seq,
        };
        assert!(db.enqueue_delivery(event).await.is_err());
    }
    let mut event = intent(101);
    event.payload = DeliveryPayload::Notice {
        content: ContentRef {
            id: ContentId::new("not-text").unwrap(),
            sha256: ContentHash::of("x"),
            bytes: at(1),
            kind: ContentKind::ToolText,
        },
    };
    assert!(db.enqueue_delivery(event).await.is_err());
    db.enqueue_delivery(intent(101)).await.unwrap();
    assert_eq!(
        db.delivery_target_heads(at(0), 1).await.unwrap()[0]
            .order
            .get(),
        1
    );
    db.shutdown().await.unwrap();
}

#[tokio::test]
async fn sql_delivery_accepted_ack_survives_observer_drop_and_shutdown_retains_lease_until_drain() {
    use super::format::StorageLease;
    use std::time::Duration;
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let event = intent(101);
    db.enqueue_delivery(event.clone()).await.unwrap();
    let pause = db.pause_executor().await.unwrap();
    let (reply, wait) = tokio::sync::oneshot::channel();
    db.enqueue(StoreRequest::Delivery(Box::new(Request::Ack {
        id: event.id.clone(),
        destination: None,
        reply,
    })))
    .await
    .unwrap();
    drop(wait); // The accepted ack is no longer owned by a request observer.
    drop(lease);
    let closing = db.clone();
    let mut shutdown = tokio::spawn(async move { closing.shutdown().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(80), &mut shutdown)
            .await
            .is_err()
    );
    assert!(
        StorageLease::lock(&root.data()).is_err(),
        "the DB thread still owns the host lease"
    );
    drop(pause);
    shutdown.await.unwrap().unwrap();
    let lease = StorageLease::lock(&root.data()).unwrap();
    let restarted = Database::open(root.data(), &lease).await.unwrap();
    restarted.enqueue_delivery(event).await.unwrap();
    assert!(
        restarted
            .delivery_target_heads(at(0), 1)
            .await
            .unwrap()
            .is_empty(),
        "accepted ack must commit despite abandoned observer"
    );
    restarted.shutdown().await.unwrap();
}
#[tokio::test]
async fn sql_delivery_failed_ack_and_fail_leave_exact_pending_record_and_can_retry_after_reopen() {
    for ack in [true, false] {
        let root = Root::new();
        let (lease, db) = open(&root.data()).await;
        let event = intent(101);
        db.enqueue_delivery(event.clone()).await.unwrap();
        db.shutdown().await.unwrap();
        let file = root.data().join("workbench.sqlite3");
        let sql = rusqlite::Connection::open(&file).unwrap();
        sql.execute_batch("CREATE TRIGGER reject_delivery_update BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT,'test ack/fail failure'); END").unwrap();
        drop(sql);
        let before = std::fs::read(&file).unwrap();
        let db = Database::open(root.data(), &lease).await.unwrap();
        let result = if ack {
            db.ack_delivery(event.id.clone()).await
        } else {
            db.fail_delivery(event.id.clone(), Failure::Transport, at(123))
                .await
        };
        assert!(result.is_err());
        let pending = db.delivery_target_heads(at(0), 1).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].intent.id, event.id);
        assert_eq!(pending[0].attempt, 0);
        assert_eq!(pending[0].retry_at, at(0));
        assert_eq!(pending[0].last_failure, None);
        db.shutdown().await.unwrap();
        assert_eq!(
            std::fs::read(&file).unwrap(),
            before,
            "failed SQL transaction must not alter record/sequence"
        );
        let sql = rusqlite::Connection::open(&file).unwrap();
        sql.execute_batch("DROP TRIGGER reject_delivery_update")
            .unwrap();
        drop(sql);
        let db = Database::open(root.data(), &lease).await.unwrap();
        if ack {
            db.ack_delivery(event.id).await.unwrap();
            assert!(db.delivery_target_heads(at(0), 1).await.unwrap().is_empty());
        } else {
            db.fail_delivery(event.id, Failure::Transport, at(123))
                .await
                .unwrap();
            assert!(db
                .delivery_target_heads(at(122), 1)
                .await
                .unwrap()
                .is_empty());
            let pending = db.delivery_target_heads(at(123), 1).await.unwrap();
            assert_eq!(pending[0].attempt, 1);
            assert_eq!(pending[0].last_failure, Some(Failure::Transport));
        }
        db.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn sql_delivery_topic_heads_merge_session_and_direct_targets_before_window_and_preserve_deferred_fifo(
) {
    use crate::domain::SessionId;
    let root = Root::new();
    let (_lease, db) = open(&root.data()).await;
    let session = SessionId::generate();
    let mut first = intent(101);
    first.target = DeliveryTarget::Session {
        session: session.clone(),
        cwd: WorkspacePath::new("/tmp").unwrap(),
    };
    db.enqueue_delivery(first.clone()).await.unwrap();
    db.fail_delivery(first.id.clone(), Failure::RateLimited, at(100))
        .await
        .unwrap();
    for _ in 0..1100 {
        db.enqueue_delivery(intent(101)).await.unwrap();
    }
    let other = intent(102);
    db.enqueue_delivery(other.clone()).await.unwrap();
    let bindings = vec![(session.clone(), -100, 101)];
    let rows = db
        .delivery_topic_heads(at(99), 1024, bindings.clone(), 1)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].intent.id, other.id, "deferred session head fences ready direct-topic successors, not another topic beyond 1024 rows");
    let rows = db
        .delivery_topic_heads(at(100), 1024, bindings.clone(), 1)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].intent.id, first.id);
    db.ack_delivery(first.id).await.unwrap();
    let rows = db
        .delivery_topic_heads(at(0), 1024, bindings.clone(), 1)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].order < rows[1].order);
    assert!(db
        .delivery_topic_heads(
            at(0),
            1024,
            vec![(session.clone(), -100, 101), (session, -100, 102)],
            1
        )
        .await
        .is_err());
    // A new binding must not retain a stale session/topic merge.
    let another = SessionId::generate();
    let mut session_intent = intent(103);
    session_intent.target = DeliveryTarget::Session {
        session: another.clone(),
        cwd: WorkspacePath::new("/tmp").unwrap(),
    };
    db.enqueue_delivery(session_intent).await.unwrap();
    let rows = db
        .delivery_topic_heads(at(0), 1024, vec![(another, -100, 104)], 1)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        3,
        "caller snapshot, not a cached prior binding, resolves topic heads"
    );
    db.shutdown().await.unwrap();
}

#[tokio::test]
async fn sql_delivery_missing_revision_schema_is_refused_without_migration() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.shutdown().await.unwrap();
    let file = root.data().join("workbench.sqlite3");
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("ALTER TABLE deliveries DROP COLUMN revision")
        .unwrap();
    drop(sql);
    let before = std::fs::read(&file).unwrap();
    assert!(matches!(
        Database::open(root.data(), &lease).await,
        Err(StoreError::Invalid("unsupported delivery schema"))
    ));
    assert_eq!(std::fs::read(&file).unwrap(), before);
}

#[tokio::test]
async fn sql_delivery_old_internal_index_is_refused_without_rewrite() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    db.shutdown().await.unwrap();
    let file = root.data().join("workbench.sqlite3");
    let sql = rusqlite::Connection::open(&file).unwrap();
    sql.execute_batch("DROP INDEX deliveries_topic_order; CREATE INDEX deliveries_topic_order ON deliveries(target_key,order_seq)").unwrap();
    drop(sql);
    let before = std::fs::read(&file).unwrap();
    assert!(matches!(
        Database::open(root.data(), &lease).await,
        Err(StoreError::Invalid("unsupported delivery index"))
    ));
    assert_eq!(std::fs::read(&file).unwrap(), before);
}
#[tokio::test]
async fn sql_delivery_saturates_attempt_and_exhausted_sequence_never_inserts() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let first = intent(101);
    db.enqueue_delivery(first.clone()).await.unwrap();
    db.shutdown().await.unwrap();
    let file = root.data().join("workbench.sqlite3");
    let sql = rusqlite::Connection::open(&file).unwrap();
    assert!(sql
        .execute("UPDATE deliveries SET order_seq=0", [])
        .is_err());
    sql.execute("UPDATE deliveries SET attempt=4294967295", [])
        .unwrap();
    sql.execute(
        "UPDATE store_meta SET value=9007199254740991 WHERE key='delivery_seq'",
        [],
    )
    .unwrap();
    drop(sql);
    let db = Database::open(root.data(), &lease).await.unwrap();
    db.fail_delivery(first.id.clone(), Failure::Transport, at(0))
        .await
        .unwrap();
    let rows = db.delivery_target_heads(at(0), 1).await.unwrap();
    assert_eq!(rows[0].attempt, u32::MAX);
    assert!(matches!(
        db.enqueue_delivery(intent(102)).await,
        Err(StoreError::Invalid("database sequence exhausted"))
    ));
    db.enqueue_delivery(first).await.unwrap();
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(&file).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM deliveries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row(
            "SELECT value FROM store_meta WHERE key='delivery_seq'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        9007199254740991
    );
}

#[tokio::test]
async fn sql_delivery_corrupt_typed_identity_rejects_read_replay_ack_and_fail_without_changes() {
    for fault in 0..2 {
        let root = Root::new();
        let (lease, db) = open(&root.data()).await;
        let event = intent(101);
        db.enqueue_delivery(event.clone()).await.unwrap();
        db.shutdown().await.unwrap();
        let file = root.data().join("workbench.sqlite3");
        let sql = rusqlite::Connection::open(&file).unwrap();
        if fault == 0 {
            sql.execute("UPDATE deliveries SET target_key='wrong'", [])
                .unwrap();
        } else {
            sql.execute(r#"UPDATE deliveries SET payload_json='{"Future":{}}'"#, [])
                .unwrap();
        }
        drop(sql);
        let before = std::fs::read(&file).unwrap();
        let db = Database::open(root.data(), &lease).await.unwrap();
        assert!(db.delivery_target_heads(at(0), 1).await.is_err());
        assert!(db.enqueue_delivery(event.clone()).await.is_err());
        assert!(db.ack_delivery(event.id.clone()).await.is_err());
        assert!(db
            .fail_delivery(event.id, Failure::Transport, at(1))
            .await
            .is_err());
        db.shutdown().await.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), before);
    }
}
