//! Typed incremental write set. The reducer starts returning it in T05.
use super::{
    fork::ContentHash,
    ids::*,
    image::ImageAsset,
    query::{ContentRef, SafeInteger, ToolHeader},
    session::SessionState,
    transcript::EntryRole,
    WorkspacePath,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct Transition {
    pub next: SessionState,
    pub append: Vec<NewEntry>,
    pub tool_updates: Vec<ToolUpdate>,
    pub deliveries: Vec<DeliveryIntent>,
    pub view_changed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewContent {
    pub content: ContentRef,
    pub text: String,
}
impl NewContent {
    pub fn validate(&self) -> Result<(), super::query::QueryError> {
        self.content.validate()?;
        if self.content.bytes.get() != self.text.len() as u64
            || self.content.sha256 != ContentHash::of(&self.text)
        {
            return Err(super::query::QueryError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct NewEntry {
    pub id: EntryId,
    pub turn: TurnId,
    pub role: EntryRole,
    pub message: Option<ProviderMessageId>,
    pub text: NewContent,
    pub image: Option<ImageAsset>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolUpdate {
    pub header: ToolHeader,
    pub contents: Vec<NewContent>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryIntent {
    pub id: DeliveryId,
    /// Source revision is immutable identity, not a cross-source ordering key.
    pub revision: SafeInteger,
    pub target: DeliveryTarget,
    pub payload: DeliveryPayload,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum DeliveryTarget {
    Session {
        session: SessionId,
        cwd: WorkspacePath,
    },
    Telegram {
        bot_id: i64,
        chat: i64,
        thread: i64,
        cwd: WorkspacePath,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum DeliveryPayload {
    Turn {
        session: SessionId,
        turn: TurnId,
        first_seq: SafeInteger,
        last_seq: SafeInteger,
    },
    Entry {
        entry: EntryId,
    },
    Image {
        image: ImageId,
    },
    Interaction {
        interaction: InteractionId,
    },
    Notice {
        content: ContentRef,
    },
}
