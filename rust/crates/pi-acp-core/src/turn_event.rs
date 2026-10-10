//! Durable task events shared by publishers and notification consumers.
use serde::{Deserialize, Serialize};

fn optional_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
fn status<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    match value.as_str() {
        "running" | "completed" | "cancelled" | "failed" => Ok(value),
        _ => Err(serde::de::Error::custom("unknown event status")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnEvent {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "optional_text")]
    pub input_text: Option<String>,
    pub text: String,
    #[serde(deserialize_with = "status")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "optional_text")]
    pub error: Option<String>,
    pub updated: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pending_permissions: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub non_text_blocks: usize,
    /// Immutable entry references for this turn's output images; bytes stay in the snapshot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_entry_ids: Vec<String>,
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}
