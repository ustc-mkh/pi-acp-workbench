//! Persisted view types — serde output must reproduce the TypeScript object
//! shapes exactly (docs/data-formats.md). `Option` fields are omitted from JSON
//! when `None`, matching JSON.stringify dropping `undefined` values.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub role: String, // user | assistant | thought | notice | tool | diff
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_blocks: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<TurnDiff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnDiff {
    pub status: String, // complete | partial | unavailable
    pub files: Vec<TurnFileDiff>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFileDiff {
    pub path: String,
    pub status: String, // added | modified | deleted
    pub added: u64,
    pub removed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_mode: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_mode: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBranchTarget {
    pub entry_id: String,
    pub hash: String,
}

// serde(default) at struct level: index.json stubs may legally omit fields
// (data-formats.md §4) — TS only checks the array shape, so deserialize
// leniently and let validate() do the semantic gatekeeping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub updated: u64,
    pub entries: Vec<Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_forks: Option<BTreeMap<String, NativeBranchTarget>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub usage_records: Vec<crate::usage::UsageRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configs: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    /// Preserve optional metadata in both the full snapshot and index stub.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub id: String,
    pub request: Value,
}

/// Mutable runtime state (never serialized as a unit — fields are copied into
/// the snapshot on save or into ServiceState views). Clone for preference reads.
#[derive(Debug, Clone, Default)]
pub struct ChatState {
    pub entries: Vec<Entry>,
    pub permissions: Vec<Permission>,
    pub commands: Vec<Value>,
    pub configs: Option<Vec<Value>>,
    pub modes: Option<Value>,
    pub native_forks: Option<BTreeMap<String, NativeBranchTarget>>,
    pub usage: Option<Value>,
    pub plan: Vec<Value>,
    pub usage_records: Vec<crate::usage::UsageRecord>,
}

impl Entry {
    pub fn text_entry(id: String, role: &str, text: String) -> Self {
        Entry {
            id,
            role: role.to_string(),
            text: Some(text),
            message_id: None,
            context_blocks: None,
            tool: None,
            diff: None,
            terminal: None,
        }
    }
    pub fn is(&self, role: &str) -> bool {
        self.role == role
    }
    pub fn text(&self) -> &str {
        self.text.as_deref().unwrap_or_default()
    }
}
