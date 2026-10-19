#[cfg(test)]
use super::types::{CallbackBinding, TopicKey};
use super::{
    command::TelegramCommand,
    types::{CallbackKey, UpdateId, UserId},
};
use crate::domain::OperationId;
#[cfg(test)]
use crate::domain::SessionId;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelegramState {
    pub bot: Option<UserId>,
    pub offset: u64,
    pub bindings: BTreeMap<TopicKey, SessionId>,
    pub callbacks: BTreeMap<CallbackKey, CallbackBinding>,
    pub inbox: BTreeMap<UpdateId, InboxRecord>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecord {
    pub id: UpdateId,
    pub sender: UserId,
    pub operation: OperationId,
    pub command: TelegramCommand,
    pub callback: Option<CallbackKey>,
    pub callback_query: Option<String>,
    pub status: InboxStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum InboxStatus {
    Pending,
    Completed(InboxOutcome),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum InboxOutcome {
    Cancelled { by: UpdateId },
    Applied,
    Rejected,
    Failed,
    Interrupted,
}
