//! Bundled SQLite oracle/structural cost tests, independent of wall-clock noise.
use super::*;
use crate::{
    domain::{EntryId, SessionId, WorkspacePath},
    telegram::types::TopicKey,
};
use rusqlite::StatementStatus;

fn fixture(topics: usize, backlog: usize) -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    db.execute("INSERT INTO telegram_meta VALUES (1,0,'1')", [])
        .unwrap();
    let tx = db.transaction().unwrap();
    let mut order = 0;
    for i in 1..=topics {
        let session = SessionId::new(format!("session-{i}")).unwrap();
        let topic = TopicKey::from_delivery(-100, i as i64).unwrap();
        tx.execute(
            "INSERT INTO telegram_bindings VALUES (1,-100,?1,?2,?3)",
            params![
                i as i64,
                session.as_str(),
                serde_json::to_string(&(&topic, &session)).unwrap()
            ],
        )
        .unwrap();
        for n in 0..backlog {
            order += 1;
            let target = if n % 2 == 0 {
                DeliveryTarget::Session {
                    session: session.clone(),
                    cwd: WorkspacePath::new("/tmp").unwrap(),
                }
            } else {
                DeliveryTarget::Telegram {
                    bot_id: 1,
                    chat: -100,
                    thread: i as i64,
                    cwd: WorkspacePath::new("/tmp").unwrap(),
                }
            };
            tx.execute("INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status,next_retry) VALUES (?1,?2,1,?3,?4,?5,'Pending',?6)", params![format!("delivery-{order}"), order, target_key(&target), serde_json::to_string(&target).unwrap(), serde_json::to_string(&DeliveryPayload::Entry { entry: EntryId::generate() }).unwrap(), if n == 0 { 999 } else { 0 }]).unwrap();
        }
    }
    // Acked backlog does not contribute a head or gate a Pending successor.
    for i in 0..10000 {
        order += 1;
        tx.execute("INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status) VALUES (?1,?2,1,'acked','{}','{}','Acked')", params![format!("acked-{i}"), order]).unwrap();
    }
    tx.commit().unwrap();
    db
}
fn measured(db: &Connection, limit: usize) -> (Vec<u64>, i32) {
    let mut statement = db.prepare(&dispatch_sql()).unwrap();
    let mut rows = statement.query(params![1, limit as i64, 0]).unwrap();
    let mut orders = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        orders.push(pending(row).unwrap().order.get());
    }
    drop(rows);
    (orders, statement.get_status(StatementStatus::VmStep))
}
fn oracle(db: &Connection, limit: usize) -> Vec<u64> {
    let snapshot = dispatch_snapshot(db, 1, MAX_DELIVERY_WINDOW).unwrap();
    let mut statement = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM deliveries d WHERE status='Pending' ORDER BY order_seq"
        ))
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    let mut seen = std::collections::BTreeSet::new();
    let mut orders = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        let record = pending(row).unwrap();
        let key = match &record.intent.target {
            DeliveryTarget::Session { session, .. } => snapshot
                .bindings
                .iter()
                .find(|(_, id)| *id == session)
                .map(|(topic, _)| {
                    format!(
                        "telegram:1:{}:{}",
                        topic.chat.get(),
                        topic.thread.map_or(0, |t| t.get())
                    )
                })
                .unwrap_or_else(|| target_key(&record.intent.target)),
            _ => target_key(&record.intent.target),
        };
        if seen.insert(key) {
            orders.push((record.retry_at.get() > 0, record.order.get()));
        }
    }
    orders.sort_unstable();
    orders.truncate(limit);
    orders.into_iter().map(|(_, order)| order).collect()
}
#[test]
fn dispatch_delivery_scale_has_no_per_candidate_scan_and_matches_fifo_oracle() {
    for backlog in [1, 100] {
        let mut previous = None;
        for topics in [30, 100, 200, 1000] {
            let db = fixture(topics, backlog);
            let (orders, steps) = measured(&db, MAX_DELIVERY_WINDOW);
            assert_eq!(orders, oracle(&db, MAX_DELIVERY_WINDOW));
            assert_eq!(orders.len(), topics);
            assert!(dispatch_snapshot(&db, 1, MAX_DELIVERY_WINDOW)
                .unwrap()
                .heads
                .iter()
                .all(|r| r.retry_at.get() == 999));
            let plan = db
                .prepare(&format!("EXPLAIN QUERY PLAN {}", dispatch_sql()))
                .unwrap()
                .query_map(params![1, 1024, 0], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                !plan.iter().any(|line| line.contains("CORRELATED")),
                "{plan:?}"
            );
            assert!(
                plan.iter()
                    .any(|line| line.contains("deliveries_topic_order")),
                "{plan:?}"
            );
            assert!(
                !plan.iter().any(|line| line.contains("deliveries_retry")),
                "{plan:?}"
            );
            // Acked identities remain durable but cannot grow dispatch work.
            let before = measured(&db, MAX_DELIVERY_WINDOW).1;
            db.execute("INSERT INTO deliveries(delivery_id,order_seq,revision,target_key,target_json,payload_json,status) SELECT delivery_id || '-copy', order_seq+10000000,revision,target_key,target_json,payload_json,status FROM deliveries WHERE status='Acked'", []).unwrap();
            assert_eq!(measured(&db, MAX_DELIVERY_WINDOW).1, before);
            assert!(
                plan.iter()
                    .any(|line| line.contains("SEARCH b") && line.contains("session=?")),
                "binding must use its unique index: {plan:?}"
            );
            // Linear work in Pending rows + target heads, not candidates squared.
            assert!(
                steps < (topics * backlog * 150 + topics * 250 + 10000) as i32,
                "topics={topics} backlog={backlog} steps={steps}"
            );
            if let Some((old_topics, old_steps)) = previous {
                assert!(
                    steps as f64 / old_steps as f64 <= topics as f64 / old_topics as f64 * 1.15
                );
            }
            previous = Some((topics, steps));
            eprintln!("dispatch topics={topics} backlog={backlog} vm_steps={steps}");
        }
    }
}

