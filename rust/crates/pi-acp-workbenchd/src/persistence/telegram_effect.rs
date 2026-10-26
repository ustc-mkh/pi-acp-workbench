//! Write-before-effect receipts on the host's sole database executor.
use super::database::{Database, StoreRequest};
use crate::{
    domain::{error::DomainError, OperationId},
    telegram::{
        api::{ApiError, BotApi},
        types::{ChatId, TopicId},
    },
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TopicRequest {
    chat: ChatId,
    name: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) enum EffectState {
    Started,
    Completed(TopicId),
    Failed(u16),
    Uncertain,
}
impl EffectState {
    fn status(&self) -> &'static str {
        match self {
            Self::Started => "Started",
            Self::Completed(_) => "Completed",
            Self::Failed(_) => "Failed",
            Self::Uncertain => "Uncertain",
        }
    }
    fn result(self) -> Result<TopicId, DomainError> {
        match self {
            Self::Completed(topic) => Ok(topic),
            Self::Started | Self::Uncertain => Err(DomainError::OperationInterrupted),
            Self::Failed(code) => Err(DomainError::Worker(format!(
                "Telegram topic creation rejected ({code})"
            ))),
        }
    }
}
/// None means that this caller alone admitted Started and may perform HTTP.
pub(super) struct Request {
    operation: OperationId,
    request: TopicRequest,
    action: Action,
    reply: oneshot::Sender<Result<Option<EffectState>, DomainError>>,
}
enum Action {
    TitleMatches,
    TitleApplied(TopicId),
    BeginRename,
    Lookup,
    Begin,
    Finish(EffectState),
}
#[derive(Clone)]
pub struct TelegramEffects {
    database: Database,
}
impl TelegramEffects {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
    async fn request(
        &self,
        operation: OperationId,
        chat: ChatId,
        name: String,
        action: Action,
    ) -> Result<Option<EffectState>, DomainError> {
        let (reply, result) = oneshot::channel();
        self.database
            .enqueue(StoreRequest::TelegramEffect(Box::new(Request {
                operation,
                request: TopicRequest { chat, name },
                action,
                reply,
            })))
            .await
            .map_err(failure)?;
        result.await.map_err(failure)?
    }
    pub(crate) async fn rename_topic(
        &self,
        api: &impl BotApi,
        chat: ChatId,
        thread: TopicId,
        name: String,
    ) -> Result<(), DomainError> {
        let marker = OperationId::new(format!("topic-title-{}-{}", chat.get(), thread.get()))?;
        if self
            .request(marker.clone(), chat, name.clone(), Action::TitleMatches)
            .await?
            .is_some()
        {
            return Ok(());
        }
        // Editing a title is idempotent. A fresh receipt also handles A→B→A
        // at the same session revision; a historical Completed(A) is not proof
        // that Telegram still has A after B was applied.
        let operation = OperationId::new(format!("topic-rename-{}", uuid::Uuid::new_v4()))?;
        let state = if let Some(state) = self
            .request(operation.clone(), chat, name.clone(), Action::BeginRename)
            .await?
        {
            state
        } else {
            let state = match api.edit_topic(chat, thread, &name).await {
                Ok(()) => EffectState::Completed(thread),
                Err(ApiError::Response {
                    code: code @ 400..=499,
                    ..
                }) => EffectState::Failed(code),
                Err(_) => EffectState::Uncertain,
            };
            self.request(operation, chat, name.clone(), Action::Finish(state.clone()))
                .await?;
            state
        };
        state.result()?;
        self.request(marker, chat, name, Action::TitleApplied(thread))
            .await?;
        Ok(())
    }
    pub async fn completed(
        &self,
        operation: &OperationId,
        chat: ChatId,
        name: &str,
    ) -> Result<TopicId, DomainError> {
        self.request(operation.clone(), chat, name.into(), Action::Lookup)
            .await?
            .ok_or_else(|| failure("completed topic receipt missing"))?
            .result()
    }
    pub async fn create_topic(
        &self,
        operation: OperationId,
        api: &impl BotApi,
        chat: ChatId,
        name: String,
    ) -> Result<TopicId, DomainError> {
        if let Some(state) = self
            .request(operation.clone(), chat, name.clone(), Action::Begin)
            .await?
        {
            return state.result();
        }
        let state = match api.create_topic(chat, &name).await {
            Ok(topic) => EffectState::Completed(topic.message_thread_id),
            Err(ApiError::Response {
                code: code @ 400..=499,
                ..
            }) => EffectState::Failed(code),
            Err(_) => EffectState::Uncertain,
        };
        self.request(operation, chat, name, Action::Finish(state.clone()))
            .await?;
        state.result()
    }
}
fn failure(error: impl std::fmt::Display) -> DomainError {
    DomainError::Persistence(error.to_string())
}
pub(super) fn execute(db: &mut Connection, request: Request) {
    let Request {
        operation,
        request,
        action,
        reply,
    } = request;
    let result = (|| {
        let tx = db.transaction().map_err(failure)?;
        let found: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT request_json,status,result_json FROM telegram_effects WHERE effect_id=?1",
                [operation.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(failure)?;
        if matches!(action, Action::TitleMatches | Action::TitleApplied(_)) {
            let result = match action {
                Action::TitleMatches => found
                    .map(|(json, _, _)| {
                        serde_json::from_str::<TopicRequest>(&json).map_err(failure)
                    })
                    .transpose()?
                    .filter(|old| old == &request)
                    .map(|_| EffectState::Started),
                Action::TitleApplied(thread) => {
                    let state = EffectState::Completed(thread);
                    tx.execute("INSERT INTO telegram_effects(effect_id,status,request_json,result_json) VALUES (?1,'Completed',?2,?3) ON CONFLICT(effect_id) DO UPDATE SET status=excluded.status,request_json=excluded.request_json,result_json=excluded.result_json", params![operation.as_str(),serde_json::to_string(&request).map_err(failure)?,serde_json::to_string(&state).map_err(failure)?]).map_err(failure)?;
                    Some(state)
                }
                _ => unreachable!(),
            };
            crate::diagnostics::sqlite_commit(tx).map_err(failure)?;
            return Ok(result);
        }
        let stored = found
            .map(|(json, status, result)| {
                let old: TopicRequest = serde_json::from_str(&json).map_err(failure)?;
                if old != request {
                    return Err(DomainError::OperationConflict);
                }
                let state: EffectState = serde_json::from_str(
                    result
                        .as_deref()
                        .ok_or_else(|| failure("topic result missing"))?,
                )
                .map_err(failure)?;
                if state.status() != status {
                    return Err(failure("topic receipt status mismatch"));
                }
                Ok(state)
            })
            .transpose()?;
        let result = match action {
            Action::TitleMatches | Action::TitleApplied(_) => unreachable!(),
            Action::Lookup => stored,
            Action::Begin | Action::BeginRename
                if matches!(stored, Some(EffectState::Failed(429)))
                    || (matches!(action, Action::BeginRename)
                        && matches!(
                            stored,
                            Some(EffectState::Started | EffectState::Uncertain)
                        )) =>
            {
                tx.execute("UPDATE telegram_effects SET status='Started',result_json=?2 WHERE effect_id=?1",params![operation.as_str(),serde_json::to_string(&EffectState::Started).map_err(failure)?]).map_err(failure)?;
                None
            }
            Action::Begin | Action::BeginRename if stored.is_some() => stored,
            Action::Begin | Action::BeginRename => {
                tx.execute("INSERT INTO telegram_effects(effect_id,status,request_json,result_json) VALUES (?1,'Started',?2,?3)", params![operation.as_str(), serde_json::to_string(&request).map_err(failure)?, serde_json::to_string(&EffectState::Started).map_err(failure)?]).map_err(failure)?;
                None
            }
            Action::Finish(state) => {
                match stored {
                    Some(EffectState::Started) => {}
                    Some(old) if old == state => return Ok(Some(old)),
                    Some(_) => return Err(DomainError::OperationConflict),
                    None => return Err(failure("topic receipt missing")),
                }
                tx.execute(
                    "UPDATE telegram_effects SET status=?2,result_json=?3 WHERE effect_id=?1",
                    params![
                        operation.as_str(),
                        state.status(),
                        serde_json::to_string(&state).map_err(failure)?
                    ],
                )
                .map_err(failure)?;
                Some(state)
            }
        };
        crate::diagnostics::sqlite_commit(tx).map_err(failure)?;
        Ok(result)
    })();
    let _ = reply.send(result);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::sqlite_tests::{open, Root};

    #[tokio::test]
    async fn sql_effect_concurrent_admission_and_restart_never_readmit_started_or_uncertain() {
        let root = Root::new();
        let (lease, database) = open(&root.data()).await;
        let effects = TelegramEffects::new(database.clone());
        let operation = OperationId::generate();
        let chat = ChatId::new(-100).unwrap();
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..16 {
            let effects = effects.clone();
            let operation = operation.clone();
            jobs.spawn(async move {
                effects
                    .request(operation, chat, "topic".into(), Action::Begin)
                    .await
                    .unwrap()
            });
        }
        let mut admitted = 0;
        while let Some(result) = jobs.join_next().await {
            match result.unwrap() {
                None => admitted += 1,
                Some(state) => assert_eq!(state, EffectState::Started),
            }
        }
        assert_eq!(admitted, 1);
        database.shutdown().await.unwrap();
        let database = Database::open(root.data(), &lease).await.unwrap();
        let effects = TelegramEffects::new(database.clone());
        assert_eq!(
            effects
                .request(operation.clone(), chat, "topic".into(), Action::Begin)
                .await
                .unwrap(),
            Some(EffectState::Started)
        );
        assert!(matches!(
            effects
                .request(operation.clone(), chat, "different".into(), Action::Begin)
                .await,
            Err(DomainError::OperationConflict)
        ));
        effects
            .request(
                operation.clone(),
                chat,
                "topic".into(),
                Action::Finish(EffectState::Uncertain),
            )
            .await
            .unwrap();
        assert!(matches!(
            effects.completed(&operation, chat, "topic").await,
            Err(DomainError::OperationInterrupted)
        ));
        assert_eq!(
            effects
                .request(operation, chat, "topic".into(), Action::Begin)
                .await
                .unwrap(),
            Some(EffectState::Uncertain)
        );
        database.shutdown().await.unwrap();
    }
}
