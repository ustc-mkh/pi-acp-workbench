//! Poisoned unrelated rows prove normal reads never deserialize retained history.
use super::*;
use crate::{
    domain::DeliveryId,
    telegram::{
        command::{RejectionReason, TelegramAction, TelegramCommand},
        state::InboxOutcome,
        types::UpdateId,
    },
};
use rusqlite::StatementStatus;
#[test]
fn telegram_100k_completed_inbox_is_not_read_by_offset_pending_admit_or_complete() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    execute_action(&db, Action::Claim(UserId::new(1).unwrap()), 8).unwrap();
    let tx = db.transaction().unwrap();
    for id in 0..100_000i64 {
        // Valid SQL JSON, intentionally invalid typed rows: accessing one fails.
        tx.execute("INSERT INTO telegram_inbox(bot_id,update_id,command_json,operation,status,outcome_json) VALUES (1,?1,'{}',?2,'Completed','{}')", params![id, format!("telegram-update-{id}")]).unwrap();
    }
    // An unrelated poisoned callback must not be loaded during admission.
    tx.execute(
        "INSERT INTO telegram_callbacks VALUES (1,'unrelated','{}',100, NULL)",
        [],
    )
    .unwrap();
    tx.execute("UPDATE telegram_meta SET offset=100000", [])
        .unwrap();
    tx.commit().unwrap();
    let topic = TopicKey::from_delivery(-100, 1).unwrap();
    let session = SessionId::generate();
    execute_action(&db, Action::Bind(topic.clone(), session.clone()), 8).unwrap();
    let key = CallbackKey::for_option(&DeliveryId::generate(), 0);
    assert!(callback(&db, 1, &key).unwrap().is_none());
    assert!(matches!(
        execute_action(&db, Action::Offset, 8).unwrap(),
        Output::Offset(100000)
    ));
    assert!(pending(&db, 1, 100000, 8).unwrap().is_empty());
    assert_eq!(binding(&db, 1, &topic).unwrap(), Some(session.clone()));
    assert_eq!(
        super::super::delivery::dispatch_snapshot(&db, 1, 8)
            .unwrap()
            .bindings
            .get(&topic),
        Some(&session)
    );
    let make_admission = |expected| Admission {
        id: UpdateId::new(100000).unwrap(),
        sender: Some(UserId::new(2).unwrap()),
        command: Some(TelegramCommand {
            topic: topic.clone(),
            action: TelegramAction::Rejected(RejectionReason::InvalidCallback),
        }),
        callback: None,
        callback_query: None,
        expected_binding: expected,
    };
    assert!(matches!(
        execute_action(&db, Action::Admit(make_admission(None)), 8),
        Err(DomainError::Backpressure)
    ));
    assert!(matches!(
        execute_action(&db, Action::Admit(make_admission(Some(session))), 8).unwrap(),
        Output::Admission(AdmissionResult::Accepted)
    ));
    assert_eq!(pending(&db, 1, 100001, 8).unwrap().len(), 1);
    execute_action(
        &db,
        Action::Complete(UpdateId::new(100000).unwrap(), InboxOutcome::Applied),
        8,
    )
    .unwrap();
    assert!(pending(&db, 1, 100001, 8).unwrap().is_empty());
    // The actual predicate/order is covered by a status index and performs
    // constant work even with all 100k poisoned rows retained.
    let mut statement = db.prepare(&format!("SELECT {INBOX_COLUMNS} FROM telegram_inbox WHERE bot_id=?1 AND status='Pending' ORDER BY update_id LIMIT ?2")).unwrap();
    assert!(statement
        .query(params![1, 8])
        .unwrap()
        .next()
        .unwrap()
        .is_none());
    assert!(statement.get_status(StatementStatus::VmStep) < 50);
    let plan = db.prepare("EXPLAIN QUERY PLAN SELECT update_id FROM telegram_inbox WHERE bot_id=1 AND status='Pending' ORDER BY update_id LIMIT 8").unwrap().query_map([], |row| row.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert!(
        plan.iter()
            .any(|line| line.contains("telegram_inbox_pending")),
        "{plan:?}"
    );
}
