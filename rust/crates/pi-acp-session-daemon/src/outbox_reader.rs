//! Private outbox storage reader. Relay clients see only opaque cursors/tokens.
use pi_acp_core::turn_event::TurnEvent;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;
const MAX_AGE: Duration = Duration::from_secs(7 * 86_400);
const MAX_SIZE: u64 = 16 * 1024 * 1024;
fn is_event_name(name: &str) -> bool {
    name.len() == 69
        && name.ends_with(".json")
        && name.as_bytes()[..64]
            .iter()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
pub(super) fn event_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}
#[derive(Serialize)]
pub struct Delivery {
    pub cursor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<TurnEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}
async fn read_event(file: &Path, expire: bool) -> io::Result<Option<(TurnEvent, String)>> {
    let meta = match tokio::fs::symlink_metadata(file).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    if !meta.is_file() || meta.len() > MAX_SIZE {
        return Ok(None);
    }
    if meta
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|age| age > MAX_AGE)
    {
        if expire {
            let _ = tokio::fs::remove_file(file).await;
        }
        return Ok(None);
    }
    let input = match tokio::fs::File::open(file).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    let mut body = Vec::new();
    input.take(MAX_SIZE + 1).read_to_end(&mut body).await?;
    if body.len() as u64 > MAX_SIZE {
        return Ok(None);
    }
    let event = match serde_json::from_slice::<TurnEvent>(&body) {
        Ok(event) => event,
        Err(_) => return Ok(None), // Keep corrupt evidence, skip this cursor.
    };
    if event.id.is_empty()
        || event.session_id.is_empty()
        || file.file_name() != event_file(Path::new(""), &event.id).file_name()
    {
        return Ok(None);
    }
    Ok(Some((event, format!("{:x}", Sha256::digest(&body)))))
}
/// One file per call; scanning keeps one filename rather than loading the backlog.
pub async fn next(dir: &Path, cursor: Option<&str>) -> io::Result<Option<Delivery>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    let mut selected: Option<String> = None;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_event_name(&name)
            && cursor.is_none_or(|c| name.as_str() > c)
            && selected.as_ref().is_none_or(|s| &name < s)
        {
            selected = Some(name);
        }
    }
    let Some(cursor) = selected else {
        return Ok(None);
    };
    let value = read_event(&dir.join(&cursor), true).await?;
    let (event, token) = match value {
        Some((e, t)) => (Some(e), Some(t)),
        None => (None, None),
    };
    Ok(Some(Delivery {
        cursor,
        event,
        token,
    }))
}
/// Caller serializes this with publishers. Stale acknowledgement never deletes a newer revision.
pub async fn ack(dir: &Path, id: &str, token: &str) -> io::Result<bool> {
    let file = event_file(dir, id);
    let Some((_, current)) = read_event(&file, false).await? else {
        return Ok(false);
    };
    if current != token {
        return Ok(false);
    }
    tokio::fs::remove_file(file).await?;
    tokio::fs::File::open(dir).await?.sync_all().await?;
    Ok(true)
}
#[cfg(test)]
struct Scanner {
    directory: PathBuf,
    cursor: Option<String>,
}
#[cfg(test)]
impl Scanner {
    async fn open(dir: &Path) -> io::Result<Self> {
        Ok(Self {
            directory: dir.to_owned(),
            cursor: None,
        })
    }
    async fn next(&mut self) -> io::Result<Option<TurnEvent>> {
        while let Some(delivery) = next(&self.directory, self.cursor.as_deref()).await? {
            self.cursor = Some(delivery.cursor);
            if delivery.event.is_some() {
                return Ok(delivery.event);
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
async fn remove(dir: &Path, id: &str) -> io::Result<()> {
    match tokio::fs::remove_file(event_file(dir, id)).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
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
    async fn stale_and_repeated_ack_never_delete_newer_events() {
        let root = Root::new();
        let outbox = crate::outbox::TaskOutbox::new(root.0.clone());
        let mut old: TurnEvent = serde_json::from_value(event("turn")).unwrap();
        old.status = "running".into();
        outbox.write(&old).await.unwrap();
        let first = outbox.next(None).await.unwrap();
        old.status = "completed".into();
        old.text = "new terminal revision".into();
        outbox.write(&old).await.unwrap();
        assert!(!outbox
            .ack("turn", first["token"].as_str().unwrap())
            .await
            .unwrap());
        let current = outbox.next(None).await.unwrap();
        assert_eq!(current["event"]["text"], "new terminal revision");
        // Consumer restart does not require any in-memory cursor or lease.
        let restarted = crate::outbox::TaskOutbox::new(root.0.clone());
        assert!(restarted
            .ack("turn", current["token"].as_str().unwrap())
            .await
            .unwrap());
        assert!(!restarted
            .ack("turn", current["token"].as_str().unwrap())
            .await
            .unwrap());
        assert!(restarted.next(None).await.unwrap().is_null());
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
