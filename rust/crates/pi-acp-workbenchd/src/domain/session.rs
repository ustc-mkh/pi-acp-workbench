use super::{
    ids::*, interaction::*, plan::Plan, transcript::Transcript, usage::UsageState, WorkspacePath,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Harness {
    Pi,
    Codex,
    Claude,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SessionStatus {
    Idle,
    Running,
    Waiting,
    Cancelling,
    Failed(String),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionConfig {
    pub model: Option<ModelId>,
    pub mode: Option<ModeId>,
}
/// Durable write-ahead record for a provider setting side effect. Until the
/// desired preference commit succeeds, reload must restore this known baseline.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigurationIntent {
    pub requested: SessionConfig,
    pub restore: SessionConfig,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub id: SessionId,
    pub provider_session: Option<ProviderSessionId>,
    pub harness: Harness,
    pub cwd: WorkspacePath,
    pub status: SessionStatus,
    pub transcript: Transcript,
    pub plan: Plan,
    pub active_turn: Option<TurnId>,
    pub pending_interactions: std::collections::BTreeMap<InteractionId, Interaction>,
    pub usage: UsageState,
    pub config: SessionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_intent: Option<ConfigurationIntent>,
    pub catalogue: super::catalogue::Catalogue,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionState {
    pub id: SessionId,
    #[serde(default)]
    pub provider_session: Option<ProviderSessionId>,
    pub harness: Harness,
    pub cwd: WorkspacePath,
    pub status: SessionStatus,
    pub transcript: Transcript,
    pub plan: Plan,
    pub active_turn: Option<TurnId>,
    pub pending_interactions: std::collections::BTreeMap<InteractionId, Interaction>,
    pub usage: UsageState,
    pub config: SessionConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_intent: Option<ConfigurationIntent>,
    #[serde(default)]
    pub catalogue: super::catalogue::Catalogue,
    pub revision: u64,
}
impl SessionState {
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            id: self.id.clone(),
            provider_session: self.provider_session.clone(),
            harness: self.harness.clone(),
            cwd: self.cwd.clone(),
            status: self.status.clone(),
            transcript: self.transcript.clone(),
            plan: self.plan.clone(),
            active_turn: self.active_turn.clone(),
            pending_interactions: self.pending_interactions.clone(),
            usage: self.usage.clone(),
            config: self.config.clone(),
            configuration_intent: self.configuration_intent.clone(),
            catalogue: self.catalogue.clone(),
            revision: self.revision,
        }
    }
}
