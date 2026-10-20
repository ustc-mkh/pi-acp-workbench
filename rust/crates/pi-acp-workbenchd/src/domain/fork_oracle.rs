//! Test-only vector oracle for streaming fork proofs, never an app/store API.
use super::*;
use crate::domain::{
    query::{SafeInteger, SessionView},
    session::{SessionConfig, SessionStatus},
    transcript::{EntryRole, Transcript},
};
#[path = "fork_messages.rs"]
mod messages;
#[derive(Clone, Debug, Serialize)]
pub struct OracleHistory {
    pub view: SessionView,
    pub transcript: Transcript,
}
impl std::ops::Deref for OracleHistory {
    type Target = SessionView;
    fn deref(&self) -> &SessionView {
        &self.view
    }
}
impl std::ops::DerefMut for OracleHistory {
    fn deref_mut(&mut self) -> &mut SessionView {
        &mut self.view
    }
}
impl OracleHistory {
    pub fn new(view: SessionView) -> Self {
        Self {
            view,
            transcript: Default::default(),
        }
    }
    pub fn hot_view(&self) -> SessionView {
        let mut view = self.view.clone();
        view.origin = self.transcript.origin.clone();
        view.last_entry_seq = SafeInteger::new(self.transcript.entries.len() as u64).unwrap();
        view
    }
}
#[derive(Clone, Debug)]
pub struct OracleProjection {
    pub source: SessionId,
    pub source_native: ProviderSessionId,
    pub target: ForkTarget,
    pub snapshot: OracleHistory,
}
fn unsafe_point() -> DomainError {
    DomainError::Protocol("native fork point is unsafe, stale or ambiguous".into())
}
fn matches(role: &ForkRole, row: &EntryRole) -> bool {
    matches!(
        (role, row),
        (ForkRole::User, EntryRole::User) | (ForkRole::Agent, EntryRole::Agent)
    )
}
pub fn prepare(
    state: &OracleHistory,
    request: &ForkRequest,
    candidates: &[ForkCandidate],
) -> Result<OracleProjection, DomainError> {
    if state.active_turn.is_some() || state.configuration_intent.is_some() {
        return Err(DomainError::Busy);
    }
    let source_native = state.provider_session.clone().ok_or_else(unsafe_point)?;
    let index = state
        .transcript
        .entries
        .iter()
        .position(|entry| entry.id == request.entry)
        .ok_or_else(unsafe_point)?;
    let entry = &state.transcript.entries[index];
    let role = match entry.role {
        EntryRole::User => ForkRole::User,
        EntryRole::Agent => ForkRole::Agent,
        _ => return Err(unsafe_point()),
    };
    let messages = messages::messages(&state.transcript.entries);
    let selected = messages
        .iter()
        .find(|message| message.end == index)
        .ok_or_else(unsafe_point)?;
    if state.transcript.entries[selected.start..=selected.end]
        .iter()
        .any(|row| row.image.is_some())
    {
        return Err(unsafe_point());
    }
    if messages
        .iter()
        .filter(|message| message.role == role && message.text == selected.text)
        .count()
        != 1
        || state
            .transcript
            .entries
            .iter()
            .enumerate()
            .any(|(index, row)| {
                !(selected.start..=selected.end).contains(&index)
                    && matches(&role, &row.role)
                    && row.text == selected.text
            })
    {
        return Err(unsafe_point());
    }
    let text = ContentHash::of(&selected.text);
    let matching: Vec<_> = candidates
        .iter()
        .filter(|point| point.role == role && point.text == text)
        .collect();
    if matching.len() != 1 || !matching[0].safe {
        return Err(unsafe_point());
    }
    let target = matching[0].target.clone();
    let mut fork = state.clone();
    fork.view.id = SessionId::generate();
    fork.view.provider_session = None;
    fork.view.status = SessionStatus::Idle;
    fork.transcript.entries.truncate(index + 1);
    let prior_turns: std::collections::BTreeSet<_> = fork
        .transcript
        .entries
        .iter()
        .filter(|row| row.turn != entry.turn)
        .map(|row| row.turn.clone())
        .collect();
    fork.transcript
        .tools
        .retain(|turn, _| prior_turns.contains(turn));
    fork.transcript.origin = Some(ForkOrigin {
        session: state.id.clone(),
        entry: entry.id.clone(),
        target: target.clone(),
    });
    fork.view.active_turn = None;
    fork.view.pending_interactions.clear();
    fork.view.plan = Default::default();
    fork.view.usage = Default::default();
    fork.view.config = SessionConfig {
        options: Default::default(),
        model: None,
        mode: None,
    };
    fork.view.configuration_intent = None;
    fork.view.catalogue = Default::default();
    fork.view.revision = Default::default();
    fork.view = fork.hot_view();
    Ok(OracleProjection {
        source: state.id.clone(),
        source_native,
        target,
        snapshot: fork,
    })
}
impl OracleProjection {
    pub fn adopt(mut self, native: ProviderSessionId) -> Result<OracleHistory, DomainError> {
        if native == self.source_native || self.snapshot.id == self.source {
            return Err(unsafe_point());
        }
        self.snapshot.view.provider_session = Some(native);
        Ok(self.snapshot)
    }
}
