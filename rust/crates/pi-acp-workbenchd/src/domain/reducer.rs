//! Transport-independent session state transitions. Only the session owner applies them.
use super::{
    command::{AgentEvent, DomainCommand},
    error::DomainError,
    event::DomainEvent,
    ids::{EntryId, TurnId},
    interaction::InteractionResolution,
    session::{SessionState, SessionStatus},
    transcript::{EntryRole, TranscriptEntry},
};

pub fn apply(
    state: &mut SessionState,
    command: DomainCommand,
) -> Result<Vec<DomainEvent>, DomainError> {
    apply_at(state, command, 0)
}

/// Explicit wall-clock input keeps expiry transitions deterministic in tests.
pub fn apply_at(
    state: &mut SessionState,
    command: DomainCommand,
    now: u64,
) -> Result<Vec<DomainEvent>, DomainError> {
    let session = match &command {
        DomainCommand::Prompt { session, .. }
        | DomainCommand::Cancel { session }
        | DomainCommand::RequestCancel { session }
        | DomainCommand::AnswerInteraction { session, .. }
        | DomainCommand::SetModel { session, .. }
        | DomainCommand::SetMode { session, .. }
        | DomainCommand::PrepareConfiguration { session, .. }
        | DomainCommand::CommitConfiguration { session }
        | DomainCommand::Agent { session, .. } => session,
        DomainCommand::Inspect(session) => session,
        _ => return Err(DomainError::NotFound(state.id.clone())),
    };
    if session != &state.id {
        return Err(DomainError::NotFound(session.clone()));
    }
    let session = state.id.clone();
    match command {
        DomainCommand::Prompt { prompt, .. } => {
            if state.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            let turn = TurnId::generate();
            let entry = EntryId::generate();
            state.active_turn = Some(turn.clone());
            state.status = SessionStatus::Running;
            state.transcript.entries.push(TranscriptEntry {
                id: entry.clone(),
                turn: turn.clone(),
                role: EntryRole::User,
                text: prompt.as_str().to_owned(),
                message: None,
                image: None,
            });
            Ok(vec![
                DomainEvent::TurnStarted {
                    session: session.clone(),
                    turn: turn.clone(),
                },
                DomainEvent::UserPromptAdded {
                    session,
                    turn,
                    entry,
                    prompt: prompt.as_str().to_owned(),
                },
            ])
        }
        DomainCommand::RequestCancel { .. } => {
            if state.active_turn.is_none() {
                return Err(DomainError::NoActiveTurn);
            }
            if matches!(state.status, SessionStatus::Cancelling) {
                return Ok(vec![]);
            }
            state.status = SessionStatus::Cancelling;
            Ok(vec![DomainEvent::SessionLoaded(state.snapshot())])
        }
        DomainCommand::Cancel { .. } => {
            let turn = state.active_turn.take().ok_or(DomainError::NoActiveTurn)?;
            let mut events = cancel_interactions(state);
            state.status = SessionStatus::Idle;
            events.push(DomainEvent::TurnCancelled { session, turn });
            Ok(events)
        }
        DomainCommand::AnswerInteraction { answer, .. } => {
            if matches!(state.status, SessionStatus::Cancelling) {
                return Err(DomainError::Busy);
            }
            let interaction = state
                .pending_interactions
                .get(&answer.interaction)
                .ok_or(DomainError::InteractionNotFound)?;
            let answer = interaction.validate_answer(answer, now)?;
            state.pending_interactions.remove(&answer.interaction);
            state.status = if state.pending_interactions.is_empty() {
                SessionStatus::Running
            } else {
                SessionStatus::Waiting
            };
            Ok(vec![DomainEvent::InteractionResolved {
                session,
                resolution: InteractionResolution::Answered(answer),
            }])
        }
        DomainCommand::PrepareConfiguration { intent, .. } => {
            if state.active_turn.is_some() || state.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            validate_config(state, &intent.requested)?;
            if (intent.requested.model != state.config.model && intent.restore.model.is_none())
                || (intent.requested.mode != state.config.mode && intent.restore.mode.is_none())
            {
                return Err(DomainError::Protocol(
                    "provider setting has no known recovery baseline".into(),
                ));
            }
            state.configuration_intent = Some(intent);
            Ok(vec![DomainEvent::SessionLoaded(state.snapshot())])
        }
        DomainCommand::CommitConfiguration { .. } => {
            if state.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            let intent = state
                .configuration_intent
                .as_ref()
                .ok_or_else(|| DomainError::Protocol("configuration intent is missing".into()))?;
            validate_observed(
                &intent.requested,
                state.catalogue.current_model.as_ref(),
                state.catalogue.current_mode.as_ref(),
            )?;
            state.config = intent.requested.clone();
            state.configuration_intent = None;
            Ok(vec![DomainEvent::SessionLoaded(state.snapshot())])
        }
        DomainCommand::SetModel { model, .. } => {
            if state.active_turn.is_some() || state.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            if !state.catalogue.models.is_empty()
                && !state
                    .catalogue
                    .models
                    .iter()
                    .any(|choice| choice.id == model)
            {
                return Err(DomainError::Protocol(
                    "model is not in provider catalogue".into(),
                ));
            }
            state.config.model = Some(model);
            Ok(vec![DomainEvent::SessionLoaded(state.snapshot())])
        }
        DomainCommand::SetMode { mode, .. } => {
            if state.active_turn.is_some() || state.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            if !state.catalogue.modes.is_empty()
                && !state.catalogue.modes.iter().any(|choice| choice.id == mode)
            {
                return Err(DomainError::Protocol(
                    "mode is not in provider catalogue".into(),
                ));
            }
            state.config.mode = Some(mode);
            Ok(vec![DomainEvent::SessionLoaded(state.snapshot())])
        }
        DomainCommand::Inspect(_) => Ok(vec![DomainEvent::SessionLoaded(state.snapshot())]),
        DomainCommand::Agent { event, .. } => apply_agent(state, event),
        _ => unreachable!("validated command above"),
    }
}

