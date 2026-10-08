//! Shared history transactions use a proper-lockfile-compatible directory lock.
//! Root transactions preserve tombstones and allocate unique safe-integer session numbers.
//! Live sessions hold separate leases; compromised ownership aborts commits.
//! Snapshot files are atomic, private and revision-addressed (docs/data-formats.md).
use crate::types::Snapshot;
use pi_acp_core::atomic::write_atomic_json;
use pi_acp_core::canonical::sha256_hex;
use pi_acp_core::mkdir_lock::{LockError, MkdirLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io;
use std::ops::AsyncFnOnce;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

const FORMAT_UNSUPPORTED: &str = "历史格式不受支持：需要当前完整快照。原文件未修改。";
const HARNESS_UNSUPPORTED: &str = "历史记录中的 harness 不受支持或不匹配，未启动 Agent。";
const INDEX_INVALID: &str = "共享历史索引无效，请从备份恢复。";
const SNAPSHOT_MISMATCH: &str = "本地完整历史文件不匹配，未恢复会话。";
const LOCK_COMPROMISED: &str = "共享历史锁已失效，事务中止。";

/// proper-lockfile timing shared by every mkdir lock (docs/data-formats.md §2).
const LOCK_UPDATE: Duration = Duration::from_millis(10_000);
const LOCK_STALE: Duration = Duration::from_millis(30_000);
const INDEX_LOCK_RETRIES: u32 = 20;

#[derive(Debug)]
pub struct SessionInUseError;
impl std::fmt::Display for SessionInUseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "此会话正在另一个窗口中使用，当前仅查看。请在原窗口释放会话或关闭窗口后重新连接。"
        )
    }
}
impl std::error::Error for SessionInUseError {}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    #[serde(default)]
    pub sessions: Vec<Snapshot>,
    #[serde(default)]
    pub deleted: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_session_number: Option<u64>,
}

pub type LeaseLost = Arc<dyn Fn(&str) + Send + Sync>;

pub struct SharedHistoryStore {
    root: PathBuf,
    conversations: PathBuf,
    seen: Mutex<HashMap<String, Option<String>>>,
    leases: Mutex<HashMap<String, pi_acp_core::mkdir_lock::MkdirLock>>,
    lost: Arc<StdMutex<HashSet<String>>>,
    on_lease_lost: Option<LeaseLost>,
    transactions: Mutex<()>,
    transaction_error: Arc<StdMutex<Option<String>>>,
}

