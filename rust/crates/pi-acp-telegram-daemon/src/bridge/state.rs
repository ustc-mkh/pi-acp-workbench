//! Persisted relay schema. This module has no transport or task dependencies.
use super::{CONTROL_LIMIT, INBOX_LIMIT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Topic {
    pub session_id: String,
    pub thread_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum InboxPhase {
    Pending,
    Started,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InboxItem {
    pub(super) id: i64,
    pub(super) update: Value,
    pub(super) phase: InboxPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeState {
    pub version: u32,
    pub bot_id: i64,
    pub chat_id: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub offset: Option<i64>,
    pub topics: Vec<Topic>,
    pub delivered: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub notifications: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub silent: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub history_sent: Option<HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) inbox: Vec<InboxItem>,
}

impl BridgeState {
    pub(crate) fn valid_inbox(&self) -> bool {
        let mut ids = HashSet::new();
        self.inbox.len() <= INBOX_LIMIT + CONTROL_LIMIT
            && self.inbox.iter().all(|item| {
                item.id >= 0
                    && self.offset.is_some_and(|offset| item.id < offset)
                    && item.update.get("update_id").and_then(Value::as_i64) == Some(item.id)
                    && ids.insert(item.id)
            })
    }
}
