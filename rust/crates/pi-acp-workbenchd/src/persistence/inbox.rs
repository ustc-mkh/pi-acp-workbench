//! Typed facade: offset, classification and callback use share one SQL transaction.
use super::database::{Database, StoreRequest};
#[cfg(test)]
use crate::telegram::state::TelegramState;
use crate::{
    domain::{error::DomainError, OperationId, SessionId},
    telegram::{
        command::TelegramCommand,
        state::{InboxOutcome, InboxRecord},
        types::{CallbackBinding, CallbackKey, TopicKey, UpdateId, UserId},
    },
};
use tokio::sync::oneshot;
#[derive(Clone)]
pub struct TelegramStore {
    pub(super) database: Database,
    max_pending: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionResult {
    Accepted,
    Ignored,
    Duplicate,
}
pub struct Admission {
    pub id: UpdateId,
    pub sender: Option<UserId>,
    pub command: Option<TelegramCommand>,
    pub callback: Option<CallbackKey>,
    pub callback_query: Option<String>,
    pub expected_binding: Option<SessionId>,
}
pub(super) enum Action {
    #[cfg(test)]
    Snapshot,
    Offset,
    Binding(TopicKey),
    Topic(SessionId),
    Callback(CallbackKey),
    Claim(UserId),
    Bind(TopicKey, SessionId),
    Unbind(TopicKey, SessionId),
    Register(CallbackKey, CallbackBinding),
    Admit(Admission),
    Pending(usize),
    Compact(u64),
    Complete(UpdateId, InboxOutcome),
}
pub(super) enum Output {
    Unit,
    #[cfg(test)]
    Snapshot(TelegramState),
    Offset(u64),
    Binding(Option<SessionId>),
    Topic(Option<TopicKey>),
    Callback(Option<CallbackBinding>),
    Pending(Vec<InboxRecord>),
    Admission(AdmissionResult),
    Compacted(usize, usize),
}
pub(super) struct Request {
    pub action: Action,
    pub max_pending: usize,
    pub reply: oneshot::Sender<Result<Output, DomainError>>,
}
impl TelegramStore {
    #[cfg(test)]
    pub(crate) fn database(&self) -> &Database {
        &self.database
    }
    pub fn new(database: Database, max_pending: usize) -> Self {
        Self {
            database,
            max_pending,
        }
    }
    async fn request(&self, action: Action) -> Result<Output, DomainError> {
        let (reply, result) = oneshot::channel();
        self.database
            .enqueue(StoreRequest::TelegramInbox(Box::new(Request {
                action,
                max_pending: self.max_pending,
                reply,
            })))
            .await
            .map_err(failure)?;
        result.await.map_err(failure)?
    }
    #[cfg(test)]
    pub async fn snapshot(&self) -> Result<TelegramState, DomainError> {
        match self.request(Action::Snapshot).await? {
            Output::Snapshot(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn offset(&self) -> Result<u64, DomainError> {
        match self.request(Action::Offset).await? {
            Output::Offset(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn binding(&self, topic: &TopicKey) -> Result<Option<SessionId>, DomainError> {
        match self.request(Action::Binding(topic.clone())).await? {
            Output::Binding(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn topic(&self, session: &SessionId) -> Result<Option<TopicKey>, DomainError> {
        match self.request(Action::Topic(session.clone())).await? {
            Output::Topic(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn callback(
        &self,
        key: &CallbackKey,
    ) -> Result<Option<CallbackBinding>, DomainError> {
        match self.request(Action::Callback(key.clone())).await? {
            Output::Callback(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn claim_bot(&self, bot: UserId) -> Result<(), DomainError> {
        self.request(Action::Claim(bot)).await.map(|_| ())
    }
    pub async fn bind(&self, topic: TopicKey, session: SessionId) -> Result<(), DomainError> {
        self.request(Action::Bind(topic, session)).await.map(|_| ())
    }
    pub async fn unbind(&self, topic: &TopicKey, expected: &SessionId) -> Result<(), DomainError> {
        self.request(Action::Unbind(topic.clone(), expected.clone()))
            .await
            .map(|_| ())
    }
    pub async fn register_callback(
        &self,
        key: CallbackKey,
        binding: CallbackBinding,
    ) -> Result<(), DomainError> {
        self.request(Action::Register(key, binding))
            .await
            .map(|_| ())
    }
    pub async fn admit(&self, admission: Admission) -> Result<AdmissionResult, DomainError> {
        match self.request(Action::Admit(admission)).await? {
            Output::Admission(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn pending(&self, limit: usize) -> Result<Vec<InboxRecord>, DomainError> {
        match self
            .request(Action::Pending(limit.min(self.max_pending)))
            .await?
        {
            Output::Pending(value) => Ok(value),
            _ => unreachable!(),
        }
    }
    pub async fn compact(&self, now: u64) -> Result<(usize, usize), DomainError> {
        match self.request(Action::Compact(now)).await? {
            Output::Compacted(inbox, callbacks) => Ok((inbox, callbacks)),
            _ => unreachable!(),
        }
    }
    pub async fn complete(&self, id: UpdateId, outcome: InboxOutcome) -> Result<(), DomainError> {
        self.request(Action::Complete(id, outcome))
            .await
            .map(|_| ())
    }
}
pub(super) fn operation(id: UpdateId) -> Result<OperationId, DomainError> {
    Ok(OperationId::new(format!("telegram-update-{}", id.get()))?)
}
pub(super) fn failure(error: impl std::fmt::Display) -> DomainError {
    DomainError::Persistence(error.to_string())
}
