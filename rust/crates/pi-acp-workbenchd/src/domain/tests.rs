use super::{
    command::{AgentEvent, DomainCommand},
    error::DomainError,
    ids::{InteractionId, Prompt, SessionId, TurnId},
    interaction::{Interaction, InteractionKind},
    reducer::apply,
    session::{Harness, SessionConfig, SessionState, SessionStatus},
};

pub(super) fn state() -> SessionState {
    SessionState {
        id: SessionId::generate(),
        provider_session: None,
        harness: Harness::Pi,
        cwd: super::WorkspacePath::new("/tmp").unwrap(),
        status: SessionStatus::Idle,
        transcript: Default::default(),
        plan: Default::default(),
        active_turn: None,
        pending_interactions: Default::default(),
        usage: Default::default(),
        configuration_intent: None,
        config: SessionConfig {
            model: None,
            mode: None,
        },
        catalogue: Default::default(),
        revision: 0,
    }
}
fn prompt(state: &mut SessionState) -> TurnId {
    apply(
        state,
        DomainCommand::Prompt {
            session: state.id.clone(),
            prompt: Prompt::new("hello").unwrap(),
        },
    )
    .unwrap();
    state.active_turn.clone().unwrap()
}
fn interaction(state: &mut SessionState) {
    apply(
        state,
        DomainCommand::Agent {
            session: state.id.clone(),
            event: AgentEvent::Interaction(Interaction {
                id: InteractionId::generate(),
                kind: InteractionKind::Permission,
                title: "Allow?".into(),
                detail: String::new(),
                fields: vec![],
                options: vec![super::interaction::InteractionOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                }],
                expires_at: None,
            }),
        },
    )
    .unwrap();
}

#[test]
fn catalogue_patches_preserve_omission_clear_explicit_lists_and_keep_preferences_separate() {
    use super::catalogue::*;
    let mut state = state();
    let desired = super::ModeId::new("desired").unwrap();
    state.config.mode = Some(desired.clone());
    let initial = CataloguePatch {
        models: Some(vec![ModelChoice {
            id: super::ModelId::new("model").unwrap(),
            name: "Model".into(),
        }]),
        modes: Some(vec![ModeChoice {
            id: super::ModeId::new("observed").unwrap(),
            name: "Observed".into(),
        }]),
        commands: Some(vec![AvailableCommand {
            name: "review".into(),
            description: String::new(),
            input_hint: None,
        }]),
        current_model: Some(super::ModelId::new("model").unwrap()),
        current_mode: Some(super::ModeId::new("observed").unwrap()),
    };
    let apply_patch = |state: &mut SessionState, patch| {
        apply(
            state,
            DomainCommand::Agent {
                session: state.id.clone(),
                event: AgentEvent::Catalogue(patch),
            },
        )
        .unwrap()
    };
    assert_eq!(apply_patch(&mut state, initial).len(), 1);
    let before = state.catalogue.clone();
    assert!(apply_patch(&mut state, CataloguePatch::default()).is_empty());
    assert_eq!(state.catalogue, before);
    apply_patch(
        &mut state,
        CataloguePatch {
            models: Some(vec![]),
            commands: Some(vec![]),
            ..Default::default()
        },
    );
    assert!(state.catalogue.models.is_empty());
    assert!(state.catalogue.current_model.is_none());
    assert!(state.catalogue.commands.is_empty());
    assert_eq!(state.catalogue.modes, before.modes);
    assert_eq!(state.config.mode, Some(desired));
}

#[test]
fn busy_prompt_does_not_replace_active_turn() {
    let mut state = state();
    let turn = prompt(&mut state);
    let id = state.id.clone();
    let result = apply(
        &mut state,
        DomainCommand::Prompt {
            session: id,
            prompt: Prompt::new("second").unwrap(),
        },
    );
    assert!(matches!(result, Err(DomainError::Busy)));
    assert_eq!(state.active_turn, Some(turn));
    assert_eq!(state.transcript.entries.len(), 1);
}

#[test]
fn cancelled_turn_cannot_finish_or_append_to_replacement() {
    let mut state = state();
    let old = prompt(&mut state);
    interaction(&mut state);
    let id = state.id.clone();
    let events = apply(
        &mut state,
        DomainCommand::Cancel {
            session: id.clone(),
        },
    )
    .unwrap();
    assert_eq!(events.len(), 2);
    assert!(state.pending_interactions.is_empty());
    let current = prompt(&mut state);
    for event in [
        AgentEvent::Text {
            turn: old.clone(),
            text: "late".into(),
            message: None,
        },
        AgentEvent::Finished { turn: old },
    ] {
        assert!(apply(
            &mut state,
            DomainCommand::Agent {
                session: id.clone(),
                event
            }
        )
        .unwrap()
        .is_empty());
    }
    assert_eq!(state.active_turn, Some(current));
    assert_eq!(state.transcript.entries.len(), 2);
}