#[test]
fn ready_topic_beyond_two_full_deferred_windows_is_visible_without_overtaking() {
    let db = fixture(2049, 2);
    let ready_head: i64 = 2048 * 2 + 1;
    db.execute(
        "UPDATE deliveries SET next_retry=0 WHERE order_seq=?1",
        [ready_head],
    )
    .unwrap();
    let snapshot = dispatch_snapshot_at(&db, 1, MAX_DELIVERY_WINDOW, 0).unwrap();
    assert_eq!(snapshot.heads.len(), MAX_DELIVERY_WINDOW);
    assert_eq!(snapshot.heads[0].order.get(), ready_head as u64);
    assert!(snapshot.heads[1..]
        .iter()
        .all(|row| row.retry_at.get() == 999));
    // Every topic also has a ready direct-target successor. They remain hidden
    // behind their deferred session-target head, including after rebind merge.
    assert!(snapshot.heads.iter().all(|row| row.order.get() % 2 == 1));
    db.execute(
        "UPDATE deliveries SET status='Acked' WHERE order_seq=?1",
        [ready_head],
    )
    .unwrap();
    let snapshot = dispatch_snapshot_at(&db, 1, 1, 0).unwrap();
    assert_eq!(snapshot.heads[0].order.get(), (ready_head + 1) as u64);
    // Once retries become ready, immutable FIFO order wins again; prioritizing
    // retry timestamps themselves would incorrectly starve older retries.
    let snapshot = dispatch_snapshot_at(&db, 1, MAX_DELIVERY_WINDOW, 999).unwrap();
    assert_eq!(snapshot.heads[0].order.get(), 1);
    assert!(snapshot
        .heads
        .windows(2)
        .all(|pair| pair[0].order < pair[1].order));
    let future_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    db.execute(
        "UPDATE deliveries SET next_retry=?1 WHERE status='Pending'",
        [future_seconds as i64],
    )
    .unwrap();
    db.execute(
        "UPDATE deliveries SET next_retry=0 WHERE order_seq=?1",
        [ready_head + 1],
    )
    .unwrap();
    assert_eq!(
        dispatch_snapshot(&db, 1, 1).unwrap().heads[0].order.get(),
        (ready_head + 1) as u64,
        "production readiness uses Unix seconds, not milliseconds"
    );
}
#[test]
fn dispatch_delivery_rebind_merges_direct_target_without_mutating_frozen_target() {
    let db = fixture(3, 4);
    let topic = TopicKey::from_delivery(-100, 2).unwrap();
    let session = SessionId::new("session-1").unwrap();
    db.execute(
        "DELETE FROM telegram_bindings WHERE session='session-2'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE telegram_bindings SET thread=2,binding_json=?1 WHERE session='session-1'",
        [serde_json::to_string(&(&topic, &session)).unwrap()],
    )
    .unwrap();
    assert_eq!(measured(&db, 1024).0, oracle(&db, 1024));
    let snapshot = dispatch_snapshot(&db, 1, 1024).unwrap();
    assert_eq!(snapshot.bindings.get(&topic), Some(&session));
    assert!(snapshot.heads.iter().any(|row| matches!(
        row.intent.target,
        DeliveryTarget::Telegram { thread: 1, .. }
    )));
    db.execute("DELETE FROM telegram_bindings", []).unwrap();
    assert_eq!(measured(&db, 1024).0, oracle(&db, 1024));
    assert!(dispatch_snapshot(&db, 1, 0).is_err());
    assert!(dispatch_snapshot(&db, -1, 1).is_err());
}
