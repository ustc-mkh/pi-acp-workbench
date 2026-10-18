//! Standard ACP v1 tool metadata. Raw input/output are intentionally not
//! forwarded to domain state. Unknown content has an explicit boundary case.
use super::content::{ContentBlock, KnownContent};
use crate::domain::tool as domain;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Content {
        content: ContentBlock,
    },
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        #[serde(default)]
        old_text: Option<String>,
        new_text: String,
    },
    #[serde(rename_all = "camelCase")]
    Terminal {
        terminal_id: crate::domain::TerminalId,
    },
    #[serde(other)]
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolLocation {
    pub path: String,
    #[serde(default)]
    pub line: Option<u32>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ToolDetailsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ToolContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<ToolLocation>>,
    // Opaque standard fields stay at the protocol boundary only. Conversion
    // deliberately does not place arbitrary JSON in business state/events.
    #[serde(default, rename = "rawInput", skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<super::content::RawExtension>,
    #[serde(default, rename = "rawOutput", skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<super::content::RawExtension>,
}
impl ToolDetailsPatch {
    pub fn into_domain(self) -> domain::ToolDetailsPatch {
        let kind = self.kind.and_then(|kind| {
            Some(match kind {
                ToolKind::Read => domain::ToolKind::Read,
                ToolKind::Edit => domain::ToolKind::Edit,
                ToolKind::Delete => domain::ToolKind::Delete,
                ToolKind::Move => domain::ToolKind::Move,
                ToolKind::Search => domain::ToolKind::Search,
                ToolKind::Execute => domain::ToolKind::Execute,
                ToolKind::Think => domain::ToolKind::Think,
                ToolKind::Fetch => domain::ToolKind::Fetch,
                ToolKind::SwitchMode => domain::ToolKind::SwitchMode,
                ToolKind::Other => domain::ToolKind::Other,
                ToolKind::Unknown => return None,
            })
        });
        domain::ToolDetailsPatch {
            kind,
            name: self.name,
            locations: self.locations.map(|locations| {
                locations
                    .into_iter()
                    .map(|location| domain::ToolLocation {
                        path: location.path,
                        line: location.line,
                    })
                    .collect()
            }),
            content: self.content.map(|content| {
                content
                    .into_iter()
                    .map(|item| match item {
                        ToolContent::Content { content } => match content {
                            ContentBlock::Known(KnownContent::Text { text }) => {
                                domain::ToolContent::Text { text }
                            }
                            ContentBlock::Known(KnownContent::Resource {
                                resource:
                                    super::content::EmbeddedResource::Text {
                                        uri,
                                        text,
                                        mime_type,
                                    },
                            }) => domain::ToolContent::ResourceText {
                                uri,
                                text,
                                mime_type,
                            },
                            ContentBlock::Known(KnownContent::Image { .. }) => {
                                domain::ToolContent::Unsupported {
                                    kind: domain::UnsupportedToolContent::Image,
                                }
                            }
                            ContentBlock::Known(KnownContent::Audio { .. }) => {
                                domain::ToolContent::Unsupported {
                                    kind: domain::UnsupportedToolContent::Audio,
                                }
                            }
                            ContentBlock::Known(KnownContent::Resource { .. }) => {
                                domain::ToolContent::Unsupported {
                                    kind: domain::UnsupportedToolContent::ResourceBlob,
                                }
                            }
                            ContentBlock::Known(KnownContent::ResourceLink {
                                uri,
                                name,
                                mime_type,
                            }) => domain::ToolContent::ResourceLink {
                                uri,
                                name,
                                mime_type,
                            },
                            ContentBlock::Unknown(_) => domain::ToolContent::Unsupported {
                                kind: domain::UnsupportedToolContent::Unknown,
                            },
                        },
                        ToolContent::Diff {
                            path,
                            old_text,
                            new_text,
                        } => domain::ToolContent::Diff {
                            path,
                            old_text,
                            new_text,
                        },
                        ToolContent::Terminal { terminal_id } => {
                            domain::ToolContent::TerminalReference { id: terminal_id }
                        }
                        ToolContent::Unknown => domain::ToolContent::Unsupported {
                            kind: domain::UnsupportedToolContent::Unknown,
                        },
                    })
                    .collect()
            }),
        }
    }
}
