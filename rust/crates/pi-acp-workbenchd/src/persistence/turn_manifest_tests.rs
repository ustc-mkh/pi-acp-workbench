//! Atomic immutable turn manifests survive source removal and physical reopen.
use super::{
    database::Database,
    sqlite_tests::{open, Root},
};
use crate::domain::{
    command::{AgentEvent, DomainCommand},
    query::SessionView,
    reducer::{transition, TransitionContext},
    EntryId, SessionId,
};
pub(super) fn initial() -> SessionView {
    #[derive(serde::Deserialize)]
    struct Fixture {
        view: SessionView,
    }
    let mut view = serde_json::from_str::<Fixture>(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
    .view;
    view.id = SessionId::generate();
    view.revision = Default::default();
    view.last_entry_seq = Default::default();
    view
}
pub(super) async fn apply(db: &Database, view: &mut SessionView, command: DomainCommand) {
    let change = transition(view, command, &TransitionContext::default(), 0)
        .unwrap()
        .unwrap();
    let next = change.next.clone();
    let batch = db.commit(change).await.unwrap();
    assert_eq!(batch.revision, next.revision);
    *view = next;
}
#[tokio::test]
async fn incremental_turn_manifest_freezes_agent_links_and_survives_remove_and_reopen() {
    let root = Root::new();
    let (lease, db) = open(&root.data()).await;
    let mut view = initial();
    db.create(view.clone()).await.unwrap();
    let session = view.id.clone();
    apply(
        &db,
        &mut view,
        DomainCommand::Prompt {
            session: session.clone(),
            prompt: crate::domain::Prompt::new("prompt").unwrap(),
        },
    )
    .await;
    let turn = view.active_turn.clone().unwrap();
    for event in [
        AgentEvent::Text {
            turn: turn.clone(),
            text: "one".into(),
            message: None,
        },
        AgentEvent::Thought {
            turn: turn.clone(),
            text: "private thought".into(),
            message: None,
        },
        AgentEvent::Text {
            turn: turn.clone(),
            text: "two".into(),
            message: None,
        },
    ] {
        apply(
            &db,
            &mut view,
            DomainCommand::Agent {
                session: session.clone(),
                event,
            },
        )
        .await;
    }
    apply(
        &db,
        &mut view,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::Finished { turn: turn.clone() },
        },
    )
    .await;
    let delivery = format!("turn-{turn}");
    db.remove(session.clone(), None).await.unwrap();
    db.shutdown().await.unwrap();
    let db = Database::open(root.data(), &lease).await.unwrap();
    assert!(matches!(
        db.view(session).await,
        Err(super::database::StoreError::NotFound)
    ));
    let page = super::payload::PayloadStore::new(db.clone())
        .delivery_page(
            &crate::domain::DeliveryId::new(delivery.clone()).unwrap(),
            Default::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| entry.seq.get())
            .collect::<Vec<_>>(),
        [2, 4]
    );
    assert!(page.next_seq.is_none());
    db.shutdown().await.unwrap();
    let sql = rusqlite::Connection::open(root.data().join("workbench.sqlite3")).unwrap();
    let rows = sql.prepare("SELECT de.seq,de.entry_id,CAST(c.data AS TEXT) FROM delivery_entries de JOIN entries e ON e.entry_id=de.entry_id JOIN contents c ON c.id=e.content_id WHERE de.delivery_id=?1 ORDER BY de.seq").unwrap().query_map([delivery], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(
        rows.iter().map(|r| (r.0, r.2.as_str())).collect::<Vec<_>>(),
        [(2, "one"), (4, "two")]
    );
    for (_, id, _) in rows {
        EntryId::new(id).unwrap();
    }
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM deliveries WHERE status='Pending' AND json_extract(payload_json,'$.Turn') IS NOT NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
