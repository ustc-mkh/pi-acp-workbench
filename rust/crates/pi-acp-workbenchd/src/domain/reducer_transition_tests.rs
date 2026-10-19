use super::*;
use crate::domain::{
    query::MAX_SAFE_INTEGER,
    tool::{ToolCallUpdate, ToolDetailsPatch, ToolStatus},
};
fn fixture() -> SessionView {
    #[derive(serde::Deserialize)]
    struct Fixture {
        view: SessionView,
    }
    serde_json::from_str::<Fixture>(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
    .view
}
fn agent(view: &SessionView, event: AgentEvent) -> DomainCommand {
    DomainCommand::Agent {
        session: view.id.clone(),
        event,
    }
}
#[test]
fn incremental_prompt_text_cancel_never_require_old_entries_and_advance_once() {
    let mut view = fixture();
    view.last_entry_seq = SafeInteger::new(100000).unwrap();
    let before = serde_json::to_vec(&view).unwrap();
    let change = transition(
        &view,
        DomainCommand::Prompt {
            session: view.id.clone(),
            prompt: Prompt::new("hello").unwrap(),
        },
        &TransitionContext::default(),
        0,
    )
    .unwrap()
    .unwrap();
    assert_eq!(serde_json::to_vec(&view).unwrap(), before);
    assert_eq!(change.expected_revision, view.revision);
    assert_eq!(change.next.revision.get(), view.revision.get() + 1);
    assert_eq!(change.next.last_entry_seq.get(), 100001);
    assert_eq!(change.append.len(), 1);
    assert_eq!(change.append[0].role, EntryRole::User);
    let batch = change.batch(view.last_entry_seq).unwrap();
    assert_eq!(batch.entries[0].seq.get(), 100001);
    view = change.next;
    let turn = view.active_turn.clone().unwrap();
    let change = transition(
        &view,
        agent(
            &view,
            AgentEvent::Text {
                turn: turn.clone(),
                text: "new text".into(),
                message: None,
            },
        ),
        &TransitionContext::default(),
        0,
    )
    .unwrap()
    .unwrap();
    assert_eq!(change.append[0].text.text, "new text");
    assert!(serde_json::to_string(&change.next).unwrap().len() < 2048);
    view = change.next;
    let change = transition(
        &view,
        DomainCommand::RequestCancel {
            session: view.id.clone(),
        },
        &TransitionContext::default(),
        0,
    )
    .unwrap()
    .unwrap();
    view = change.next;
    assert!(transition(
        &view,
        DomainCommand::RequestCancel {
            session: view.id.clone()
        },
        &TransitionContext::default(),
        0
    )
    .unwrap()
    .is_none());
    assert!(transition(
        &view,
        agent(
            &view,
            AgentEvent::Text {
                turn,
                text: "late".into(),
                message: None
            }
        ),
        &TransitionContext::default(),
        0
    )
    .unwrap()
    .is_none());
    let change = transition(
        &view,
        DomainCommand::Cancel {
            session: view.id.clone(),
        },
        &TransitionContext::default(),
        0,
    )
    .unwrap()
    .unwrap();
    assert!(change.next.active_turn.is_none());
    assert_eq!(change.contents.len(), 1);
    assert_eq!(change.deliveries.len(), 1);
    assert_eq!(change.deliveries[0].revision, change.next.revision);
}
#[test]
fn incremental_noops_at_revision_exhaustion_stay_noops_and_wrong_turns_write_nothing() {
    let mut view = fixture();
    view.revision = SafeInteger::new(MAX_SAFE_INTEGER).unwrap();
    assert!(transition(
        &view,
        agent(
            &view,
            AgentEvent::AvailableCommands(view.catalogue.commands.clone())
        ),
        &TransitionContext::default(),
        0
    )
    .unwrap()
    .is_none());
    assert!(transition(
        &view,
        DomainCommand::SetModel {
            session: view.id.clone(),
            model: ModelId::new("different").unwrap()
        },
        &TransitionContext::default(),
        0
    )
    .is_err());
    view.active_turn = Some(TurnId::generate());
    assert!(transition(
        &view,
        agent(
            &view,
            AgentEvent::Finished {
                turn: TurnId::generate()
            }
        ),
        &TransitionContext::default(),
        0
    )
    .unwrap()
    .is_none());
}
#[test]
fn incremental_tool_status_patch_preserves_big_content_refs_without_old_body() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        tools: Vec<ToolHeader>,
    }
    let old = serde_json::from_str::<Fixture>(include_str!(
        "../../../../../test/fixtures/rewrite/ipc-v3.json"
    ))
    .unwrap()
    .tools
    .remove(0);
    let mut view = fixture();
    view.active_turn = Some(old.turn.clone());
    view.status = SessionStatus::Running;
    let command = |status| {
        agent(
            &view,
            AgentEvent::ToolCall(ToolCallUpdate {
                id: old.id.clone(),
                turn: old.turn.clone(),
                title: None,
                status: Some(status),
                details: ToolDetailsPatch::default(),
            }),
        )
    };
    let context = TransitionContext { tool: Some(&old) };
    assert!(
        transition(&view, command(ToolStatus::Completed), &context, 0)
            .unwrap()
            .is_none()
    );
    let change = transition(&view, command(ToolStatus::Failed), &context, 0)
        .unwrap()
        .unwrap();
    let update = &change.tool_updates[0];
    assert!(update.contents.is_empty());
    assert_eq!(
        serde_json::to_vec(&update.header.content).unwrap(),
        serde_json::to_vec(&old.content).unwrap()
    );
    assert!(serde_json::to_string(&change.next).unwrap().len() < 2048);
    let mut wrong = old.clone();
    wrong.turn = TurnId::generate();
    assert!(transition(
        &view,
        command(ToolStatus::Failed),
        &TransitionContext { tool: Some(&wrong) },
        0
    )
    .is_err());
}
