//! Typed facade: offset, classification and callback use share one SQL transaction.
use super::database::{Database, StoreRequest};
use crate::{
    domain::{error::DomainError, OperationId, SessionId},
    telegram::{
        command::{TelegramAction, TelegramCommand},
        state::{InboxOutcome, InboxRecord, InboxStatus, TelegramState},
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
    Snapshot,
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
    Snapshot(TelegramState),
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
    pub async fn snapshot(&self) -> Result<TelegramState, DomainError> {
        match self.request(Action::Snapshot).await? {
            Output::Snapshot(state) => Ok(state),
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
            Output::Admission(result) => Ok(result),
            _ => unreachable!(),
        }
    }
    pub async fn pending(&self, limit: usize) -> Result<Vec<InboxRecord>, DomainError> {
        match self.request(Action::Pending(limit)).await? {
            Output::Pending(records) => Ok(records),
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

/// Pure admission logic runs only on the database thread, never across HTTP/await.
pub(super) fn apply(
    state: &mut TelegramState,
    action: Action,
    max_pending: usize,
) -> Result<Output, DomainError> {
    match action {
        Action::Snapshot => return Ok(Output::Snapshot(state.clone())),
        Action::Pending(limit) => {
            return Ok(Output::Pending(
                state
                    .inbox
                    .values()
                    .filter(|r| matches!(r.status, InboxStatus::Pending))
                    .take(limit)
                    .cloned()
                    .collect(),
            ))
        }
        Action::Claim(bot) => {
            if state.bot.is_some_and(|old| old != bot) {
                return Err(failure("Telegram state belongs to another bot"));
            }
            state.bot = Some(bot);
        }
        Action::Bind(topic, session) => {
            if state
                .bindings
                .iter()
                .any(|(key, id)| id == &session && key != &topic)
            {
                return Err(DomainError::InvalidAnswer(
                    "session already bound to another Telegram topic".into(),
                ));
            }
            state.bindings.insert(topic, session);
        }
        Action::Unbind(topic, expected) => {
            if state.bindings.get(&topic) == Some(&expected) {
                state.bindings.remove(&topic);
            }
        }
        Action::Register(key, binding) => {
            if let Some(existing) = state.callbacks.get(&key) {
                let mut expected = binding;
                expected.used_by = existing.used_by;
                if serde_json::to_vec(existing).map_err(failure)?
                    != serde_json::to_vec(&expected).map_err(failure)?
                {
                    return Err(DomainError::OperationConflict);
                }
            } else {
                if state.callbacks.len() >= 4096 {
                    return Err(DomainError::Backpressure);
                }
                if binding.used_by.is_some() {
                    return Err(DomainError::InvalidAnswer(
                        "callback cannot start consumed".into(),
                    ));
                }
                state.callbacks.insert(key, binding);
            }
        }
        Action::Admit(admission) => {
            if admission.id.get() < state.offset {
                return Ok(Output::Admission(AdmissionResult::Duplicate));
            }
            if let Some(command) = &admission.command {
                if state.bindings.get(&command.topic) != admission.expected_binding.as_ref() {
                    return Err(DomainError::Backpressure);
                }
                if state
                    .inbox
                    .values()
                    .filter(|r| matches!(r.status, InboxStatus::Pending))
                    .count()
                    >= max_pending
                {
                    return Err(DomainError::Backpressure);
                }
            }
            if admission
                .callback_query
                .as_ref()
                .is_some_and(|q| q.is_empty() || q.len() > 200 || q.chars().any(char::is_control))
            {
                return Err(DomainError::InvalidAnswer(
                    "invalid callback query identity".into(),
                ));
            }
            if let Some(key) = &admission.callback {
                let binding = state
                    .callbacks
                    .get_mut(key)
                    .ok_or_else(|| DomainError::InvalidAnswer("callback not found".into()))?;
                let command = admission
                    .command
                    .as_ref()
                    .ok_or_else(|| DomainError::InvalidAnswer("callback command missing".into()))?;
                match &command.action {
                    TelegramAction::Answer { session, answer }
                        if binding.used_by.is_none()
                            && binding.topic == command.topic
                            && &binding.session == session
                            && &binding.answer == answer =>
                    {
                        binding.used_by = Some(admission.id)
                    }
                    _ => {
                        return Err(DomainError::InvalidAnswer(
                            "callback already used or binding mismatch".into(),
                        ))
                    }
                }
            }
            state.offset = admission.id.get() + 1;
            crate::domain::query::SafeInteger::new(state.offset).map_err(failure)?;
            let result = if let Some(command) = admission.command {
                state.inbox.insert(
                    admission.id,
                    InboxRecord {
                        id: admission.id,
                        sender: admission.sender.ok_or_else(|| {
                            DomainError::InvalidAnswer("inbox sender missing".into())
                        })?,
                        operation: operation(admission.id)?,
                        command,
                        callback: admission.callback,
                        callback_query: admission.callback_query,
                        status: InboxStatus::Pending,
                    },
                );
                AdmissionResult::Accepted
            } else {
                AdmissionResult::Ignored
            };
            return Ok(Output::Admission(result));
        }
        Action::Compact(now) => {
            let before = (state.inbox.len(), state.callbacks.len());
            state
                .inbox
                .retain(|_, r| matches!(r.status, InboxStatus::Pending));
            let protected: std::collections::BTreeSet<_> = state
                .inbox
                .values()
                .filter_map(|r| r.callback.clone())
                .collect();
            state
                .callbacks
                .retain(|key, binding| binding.expires_at > now || protected.contains(key));
            return Ok(Output::Compacted(
                before.0 - state.inbox.len(),
                before.1 - state.callbacks.len(),
            ));
        }
        Action::Complete(id, outcome) => {
            let record = state
                .inbox
                .get_mut(&id)
                .ok_or_else(|| failure("inbox record missing"))?;
            if matches!(record.status, InboxStatus::Pending) {
                record.status = InboxStatus::Completed(outcome);
            }
        }
    }
    Ok(Output::Unit)
}