#[test]
fn invalid_answer_does_not_consume_interaction_and_valid_answer_resumes_turn() {
    use super::interaction::{InteractionAnswer, InteractionResolution, InteractionResponse};
    let mut state = state();
    prompt(&mut state);
    interaction(&mut state);
    let id = state.pending_interactions.keys().next().unwrap().clone();
    let command = |response| DomainCommand::AnswerInteraction {
        session: state.id.clone(),
        answer: InteractionAnswer {
            interaction: id.clone(),
            response,
        },
    };
    let invalid = command(InteractionResponse::Permission {
        option: "not-offered".into(),
    });
    let valid = command(InteractionResponse::Text("allow".into()));
    assert!(apply(&mut state, invalid).is_err());
    assert!(state.pending_interactions.contains_key(&id));
    let events = apply(&mut state, valid.clone()).unwrap();
    assert!(
        matches!(&events[0], super::DomainEvent::InteractionResolved {
        resolution: InteractionResolution::Answered(InteractionAnswer {
            response: InteractionResponse::Permission { option }, ..
        }), ..
    } if option == "allow")
    );
    assert!(state.pending_interactions.is_empty());
    assert!(matches!(state.status, SessionStatus::Running));
    assert!(matches!(
        apply(&mut state, valid),
        Err(DomainError::InteractionNotFound)
    ));
}

#[test]
fn tool_partial_updates_preserve_fields_and_scope_reused_ids_to_turns() {
    use super::tool::{ToolCallUpdate, ToolStatus};
    let mut state = state();
    let turn = prompt(&mut state);
    let session = state.id.clone();
    let tool_id = super::ToolCallId::new("call:1").unwrap();
    for update in [
        ToolCallUpdate {
            id: tool_id.clone(),
            turn: turn.clone(),
            title: Some("Read".into()),
            status: Some(ToolStatus::InProgress),
            details: super::tool::ToolDetailsPatch {
                kind: Some(super::tool::ToolKind::Edit),
                name: Some("apply_patch".into()),
                content: Some(vec![super::tool::ToolContent::Diff {
                    path: "/display/only".into(),
                    old_text: None,
                    new_text: "new".into(),
                }]),
                locations: Some(vec![super::tool::ToolLocation {
                    path: "/display/only".into(),
                    line: Some(0),
                }]),
            },
        },
        ToolCallUpdate {
            id: tool_id.clone(),
            turn: turn.clone(),
            title: None,
            status: Some(ToolStatus::Completed),
            details: Default::default(),
        },
    ] {
        apply(
            &mut state,
            DomainCommand::Agent {
                session: session.clone(),
                event: AgentEvent::ToolCall(update),
            },
        )
        .unwrap();
    }
    let tool = &state.transcript.tools[&turn][&tool_id];
    assert_eq!(tool.title, "Read");
    assert_eq!(tool.status, ToolStatus::Completed);
    assert_eq!(tool.details.kind, Some(super::tool::ToolKind::Edit));
    assert_eq!(tool.details.name.as_deref(), Some("apply_patch"));
    assert_eq!(tool.details.content.len(), 1);
    assert_eq!(tool.details.locations[0].line, Some(0));
    apply(
        &mut state,
        DomainCommand::Agent {
            session: session.clone(),
            event: AgentEvent::Finished { turn: turn.clone() },
        },
    )
    .unwrap();
    let next = prompt(&mut state);
    apply(
        &mut state,
        DomainCommand::Agent {
            session,
            event: AgentEvent::ToolCall(ToolCallUpdate {
                id: tool_id.clone(),
                turn: next.clone(),
                title: Some("Write".into()),
                status: None,
                details: Default::default(),
            }),
        },
    )
    .unwrap();
    assert_eq!(state.transcript.tools[&turn][&tool_id].title, "Read");
    assert_eq!(state.transcript.tools[&next][&tool_id].title, "Write");
    assert_eq!(
        state.transcript.tools[&next][&tool_id].details,
        super::tool::ToolDetails::default()
    );
}

