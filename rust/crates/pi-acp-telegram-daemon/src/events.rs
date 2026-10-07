//! TelegramEvents reader port (src/telegram-events.ts, iterate() only — the
//! Rust daemon consumes the outbox; writing stays with the session service).
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

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

/// Lazy scan: hold at most one event, never load the entire durable backlog.
pub struct Scanner {
    directory: PathBuf,
    entries: tokio::fs::ReadDir,
}
impl Scanner {
    pub async fn open(dir: &Path) -> io::Result<Self> {
        tokio::fs::create_dir_all(dir).await?;
        Ok(Self {
            directory: dir.to_owned(),
            entries: tokio::fs::read_dir(dir).await?,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<TurnEvent>> {
        while let Some(entry) = self.entries.next_entry().await? {
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
            let Ok(input) = tokio::fs::File::open(&file).await else {
                continue;
            };
            let mut body = Vec::new();
            if input
                .take(MAX_SIZE + 1)
                .read_to_end(&mut body)
                .await
                .is_err()
                || body.len() as u64 > MAX_SIZE
            {
                continue;
            }
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
            if event_file(&self.directory, id) != file {
                continue; // filename must equal sha256(id) — writer contract
            }
            if let Ok(event) = serde_json::from_value::<TurnEvent>(value) {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }
}
#[cfg(test)]
async fn scan(dir: &Path) -> io::Result<Vec<TurnEvent>> {
    let mut scanner = Scanner::open(dir).await?;
    let mut out = Vec::new();
    while let Some(event) = scanner.next().await? {
        out.push(event);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("pi-events-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn event(id: &str) -> Value {
        json!({"id":id,"sessionId":"one","cwd":"/work","title":"Title","text":"中文😀","status":"completed","updated":1})
    }
    async fn write(root: &Root, id: &str, value: Value) {
        tokio::fs::write(event_file(&root.0, id), serde_json::to_vec(&value).unwrap())
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn rejects_malformed_and_mismatched_events_without_deleting_evidence() {
        let root = Root::new();
        write(&root, "good", event("good")).await;
        let mut invalid = event("invalid-status");
        invalid["status"] = json!("unknown");
        write(&root, "invalid-status", invalid).await;
        for (id, key) in [
            ("bad-input", "inputText"),
            ("bad-error", "error"),
            ("bad-text", "text"),
            ("bad-time", "updated"),
        ] {
            let mut invalid = event(id);
            invalid[key] = Value::Null;
            write(&root, id, invalid).await;
        }
        write(&root, "mismatch", event("different-id")).await;
        tokio::fs::write(event_file(&root.0, "corrupt"), "{")
            .await
            .unwrap();
        let found = scan(&root.0).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "good");
        assert_eq!(found[0].text, "中文😀");
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 8);
        remove(&root.0, "good").await.unwrap();
        remove(&root.0, "good").await.unwrap();
        assert!(scan(&root.0).await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn reads_the_next_record_only_when_consumed() {
        let root = Root::new();
        write(&root, "one", event("one")).await;
        write(&root, "two", event("two")).await;
        let mut scanner = Scanner::open(&root.0).await.unwrap();
        let first = scanner.next().await.unwrap().unwrap();
        let other = if first.id == "one" { "two" } else { "one" };
        let mut changed = event(other);
        changed["text"] = json!("modified after first read");
        write(&root, other, changed).await;
        let second = scanner.next().await.unwrap().unwrap();
        assert_eq!(second.id, other);
        assert_eq!(second.text, "modified after first read");
        assert!(scanner.next().await.unwrap().is_none());
    }
    #[tokio::test]
    async fn expires_old_files_and_skips_oversize_files_before_reading() {
        let root = Root::new();
        write(&root, "old", event("old")).await;
        std::fs::File::options()
            .write(true)
            .open(event_file(&root.0, "old"))
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::now() - MAX_AGE - Duration::from_secs(60)),
            )
            .unwrap();
        let large = std::fs::File::create(event_file(&root.0, "large")).unwrap();
        large.set_len(MAX_SIZE + 1).unwrap();
        drop(large);
        assert!(scan(&root.0).await.unwrap().is_empty());
        assert!(!event_file(&root.0, "old").exists());
        assert!(event_file(&root.0, "large").exists());
    }
}

pub async fn remove(dir: &Path, id: &str) -> io::Result<()> {
    match tokio::fs::remove_file(event_file(dir, id)).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