fn validate_observed(
    config: &super::session::SessionConfig,
    model: Option<&super::ModelId>,
    mode: Option<&super::ModeId>,
) -> Result<(), DomainError> {
    if config
        .model
        .as_ref()
        .is_some_and(|expected| model != Some(expected))
        || config
            .mode
            .as_ref()
            .is_some_and(|expected| mode != Some(expected))
    {
        return Err(DomainError::Protocol(
            "provider did not confirm requested settings".into(),
        ));
    }
    Ok(())
}

fn validate_config(
    state: &SessionState,
    config: &super::session::SessionConfig,
) -> Result<(), DomainError> {
    if config.model.as_ref().is_some_and(|id| {
        !state.catalogue.models.is_empty()
            && !state.catalogue.models.iter().any(|choice| &choice.id == id)
    }) {
        return Err(DomainError::Protocol(
            "model is not in provider catalogue".into(),
        ));
    }
    if config.mode.as_ref().is_some_and(|id| {
        !state.catalogue.modes.is_empty()
            && !state.catalogue.modes.iter().any(|choice| &choice.id == id)
    }) {
        return Err(DomainError::Protocol(
            "mode is not in provider catalogue".into(),
        ));
    }
    Ok(())
}

fn cancel_interactions(state: &mut SessionState) -> Vec<DomainEvent> {
    std::mem::take(&mut state.pending_interactions)
        .into_keys()
        .map(|interaction| DomainEvent::InteractionResolved {
            session: state.id.clone(),
            resolution: InteractionResolution::Cancelled { interaction },
        })
        .collect()
}

