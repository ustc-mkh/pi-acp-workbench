use super::ids::{EntryId, TurnId};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Transcript {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<super::fork::ForkOrigin>,
    pub entries: Vec<TranscriptEntry>,
    #[serde(default)]
    pub tools: std::collections::BTreeMap<
        TurnId,
        std::collections::BTreeMap<super::ids::ToolCallId, super::tool::ToolCall>,
    >,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub id: EntryId,
    pub turn: TurnId,
    pub role: EntryRole,
    pub text: String,
    /// Optional opaque stream group. Each delta still owns a distinct immutable
    /// entry/archive ID; this is not a native fork position or a timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<super::ids::ProviderMessageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<super::image::ImageRef>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum EntryRole {
    User,
    Agent,
    Thought,
    Tool,
}
