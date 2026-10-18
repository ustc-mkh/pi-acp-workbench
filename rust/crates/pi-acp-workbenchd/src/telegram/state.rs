use super::{
    command::TelegramCommand,
    types::{CallbackBinding, CallbackKey, TopicKey, UpdateId, UserId},
};
use crate::domain::{OperationId, SessionId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    Applied,
    Rejected,
    Failed,
    Interrupted,
}
