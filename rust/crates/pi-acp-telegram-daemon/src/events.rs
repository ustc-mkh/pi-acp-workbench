//! TelegramEvents reader port (src/telegram-events.ts, iterate() only — the
//! Rust daemon consumes the outbox; writing stays with the session service).
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_AGE: Duration = Duration::from_secs(7 * 86_400);
const MAX_SIZE: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // title/session_number/updated are contract fields, not all read here
pub struct TurnEvent {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default)]
    pub session_number: Option<u64>,
    #[serde(default)]
    pub input_text: Option<String>,
    pub text: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub updated: f64,
}

fn is_event_name(name: &str) -> bool {
    name.len() == 69
        && name.ends_with(".json")
        && name[..64]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn event_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!(
        "{}.json",
        hex::encode(Sha256::digest(id.as_bytes()))
    ))
}

/// One scan pass; mirrors iterate(): too-old files are deleted, invalid ones skipped.
pub async fn scan(dir: &Path) -> io::Result<Vec<TurnEvent>> {
    tokio::fs::create_dir_all(dir).await?;
    let mut out = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_event_name(&name) {
            continue;
        }
        let file = entry.path();
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .map(|age| age > MAX_AGE)
            .unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(&file).await;
            continue;
        }
        if meta.len() > MAX_SIZE {
            continue;
        }
        let Ok(body) = tokio::fs::read(&file).await else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        let valid_strings = ["id", "sessionId", "cwd", "text", "title"]
            .iter()
            .all(|k| value.get(*k).and_then(|v| v.as_str()).is_some());
        let optional = ["inputText", "error"]
            .iter()
            .all(|k| value.get(*k).map(|v| v.is_string()).unwrap_or(true));
        let status = value.get("status").and_then(|v| v.as_str());
        let updated_ok = value
            .get("updated")
            .and_then(|v| v.as_f64())
            .map(|u| u.is_finite())
            .unwrap_or(false);
        if !valid_strings
            || !optional
            || !updated_ok
            || !matches!(
                status,
                Some("running" | "completed" | "cancelled" | "failed")
            )
        {
            continue;
        }
        let id = value["id"].as_str().unwrap();
        if event_file(dir, id) != file {
            continue; // filename must equal sha256(id) — writer contract
        }
        if let Ok(event) = serde_json::from_value::<TurnEvent>(value) {
            out.push(event);
        }
    }
    Ok(out)
}

pub async fn remove(dir: &Path, id: &str) -> io::Result<()> {
    match tokio::fs::remove_file(event_file(dir, id)).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
