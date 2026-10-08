//! Daemon-owned history. Transactions and runtime ownership are in-process;
//! the service singleton lock excludes other writers. Snapshots are immutable revisions.
use crate::types::Snapshot;
use pi_acp_core::atomic::write_atomic_json;
use pi_acp_core::canonical::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ops::AsyncFnOnce;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use tokio::sync::Mutex;
use uuid::Uuid;

const FORMAT_UNSUPPORTED: &str = "历史格式不受支持：需要当前完整快照。原文件未修改。";
const HARNESS_UNSUPPORTED: &str = "历史记录中的 harness 不受支持或不匹配，未启动 Agent。";
const INDEX_INVALID: &str = "共享历史索引无效，请从备份恢复。";
const SNAPSHOT_MISMATCH: &str = "本地完整历史文件不匹配，未恢复会话。";
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub sessions: Vec<Snapshot>,
    pub deleted: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_session_number: Option<u64>,
}

pub struct SharedHistoryStore {
    root: PathBuf,
    conversations: PathBuf,
    seen: Mutex<HashMap<String, Option<String>>>,
    leases: Mutex<HashSet<String>>,
    transactions: Mutex<()>,
}
impl SharedHistoryStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            conversations: root.join("conversations"),
            root,
            seen: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashSet::new()),
            transactions: Mutex::new(()),
        }
    }
    async fn initialize(&self) -> Result<(), String> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(|e| e.to_string())
    }

    async fn index(&self) -> Result<Index, String> {
        let text = match tokio::fs::read_to_string(self.root.join("index.json")).await {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Index::default()),
            Err(e) => return Err(e.to_string()),
        };
        serde_json::from_str(&text).map_err(|_| INDEX_INVALID.to_string())
    }

    async fn transaction<T, F>(&self, operation: F) -> Result<T, String>
    where
        F: AsyncFnOnce(&mut Index) -> Result<T, String>,
    {
        let _guard = self.transactions.lock().await;
        self.initialize().await?;
        let mut index = self.index().await?;
        operation(&mut index).await
    }

    async fn commit(&self, index: &Index) -> Result<(), String> {
        write_atomic_json(&self.root.join("index.json"), index, true)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn list(&self) -> Result<Vec<Snapshot>, String> {
        let mut sessions = self.index().await?.sessions;
        sessions.sort_by_key(|a| std::cmp::Reverse(a.updated));
        Ok(sessions)
    }
    /// Runtime ownership is internal; clients may attach concurrently through the socket.
    pub async fn claim(&self, id: &str) -> Result<(), String> {
        self.initialize().await?;
        self.leases.lock().await.insert(id.to_string());
        Ok(())
    }
    pub async fn release(&self, id: &str) {
        self.leases.lock().await.remove(id);
        self.seen.lock().await.remove(id);
    }
    pub async fn release_all(&self) {
        self.leases.lock().await.clear();
        self.seen.lock().await.clear();
    }

    fn snapshot_file(&self, storage_key: &str) -> PathBuf {
        self.conversations
            .join(format!("{}.json", sha256_hex(storage_key)))
    }

    fn storage_key(snapshot: &Snapshot) -> Result<String, String> {
        match snapshot.revision.as_deref() {
            Some(revision) if !revision.is_empty() => Ok(format!("{}:{}", snapshot.id, revision)),
            _ => Err("共享历史缺少版本标识，拒绝读取或覆盖。".into()),
        }
    }

    async fn raw_write(&self, snapshot: &Snapshot, storage_key: &str) -> Result<Snapshot, String> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.conversations)
            .map_err(|e| e.to_string())?;
        write_atomic_json(&self.snapshot_file(storage_key), snapshot, true)
            .await
            .map_err(|e| e.to_string())?;
        let mut stub = snapshot.clone();
        stub.entries = Vec::new();
        stub.native_forks = None;
        stub.stored = Some(true);
        Ok(stub)
    }

    async fn raw_read(&self, stub: &Snapshot, storage_key: &str) -> Result<Snapshot, String> {
        if stub.stored != Some(true) {
            return validate_snapshot(stub.clone());
        }
        let text = tokio::fs::read_to_string(self.snapshot_file(storage_key))
            .await
            .map_err(|e| e.to_string())?;
        let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if data.get("id").and_then(Value::as_str) != Some(stub.id.as_str())
            || data.get("cwd").and_then(Value::as_str) != Some(stub.cwd.as_str())
            || !data.get("entries").is_some_and(Value::is_array)
        {
            return Err(SNAPSHOT_MISMATCH.into());
        }
        validate_snapshot_value(&data)?;
        serde_json::from_value(data).map_err(|_| FORMAT_UNSUPPORTED.into())
    }

    async fn raw_remove(&self, storage_key: &str) {
        let _ = tokio::fs::remove_file(self.snapshot_file(storage_key)).await;
    }

    /// Read a session's full snapshot inside a transaction; enforces
    /// deleted-missing rules and records seen revision when leased.
    pub async fn read(&self, stub: &Snapshot) -> Result<Snapshot, String> {
        self.transaction(async |index: &mut Index| {
            let current = index.sessions.iter().find(|s| s.id == stub.id).cloned();
            let Some(current) = current else {
                if stub.stored != Some(true) && !index.deleted.iter().any(|d| d == &stub.id) {
                    return validate_snapshot(stub.clone());
                }
                return Err("共享会话已被删除，请刷新历史列表。".into());
            };
            let mut data = self
                .raw_read(&current, &Self::storage_key(&current)?)
                .await?;
            if self.leases.lock().await.contains(&data.id) {
                self.seen
                    .lock()
                    .await
                    .insert(data.id.clone(), data.revision.clone());
            }
            data.session_number = current.session_number;
            Ok(data)
        })
        .await
    }

    pub async fn write(&self, snapshot: &Snapshot) -> Result<Snapshot, String> {
        self.transaction(async |index: &mut Index| {
            if !self.leases.lock().await.contains(&snapshot.id) {
                return Err("未持有服务会话，请重新连接后再保存。".into());
            }
            let current = index.sessions.iter().find(|s| s.id == snapshot.id).cloned();
            if index.deleted.iter().any(|d| d == &snapshot.id) {
                return Err("此会话已从共享历史删除，不会重新保存。".into());
            }
            if let Some(current) = &current {
                let seen = self.seen.lock().await.get(&snapshot.id).cloned().flatten();
                if current.revision != seen {
                    return Err("会话已被另一个窗口更新，请重新连接。".into());
                }
            }
            let mut version = snapshot.clone();
            version.session_number = Some(allocate_session_number(index, snapshot)?);
            version.revision = Some(Uuid::new_v4().to_string());
            let saved = self
                .raw_write(&version, &Self::storage_key(&version)?)
                .await?;
            index.sessions.retain(|s| s.id != snapshot.id);
            index.sessions.insert(0, saved.clone());
            self.commit(index).await?;
            self.seen
                .lock()
                .await
                .insert(saved.id.clone(), saved.revision.clone());
            if let Some(current) = current {
                self.raw_remove(&Self::storage_key(&current)?).await;
            }
            Ok(saved)
        })
        .await
    }

    pub async fn clear(&self) -> Result<(), String> {
        self.transaction(async |index: &mut Index| {
            let sessions = std::mem::take(&mut index.sessions);
            for snapshot in &sessions {
                if !index.deleted.iter().any(|d| d == &snapshot.id) {
                    index.deleted.push(snapshot.id.clone());
                }
            }
            self.commit(index).await?;
            for snapshot in &sessions {
                self.raw_remove(&Self::storage_key(snapshot)?).await;
            }
            Ok(())
        })
        .await
    }

    /// Tombstone + snapshot removal; commit precedes unlink.
    pub async fn remove(&self, id: &str) -> Result<(), String> {
        self.transaction(async |index: &mut Index| {
            let current = index.sessions.iter().find(|s| s.id == id).cloned();
            index.sessions.retain(|s| s.id != id);
            if !index.deleted.iter().any(|d| d == id) {
                index.deleted.push(id.to_string());
            }
            self.commit(index).await?;
            if let Some(current) = current {
                self.raw_remove(&Self::storage_key(&current)?).await;
            }
            Ok(())
        })
        .await
    }
}

