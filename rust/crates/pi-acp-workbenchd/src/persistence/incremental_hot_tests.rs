//! Structural tests: old history is poison; a tool patch cannot read BLOBs.
use super::{content, database::encode, query};
use crate::domain::{
    command::{AgentEvent, DomainCommand},
    query::{SafeInteger, SessionView},
    reducer::{transition, TransitionContext},
    tool::{ToolCall, ToolCallUpdate, ToolContent, ToolDetails, ToolStatus},
    ToolCallId,
};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params, Connection,
};
fn apply(
    db: &mut Connection,
    view: &mut SessionView,
    command: DomainCommand,
    context: &TransitionContext,
) {
    let change = transition(view, command, context, 0).unwrap().unwrap();
    let next = change.next.clone();
    let batch = query::commit(db, change).unwrap();
    assert_eq!(batch.revision, next.revision);
    *view = next;
}
#[test]
fn incremental_hot_commands_do_not_decode_100k_history_or_read_old_tool_bodies() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        view: SessionView,
    }
    let mut view = serde_json::from_str::<Fixture>(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
    .view;
    view.revision = SafeInteger::default();
    view.last_entry_seq = SafeInteger::default();
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    query::create(&mut db, &view).unwrap();
    db.execute(
        "INSERT INTO contents(id,kind,sha256,bytes,data) VALUES ('poison','Text',?1,1,x'ff')",
        ["a".repeat(64)],
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    for i in 1..=100_000 {
        tx.execute("INSERT INTO entries(entry_id,turn,role,content_id,metadata_json) VALUES (?1,'old-turn','Agent','poison','{}')", [format!("old-{i}")]).unwrap();
        tx.execute(
            "INSERT INTO session_entries VALUES (?1,?2,?3)",
            params![view.id.as_str(), i, format!("old-{i}")],
        )
        .unwrap();
    }
    view.last_entry_seq = SafeInteger::new(100_000).unwrap();
    tx.execute(
        "UPDATE sessions SET last_entry_seq=?2,hot_state_json=?3 WHERE id=?1",
        params![
            view.id.as_str(),
            view.last_entry_seq,
            encode(&view).unwrap()
        ],
    )
    .unwrap();
    tx.commit().unwrap();
    let session = view.id.clone();
    apply(
        &mut db,
        &mut view,
        DomainCommand::Prompt {
            session: session.clone(),
            prompt: crate::domain::Prompt::new("new prompt").unwrap(),
        },
        &TransitionContext::default(),
    );
    let turn = view.active_turn.clone().unwrap();
    apply(
        &mut db,
        &mut view,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::Text {
                turn: turn.clone(),
                message: None,
                text: "fresh text".into(),
            },
        },
        &TransitionContext::default(),
    );
    let tool = ToolCall {
        id: ToolCallId::generate(),
        turn: turn.clone(),
        title: "large tool".into(),
        status: ToolStatus::InProgress,
        details: ToolDetails {
            content: vec![ToolContent::Text {
                text: "t".repeat(1024 * 1024),
            }],
            ..Default::default()
        },
    };
    apply(
        &mut db,
        &mut view,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::ToolCall(ToolCallUpdate {
                id: tool.id.clone(),
                turn: turn.clone(),
                title: Some(tool.title.clone()),
                status: Some(ToolStatus::InProgress),
                details: crate::domain::tool::ToolDetailsPatch {
                    content: Some(tool.details.content.clone()),
                    ..Default::default()
                },
            }),
        },
        &TransitionContext::default(),
    );
    db.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Read {
            table_name: "entries" | "session_entries",
            ..
        }
        | AuthAction::Read {
            table_name: "contents",
            column_name: "data",
            ..
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }))
    .unwrap();
    let old = query::tool(&db, &session, &turn, &tool.id)
        .unwrap()
        .unwrap();
    let old_json = encode(&old).unwrap();
    let update = ToolCallUpdate {
        id: tool.id.clone(),
        turn: turn.clone(),
        title: None,
        status: Some(ToolStatus::Completed),
        details: Default::default(),
    };
    apply(
        &mut db,
        &mut view,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::ToolCall(update),
        },
        &TransitionContext { tool: Some(&old) },
    );
    let patched = query::tool(&db, &session, &turn, &tool.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        encode(&patched.content).unwrap(),
        encode(&old.content).unwrap()
    );
    assert_eq!(encode(&old).unwrap(), old_json);
    assert!(matches!(patched.status, ToolStatus::Completed));
    assert!(encode(&view).unwrap().len() < 2048);
    apply(
        &mut db,
        &mut view,
        DomainCommand::RequestCancel {
            session: session.clone(),
        },
        &TransitionContext::default(),
    );
    // Cancel appends its own fresh notice. The immutable-write replay check
    // legitimately names contents.data for that NEW ID, so lift the column
    // fence; the 100k poison history still proves it is not reconstructed.
    db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .unwrap();
    apply(
        &mut db,
        &mut view,
        DomainCommand::Cancel {
            session: session.clone(),
        },
        &TransitionContext::default(),
    );
    let loaded = query::view(&db, &session).unwrap();
    assert_eq!(loaded.last_entry_seq.get(), 100_002);
    assert_eq!(encode(&loaded).unwrap(), encode(&view).unwrap());
    // Full archive validation remains available, and detects the poison; no
    // routine command above is allowed to use it as an implicit hot-state read.
    db.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .unwrap();
    let mut statement = db.prepare("SELECT se.seq,e.entry_id,e.turn,e.role,e.message,e.content_id,e.image_id,e.metadata_json,c.kind,c.sha256,c.bytes,c.data FROM session_entries se JOIN entries e ON e.entry_id=se.entry_id JOIN contents c ON c.id=e.content_id WHERE se.session=?1 AND se.seq=1").unwrap();
    let mut rows = statement.query([session.as_str()]).unwrap();
    assert!(content::header(rows.next().unwrap().unwrap()).is_err());
}