impl SharedHistoryStore {
    pub fn new(root: PathBuf, on_lease_lost: Option<LeaseLost>) -> Self {
        SharedHistoryStore {
            conversations: root.join("conversations"),
            root,
            seen: Mutex::new(HashMap::new()),
            leases: Mutex::new(HashMap::new()),
            lost: Arc::new(StdMutex::new(HashSet::new())),
            on_lease_lost,
            transactions: Mutex::new(()),
            transaction_error: Arc::new(StdMutex::new(None)),
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
        let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let valid = data.get("sessions").is_some_and(Value::is_array)
            && data.get("deleted").is_some_and(Value::is_array);
        if !valid {
            return Err(INDEX_INVALID.into());
        }
        let mut index = Index::default();
        for stub in data["sessions"].as_array().unwrap() {
            index.sessions.push(
                serde_json::from_value::<Snapshot>(stub.clone())
                    .map_err(|_| INDEX_INVALID.to_string())?,
            );
        }
        index.deleted = data["deleted"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        index.next_session_number = data.get("nextSessionNumber").and_then(Value::as_u64);
        Ok(index)
    }

    async fn transaction<T, F>(&self, operation: F) -> Result<T, String>
    where
        F: AsyncFnOnce(&mut Index) -> Result<T, String>,
    {
        let _guard = self.transactions.lock().await;
        self.initialize().await?;
        *self.transaction_error.lock().unwrap() = None;
        let flag = self.transaction_error.clone();
        let lock = MkdirLock::acquire_retry(
            &self.root,
            LOCK_UPDATE,
            LOCK_STALE,
            INDEX_LOCK_RETRIES,
            move || {
                *flag.lock().unwrap() = Some(LOCK_COMPROMISED.into());
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let result = async {
            let mut index = self.index().await?;
            let out = operation(&mut index).await?;
            if let Some(error) = self.transaction_error.lock().unwrap().clone() {
                return Err(error);
            }
            Ok(out)
        }
        .await;
        if self.transaction_error.lock().unwrap().is_none() {
            lock.release().await;
        } else {
            drop(lock);
        }
        result
    }

    async fn commit(&self, index: &Index) -> Result<(), String> {
        let file = self.root.join("index.json");
        let tmp = self.root.join(format!("index.json.{}.tmp", Uuid::new_v4()));
        let result = async {
            let mut handle = tokio::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)
                .await
                .map_err(|e| e.to_string())?;
            let body = serde_json::to_vec(index).map_err(|e| e.to_string())?;
            handle.write_all(&body).await.map_err(|e| e.to_string())?;
            drop(handle);
            if let Some(error) = self.transaction_error.lock().unwrap().clone() {
                return Err(error);
            }
            tokio::fs::rename(&tmp, &file)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(&tmp).await;
        result
    }

    /// index.json sessions sorted by updated desc; no lock needed (atomic rename).
    pub async fn list(&self) -> Result<Vec<Snapshot>, String> {
        let mut sessions = self.index().await?.sessions;
        sessions.sort_by_key(|a| std::cmp::Reverse(a.updated));
        Ok(sessions)
    }

    /// Exclusive live-session lease on `session-<sha256(id)>`.
    pub async fn claim(&self, id: &str) -> Result<(), String> {
        match self.try_claim(id).await {
            Ok(()) => Ok(()),
            Err(LockError::Held) => Err(SessionInUseError.to_string()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// claim() returning the typed LockError so callers (write_delegated) can
    /// branch on Held without matching the localized message string.
    async fn try_claim(&self, id: &str) -> Result<(), LockError> {
        if self.leases.lock().await.contains_key(id) {
            if self.lost.lock().unwrap().contains(id) {
                return Err(LockError::Io(io::Error::other(
                    "共享会话锁已失效，请重新连接。",
                )));
            }
            return Ok(());
        }
        self.initialize()
            .await
            .map_err(|e| LockError::Io(io::Error::other(e)))?;
        let key = self.root.join(format!("session-{}", sha256_hex(id)));
        let lost = self.lost.clone();
        let on_lease_lost = self.on_lease_lost.clone();
        let owned = id.to_string();
        let lock = MkdirLock::acquire(&key, LOCK_UPDATE, LOCK_STALE, move || {
            lost.lock().unwrap().insert(owned.clone());
            if let Some(callback) = &on_lease_lost {
                callback(&owned);
            }
        })
        .await?;
        self.lost.lock().unwrap().remove(id);
        self.leases.lock().await.insert(id.to_string(), lock);
        Ok(())
    }

    pub async fn release(&self, id: &str) {
        let lock = self.leases.lock().await.remove(id);
        self.seen.lock().await.remove(id);
        let lost = self.lost.lock().unwrap().remove(id);
        if let Some(lock) = lock {
            if lost {
                drop(lock);
            } else {
                lock.release().await;
            }
        }
    }

    pub async fn release_all(&self) {
        let ids: Vec<String> = self.leases.lock().await.keys().cloned().collect();
        for id in ids {
            self.release(&id).await;
        }
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
        write_atomic_json(&self.snapshot_file(storage_key), snapshot, false)
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
            if self.leases.lock().await.contains_key(&data.id) {
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

    /// Optimistic-locked write; returns the persisted stub.
    pub async fn write(&self, snapshot: &Snapshot) -> Result<Snapshot, String> {
        self.persist(snapshot, false).await
    }

    /// Freshness probe for a lease this store does not hold: the session lock
    /// dir exists and its heartbeat mtime is younger than the stale threshold
    /// (30 s, matching claim's lock options).
    async fn external_lease(&self, id: &str) -> bool {
        if self.leases.lock().await.contains_key(id) {
            return false;
        }
        let path = self.root.join(format!("session-{}.lock", sha256_hex(id)));
        match tokio::fs::metadata(&path).await.and_then(|m| m.modified()) {
            Ok(mtime) => mtime.elapsed().unwrap_or_default() < Duration::from_secs(30),
            Err(_) => false,
        }
    }

    /// Socket-delegated write (service protocol v2 `historyWrite`): the caller
    /// may hold its own fresh lease; an unheld session is claimed just for the
    /// write. A lease held by this store itself means a live local runtime —
    /// the service refuses those before calling here.
    pub async fn write_delegated(&self, snapshot: &Snapshot) -> Result<Snapshot, String> {
        if snapshot.id.is_empty() {
            return Err("无效参数：snapshot".into());
        }
        if self.leases.lock().await.contains_key(&snapshot.id) {
            return self.persist(snapshot, false).await;
        }
        let mut claimed = false;
        if !self.external_lease(&snapshot.id).await {
            match self.try_claim(&snapshot.id).await {
                Ok(()) => claimed = true,
                // Someone claimed between probe and claim — if the holder is
                // still external+fresh the write may proceed under its lease.
                Err(LockError::Held) if self.external_lease(&snapshot.id).await => {}
                Err(LockError::Held) => return Err(SessionInUseError.to_string()),
                Err(e) => return Err(e.to_string()),
            }
        }
        // Delegated writes always check the caller-supplied base revision,
        // even when we hold a brief claim (`seen` tracks only this store's
        // own reads under its own leases).
        let result = self.persist(snapshot, true).await;
        if claimed {
            self.release(&snapshot.id).await;
        }
        result
    }

    async fn persist(&self, snapshot: &Snapshot, external: bool) -> Result<Snapshot, String> {
        self.transaction(async |index: &mut Index| {
            // Split the checks: the `lost` guard is a std mutex that must not
            // be held across the leases.await (L9 review finding).
            let lost = self.lost.lock().unwrap().contains(&snapshot.id);
            if lost || (!external && !self.leases.lock().await.contains_key(&snapshot.id)) {
                return Err("未持有共享会话锁，请重新连接后再保存。".into());
            }
            let current = index.sessions.iter().find(|s| s.id == snapshot.id).cloned();
            if index.deleted.iter().any(|d| d == &snapshot.id) {
                return Err("此会话已从共享历史删除，不会重新保存。".into());
            }
            if let Some(current) = &current {
                // External (delegated) writes carry the caller's base revision
                // in the snapshot itself; local writes use `seen`. A missing
                // seen entry and a stored `undefined` revision both flatten
                // to None.
                let seen = if external {
                    snapshot.revision.clone()
                } else {
                    self.seen.lock().await.get(&snapshot.id).cloned().flatten()
                };
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
    if harness != Some("pi")
        || id.starts_with("workbench:codex:")
        || id.starts_with("workbench:claude:")
    {
        return Err(HARNESS_UNSUPPORTED.into());
    }
    Ok(())
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
        let store = SharedHistoryStore::new(root.clone(), None);
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
    async fn lease_and_optimistic_lock_conflict() {
        let root = temp_root();
        let a = SharedHistoryStore::new(root.clone(), None);
        let b = SharedHistoryStore::new(root.clone(), None);
        a.claim("s1").await.unwrap();
        // A second claim across processes/instances is refused while leased.
        assert_eq!(
            b.claim("s1").await.unwrap_err(),
            SessionInUseError.to_string()
        );
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