fn validate_snapshot(snapshot: Snapshot) -> Result<Snapshot, String> {
    if snapshot.context_complete != Some(true) {
        return Err(FORMAT_UNSUPPORTED.into());
    }
    check_harness(&snapshot.id, snapshot.harness.as_deref())?;
    Ok(snapshot)
}

fn validate_snapshot_value(data: &Value) -> Result<(), String> {
    let Some(object) = data.as_object() else {
        return Err(FORMAT_UNSUPPORTED.into());
    };
    if !object.get("id").is_some_and(Value::is_string)
        || !object.get("cwd").is_some_and(Value::is_string)
        || !object.get("entries").is_some_and(Value::is_array)
        || object.get("contextComplete") != Some(&Value::Bool(true))
        || object.contains_key("contextPending")
    {
        return Err(FORMAT_UNSUPPORTED.into());
    }
    check_harness(
        object.get("id").and_then(Value::as_str).unwrap_or_default(),
        object.get("harness").and_then(Value::as_str),
    )
}

fn check_harness(id: &str, harness: Option<&str>) -> Result<(), String> {
    let harness = harness
        .ok_or(HARNESS_UNSUPPORTED)
        .and_then(|name| crate::harness::Harness::parse(name).map_err(|_| HARNESS_UNSUPPORTED))?;
    harness
        .native_id(id)
        .map(|_| ())
        .map_err(|_| HARNESS_UNSUPPORTED.to_string())
}

