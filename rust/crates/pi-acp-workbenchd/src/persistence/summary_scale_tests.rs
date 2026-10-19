//! A poisoned hot-state column proves summary listing never hydrates owners.
use super::query;
use crate::domain::{query::SafeInteger, tests::state, SessionId};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params, Connection,
};

#[test]
fn scale_10k_summaries_keyset_pages_do_not_read_history_or_hot_state() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    let tx = db.transaction().unwrap();
    let view = state();
    for i in 1..=10_000 {
        tx.execute("INSERT INTO sessions(id,created_seq,harness,cwd,status_json,revision,last_entry_seq,hot_state_json) VALUES (?1,?2,'Pi',?3,'\"Idle\"',0,0,'{}')", params![format!("summary-{i}"),i,view.cwd.as_str()]).unwrap();
    }
    tx.execute(
        "UPDATE store_meta SET value=10000 WHERE key='created_seq'",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    db.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Read {
            table_name: "entries" | "session_entries" | "contents" | "tools",
            ..
        }
        | AuthAction::Read {
            table_name: "sessions",
            column_name: "hot_state_json",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }))
    .unwrap();
    let mut cursor = None;
    let mut expected = 10_000;
    let mut wire_bytes = 0;
    let mut rows = 0;
    loop {
        let page = query::list(&db, cursor, Some(100)).unwrap();
        let wire = crate::domain::query::query_bytes("list", &page).unwrap();
        assert!(wire.len() <= crate::domain::query::MAX_QUERY_BYTES);
        wire_bytes += wire.len();
        for row in &page.sessions {
            assert_eq!(
                row.id,
                SessionId::new(format!("summary-{expected}")).unwrap()
            );
            assert_eq!(row.created_seq, SafeInteger::new(expected).unwrap());
            expected -= 1;
            rows += 1;
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(expected, 0);
    assert_eq!(rows, 10_000);
    eprintln!("scale summaries=10000 returned_rows={rows} wire_bytes={wire_bytes} forbidden_history_reads=0 forbidden_hot_state_reads=0");
}
