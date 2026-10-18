//! Non-idempotent Telegram topic creation has its own typed write-before-effect receipt.
use super::io;
use crate::{
    domain::{error::DomainError, OperationId},
    telegram::{
        api::{ApiError, BotApi},
        types::{ChatId, TopicId},
    },
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct TopicRequest {
    chat: ChatId,
    name: String,
}
#[derive(Serialize, Deserialize)]
enum EffectState {
    Started,
    Completed(TopicId),
    Failed(u16),
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    operation: OperationId,
    request: TopicRequest,
    state: EffectState,
}
#[derive(Clone)]
pub struct TelegramEffects {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}
impl TelegramEffects {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub async fn completed(
        &self,
        operation: &OperationId,
        chat: ChatId,
        name: &str,
    ) -> Result<TopicId, DomainError> {
        let _gate = self.gate.lock().await;
        let receipt: Receipt = io::read(&self.root.join(format!("{operation}.json")))
            .await?
            .ok_or_else(|| DomainError::Persistence("completed topic receipt missing".into()))?;
        if &receipt.operation != operation
            || receipt.request
                != (TopicRequest {
                    chat,
                    name: name.into(),
                })
        {
            return Err(DomainError::OperationConflict);
        }
        match receipt.state {
            EffectState::Completed(topic) => Ok(topic),
            EffectState::Started => Err(DomainError::OperationInterrupted),
            EffectState::Failed(code) => Err(DomainError::Worker(format!(
                "Telegram topic creation rejected ({code})"
            ))),
        }
    }
    pub async fn create_topic(
        &self,
        operation: OperationId,
        api: &impl BotApi,
        chat: ChatId,
        name: String,
    ) -> Result<TopicId, DomainError> {
        let _gate = self.gate.lock().await;
        let path = self.root.join(format!("{operation}.json"));
        let request = TopicRequest { chat, name };
        if let Some(receipt) = io::read::<Receipt>(&path).await? {
            if receipt.operation != operation || receipt.request != request {
                return Err(DomainError::OperationConflict);
            }
            return match receipt.state {
                EffectState::Started => Err(DomainError::OperationInterrupted),
                EffectState::Completed(topic) => Ok(topic),
                EffectState::Failed(code) => Err(DomainError::Worker(format!(
                    "Telegram topic creation rejected ({code})"
                ))),
            };
        }
        let mut receipt = Receipt {
            operation,
            request,
            state: EffectState::Started,
        };
        io::write(&path, &receipt).await?;
        match api.create_topic(chat, &receipt.request.name).await {
            Ok(topic) => {
                receipt.state = EffectState::Completed(topic.message_thread_id);
                io::write(&path, &receipt).await?;
                Ok(topic.message_thread_id)
            }
            Err(ApiError::Response {
                code: code @ 400..=499,
                ..
            }) => {
                receipt.state = EffectState::Failed(code);
                io::write(&path, &receipt).await?;
                Err(DomainError::Worker(
                    "Telegram topic creation rejected".into(),
                ))
            }
            // A transport/protocol/server failure can follow a committed remote
            // effect. Keep Started and require explicit user reconciliation.
            Err(_) => Err(DomainError::OperationInterrupted),
        }
    }
}