/// session-numbers.ts allocateSessionNumber — pure function, fully implementable
/// from the index invariants above.
pub fn allocate_session_number(index: &mut Index, snapshot: &Snapshot) -> Result<u64, String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991; // 2**53 - 1
    fn valid(number: Option<u64>) -> Option<u64> {
        number.filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER)
    }
    let logical = snapshot
        .conversation_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or(snapshot.id.as_str());
    let existing = index.sessions.iter().find(|s| {
        let key = s
            .conversation_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .unwrap_or(s.id.as_str());
        key == logical && valid(s.session_number).is_some()
    });
    if let Some(existing) = existing {
        return Ok(existing.session_number.unwrap_or_default());
    }
    let floor = valid(index.next_session_number).unwrap_or(1);
    let number = index
        .sessions
        .iter()
        .fold(floor, |n, s| match valid(s.session_number) {
            Some(current) => n.max(current + 1),
            None => n,
        });
    if number + 1 > MAX_SAFE_INTEGER {
        return Err("会话编号已超过安全范围。".into());
    }
    index.next_session_number = Some(number + 1);
    Ok(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Entry;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("pi-acp-history-test-{}", Uuid::new_v4()))
    }

    fn snapshot(id: &str) -> Snapshot {
        Snapshot {
            id: id.into(),
            cwd: "/tmp".into(),
            title: "t".into(),
            updated: 1,
            entries: vec![Entry::text_entry("e1".into(), "user", "hi".into())],
            harness: Some("pi".into()),
            context_complete: Some(true),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn write_read_remove_roundtrip() {
        let root = temp_root();
        let store = SharedHistoryStore::new(root.clone());
        assert!(store.list().await.unwrap().is_empty());
        store.claim("s1").await.unwrap();
        let written = store.write(&snapshot("s1")).await.unwrap();
        assert_eq!(written.stored, Some(true));
        assert!(written.entries.is_empty());
        assert_eq!(written.session_number, Some(1));
        assert!(written.revision.is_some());

        let listed = store.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        let full = store.read(&listed[0]).await.unwrap();
        assert_eq!(full.entries.len(), 1);
        assert_eq!(full.entries[0].text(), "hi");
        assert_eq!(full.session_number, Some(1));

        // Second write passes the optimistic check (seen == current revision)
        // and reuses the session number.
        let mut again = snapshot("s1");
        again.updated = 2;
        let rewritten = store.write(&again).await.unwrap();
        assert_eq!(rewritten.session_number, Some(1));
        assert_ne!(rewritten.revision, written.revision);

        store.remove("s1").await.unwrap();
        assert!(store.list().await.unwrap().is_empty());
        // Tombstone blocks rewriting while still leased.
        let err = store.write(&snapshot("s1")).await.unwrap_err();
        assert_eq!(err, "此会话已从共享历史删除，不会重新保存。");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn stale_revision_is_rejected() {
        let root = temp_root();
        let a = SharedHistoryStore::new(root.clone());
        let b = SharedHistoryStore::new(root.clone());
        a.claim("s1").await.unwrap();
        a.write(&snapshot("s1")).await.unwrap();
        a.release("s1").await;

        // Writer B: claim → read (records seen revision) → write.
        b.claim("s1").await.unwrap();
        let stub = b.list().await.unwrap().remove(0);
        b.read(&stub).await.unwrap();
        b.write(&snapshot("s1")).await.unwrap();
        b.release("s1").await;

        // Writer A returns with a stale seen map → optimistic lock fires.
        a.claim("s1").await.unwrap();
        let err = a.write(&snapshot("s1")).await.unwrap_err();
        assert_eq!(err, "会话已被另一个窗口更新，请重新连接。");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allocates_session_numbers() {
        let mut index = Index::default();
        let s = snapshot("s1");
        assert_eq!(allocate_session_number(&mut index, &s).unwrap(), 1);
        assert_eq!(index.next_session_number, Some(2));

        // Existing session for the same logical conversation reuses its number.
        let mut stub = snapshot("s1");
        stub.entries = Vec::new();
        stub.session_number = Some(1);
        index.sessions.push(stub);
        let mut fork = snapshot("s2");
        fork.conversation_id = Some("s1".into());
        assert_eq!(allocate_session_number(&mut index, &fork).unwrap(), 1);
        // Unrelated session takes nextSessionNumber as floor.
        assert_eq!(
            allocate_session_number(&mut index, &snapshot("s3")).unwrap(),
            2
        );
        assert_eq!(index.next_session_number, Some(3));
    }
}
