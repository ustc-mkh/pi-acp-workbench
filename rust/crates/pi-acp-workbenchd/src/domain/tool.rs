use super::ids::{ToolCallId, TurnId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: ToolCallId,
    pub turn: TurnId,
    pub title: String,
    pub status: ToolStatus,
    #[serde(default)]
    pub details: ToolDetails,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCallUpdate {
    pub id: ToolCallId,
    pub turn: TurnId,
    pub title: Option<String>,
    pub status: Option<ToolStatus>,
    #[serde(default)]
    pub details: ToolDetailsPatch,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum UnsupportedToolContent {
    Image,
    Audio,
    ResourceBlob,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ToolContent {
    Text {
        text: String,
    },
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    ResourceText {
        uri: String,
        text: String,
        mime_type: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: String,
        mime_type: Option<String>,
    },
    /// Display-only reference. Client terminal capability remains disabled.
    TerminalReference {
        id: super::ids::TerminalId,
    },
    Unsupported {
        kind: UnsupportedToolContent,
    },
}
/// Paths/URIs in tool results are untrusted display metadata, NOT authority to
/// open files or fetch resources. Content never contains raw ACP JSON/binaries.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolLocation {
    pub path: String,
    pub line: Option<u32>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolDetails {
    pub kind: Option<ToolKind>,
    pub name: Option<String>,
    pub content: Vec<ToolContent>,
    pub locations: Vec<ToolLocation>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ToolDetailsPatch {
    pub kind: Option<ToolKind>,
    pub name: Option<String>,
    pub content: Option<Vec<ToolContent>>,
    pub locations: Option<Vec<ToolLocation>>,
}
impl ToolDetailsPatch {
    pub fn apply(self, details: &mut ToolDetails) {
        if let Some(kind) = self.kind {
            details.kind = Some(kind);
        }
        if let Some(name) = self.name {
            details.name = Some(name);
        }
        if let Some(content) = self.content {
            details.content = content;
        }
        if let Some(locations) = self.locations {
            details.locations = locations;
        }
    }
}
