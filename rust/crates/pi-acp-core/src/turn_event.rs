//! Durable task events shared by publishers and notification consumers.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvent {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_text: Option<String>,
    pub text: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pending_permissions: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub non_text_blocks: usize,
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}