fn apply_agent(
    state: &mut SessionState,
    event: AgentEvent,
) -> Result<Vec<DomainEvent>, DomainError> {
    let session = state.id.clone();
    if matches!(state.status, SessionStatus::Cancelling)
        && !matches!(event, AgentEvent::Crashed { .. })
    {
        return Ok(vec![]);
    }
    // Late responses from a cancelled/replaced turn may not mutate the current state.
    let event_turn = match &event {
        AgentEvent::Text { turn, .. }
        | AgentEvent::Image { turn, .. }
        | AgentEvent::Thought { turn, .. }
        | AgentEvent::Finished { turn } => Some(turn),
        AgentEvent::ToolCall(update) => Some(&update.turn),
        _ => None,
    };
    if event_turn.is_some_and(|turn| state.active_turn.as_ref() != Some(turn)) {
        return Ok(vec![]);
    }
    if state.active_turn.is_none()
        && !matches!(
            event,
            AgentEvent::Crashed { .. }
                | AgentEvent::Catalogue(_)
                | AgentEvent::ConfigurationRestored(_)
                | AgentEvent::AvailableCommands(_)
        )
    {
        return Ok(vec![]);
    }
    match event {
        AgentEvent::ConfigurationRestored(patch) => {
            let Some(intent) = &state.configuration_intent else {
                return Ok(vec![]);
            };
            validate_observed(
                &intent.restore,
                patch.current_model.as_ref(),
                patch.current_mode.as_ref(),
            )?;
            state.catalogue.apply(patch);
            state.configuration_intent = None;
            Ok(vec![
                DomainEvent::CatalogueChanged {
                    session: session.clone(),
                    catalogue: state.catalogue.clone(),
                },
                DomainEvent::SessionLoaded(state.snapshot()),
            ])
        }
        AgentEvent::Catalogue(patch) => {
            let previous = state.catalogue.clone();
            state.catalogue.apply(patch);
            if state.catalogue == previous {
                return Ok(vec![]);
            }
            Ok(vec![DomainEvent::CatalogueChanged {
                session,
                catalogue: state.catalogue.clone(),
            }])
        }
        AgentEvent::AvailableCommands(commands) => {
            state.catalogue.commands = commands;
            Ok(vec![DomainEvent::CatalogueChanged {
                session,
                catalogue: state.catalogue.clone(),
            }])
        }
        AgentEvent::ProviderSessionAttached { id } => {
            if state
                .provider_session
                .as_ref()
                .is_some_and(|current| current != &id)
            {
                return Err(DomainError::Protocol(
                    "provider session identity changed".into(),
                ));
            }
            state.provider_session = Some(id.clone());
            Ok(vec![DomainEvent::ProviderSessionAttached {
                session,
                provider_session: id,
            }])
        }
        AgentEvent::Text {
            turn,
            text,
            message,
        } => {
            let entry = EntryId::generate();
            state.transcript.entries.push(TranscriptEntry {
                id: entry.clone(),
                turn: turn.clone(),
                role: EntryRole::Agent,
                text: text.clone(),
                message: message.clone(),
                image: None,
            });
            Ok(vec![DomainEvent::AgentText {
                session,
                turn,
                entry,
                message,
                text,
            }])
        }
        AgentEvent::Image {
            turn,
            asset,
            message,
        } => {
            let entry = EntryId::generate();
            let image = asset.image().clone();
            state.transcript.entries.push(TranscriptEntry {
                id: entry.clone(),
                turn: turn.clone(),
                role: EntryRole::Agent,
                text: String::new(),
                message: message.clone(),
                image: Some(image.clone()),
            });
            Ok(vec![DomainEvent::AgentImage {
                session,
                turn,
                entry,
                message,
                image,
            }])
        }
        AgentEvent::Thought {
            turn,
            text,
            message,
        } => {
            let entry = EntryId::generate();
            state.transcript.entries.push(TranscriptEntry {
                id: entry.clone(),
                turn: turn.clone(),
                role: EntryRole::Thought,
                text: text.clone(),
                message: message.clone(),
                image: None,
            });
            Ok(vec![DomainEvent::AgentThought {
                session,
                turn,
                entry,
                message,
                text,
            }])
        }
        AgentEvent::ToolCall(update) => {
            let tool = state
                .transcript
                .tools
                .entry(update.turn.clone())
                .or_default()
                .entry(update.id.clone())
                .or_insert_with(|| super::tool::ToolCall {
                    id: update.id,
                    turn: update.turn.clone(),
                    title: String::new(),
                    status: super::tool::ToolStatus::Pending,
                    details: Default::default(),
                });
            if let Some(title) = update.title {
                tool.title = title;
            }
            if let Some(status) = update.status {
                tool.status = status;
            }
            update.details.apply(&mut tool.details);
            Ok(vec![DomainEvent::ToolCallChanged {
                session,
                tool: tool.clone(),
            }])
        }
        AgentEvent::Plan(plan) => {
            state.plan = plan.clone();
            Ok(vec![DomainEvent::PlanChanged { session, plan }])
        }
        AgentEvent::Usage {
            input_tokens,
            output_tokens,
        } => {
            state.usage.input_tokens = input_tokens;
            state.usage.output_tokens = output_tokens;
            Ok(vec![DomainEvent::UsageChanged {
                session,
                input_tokens,
                output_tokens,
            }])
        }
        AgentEvent::ContextUsage { used, size } => {
            if size == 0 || used > size {
                return Err(DomainError::Protocol("invalid context occupancy".into()));
            }
            state.usage.context_used = Some(used);
            state.usage.context_size = Some(size);
            Ok(vec![DomainEvent::ContextUsageChanged {
                session,
                used,
                size,
            }])
        }
        AgentEvent::Finished { turn } => {
            let mut events = cancel_interactions(state);
            state.active_turn = None;
            state.status = SessionStatus::Idle;
            events.push(DomainEvent::TurnFinished { session, turn });
            Ok(events)
        }
        AgentEvent::Crashed { reason } => {
            let mut events = cancel_interactions(state);
            state.active_turn = None;
            state.status = SessionStatus::Failed(reason.clone());
            events.push(DomainEvent::SessionError {
                session,
                error: reason,
            });
            Ok(events)
        }
        AgentEvent::Interaction(interaction) => {
            interaction.validate_definition()?;
            if state.pending_interactions.contains_key(&interaction.id) {
                return Ok(vec![]);
            }
            if state.pending_interactions.len() >= 32 {
                return Err(DomainError::Backpressure);
            }
            state
                .pending_interactions
                .insert(interaction.id.clone(), interaction.clone());
            state.status = SessionStatus::Waiting;
            Ok(vec![DomainEvent::InteractionRequested {
                session,
                interaction,
            }])
        }
    }
}
