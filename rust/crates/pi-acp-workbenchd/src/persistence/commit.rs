//! Bridge from the existing full-state reducer to the SQL write-set contract.
//! T05 moves write-set construction into the reducer and removes this history diff.
use super::{
    database::{encode, SessionCommit, StoreError},
    payload,
};
use crate::domain::{
    event::DomainEvent,
    ids::*,
    image::ImageAsset,
    query::{CommitBatch, EntryHeader, SafeInteger, SessionView, TextBody},
    transcript::EntryRole,
    transition::{
        DeliveryIntent, DeliveryPayload, DeliveryTarget, NewContent, NewEntry, ToolUpdate,
    },
    SessionState,
};
use sha2::{Digest, Sha256};

impl SessionCommit {
    pub(crate) fn batch(&self, previous_seq: SafeInteger) -> Result<CommitBatch, StoreError> {
        let mut entries = Vec::with_capacity(self.append.len());
        for (index, entry) in self.append.iter().enumerate() {
            let seq = previous_seq
                .get()
                .checked_add(index as u64 + 1)
                .ok_or(StoreError::Invalid("entry sequence exhausted"))?;
            entries.push(EntryHeader {
                seq: SafeInteger::new(seq)?,
                id: entry.id.clone(),
                turn: entry.turn.clone(),
                role: entry.role.clone(),
                message: entry.message.clone(),
                text: TextBody::from_text(&entry.text.text, entry.text.content.clone())?,
                image: entry.image.as_ref().map(|asset| asset.image().clone()),
            });
        }
        let batch = CommitBatch {
            session: self.next.id.clone(),
            revision: self.next.revision,
            view: self.view_changed.then(|| self.next.clone()),
            entries,
            tools: self
                .tool_updates
                .iter()
                .map(|update| update.header.clone())
                .collect(),
            removed: false,
        };
        batch.validate()?;
        Ok(batch)
    }
    pub(crate) fn between(
        previous: &SessionState,
        next: &SessionState,
        events: &[DomainEvent],
        image: Option<ImageAsset>,
    ) -> Result<Self, StoreError> {
        validate_prefix(previous, next)?;
        let mut append = Vec::new();
        for entry in next
            .transcript
            .entries
            .iter()
            .skip(previous.transcript.entries.len())
        {
            let asset = match &entry.image {
                Some(reference) => Some(
                    image
                        .as_ref()
                        .filter(|asset| asset.image() == reference)
                        .ok_or(StoreError::Invalid("new entry image asset missing"))?
                        .clone(),
                ),
                None => None,
            };
            append.push(NewEntry {
                id: entry.id.clone(),
                turn: entry.turn.clone(),
                role: entry.role.clone(),
                message: entry.message.clone(),
                text: payload::entry_content(entry)?,
                image: asset,
            });
        }
        if image.as_ref().is_some_and(|asset| {
            !append.iter().any(|entry| {
                entry
                    .image
                    .as_ref()
                    .is_some_and(|found| found.image() == asset.image())
            })
        }) {
            return Err(StoreError::Invalid("unreferenced image asset"));
        }
        let mut tool_updates = Vec::new();
        for (turn, tools) in &next.transcript.tools {
            for (id, call) in tools {
                if turn != &call.turn || id != &call.id {
                    return Err(StoreError::Invalid("tool identity mismatch"));
                }
                let old = previous
                    .transcript
                    .tools
                    .get(turn)
                    .and_then(|tools| tools.get(id));
                if old.map(encode).transpose()? != Some(encode(call)?) {
                    tool_updates.push(ToolUpdate::from_call(call)?);
                }
            }
        }
        let (contents, deliveries) = event_records(next, events)?;
        Ok(Self {
            expected_revision: SafeInteger::new(previous.revision)?,
            next: SessionView::from_state(
                next,
                SafeInteger::new(next.transcript.entries.len() as u64)?,
            )?,
            append,
            tool_updates,
            contents,
            deliveries,
            view_changed: true,
        })
    }
}
/// Full-state save is retained for initial creation/native fork until T05/T06.
/// Both that path and the temporary reducer bridge enforce immutable history.
pub(super) fn validate_prefix(old: &SessionState, next: &SessionState) -> Result<(), StoreError> {
    if old.id != next.id || old.cwd != next.cwd || old.harness != next.harness {
        return Err(StoreError::Invalid("session immutable scope changed"));
    }
    if next.revision <= old.revision
        || next.transcript.entries.len() < old.transcript.entries.len()
        || next.transcript.origin.as_ref().map(encode).transpose()?
            != old.transcript.origin.as_ref().map(encode).transpose()?
    {
        return Err(StoreError::Conflict);
    }
    for (old, new) in old.transcript.entries.iter().zip(&next.transcript.entries) {
        if encode(old)? != encode(new)? {
            return Err(StoreError::Conflict);
        }
    }
    for (turn, tools) in &old.transcript.tools {
        if !tools.keys().all(|id| {
            next.transcript
                .tools
                .get(turn)
                .is_some_and(|tools| tools.contains_key(id))
        }) {
            return Err(StoreError::Conflict);
        }
    }
    Ok(())
}
fn event_records(
    state: &SessionState,
    source: &[DomainEvent],
) -> Result<(Vec<NewContent>, Vec<DeliveryIntent>), StoreError> {
    let mut contents = Vec::new();
    let mut intents = Vec::new();
    for event in source {
        let (session, id, body) = match event {
            DomainEvent::TurnFinished { session, turn } => (
                session,
                DeliveryId::new(format!("turn-{turn}"))
                    .map_err(|_| StoreError::Invalid("invalid turn delivery id"))?,
                DeliveryPayload::Entries {
                    turn: turn.clone(),
                    entries: state
                        .transcript
                        .entries
                        .iter()
                        .filter(|entry| &entry.turn == turn && entry.role == EntryRole::Agent)
                        .map(|entry| entry.id.clone())
                        .collect(),
                },
            ),
            DomainEvent::InteractionRequested {
                session,
                interaction,
            } => {
                contents.push(payload::interaction_content(interaction)?);
                (
                    session,
                    DeliveryId::new(format!("interaction-{}", interaction.id))
                        .map_err(|_| StoreError::Invalid("invalid interaction delivery id"))?,
                    DeliveryPayload::Interaction {
                        interaction: interaction.id.clone(),
                    },
                )
            }
            DomainEvent::TurnCancelled { session, turn } => {
                let (id, body, archive) =
                    notice(state, session, format!("Turn {turn} cancelled."))?;
                contents.push(archive);
                (session, id, body)
            }
            DomainEvent::SessionError { session, error } => {
                let (id, body, archive) =
                    notice(state, session, format!("Session error: {error}"))?;
                contents.push(archive);
                (session, id, body)
            }
            _ => continue,
        };
        if session != &state.id {
            return Err(StoreError::Invalid("session delivery identity mismatch"));
        }
        intents.push(DeliveryIntent {
            id,
            revision: SafeInteger::new(state.revision)?,
            target: DeliveryTarget::Session {
                session: session.clone(),
                cwd: state.cwd.clone(),
            },
            payload: body,
        });
    }
    Ok((contents, intents))
}
fn notice(
    state: &SessionState,
    session: &SessionId,
    text: String,
) -> Result<(DeliveryId, DeliveryPayload, NewContent), StoreError> {
    let identity = serde_json::to_vec(&(session, state.revision, &text))?;
    let id = format!("notice-{:x}", Sha256::digest(identity));
    let notice = payload::NoticeContent {
        id: NoticeId::new(id.clone()).map_err(|_| StoreError::Invalid("invalid notice id"))?,
        text,
    };
    let archive = payload::notice_content(&notice)?;
    Ok((
        DeliveryId::new(id).map_err(|_| StoreError::Invalid("invalid notice id"))?,
        DeliveryPayload::Notice {
            content: archive.content.clone(),
        },
        archive,
    ))
}
