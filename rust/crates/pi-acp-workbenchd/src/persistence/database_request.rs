//! Typed executor messages and routing policy, separate from thread lifecycle.
use super::database::StoreError;
use crate::domain::{
    query::{
        CommitBatch, ContentRef, HistoryCursor, HistoryPage, ListCursor, ListPage, SafeInteger,
        SessionSummary, SessionView,
    },
    transition::Transition,
    SessionId,
};
use tokio::sync::oneshot;

type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum StoreRequest {
    ContextStage {
        session: SessionId,
        action: crate::domain::management::ManagementAction,
        reply: Reply<crate::domain::management::ContextIntent>,
    },
    ContextSnapshot {
        reply: Reply<crate::domain::management::ContextSnapshot>,
    },
    ContextSettle {
        revision: u64,
        error: Option<String>,
        reply: Reply<()>,
    },
    ManagementRead {
        query: crate::domain::management::ManagementQuery,
        reply: Reply<crate::domain::management::ManagementData>,
    },
    ManagementUpdate {
        session: SessionId,
        action: crate::domain::management::ManagementAction,
        ticket: Option<crate::domain::operation::OperationTicket>,
        reply: Reply<crate::domain::query::CommandReceipt>,
    },
    ModelDefaults {
        session: SessionId,
        models: crate::domain::management::ProviderModels,
        reply: Reply<()>,
    },
    TitleJob {
        session: SessionId,
        reply: Reply<Option<String>>,
    },
    TitleResult {
        session: SessionId,
        result: crate::domain::management::TitleResponse,
        reply: Reply<()>,
    },
    TurnDiffSave {
        session: SessionId,
        turn: crate::domain::TurnId,
        diff: Box<crate::workspace_review::TurnDiff>,
        reply: Reply<()>,
    },
    TurnDiffGet {
        session: SessionId,
        turn: crate::domain::TurnId,
        reply: Reply<Option<crate::workspace_review::TurnDiff>>,
    },
    TurnDiffPage {
        session: SessionId,
        turn: crate::domain::TurnId,
        offset: usize,
        reply: Reply<crate::workspace_review::TurnDiff>,
    },
    TurnDiffContent {
        session: SessionId,
        turn: crate::domain::TurnId,
        file: usize,
        after: bool,
        offset: SafeInteger,
        reply: Reply<crate::workspace_review::DiffContent>,
    },
    Attached {
        session: SessionId,
        reply: Reply<crate::domain::query::Attached>,
    },
    Tools {
        session: SessionId,
        turn: crate::domain::TurnId,
        cursor: Option<crate::domain::query::ToolCursor>,
        limit: Option<usize>,
        reply: Reply<crate::domain::query::ToolPage>,
    },
    Remove {
        session: SessionId,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply<CommitBatch>,
    },
    Tool {
        session: SessionId,
        turn: crate::domain::TurnId,
        tool: crate::domain::ToolCallId,
        reply: Reply<Option<crate::domain::query::ToolHeader>>,
    },
    PrepareFork {
        view: Box<SessionView>,
        request: crate::domain::fork::ForkRequest,
        candidates: Vec<crate::domain::fork::ForkCandidate>,
        reply: Reply<crate::domain::fork::ForkPlan>,
    },
    AdoptFork {
        plan: Box<crate::domain::fork::ForkPlan>,
        native: crate::domain::ProviderSessionId,
        reply: Reply<(SessionView, SessionSummary)>,
    },
    #[cfg(test)]
    Create {
        view: Box<SessionView>,
        reply: Reply<SessionSummary>,
    },
    Commit {
        commit: Box<Transition>,
        reply: Reply<CommitBatch>,
    },
    View {
        session: SessionId,
        reply: Reply<SessionView>,
    },
    Summary {
        session: SessionId,
        reply: Reply<SessionSummary>,
    },
    WorkerActivity {
        session: SessionId,
        reply: Reply<(u64, u64)>,
    },
    List {
        cursor: Option<ListCursor>,
        limit: Option<usize>,
        reply: Reply<ListPage>,
    },
    HistoryClear {
        request: super::history_clear::Request,
        reply: Reply<super::history_clear::Output>,
    },
    Search {
        filter: crate::domain::query::SessionFilter,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
        reply: Reply<ListPage>,
    },
    ActivityList {
        cursor: Option<ListCursor>,
        limit: Option<usize>,
        reply: Reply<ListPage>,
    },
    History {
        session: SessionId,
        cursor: Option<HistoryCursor>,
        limit: Option<usize>,
        reply: Reply<HistoryPage>,
    },
    ContentSlice {
        content: ContentRef,
        offset: SafeInteger,
        length: Option<usize>,
        reply: Reply<crate::domain::query::ContentSlice>,
    },
    Content {
        content: ContentRef,
        reply: Reply<String>,
    },
    Delivery(Box<super::delivery::Request>),
    Payload(Box<super::payload::Request>),
    TelegramInbox(Box<super::inbox::Request>),
    TelegramEffect(Box<super::telegram_effect::Request>),
    Journal(Box<super::journal::Request>),
    #[cfg(test)]
    ArchiveImage {
        asset: crate::domain::image::ImageAsset,
        reply: Reply<()>,
    },
    Image {
        id: crate::domain::ImageId,
        reply: Reply<crate::domain::image::ImageAsset>,
    },
    #[cfg(test)]
    Test(super::sqlite_tests::TestRequest),
}
impl StoreRequest {
    pub(super) fn read_only(&self) -> bool {
        match self {
            Self::ManagementRead { .. }
            | Self::ContextSnapshot { .. }
            | Self::TurnDiffGet { .. }
            | Self::TurnDiffPage { .. }
            | Self::TurnDiffContent { .. }
            | Self::Attached { .. }
            | Self::Tools { .. }
            | Self::Tool { .. }
            | Self::View { .. }
            | Self::List { .. }
            | Self::Search { .. }
            | Self::History { .. }
            | Self::ContentSlice { .. }
            | Self::Content { .. }
            | Self::Image { .. } => true,
            #[cfg(test)]
            Self::Test(super::sqlite_tests::TestRequest::ReaderPause { .. }) => true,
            Self::Delivery(request) => matches!(
                request.as_ref(),
                super::delivery::Request::DispatchSnapshot { .. }
            ),
            Self::Journal(request) => {
                matches!(request.as_ref(), super::journal::Request::Status { .. })
            }
            _ => false,
        }
    }
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::ContextStage { .. } => "context_stage",
            Self::ContextSnapshot { .. } => "context_snapshot",
            Self::ContextSettle { .. } => "context_settle",
            Self::HistoryClear { .. } => "history_clear",
            Self::ManagementRead { .. } => "management_read",
            Self::ManagementUpdate { .. } => "management_update",
            Self::ModelDefaults { .. } => "model_defaults",
            Self::TitleJob { .. } => "title_job",
            Self::TitleResult { .. } => "title_result",
            Self::TurnDiffGet { .. } => "turn_diff",
            Self::TurnDiffPage { .. } => "turn_diff_page",
            Self::TurnDiffContent { .. } => "turn_diff_content",
            Self::TurnDiffSave { .. } => "turn_diff_save",
            Self::Attached { .. } => "attach",
            Self::Tools { .. } => "tools",
            Self::Remove { .. } => "remove",
            Self::Tool { .. } => "tool",
            Self::PrepareFork { .. } => "fork_prepare",
            Self::AdoptFork { .. } => "fork_adopt",
            #[cfg(test)]
            Self::Create { .. } => "create",
            Self::Commit { .. } => "commit",
            Self::View { .. } => "view",
            Self::Summary { .. } => "summary",
            Self::WorkerActivity { .. } => "worker_activity",
            Self::List { .. } | Self::Search { .. } | Self::ActivityList { .. } => "list",
            Self::History { .. } => "history",
            Self::ContentSlice { .. } => "content_slice",
            Self::Content { .. } => "content",
            Self::Delivery(_) => "delivery",
            Self::Payload(_) => "payload",
            Self::TelegramInbox(_) => "inbox",
            Self::TelegramEffect(_) => "telegram_effect",
            Self::Journal(_) => "operation",
            #[cfg(test)]
            Self::ArchiveImage { .. } => "archive_image",
            Self::Image { .. } => "image",
            #[cfg(test)]
            Self::Test(_) => "test",
        }
    }
}
