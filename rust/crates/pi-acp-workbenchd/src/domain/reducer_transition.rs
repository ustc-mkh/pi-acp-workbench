//! Pure, history-independent session transitions. Context contains headers only.
use crate::domain::{
    command::{AgentEvent, DomainCommand},
    error::DomainError,
    fork::ContentHash,
    ids::*,
    query::{ContentKind, ContentRef, QueryError, SafeInteger, SessionView, ToolHeader},
    session::{SessionConfig, SessionStatus},
    transcript::EntryRole,
    transition::{
        DeliveryIntent, DeliveryPayload, DeliveryTarget, NewContent, NewEntry, ToolUpdate,
        Transition,
    },
};
use sha2::{Digest, Sha256};

#[cfg(test)]
#[path = "reducer_transition_tests.rs"]
mod tests;

#[derive(Default)]
pub struct TransitionContext<'a> {
    pub tool: Option<&'a ToolHeader>,
}
fn invalid(error: impl std::fmt::Display) -> DomainError {
    DomainError::Protocol(error.to_string())
}
fn archive(scope: &str, id: &str, text: String) -> Result<NewContent, DomainError> {
    let item = NewContent {
        content: ContentRef {
            id: ContentId::new(format!(
                "archive-{scope}-{:x}",
                Sha256::digest(id.as_bytes())
            ))?,
            sha256: ContentHash::of(&text),
            bytes: SafeInteger::new(text.len() as u64).map_err(invalid)?,
            kind: ContentKind::Text,
        },
        text,
    };
    item.validate().map_err(invalid)?;
    Ok(item)
}
fn entry(
    turn: TurnId,
    role: EntryRole,
    text: String,
    message: Option<ProviderMessageId>,
    image: Option<crate::domain::image::ImageAsset>,
) -> Result<NewEntry, DomainError> {
    let id = EntryId::generate();
    Ok(NewEntry {
        text: archive("entry", id.as_str(), text)?,
        id,
        turn,
        role,
        message,
        image,
    })
}
fn validate_config(view: &SessionView, config: &SessionConfig) -> Result<(), DomainError> {
    if config.model.as_ref().is_some_and(|id| {
        !view.catalogue.models.is_empty()
            && !view.catalogue.models.iter().any(|choice| &choice.id == id)
    }) {
        return Err(DomainError::Protocol(
            "model is not in provider catalogue".into(),
        ));
    }
    if config.mode.as_ref().is_some_and(|id| {
        !view.catalogue.modes.is_empty()
            && !view.catalogue.modes.iter().any(|choice| &choice.id == id)
    }) {
        return Err(DomainError::Protocol(
            "mode is not in provider catalogue".into(),
        ));
    }
    Ok(())
}
fn notice(change: &mut Transition, text: String) -> Result<(), DomainError> {
    let identity = serde_json::to_vec(&(&change.next.id, change.next.revision.get(), &text))
        .map_err(invalid)?;
    let id = format!("notice-{:x}", Sha256::digest(identity));
    let content = archive("notice", &id, text)?;
    delivery(
        change,
        DeliveryId::new(id)?,
        DeliveryPayload::Notice {
            content: content.content.clone(),
        },
    );
    change.contents.push(content);
    Ok(())
}
fn delivery(change: &mut Transition, id: DeliveryId, payload: DeliveryPayload) {
    change.deliveries.push(DeliveryIntent {
        id,
        revision: change.next.revision,
        target: DeliveryTarget::Session {
            session: change.next.id.clone(),
            cwd: change.next.cwd.clone(),
        },
        payload,
    });
}
/// None means no durable change: no revision, transaction or publication.
/// Neither this API nor its context can access a transcript or old tool bodies.
pub fn transition(
    view: &SessionView,
    command: DomainCommand,
    context: &TransitionContext<'_>,
    now: u64,
) -> Result<Option<Transition>, DomainError> {
    view.validate().map_err(invalid)?;
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
        _ => return Err(DomainError::NotFound(view.id.clone())),
    };
    if session != &view.id {
        return Err(DomainError::NotFound(session.clone()));
    }
    if matches!(command, DomainCommand::Inspect(_)) {
        return Ok(None);
    }
    if let DomainCommand::Agent { event, .. } = &command {
        if matches!(view.status, SessionStatus::Cancelling)
            && !matches!(event, AgentEvent::Crashed { .. })
        {
            return Ok(None);
        }
        let turn = match event {
            AgentEvent::Text { turn, .. }
            | AgentEvent::Image { turn, .. }
            | AgentEvent::Thought { turn, .. }
            | AgentEvent::Finished { turn } => Some(turn),
            AgentEvent::ToolCall(update) => Some(&update.turn),
            _ => None,
        };
        if turn.is_some_and(|turn| view.active_turn.as_ref() != Some(turn)) {
            return Ok(None);
        }
        if view.active_turn.is_none()
            && !matches!(
                event,
                AgentEvent::Crashed { .. }
                    | AgentEvent::Catalogue(_)
                    | AgentEvent::ProviderSessionAttached { .. }
                    | AgentEvent::ConfigurationRestored(_)
                    | AgentEvent::AvailableCommands(_)
            )
        {
            return Ok(None);
        }
    }
    let mut change = Transition {
        operation: None,
        expected_revision: view.revision,
        next: view.clone(),
        contents: vec![],
        append: vec![],
        tool_updates: vec![],
        deliveries: vec![],
    };
    // This tentative revision is never observable for an unchanged command.
    // Detect no-ops before incrementing, including at JS-safe exhaustion.
    let revision = view
        .revision
        .get()
        .checked_add(1)
        .ok_or_else(|| invalid(QueryError::InvalidInput))?;
    // Assign only after checking the resulting state below. Intents use the same
    // revision; creating one necessarily changes the state or append set.
    let next_revision = || SafeInteger::new(revision).map_err(invalid);
    match command {
        DomainCommand::Prompt { prompt, .. } => {
            if view.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            let turn = TurnId::generate();
            change.next.active_turn = Some(turn.clone());
            // Keep the last provider-reported summary for reconnect/native
            // restore. The flag is per-turn evidence: a new fact stays NULL
            // until this turn actually reports usage, never copied from here.
            change.next.usage.reported = false;
            change.next.status = SessionStatus::Running;
            change.append.push(entry(
                turn,
                EntryRole::User,
                prompt.as_str().to_owned(),
                None,
                None,
            )?);
        }
        DomainCommand::RequestCancel { .. } => {
            if view.active_turn.is_none() {
                return Err(DomainError::NoActiveTurn);
            }
            if matches!(view.status, SessionStatus::Cancelling) {
                return Ok(None);
            }
            change.next.status = SessionStatus::Cancelling;
        }
        DomainCommand::Cancel { .. } => {
            let turn = change
                .next
                .active_turn
                .take()
                .ok_or(DomainError::NoActiveTurn)?;
            change.next.pending_interactions.clear();
            change.next.status = SessionStatus::Idle;
            change.next.revision = next_revision()?;
            notice(&mut change, format!("Turn {turn} cancelled."))?;
        }
        DomainCommand::AnswerInteraction { answer, .. } => {
            if matches!(view.status, SessionStatus::Cancelling) {
                return Err(DomainError::Busy);
            }
            let interaction = view
                .pending_interactions
                .get(&answer.interaction)
                .ok_or(DomainError::InteractionNotFound)?;
            let answer = interaction.validate_answer(answer, now)?;
            change.next.pending_interactions.remove(&answer.interaction);
            change.next.status = if change.next.pending_interactions.is_empty() {
                SessionStatus::Running
            } else {
                SessionStatus::Waiting
            };
        }
        DomainCommand::PrepareConfiguration { intent, .. } => {
            if view.active_turn.is_some() || view.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            validate_config(view, &intent.requested)?;
            if (intent.requested.model != view.config.model && intent.restore.model.is_none())
                || (intent.requested.mode != view.config.mode && intent.restore.mode.is_none())
            {
                return Err(DomainError::Protocol(
                    "provider setting has no known recovery baseline".into(),
                ));
            }
            change.next.configuration_intent = Some(intent);
        }
        DomainCommand::CommitConfiguration { .. } => {
            if view.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            let intent = view
                .configuration_intent
                .as_ref()
                .ok_or_else(|| DomainError::Protocol("configuration intent is missing".into()))?;
            super::validate_observed(
                &intent.requested,
                view.catalogue.current_model.as_ref(),
                view.catalogue.current_mode.as_ref(),
            )?;
            change.next.config = intent.requested.clone();
            change.next.configuration_intent = None;
        }
        DomainCommand::SetModel { model, .. } => {
            if view.active_turn.is_some() || view.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            let mut config = view.config.clone();
            config.model = Some(model);
            validate_config(view, &config)?;
            change.next.config = config;
        }
        DomainCommand::SetMode { mode, .. } => {
            if view.active_turn.is_some() || view.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            let mut config = view.config.clone();
            config.mode = Some(mode);
            validate_config(view, &config)?;
            change.next.config = config;
        }
        DomainCommand::Agent { event, .. } => match event {
            AgentEvent::ConfigurationRestored(patch) => {
                let Some(intent) = &view.configuration_intent else {
                    return Ok(None);
                };
                super::validate_observed(
                    &intent.restore,
                    patch.current_model.as_ref(),
                    patch.current_mode.as_ref(),
                )?;
                change.next.catalogue.apply(patch);
                change.next.configuration_intent = None;
            }
            AgentEvent::Catalogue(patch) => change.next.catalogue.apply(patch),
            AgentEvent::AvailableCommands(commands) => change.next.catalogue.commands = commands,
            AgentEvent::ProviderSessionAttached { id } => {
                if view
                    .provider_session
                    .as_ref()
                    .is_some_and(|current| current != &id)
                {
                    return Err(DomainError::Protocol(
                        "provider session identity changed".into(),
                    ));
                }
                change.next.provider_session = Some(id);
            }
            AgentEvent::Text {
                turn,
                text,
                message,
            } => change
                .append
                .push(entry(turn, EntryRole::Agent, text, message, None)?),
            AgentEvent::Thought {
                turn,
                text,
                message,
            } => change
                .append
                .push(entry(turn, EntryRole::Thought, text, message, None)?),
            AgentEvent::Image {
                turn,
                asset,
                message,
            } => change.append.push(entry(
                turn,
                EntryRole::Agent,
                String::new(),
                message,
                Some(asset),
            )?),
            AgentEvent::ToolCall(update) => {
                let merged = ToolUpdate::patch(update, context.tool).map_err(invalid)?;
                if context
                    .tool
                    .map(serde_json::to_vec)
                    .transpose()
                    .map_err(invalid)?
                    != Some(serde_json::to_vec(&merged.header).map_err(invalid)?)
                {
                    change.tool_updates.push(merged);
                }
            }
            AgentEvent::Plan(plan) => change.next.plan = plan,
            AgentEvent::Usage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
            } => {
                change.next.usage.reported = true;
                change.next.usage.cache_read_tokens = cache_read_tokens;
                change.next.usage.cache_write_tokens = cache_write_tokens;
                change.next.usage.input_tokens = input_tokens;
                change.next.usage.output_tokens = output_tokens;
            }
            AgentEvent::ContextUsage { used, size } => {
                if size == 0 || used > size {
                    return Err(DomainError::Protocol("invalid context occupancy".into()));
                }
                change.next.usage.context_used = Some(used);
                change.next.usage.context_size = Some(size);
            }
            AgentEvent::Finished { turn } => {
                change.next.active_turn = None;
                change.next.status = SessionStatus::Idle;
                change.next.pending_interactions.clear();
                change.next.revision = next_revision()?;
                delivery(
                    &mut change,
                    DeliveryId::new(format!("turn-{turn}"))?,
                    DeliveryPayload::Turn {
                        session: view.id.clone(),
                        turn,
                        first_seq: SafeInteger::new(1).map_err(invalid)?,
                        last_seq: view.last_entry_seq,
                    },
                );
            }
            AgentEvent::Crashed { reason } => {
                change.next.active_turn = None;
                change.next.status = SessionStatus::Failed(reason.clone());
                change.next.pending_interactions.clear();
                change.next.revision = next_revision()?;
                notice(&mut change, format!("Session error: {reason}"))?;
            }
            AgentEvent::Interaction(interaction) => {
                interaction.validate_definition()?;
                if view.pending_interactions.contains_key(&interaction.id) {
                    return Ok(None);
                }
                if view.pending_interactions.len() >= 32 {
                    return Err(DomainError::Backpressure);
                }
                let content = archive(
                    "interaction",
                    interaction.id.as_str(),
                    serde_json::to_string(&interaction).map_err(invalid)?,
                )?;
                change
                    .next
                    .pending_interactions
                    .insert(interaction.id.clone(), interaction.clone());
                change.next.status = SessionStatus::Waiting;
                change.contents.push(content);
                change.next.revision = next_revision()?;
                delivery(
                    &mut change,
                    DeliveryId::new(format!("interaction-{}", interaction.id))?,
                    DeliveryPayload::Interaction {
                        interaction: interaction.id,
                    },
                );
            }
        },
        _ => unreachable!("validated session command"),
    }
    // Compare bounded hot state before installing the new revision. No historical
    // diff: new rows/tools/archives are built while handling this command.
    change.next.revision = view.revision;
    if change.append.is_empty()
        && change.tool_updates.is_empty()
        && change.deliveries.is_empty()
        && serde_json::to_vec(&change.next).map_err(invalid)?
            == serde_json::to_vec(view).map_err(invalid)?
    {
        return Ok(None);
    }
    change.next.revision = next_revision()?;
    change.next.last_entry_seq = SafeInteger::new(
        view.last_entry_seq
            .get()
            .checked_add(change.append.len() as u64)
            .ok_or_else(|| invalid(QueryError::InvalidInput))?,
    )
    .map_err(invalid)?;
    change.next.validate().map_err(invalid)?;
    if let Some(input) = change
        .append
        .iter()
        .find(|entry| entry.role == EntryRole::User)
    {
        let payload = DeliveryPayload::Input {
            session: change.next.id.clone(),
            turn: input.turn.clone(),
            entry: input.id.clone(),
            seq: change.next.last_entry_seq,
            origin: None,
        };
        let id = DeliveryId::new(format!("input-{}", input.turn))?;
        delivery(&mut change, id, payload);
    }
    Ok(Some(change))
}
