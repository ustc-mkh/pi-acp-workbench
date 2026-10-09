//! Bind verified native fork points to visible transcript entries.
use crate::types::{Entry, NativeBranchTarget};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeForkPoint {
    pub entry_id: String,
    pub hash: String,
    pub role: String,
    pub key: String,
    // JSON.stringify drops `undefined` — None must omit the key on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    pub safe: bool,
}

fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn native_text_key(role: &str, text: &str) -> String {
    format!("{role}:{}", digest(text))
}

use pi_acp_core::util::js_optional_number_string as js_number_string;

/// Same text encoding as the pinned pi-acp promptToPiMessage; no model or image transformations.
fn ui_text(entry: &Entry) -> String {
    if entry.role != "user" {
        return entry.text().to_string();
    }
    let Some(blocks) = &entry.context_blocks else {
        return entry.text().to_string();
    };
    blocks
        .iter()
        .map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => b
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            Some("resource_link") => {
                let uri = b.get("uri").and_then(Value::as_str).unwrap_or("undefined");
                format!("\n[Context] {uri}")
            }
            Some("resource") => {
                let resource = b.get("resource");
                let has_text = resource
                    .and_then(Value::as_object)
                    .is_some_and(|r| r.contains_key("text"));
                if has_text {
                    let uri = resource
                        .and_then(|r| r.get("uri"))
                        .and_then(Value::as_str)
                        .unwrap_or("undefined");
                    let mime = resource
                        .and_then(|r| r.get("mimeType"))
                        .and_then(Value::as_str)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("text/plain");
                    let text = resource
                        .and_then(|r| r.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("undefined");
                    format!("\n[Embedded Context] {uri} ({mime})\n{text}")
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        })
        .collect()
}

/// Ambiguous old display rows fail closed instead of guessing a native cut point.
pub fn bind_native_forks(
    entries: &[Entry],
    points: &[NativeForkPoint],
    previous: &BTreeMap<String, NativeBranchTarget>,
) -> BTreeMap<String, NativeBranchTarget> {
    let mut out: BTreeMap<String, NativeBranchTarget> = BTreeMap::new();
    let mut keys: HashMap<String, usize> = HashMap::new();
    for e in entries {
        if e.role == "user" || e.role == "assistant" {
            *keys
                .entry(native_text_key(&e.role, &ui_text(e)))
                .or_default() += 1;
        }
    }
    for e in entries {
        if e.role != "user" && e.role != "assistant" {
            continue;
        }
        let key = native_text_key(&e.role, &ui_text(e));
        let matches: Vec<&NativeForkPoint> = points.iter().filter(|p| p.key == key).collect();
        let saved = previous.get(&e.id).and_then(|prev| {
            matches
                .iter()
                .find(|p| p.entry_id == prev.entry_id && p.hash == prev.hash)
        });
        let timed: Vec<&&NativeForkPoint> = match e.message_id.as_ref().and_then(Value::as_str) {
            Some(message_id) if !message_id.is_empty() => matches
                .iter()
                .filter(|p| js_number_string(p.timestamp) == message_id)
                .collect(),
            _ => Vec::new(),
        };
        let point = saved
            .copied()
            .or_else(|| (timed.len() == 1).then(|| *timed[0]))
            .or_else(|| (matches.len() == 1 && keys.get(&key) == Some(&1)).then(|| matches[0]));
        if let Some(point) = point {
            if point.safe {
                out.insert(
                    e.id.clone(),
                    NativeBranchTarget {
                        entry_id: point.entry_id.clone(),
                        hash: point.hash.clone(),
                    },
                );
            }
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_bindings_require_unambiguous_text_timestamp_and_safe_points() {
        let point = |id: &str, timestamp| NativeForkPoint {
            entry_id: id.into(),
            hash: format!("hash-{id}"),
            role: "assistant".into(),
            key: native_text_key("assistant", "same"),
            timestamp: Some(timestamp),
            safe: true,
        };
        let points = vec![point("first", 10.0), point("second", 20.0)];
        let mut entries = vec![Entry::text_entry("ui".into(), "assistant", "same".into())];
        assert!(bind_native_forks(&entries, &points, &BTreeMap::new()).is_empty());
        entries[0].message_id = Some(Value::String("20".into()));
        let bound = bind_native_forks(&entries, &points, &BTreeMap::new());
        assert_eq!(bound["ui"].entry_id, "second");
        let mut unsafe_points = points.clone();
        unsafe_points[1].safe = false;
        assert!(bind_native_forks(&entries, &unsafe_points, &bound).is_empty());
        entries[0].message_id = None;
        assert_eq!(
            bind_native_forks(&entries, &points, &bound)["ui"].entry_id,
            "second"
        );
    }
}
