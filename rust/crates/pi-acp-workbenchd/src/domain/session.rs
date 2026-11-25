use super::ids::{ModeId, ModelId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Harness {
    Pi,
    Codex,
    Claude,
    Antigravity,
}
impl Harness {
    pub const ALL: [Self; 4] = [Self::Pi, Self::Codex, Self::Claude, Self::Antigravity];

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pi => "Pi",
            Self::Codex => "Codex",
            Self::Claude => "Claude",
            Self::Antigravity => "Antigravity",
        }
    }
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
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub options: std::collections::BTreeMap<String, String>,
}
/// Durable write-ahead record for a provider setting side effect. Until the
/// desired preference commit succeeds, reload restores this known baseline.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConfigurationIntent {
    pub requested: SessionConfig,
    pub restore: SessionConfig,
}
