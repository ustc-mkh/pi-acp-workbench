use super::ids::{IdError, SessionId};
use thiserror::Error;
#[derive(Clone, Debug, Error, serde::Serialize, serde::Deserialize)]
pub enum DomainError {
    #[error("invalid id: {0}")]
    InvalidId(#[from] IdError),
    #[error("session not found: {0}")]
    NotFound(SessionId),
    #[error("mailbox is full")]
    Backpressure,
    #[error("provider worker capacity exhausted; no safely evictable idle worker (Pi background wakeups may remain pinned until explicit stop/removal)")]
    WorkerCapacity,
    #[error("mailbox is closed")]
    MailboxClosed,
    #[error("ACP frame exceeds byte budget")]
    FrameTooLarge,
    #[error("session is busy")]
    Busy,
    #[error("no active turn")]
    NoActiveTurn,
    #[error("interaction not found")]
    InteractionNotFound,
    #[error("interaction expired")]
    InteractionExpired,
    #[error("invalid interaction answer: {0}")]
    InvalidAnswer(String),
    #[error("provider is not configured")]
    ProviderNotConfigured,
    #[error("unsupported provider feature: {0}")]
    UnsupportedFeature(String),
    #[error("native fork operation is not pending for this source")]
    NoActiveFork,
    #[error("native fork cancelled before its remote effect")]
    ForkCancelled,
    #[error("native fork outcome is uncertain; a branch may exist and the operation will not be repeated")]
    NativeForkUncertain,
    #[error("native branch {native} was created but host adoption was not confirmed: {reason}")]
    NativeForkUnadopted {
        native: super::ids::ProviderSessionId,
        reason: String,
    },
    #[error("worker: {0}")]
    Worker(String),
    #[error("ACP protocol: {0}")]
    Protocol(String),
    #[error("operation ID already used for a different request")]
    OperationConflict,
    #[error("operation was interrupted; refusing to repeat an uncertain side effect")]
    OperationInterrupted,
    #[error("operation result was expired; request cannot be executed again")]
    OperationExpired,
    #[error("query: {0}")]
    Query(#[from] super::query::QueryError),
    #[error("persistence: {0}")]
    Persistence(String),
}
impl DomainError {
    pub(crate) fn mailbox<T>(error: tokio::sync::mpsc::error::TrySendError<T>) -> Self {
        match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => Self::Backpressure,
            tokio::sync::mpsc::error::TrySendError::Closed(_) => Self::MailboxClosed,
        }
    }
}
