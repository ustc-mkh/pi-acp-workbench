//! Format/IPC v3 contracts. Production switches to these in T04–T08, not here.
use super::{
    catalogue::Catalogue,
    fork::{ContentHash, ForkOrigin},
    ids::*,
    image::ImageRef,
    interaction::Interaction,
    plan::Plan,
    session::{ConfigurationIntent, Harness, SessionConfig, SessionStatus},
    tool::{ToolKind, ToolLocation, ToolStatus, UnsupportedToolContent},
    transcript::EntryRole,
    usage::UsageState,
    WorkspacePath,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 3;
pub const STORAGE_VERSION: u32 = 3;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_QUERY_BYTES: usize = 1024 * 1024;
pub const MAX_VIEW_BYTES: usize = 512 * 1024;
pub const INLINE_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
pub const CONTENT_SLICE_BYTES: usize = 64 * 1024;
pub const DEFAULT_LIST_LIMIT: usize = 50;
pub const MAX_LIST_LIMIT: usize = 100;
pub const DEFAULT_HISTORY_LIMIT: usize = 100;
pub const MAX_HISTORY_LIMIT: usize = 200;
pub const MAX_PENDING_INTERACTIONS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
pub enum QueryError {
    #[error("invalid v3 query value")]
    InvalidInput,
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    #[error("resource exceeds protocol byte budget")]
    TooLarge,
}

/// All sequence/revision values are exact nonnegative JavaScript integers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct SafeInteger(u64);
impl SafeInteger {
    pub fn new(value: u64) -> Result<Self, QueryError> {
        if value > MAX_SAFE_INTEGER {
            return Err(QueryError::InvalidInput);
        }
        Ok(Self(value))
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn next(self) -> Result<Self, QueryError> {
        Self::new(self.0 + 1)
    }
}
impl TryFrom<u64> for SafeInteger {
    type Error = QueryError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
impl From<SafeInteger> for u64 {
    fn from(value: SafeInteger) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub id: SessionId,
    pub harness: Harness,
    pub cwd: WorkspacePath,
    pub status: SessionStatus,
    pub revision: SafeInteger,
    pub created_seq: SafeInteger,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionView {
    pub id: SessionId,
    pub provider_session: Option<ProviderSessionId>,
    pub harness: Harness,
    pub cwd: WorkspacePath,
    pub status: SessionStatus,
    pub config: SessionConfig,
    pub configuration_intent: Option<ConfigurationIntent>,
    pub catalogue: Catalogue,
    pub plan: Plan,
    pub usage: UsageState,
    pub active_turn: Option<TurnId>,
    pub pending_interactions: BTreeMap<InteractionId, Interaction>,
    pub origin: Option<ForkOrigin>,
    pub revision: SafeInteger,
    pub last_entry_seq: SafeInteger,
}
impl SessionView {
    pub fn new(harness: Harness, cwd: WorkspacePath) -> Self {
        Self {
            id: SessionId::generate(),
            provider_session: None,
            harness,
            cwd,
            status: SessionStatus::Idle,
            origin: None,
            last_entry_seq: SafeInteger::default(),
            plan: Default::default(),
            active_turn: None,
            pending_interactions: BTreeMap::new(),
            usage: Default::default(),
            configuration_intent: None,
            config: SessionConfig {
                model: None,
                mode: None,
            },
            catalogue: Default::default(),
            revision: SafeInteger::default(),
        }
    }
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.pending_interactions.len() > MAX_PENDING_INTERACTIONS
            || self
                .pending_interactions
                .iter()
                .any(|(id, item)| id != &item.id || item.validate_definition().is_err())
        {
            return Err(QueryError::InvalidInput);
        }
        for item in self.pending_interactions.values() {
            if let Some(expiry) = item.expires_at {
                SafeInteger::new(expiry)?;
            }
        }
        let usage = &self.usage;
        for n in [
            Some(usage.input_tokens),
            Some(usage.output_tokens),
            Some(usage.cost_micros),
            usage.context_used,
            usage.context_size,
            usage.cache_read_tokens,
            usage.cache_write_tokens,
        ]
        .into_iter()
        .flatten()
        {
            SafeInteger::new(n)?;
        }
        json_bytes(self, MAX_VIEW_BYTES).map(|_| ())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentKind {
    Text,
    ToolText,
    ToolDiff,
    ToolResource,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ContentRefWire", into = "ContentRefWire")]
pub struct ContentRef {
    pub id: ContentId,
    pub sha256: ContentHash,
    pub bytes: SafeInteger,
    pub kind: ContentKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentRefWire {
    id: ContentId,
    sha256: ContentHash,
    bytes: SafeInteger,
    kind: ContentKind,
}
impl TryFrom<ContentRefWire> for ContentRef {
    type Error = QueryError;
    fn try_from(v: ContentRefWire) -> Result<Self, Self::Error> {
        let value = Self {
            id: v.id,
            sha256: v.sha256,
            bytes: v.bytes,
            kind: v.kind,
        };
        value.validate()?;
        Ok(value)
    }
}
impl From<ContentRef> for ContentRefWire {
    fn from(v: ContentRef) -> Self {
        Self {
            id: v.id,
            sha256: v.sha256,
            bytes: v.bytes,
            kind: v.kind,
        }
    }
}
impl ContentRef {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.bytes.get() > MAX_CONTENT_BYTES as u64 {
            return Err(QueryError::TooLarge);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum TextBody {
    Inline { text: String },
    Archived { content: ContentRef },
}
impl TextBody {
    /// Caller persists the immutable text even when the wire representation is inline.
    pub fn from_text(text: &str, content: ContentRef) -> Result<Self, QueryError> {
        content.validate()?;
        if content.kind != ContentKind::Text
            || content.bytes.get() != text.len() as u64
            || content.sha256 != ContentHash::of(text)
        {
            return Err(QueryError::InvalidInput);
        }
        if text.len() <= INLINE_TEXT_BYTES {
            Ok(Self::Inline { text: text.into() })
        } else {
            Ok(Self::Archived { content })
        }
    }
    pub fn validate(&self) -> Result<(), QueryError> {
        match self {
            Self::Inline { text } if text.len() > INLINE_TEXT_BYTES => Err(QueryError::TooLarge),
            Self::Inline { .. } => Ok(()),
            Self::Archived { content } if content.kind != ContentKind::Text => {
                Err(QueryError::InvalidInput)
            }
            Self::Archived { content } => content.validate(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryHeader {
    pub seq: SafeInteger,
    pub id: EntryId,
    pub turn: TurnId,
    pub role: EntryRole,
    pub message: Option<ProviderMessageId>,
    pub text: TextBody,
    pub image: Option<ImageRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum ToolBody {
    Text {
        content: ContentRef,
    },
    Diff {
        path: String,
        old_text: Option<ContentRef>,
        new_text: ContentRef,
    },
    ResourceText {
        uri: String,
        content: ContentRef,
        mime_type: Option<String>,
    },
    ResourceLink {
        uri: String,
        name: String,
        mime_type: Option<String>,
    },
    TerminalReference {
        id: TerminalId,
    },
    Unsupported {
        kind: UnsupportedToolContent,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolHeader {
    pub id: ToolCallId,
    pub turn: TurnId,
    pub status: ToolStatus,
    pub kind: Option<ToolKind>,
    pub title: String,
    pub name: Option<String>,
    pub locations: Vec<ToolLocation>,
    pub content: Vec<ToolBody>,
}
impl ToolHeader {
    pub fn validate(&self) -> Result<(), QueryError> {
        let check = |r: &ContentRef, kind| {
            r.validate()?;
            if r.kind != kind {
                return Err(QueryError::InvalidInput);
            }
            Ok(())
        };
        for body in &self.content {
            match body {
                ToolBody::Text { content } => check(content, ContentKind::ToolText)?,
                ToolBody::Diff {
                    old_text, new_text, ..
                } => {
                    if let Some(r) = old_text {
                        check(r, ContentKind::ToolDiff)?;
                    }
                    check(new_text, ContentKind::ToolDiff)?;
                }
                ToolBody::ResourceText { content, .. } => {
                    check(content, ContentKind::ToolResource)?
                }
                _ => {}
            }
        }
        json_bytes(self, MAX_QUERY_BYTES).map(|_| ())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum CommandReceipt {
    Created {
        summary: SessionSummary,
    },
    Loaded {
        view: Box<SessionView>,
    },
    Accepted {
        session: SessionId,
        revision: SafeInteger,
    },
    Forked {
        summary: SessionSummary,
    },
    UndoCompleted {
        session: SessionId,
        report: crate::workspace_undo::UndoReport,
    },
    Removed {
        session: SessionId,
    },
    ForkCancelRequested {
        source: SessionId,
        operation: OperationId,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitBatch {
    pub session: SessionId,
    pub revision: SafeInteger,
    pub view: Option<SessionView>,
    pub entries: Vec<EntryHeader>,
    pub tools: Vec<ToolHeader>,
    pub removed: bool,
}
impl CommitBatch {
    pub fn validate(&self) -> Result<(), QueryError> {
        if let Some(view) = &self.view {
            view.validate()?;
            if view.id != self.session || view.revision != self.revision {
                return Err(QueryError::InvalidInput);
            }
        }
        if self.removed
            && (self.view.is_some() || !self.entries.is_empty() || !self.tools.is_empty())
        {
            return Err(QueryError::InvalidInput);
        }
        for entry in &self.entries {
            entry.text.validate()?;
        }
        for tool in &self.tools {
            tool.validate()?;
        }
        #[derive(Serialize)]
        struct Envelope<'a> {
            r#type: &'static str,
            batch: &'a CommitBatch,
        }
        json_bytes(
            &Envelope {
                r#type: "batch",
                batch: self,
            },
            MAX_QUERY_BYTES,
        )
        .map(|_| ())
    }
}

/// Measure the full JSON, not character counts, before sending or committing.
pub fn json_bytes<T: Serialize>(value: &T, budget: usize) -> Result<Vec<u8>, QueryError> {
    let bytes = serde_json::to_vec(value).map_err(|_| QueryError::InvalidInput)?;
    if bytes.len() > budget {
        return Err(QueryError::TooLarge);
    }
    Ok(bytes)
}
/// Worst-case safe request ID accounts for every byte in the production
/// query envelope. Smaller IDs cannot cause a previously fitting page to grow.
pub fn query_bytes<T: Serialize>(kind: &str, value: &T) -> Result<Vec<u8>, QueryError> {
    #[derive(Serialize)]
    struct Result<'a, T> {
        kind: &'a str,
        value: &'a T,
    }
    #[derive(Serialize)]
    struct Envelope<'a, T> {
        r#type: &'static str,
        id: u64,
        result: Result<'a, T>,
    }
    json_bytes(
        &Envelope {
            r#type: "query",
            id: MAX_SAFE_INTEGER,
            result: Result { kind, value },
        },
        MAX_QUERY_BYTES,
    )
}

pub fn limit(value: Option<usize>, default: usize, maximum: usize) -> Result<usize, QueryError> {
    let n = value.unwrap_or(default);
    if n == 0 || n > maximum {
        return Err(QueryError::InvalidInput);
    }
    Ok(n)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub struct ProtocolVersion;
impl TryFrom<u32> for ProtocolVersion {
    type Error = QueryError;
    fn try_from(v: u32) -> Result<Self, Self::Error> {
        if v == PROTOCOL_VERSION {
            Ok(Self)
        } else {
            Err(QueryError::UnsupportedVersion)
        }
    }
}
impl From<ProtocolVersion> for u32 {
    fn from(_: ProtocolVersion) -> Self {
        PROTOCOL_VERSION
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListCursor {
    pub version: ProtocolVersion,
    pub max_created_seq: SafeInteger,
    pub before_seq: SafeInteger,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryCursor {
    pub version: ProtocolVersion,
    pub session: SessionId,
    pub max_entry_seq: SafeInteger,
    pub before_seq: SafeInteger,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCursor {
    pub version: ProtocolVersion,
    pub session: SessionId,
    pub turn: TurnId,
    pub after_tool: ToolCallId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListPage {
    pub sessions: Vec<SessionSummary>,
    pub next_cursor: Option<ListCursor>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryPage {
    pub entries: Vec<EntryHeader>,
    pub next_cursor: Option<HistoryCursor>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolPage {
    pub tools: Vec<ToolHeader>,
    pub next_cursor: Option<ToolCursor>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentSlice {
    pub text: String,
    pub next_offset: Option<SafeInteger>,
    pub sha256: ContentHash,
    pub total_bytes: SafeInteger,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attached {
    pub view: SessionView,
    pub recent_page: HistoryPage,
}

/// A lookup never retries an operation. Started is deliberately uncertain: a
/// durable prepare alone cannot prove whether an external effect occurred.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationStatus {
    Unknown,
    Uncertain,
    Expired,
    Completed { receipt: CommandReceipt },
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum QueryResult {
    Operation(OperationStatus),
    List(ListPage),
    View(Box<SessionView>),
    History(HistoryPage),
    Tools(ToolPage),
    Content(ContentSlice),
    Attached(Box<Attached>),
    Management(super::management::ManagementData),
    ValidateUndo(crate::workspace_undo::UndoReport),
    TurnDiff(crate::workspace_review::TurnDiff),
    TurnDiffContent(crate::workspace_review::DiffContent),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryRequest {
    pub version: ProtocolVersion,
    pub id: SafeInteger,
    pub command: QueryCommand,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum QueryCommand {
    Operation {
        operation: super::OperationId,
    },
    List {
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    },
    Inspect {
        session: SessionId,
    },
    History {
        session: SessionId,
        cursor: Option<HistoryCursor>,
        limit: Option<usize>,
    },
    Tools {
        session: SessionId,
        turn: TurnId,
        cursor: Option<ToolCursor>,
        limit: Option<usize>,
    },
    Content {
        r#ref: ContentRef,
        offset: SafeInteger,
        length: Option<usize>,
    },
    Attach {
        session: SessionId,
    },
    Image {
        image: ImageRef,
    },
    Management {
        query: super::management::ManagementQuery,
    },
    ValidateUndo {
        session: SessionId,
        turn: crate::domain::TurnId,
    },
    TurnDiff {
        session: SessionId,
        turn: TurnId,
        #[serde(default)]
        offset: usize,
    },
    TurnDiffContent {
        session: SessionId,
        turn: TurnId,
        file: usize,
        after: bool,
        offset: SafeInteger,
    },
}
impl QueryCommand {
    pub fn validate(&self) -> Result<(), QueryError> {
        match self {
            Self::TurnDiff { offset, .. } if *offset > 5000 => {
                return Err(QueryError::InvalidInput)
            }
            Self::TurnDiffContent { file, offset, .. }
                if *file >= 5000 || offset.get() > 1048576 =>
            {
                return Err(QueryError::InvalidInput)
            }
            Self::Management { query } if !query.valid() => return Err(QueryError::InvalidInput),
            Self::Management { .. }
            | Self::ValidateUndo { .. }
            | Self::TurnDiff { .. }
            | Self::TurnDiffContent { .. } => {}
            Self::List { cursor, limit: n } => {
                limit(*n, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)?;
                if cursor
                    .as_ref()
                    .is_some_and(|c| c.before_seq > c.max_created_seq || c.before_seq.get() == 0)
                {
                    return Err(QueryError::InvalidInput);
                }
            }
            Self::History {
                session,
                cursor,
                limit: n,
            } => {
                limit(*n, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)?;
                if cursor.as_ref().is_some_and(|c| {
                    &c.session != session
                        || c.before_seq > c.max_entry_seq
                        || c.before_seq.get() == 0
                }) {
                    return Err(QueryError::InvalidInput);
                }
            }
            Self::Tools {
                session,
                turn,
                cursor,
                limit: n,
            } => {
                limit(*n, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)?;
                if cursor
                    .as_ref()
                    .is_some_and(|c| &c.session != session || &c.turn != turn)
                {
                    return Err(QueryError::InvalidInput);
                }
            }
            Self::Content {
                r#ref,
                offset,
                length,
            } => {
                r#ref.validate()?;
                limit(*length, CONTENT_SLICE_BYTES, CONTENT_SLICE_BYTES)?;
                if *offset > r#ref.bytes {
                    return Err(QueryError::InvalidInput);
                }
            }
            _ => {}
        }
        Ok(())
    }
}
impl CommandReceipt {
    pub fn view(&self) -> Option<&SessionView> {
        match self {
            Self::Loaded { view } => Some(view),
            _ => None,
        }
    }
    pub fn validate(&self) -> Result<(), QueryError> {
        if let Self::Loaded { view } = self {
            view.validate()?;
        }
        #[derive(Serialize)]
        struct Envelope<'a> {
            r#type: &'static str,
            id: u64,
            receipt: &'a CommandReceipt,
        }
        json_bytes(
            &Envelope {
                r#type: "reply",
                id: MAX_SAFE_INTEGER,
                receipt: self,
            },
            MAX_QUERY_BYTES,
        )
        .map(|_| ())
    }
}
impl HistoryPage {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.entries.len() > MAX_HISTORY_LIMIT {
            return Err(QueryError::TooLarge);
        }
        for entry in &self.entries {
            entry.text.validate()?;
        }
        query_bytes("history", self).map(|_| ())
    }
}
impl ListPage {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.sessions.len() > MAX_LIST_LIMIT {
            return Err(QueryError::TooLarge);
        }
        query_bytes("list", self).map(|_| ())
    }
}
impl ToolPage {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.tools.len() > MAX_HISTORY_LIMIT {
            return Err(QueryError::TooLarge);
        }
        for tool in &self.tools {
            tool.validate()?;
        }
        query_bytes("tools", self).map(|_| ())
    }
}
impl Attached {
    pub fn validate(&self) -> Result<(), QueryError> {
        self.view.validate()?;
        self.recent_page.validate()?;
        query_bytes("attached", self).map(|_| ())
    }
}
impl ContentSlice {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.text.len() > CONTENT_SLICE_BYTES
            || self.total_bytes.get() > MAX_CONTENT_BYTES as u64
        {
            return Err(QueryError::TooLarge);
        }
        if self
            .next_offset
            .is_some_and(|offset| offset > self.total_bytes)
        {
            return Err(QueryError::InvalidInput);
        }
        json_bytes(self, MAX_QUERY_BYTES).map(|_| ())
    }
}
