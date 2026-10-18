//! Verified native branch projection. No ACP DTOs, filesystem or raw JSON.
use super::{
    error::DomainError,
    ids::*,
    session::{SessionConfig, SessionSnapshot, SessionState, SessionStatus},
    transcript::EntryRole,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[path = "fork_messages.rs"]
mod messages;
macro_rules! digest {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
                let value = value.into();
                if value.len() != 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(DomainError::Protocol("invalid SHA-256 digest".into()));
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = DomainError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}
digest!(PrefixHash);
digest!(ContentHash);
impl ContentHash {
    pub fn of(text: &str) -> Self {
        Self(format!("{:x}", Sha256::digest(text.as_bytes())))
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ForkRole {
    User,
    Agent,
}
impl ForkRole {
    fn matches(&self, role: &EntryRole) -> bool {
        matches!(
            (self, role),
            (Self::User, EntryRole::User) | (Self::Agent, EntryRole::Agent)
        )
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ForkTarget {
    pub entry: ProviderEntryId,
    pub prefix: PrefixHash,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkCandidate {
    pub target: ForkTarget,
    pub role: ForkRole,
    pub text: ContentHash,
    pub safe: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForkRequest {
    pub entry: EntryId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkOrigin {
    pub session: SessionId,
    pub entry: EntryId,
    pub target: ForkTarget,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForkProjection {
    pub source: SessionId,
    pub source_native: ProviderSessionId,
    pub target: ForkTarget,
    pub snapshot: SessionSnapshot,
}
fn unsafe_point() -> DomainError {
    DomainError::Protocol("native fork point is unsafe, stale or ambiguous".into())
}
/// Must be called by the source SessionActor against its owned state. Fresh
/// provider candidates are evidence, not an instruction to copy remote state.
pub fn prepare(
    state: &SessionState,
    request: &ForkRequest,
    candidates: &[ForkCandidate],
) -> Result<ForkProjection, DomainError> {
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
    // An opaque message ID establishes stream grouping only. It is not a native
    // key/timestamp. Only a complete, contiguous group ending at this exact row
    // can be matched by full text against fresh safe native prefix evidence.
    let messages = messages::messages(&state.transcript.entries);
    let selected = messages
        .iter()
        .find(|message| message.end == index)
        .ok_or_else(unsafe_point)?;
    // A text digest does not prove a native image cut. Do not silently select
    // image-bearing messages until native media identity is mapped explicitly.
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
                    && role.matches(&row.role)
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
    fork.id = SessionId::generate();
    fork.provider_session = None;
    fork.status = SessionStatus::Idle;
    fork.transcript.entries.truncate(index + 1);
    let prior_turns: std::collections::BTreeSet<_> = fork
        .transcript
        .entries
        .iter()
        .filter(|row| row.turn != entry.turn)
        .map(|row| row.turn.clone())
        .collect();
    // Tool updates currently have turn granularity, not native cut positions.
    // Retain only provably earlier turns; never leak future same-turn tools.
    fork.transcript
        .tools
        .retain(|turn, _| prior_turns.contains(turn));
    fork.transcript.origin = Some(ForkOrigin {
        session: state.id.clone(),
        entry: entry.id.clone(),
        target: target.clone(),
    });
    fork.active_turn = None;
    fork.pending_interactions.clear();
    fork.plan = Default::default();
    fork.usage = Default::default();
    // Native load owns the branch-point settings/compaction. Current source
    // preferences must never overwrite the native historical configuration.
    fork.config = SessionConfig {
        model: None,
        mode: None,
    };
    fork.configuration_intent = None;
    fork.catalogue = Default::default();
    fork.revision = 0;
    Ok(ForkProjection {
        source: state.id.clone(),
        source_native,
        target,
        snapshot: fork.snapshot(),
    })
}
impl ForkProjection {
    pub fn adopt(self, native: ProviderSessionId) -> Result<SessionState, DomainError> {
        if native == self.source_native || self.snapshot.id == self.source {
            return Err(unsafe_point());
        }
        let snapshot = self.snapshot;
        Ok(SessionState {
            id: snapshot.id,
            provider_session: Some(native),
            harness: snapshot.harness,
            cwd: snapshot.cwd,
            status: SessionStatus::Idle,
            transcript: snapshot.transcript,
            plan: Default::default(),
            active_turn: None,
            pending_interactions: Default::default(),
            usage: Default::default(),
            config: SessionConfig {
                model: None,
                mode: None,
            },
            configuration_intent: None,
            catalogue: Default::default(),
            revision: 0,
        })
    }
}