#[test]
fn crash_clears_turn_and_pending_interactions() {
    let mut state = state();
    prompt(&mut state);
    interaction(&mut state);
    let id = state.id.clone();
    let events = apply(
        &mut state,
        DomainCommand::Agent {
            session: id,
            event: AgentEvent::Crashed {
                reason: "EOF".into(),
            },
        },
    )
    .unwrap();
    assert_eq!(events.len(), 2);
    assert!(state.active_turn.is_none());
    assert!(state.pending_interactions.is_empty());
    assert!(matches!(state.status, SessionStatus::Failed(_)));
}

#[test]
fn plan_usage_and_settings_update_domain_state() {
    let mut state = state();
    let id = state.id.clone();
    apply(
        &mut state,
        DomainCommand::SetModel {
            session: id.clone(),
            model: super::ModelId::new("model").unwrap(),
        },
    )
    .unwrap();
    assert_eq!(
        state.config.model.as_ref().map(super::ModelId::as_str),
        Some("model")
    );
    prompt(&mut state);
    let plan = super::plan::Plan {
        items: vec![super::plan::PlanItem {
            description: "实现".into(),
            status: super::plan::PlanStatus::InProgress,
        }],
    };
    apply(
        &mut state,
        DomainCommand::Agent {
            session: id.clone(),
            event: AgentEvent::Plan(plan.clone()),
        },
    )
    .unwrap();
    apply(
        &mut state,
        DomainCommand::Agent {
            session: id,
            event: AgentEvent::Usage {
                input_tokens: 42,
                output_tokens: 7,
            },
        },
    )
    .unwrap();
    assert_eq!(state.plan, plan);
    assert_eq!(state.usage.input_tokens, 42);
    assert_eq!(state.usage.output_tokens, 7);
}

#[test]
fn catalogue_ids_allow_provider_qualification_but_reject_invalid_inputs() {
    for value in ["anthropic/claude-model", "provider:model@2026", "mode-1"] {
        let id = super::ModelId::new(value).unwrap();
        assert_eq!(
            serde_json::from_str::<super::ModelId>(&serde_json::to_string(&id).unwrap()).unwrap(),
            id
        );
    }
    for value in ["", " ", " model", "model\nsecret", ".."] {
        assert!(super::ModelId::new(value).is_err());
        assert!(
            serde_json::from_str::<super::ModeId>(&serde_json::to_string(value).unwrap()).is_err()
        );
    }
}

#[test]
fn identifiers_validate_construction_and_deserialization() {
    for invalid in ["", ".", "..", "../escape", "a/b", "a\\b", "a b", "中文"] {
        assert!(SessionId::new(invalid).is_err(), "{invalid:?}");
        let encoded = serde_json::to_string(invalid).unwrap();
        assert!(
            serde_json::from_str::<SessionId>(&encoded).is_err(),
            "{invalid:?}"
        );
    }
    assert!(SessionId::new("a".repeat(201)).is_err());
    for valid in ["session-1", "native_123", "a.b"] {
        let id = SessionId::new(valid).unwrap();
        let encoded = serde_json::to_string(&id).unwrap();
        assert_eq!(serde_json::from_str::<SessionId>(&encoded).unwrap(), id);
    }
}

#[test]
fn workspaces_validate_serde_and_normalize_lexically() {
    use super::WorkspacePath;
    for invalid in ["", "relative/path", "/tmp/../escape", "/tmp/\0bad"] {
        assert!(WorkspacePath::new(invalid).is_err());
        assert!(
            serde_json::from_str::<WorkspacePath>(&serde_json::to_string(invalid).unwrap())
                .is_err()
        );
    }
    let path = WorkspacePath::new("/tmp//项目/./workspace/").unwrap();
    assert_eq!(path.as_str(), "/tmp/项目/workspace");
    assert_eq!(
        serde_json::from_str::<WorkspacePath>(&serde_json::to_string(&path).unwrap()).unwrap(),
        path
    );
}

#[test]
fn prompts_validate_deserialization_without_losing_unicode() {
    for invalid in [String::new(), " \n\t".into(), "a".repeat(100_001)] {
        let encoded = serde_json::to_string(&invalid).unwrap();
        assert!(serde_json::from_str::<Prompt>(&encoded).is_err());
    }
    let prompt = Prompt::new("你好 🌏\nhello").unwrap();
    assert_eq!(
        serde_json::from_str::<Prompt>(&serde_json::to_string(&prompt).unwrap()).unwrap(),
        prompt
    );
}
