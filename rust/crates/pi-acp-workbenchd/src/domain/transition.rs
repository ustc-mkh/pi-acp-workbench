//! The single incremental write set accepted by the session store.
use super::{
    fork::ContentHash,
    ids::*,
    image::ImageAsset,
    query::{
        CommitBatch, ContentRef, EntryHeader, QueryError, SafeInteger, SessionView, TextBody,
        ToolHeader,
    },
    transcript::EntryRole,
    WorkspacePath,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct Transition {
    pub operation: Option<super::operation::OperationTicket>,
    pub expected_revision: SafeInteger,
    pub next: SessionView,
    pub contents: Vec<NewContent>,
    pub append: Vec<NewEntry>,
    pub tool_updates: Vec<ToolUpdate>,
    pub deliveries: Vec<DeliveryIntent>,
}
impl Transition {
    pub(crate) fn batch(&self, previous_seq: SafeInteger) -> Result<CommitBatch, QueryError> {
        let mut entries = Vec::with_capacity(self.append.len());
        for (index, entry) in self.append.iter().enumerate() {
            let seq = previous_seq
                .get()
                .checked_add(index as u64 + 1)
                .ok_or(QueryError::InvalidInput)?;
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
            view: Some(self.next.clone()),
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
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryIntent {
    pub id: DeliveryId,
    /// Source revision is immutable identity, not a cross-source ordering key.
    pub revision: SafeInteger,
    pub target: DeliveryTarget,
    pub payload: DeliveryPayload,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum DeliveryPayload {
    Input {
        session: SessionId,
        turn: TurnId,
        entry: EntryId,
        seq: SafeInteger,
        origin: Option<crate::domain::OperationId>,
    },
    /// Immutable archive references; no session snapshot is required to render.
    Turn {
        session: SessionId,
        turn: TurnId,
        first_seq: SafeInteger,
        last_seq: SafeInteger,
    },
    Entry {
        entry: EntryId,
    },
    /// Explicit history export: immutable body streamed in bounded slices.
    HistoryEntry {
        session: SessionId,
        entries: Vec<(EntryId, SafeInteger)>,
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
    Menu {
        content: ContentRef,
    },
}
