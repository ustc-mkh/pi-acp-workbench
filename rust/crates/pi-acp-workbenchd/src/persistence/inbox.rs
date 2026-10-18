//! Offset, classification and callback consumption commit in one atomic record.
use super::io;
use crate::{
    domain::{error::DomainError, OperationId, SessionId},
    telegram::{
        command::{TelegramAction, TelegramCommand},
        state::{InboxOutcome, InboxRecord, InboxStatus, TelegramState},
        types::{CallbackBinding, CallbackKey, TopicKey, UpdateId, UserId},
    },
};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
#[derive(Clone)]
pub struct TelegramStore {
    path: PathBuf,
    gate: Arc<Mutex<()>>,
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
impl TelegramStore {
    pub fn new(path: impl Into<PathBuf>, max_pending: usize) -> Self {
        Self {
            path: path.into(),
            gate: Arc::new(Mutex::new(())),
            max_pending,
        }
    }
    async fn read(&self) -> Result<TelegramState, DomainError> {
        let state: TelegramState = io::read(&self.path).await?.unwrap_or_default();
        if state.bindings.values().collect::<BTreeSet<_>>().len() != state.bindings.len() {
            return Err(DomainError::Persistence(
                "duplicate Telegram session binding".into(),
            ));
        }
        for (id, record) in &state.inbox {
            if id != &record.id || state.offset <= id.get() || record.operation != operation(*id)? {
                return Err(DomainError::Persistence(
                    "Telegram inbox identity/offset mismatch".into(),
                ));
            }
            if let Some(callback) = &record.callback {
                if state
                    .callbacks
                    .get(callback)
                    .and_then(|callback| callback.used_by)
                    != Some(*id)
                {
                    return Err(DomainError::Persistence(
                        "Telegram callback receipt missing".into(),
                    ));
                }
            }
        }
        Ok(state)
    }
    pub async fn snapshot(&self) -> Result<TelegramState, DomainError> {
        let _gate = self.gate.lock().await;
        self.read().await
    }
    pub async fn claim_bot(&self, bot: UserId) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        if state.bot.is_some_and(|existing| existing != bot) {
            return Err(DomainError::Persistence(
                "Telegram state belongs to another bot".into(),
            ));
        }
        state.bot = Some(bot);
        io::write(&self.path, &state).await
    }
    pub async fn bind(&self, topic: TopicKey, session: SessionId) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        if state
            .bindings
            .iter()
            .any(|(existing_topic, existing_session)| {
                existing_session == &session && existing_topic != &topic
            })
        {
            return Err(DomainError::InvalidAnswer(
                "session already bound to another Telegram topic".into(),
            ));
        }
        state.bindings.insert(topic, session);
        io::write(&self.path, &state).await
    }
    pub async fn unbind(&self, topic: &TopicKey, expected: &SessionId) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        if state.bindings.get(topic) == Some(expected) {
            state.bindings.remove(topic);
        }
        io::write(&self.path, &state).await
    }
    pub async fn register_callback(
        &self,
        key: CallbackKey,
        binding: CallbackBinding,
    ) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        if let Some(existing) = state.callbacks.get(&key) {
            let mut expected = binding;
            expected.used_by = existing.used_by;
            if serde_json::to_vec(existing).map_err(serialization)?
                != serde_json::to_vec(&expected).map_err(serialization)?
            {
                return Err(DomainError::OperationConflict);
            }
            return Ok(());
        }
        if state.callbacks.len() >= 4096 {
            return Err(DomainError::Backpressure);
        }
        if binding.used_by.is_some() {
            return Err(DomainError::InvalidAnswer(
                "callback cannot start consumed".into(),
            ));
        }
        state.callbacks.insert(key, binding);
        io::write(&self.path, &state).await
    }
    pub async fn admit(&self, admission: Admission) -> Result<AdmissionResult, DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        if admission.id.get() < state.offset {
            return Ok(AdmissionResult::Duplicate);
        }
        if let Some(command) = &admission.command {
            if state.bindings.get(&command.topic) != admission.expected_binding.as_ref() {
                return Err(DomainError::Backpressure);
            }
            if state
                .inbox
                .values()
                .filter(|record| matches!(record.status, InboxStatus::Pending))
                .count()
                >= self.max_pending
            {
                return Err(DomainError::Backpressure);
            }
        }
        if admission.callback_query.as_ref().is_some_and(|query| {
            query.is_empty() || query.len() > 200 || query.chars().any(char::is_control)
        }) {
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
        let outcome = if let Some(command) = admission.command {
            state.inbox.insert(
                admission.id,
                InboxRecord {
                    id: admission.id,
                    sender: admission
                        .sender
                        .ok_or_else(|| DomainError::InvalidAnswer("inbox sender missing".into()))?,
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
        io::write(&self.path, &state).await?;
        Ok(outcome)
    }
    pub async fn pending(&self, limit: usize) -> Result<Vec<InboxRecord>, DomainError> {
        let _gate = self.gate.lock().await;
        Ok(self
            .read()
            .await?
            .inbox
            .into_values()
            .filter(|record| matches!(record.status, InboxStatus::Pending))
            .take(limit)
            .collect())
    }
    /// Explicit maintenance only. Offset remains the deduplication high-water
    /// mark. Pending records and every callback they reference survive together;
    /// unexpired consumed bindings remain to reject delayed repeat clicks.
    pub async fn compact(&self, now: u64) -> Result<(usize, usize), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        let before_inbox = state.inbox.len();
        let before_callbacks = state.callbacks.len();
        state
            .inbox
            .retain(|_, record| matches!(record.status, InboxStatus::Pending));
        let protected: BTreeSet<_> = state
            .inbox
            .values()
            .filter_map(|record| record.callback.clone())
            .collect();
        state
            .callbacks
            .retain(|key, binding| binding.expires_at > now || protected.contains(key));
        let counts = (
            before_inbox - state.inbox.len(),
            before_callbacks - state.callbacks.len(),
        );
        if counts != (0, 0) {
            io::write(&self.path, &state).await?;
        }
        Ok(counts)
    }
    pub async fn complete(&self, id: UpdateId, outcome: InboxOutcome) -> Result<(), DomainError> {
        let _gate = self.gate.lock().await;
        let mut state = self.read().await?;
        let record = state
            .inbox
            .get_mut(&id)
            .ok_or_else(|| DomainError::Persistence("inbox record missing".into()))?;
        if matches!(record.status, InboxStatus::Completed(_)) {
            return Ok(());
        }
        record.status = InboxStatus::Completed(outcome);
        io::write(&self.path, &state).await
    }
}
fn operation(id: UpdateId) -> Result<OperationId, DomainError> {
    Ok(OperationId::new(format!("telegram-update-{}", id.get()))?)
}
fn serialization(error: serde_json::Error) -> DomainError {
    DomainError::Persistence(error.to_string())
}
