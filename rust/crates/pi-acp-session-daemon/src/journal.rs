//! Durable, idempotent request receipts and restart recovery.
//! Incomplete work is marked interrupted and never replayed automatically.
use crate::queue::{Check, TaskQueue};
use pi_acp_core::atomic::write_atomic_json;
use pi_acp_core::canonical::{request_fingerprint, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::sync::{broadcast, Mutex};

pub const MAX_RECEIPT_BYTES: usize = 256 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
// Old daemons must reject external-result receipts, not replay them as null.
const COMPLETED_REF: &str = "completed_ref";
const RETENTION_MS: u64 = 30 * 86_400_000;
const MALFORMED: &str = "任务收据格式不受支持或已损坏，拒绝执行；请保留原文件检查。";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub session_id: String,
    pub fingerprint: String,
    pub status: String, // running | completed | interrupted
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Pending {
    fingerprint: String,
    task: broadcast::Sender<Result<Value, String>>,
}

pub struct RequestJournal {
    directory: PathBuf,
    in_flight: Mutex<HashMap<String, Pending>>,
    // Deterministic durability/cancellation race injection, absent in binaries.
    #[cfg(test)]
    after_running_write: Option<std::sync::Arc<tokio::sync::Semaphore>>,
    #[cfg(test)]
    fail_running_write: bool,
}

fn is_hex64(bytes: &[u8]) -> bool {
    bytes.len() == 64 && bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl RequestJournal {
    pub fn new(directory: PathBuf) -> Self {
        RequestJournal {
            directory,
            in_flight: Mutex::new(HashMap::new()),
            #[cfg(test)]
            after_running_write: None,
            #[cfg(test)]
            fail_running_write: false,
        }
    }

    #[cfg(test)]
    pub async fn pending_count(&self) -> usize {
        self.in_flight.lock().await.len()
    }

    fn file(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{}.json", sha256_hex(id)))
    }

    fn last_file(&self, session_id: &str) -> PathBuf {
        self.directory
            .join(format!("session-{}.json", sha256_hex(session_id)))
    }

    async fn read(&self, file: &Path) -> Result<Option<Receipt>, String> {
        let metadata = match fs::metadata(file).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        if metadata.len() > MAX_RECEIPT_BYTES as u64 {
            return Err("任务收据过大".into());
        }
        let text = match fs::read_to_string(file).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let value: Value = serde_json::from_str(&text).map_err(|_| MALFORMED.to_string())?;
        let id = value.get("id").and_then(Value::as_str);
        let session_id = value.get("sessionId").and_then(Value::as_str);
        let status = value.get("status").and_then(Value::as_str);
        let fingerprint = value.get("fingerprint").and_then(Value::as_str);
        let (Some(id), Some(session_id), Some(status), Some(fingerprint)) =
            (id, session_id, status, fingerprint)
        else {
            return Err(MALFORMED.into());
        };
        let result_ref = match value.get("resultRef") {
            None => None,
            Some(Value::String(hash)) if is_hex64(hash.as_bytes()) => Some(hash.clone()),
            _ => return Err(MALFORMED.into()),
        };
        if !matches!(
            status,
            "running" | "completed" | "interrupted" | COMPLETED_REF
        ) || !is_hex64(fingerprint.as_bytes())
            || (status == COMPLETED_REF) != result_ref.is_some()
            || (result_ref.is_some()
                && (value.get("result").is_some() || value.get("error").is_some()))
        {
            return Err(MALFORMED.into());
        }
        Ok(Some(Receipt {
            id: id.to_string(),
            session_id: session_id.to_string(),
            fingerprint: fingerprint.to_string(),
            status: if status == COMPLETED_REF {
                "completed"
            } else {
                status
            }
            .to_string(),
            result: value.get("result").cloned(),
            result_ref,
            error: match value.get("error") {
                None | Some(Value::Null) | Some(Value::Bool(false)) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) if n.as_f64() == Some(0.0) => None,
                Some(other) => Some(other.to_string()),
            },
        }))
    }

    pub async fn get(&self, id: &str) -> Result<Option<Receipt>, String> {
        let receipt = self.read(&self.file(id)).await?;
        if let Some(receipt) = &receipt {
            if receipt.id != id {
                return Err("任务收据 ID 不匹配".into());
            }
        }
        Ok(receipt)
    }

    pub async fn last(&self, session_id: &str) -> Result<Option<Receipt>, String> {
        let receipt = self.read(&self.last_file(session_id)).await?;
        if let Some(receipt) = &receipt {
            if receipt.session_id != session_id {
                return Err("任务收据会话不匹配".into());
            }
        }
        Ok(receipt)
    }

    pub async fn write(&self, receipt: &Receipt) -> Result<(), String> {
        #[cfg(test)]
        if self.fail_running_write && receipt.status == "running" {
            return Err("simulated durable write failure".into());
        }
        let mut stored = receipt.clone();
        let size = serde_json::to_vec(receipt)
            .map_err(|e| e.to_string())?
            .len();
        if size > MAX_RECEIPT_BYTES {
            let result = receipt
                .result
                .as_ref()
                .filter(|_| receipt.status == "completed")
                .ok_or("任务收据过大")?;
            let result_body = serde_json::to_vec(result).map_err(|e| e.to_string())?;
            if result_body.len() > MAX_RESULT_BYTES {
                return Err("任务结果过大".into());
            }
            let hash = hex::encode(Sha256::digest(&result_body));
            stored.result = None;
            stored.result_ref = Some(hash.clone());
            drop(result_body);
            let directory = self.directory.join("results");
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&directory)
                .map_err(|e| e.to_string())?;
            // Publish the immutable payload durably BEFORE its receipt/reference.
            write_atomic_json(&self.result_file(&hash), result, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        if stored.result_ref.is_some() {
            stored.status = COMPLETED_REF.into();
        }
        if serde_json::to_vec(&stored)
            .map_err(|e| e.to_string())?
            .len()
            > MAX_RECEIPT_BYTES
        {
            return Err("任务收据过大".into());
        }
        // Receipt first, then the session marker. Large results remain bounded
        // references, including duplicate replies after deletion or restart.
        write_atomic_json(&self.file(&receipt.id), &stored, true)
            .await
            .map_err(|e| e.to_string())?;
        if !receipt.session_id.is_empty() {
            write_atomic_json(&self.last_file(&receipt.session_id), &stored, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn result_file(&self, hash: &str) -> PathBuf {
        self.directory.join("results").join(format!("{hash}.json"))
    }

    async fn result(&self, receipt: &Receipt) -> Result<Value, String> {
        let Some(hash) = &receipt.result_ref else {
            return Ok(receipt.result.clone().unwrap_or(Value::Null));
        };
        let file = fs::File::open(self.result_file(hash))
            .await
            .map_err(|_| "任务结果缺失，拒绝重放；请保留收据检查。".to_string())?;
        let meta = file.metadata().await.map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_RESULT_BYTES as u64 {
            return Err("任务结果过大或类型无效，拒绝重放。".into());
        }
        let mut body = Vec::new();
        file.take(MAX_RESULT_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .await
            .map_err(|e| e.to_string())?;
        if body.len() > MAX_RESULT_BYTES || hex::encode(Sha256::digest(&body)) != *hash {
            return Err("任务结果校验失败，拒绝重放；请保留原文件检查。".into());
        }
        serde_json::from_slice(&body).map_err(|_| MALFORMED.to_string())
    }

    pub async fn run<F, Fut>(
        &self,
        request_id: &str,
        method: &str,
        params: &Value,
        session_id: &str,
        queue: &TaskQueue,
        execute: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Check) -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let fingerprint = request_fingerprint(method, params);
        enum Dedup {
            Wait(broadcast::Receiver<Result<Value, String>>),
            Owner,
        }
        let dedup = {
            let mut in_flight = self.in_flight.lock().await;
            match in_flight.get(request_id) {
                Some(pending) if pending.fingerprint != fingerprint => {
                    return Err("请求 ID 已被其他操作使用".into())
                }
                Some(pending) => Dedup::Wait(pending.task.subscribe()),
                None => {
                    if in_flight.len() >= 100 {
                        return Err("服务请求已满".into());
                    }
                    let (task, _) = broadcast::channel(1);
                    in_flight.insert(
                        request_id.to_string(),
                        Pending {
                            fingerprint: fingerprint.clone(),
                            task,
                        },
                    );
                    Dedup::Owner
                }
            }
        };
        if let Dedup::Wait(mut receiver) = dedup {
            // Lagged is unreachable (single send into a capacity-1 channel);
            // Closed means the owner future was dropped mid-flight — a state JS
            // cannot express — so it maps to the shutdown error.
            return receiver
                .recv()
                .await
                .map_err(|_| "会话服务正在停止".to_string())
                .and_then(|r| r);
        }
        let lane_id = if session_id.is_empty() {
            format!("create:{request_id}")
        } else {
            session_id.to_string()
        };
        let request_id_owned = request_id.to_string();
        let session_id_owned = session_id.to_string();
        let result = queue
            .run(&lane_id, |check: Check| async move {
                let existing = self.get(&request_id_owned).await?;
                check()?;
                if let Some(existing) = existing {
                    if existing.session_id != session_id_owned
                        || existing.fingerprint != fingerprint
                    {
                        return Err("请求 ID 已被其他操作使用".into());
                    }
                    if existing.status != "completed" {
                        return Err(existing
                            .error
                            .unwrap_or_else(|| "此请求曾中断，不会自动重放".into()));
                    }
                    if let Some(error) = &existing.error {
                        return Err(error.clone());
                    }
                    return self.result(&existing).await;
                }
                // 'running' receipt lands BEFORE execute — durability contract.
                let receipt = Receipt {
                    id: request_id_owned.clone(),
                    session_id: session_id_owned.clone(),
                    fingerprint: fingerprint.clone(),
                    status: "running".into(),
                    result: None,
                    result_ref: None,
                    error: None,
                };
                self.write(&receipt).await?;
                #[cfg(test)]
                if let Some(gate) = &self.after_running_write {
                    gate.acquire()
                        .await
                        .map_err(|error| error.to_string())?
                        .forget();
                }
                match async {
                    check()?;
                    execute(check.clone()).await
                }
                .await
                {
                    Ok(result) => {
                        self.write(&Receipt {
                            status: "completed".into(),
                            result: Some(result.clone()),
                            ..receipt
                        })
                        .await?;
                        Ok(result)
                    }
                    Err(error) => {
                        let _ = self
                            .write(&Receipt {
                                status: "interrupted".into(),
                                error: Some(format!("请求未完成，不会自动重放：{error}")),
                                ..receipt
                            })
                            .await;
                        Err(error)
                    }
                }
            })
            .await;
        let pending = self.in_flight.lock().await.remove(request_id);
        if let Some(pending) = pending {
            let _ = pending.task.send(result.clone());
        }
        result
    }

    pub async fn initialize<R, Fut>(&self, recover: R) -> Result<(), String>
    where
        R: Fn(Receipt) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)
            .map_err(|e| e.to_string())?;
        let mut entries = fs::read_dir(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let bytes = name.as_bytes();
            if bytes.len() != 69 || &bytes[64..] != b".json" || !is_hex64(&bytes[..64]) {
                continue;
            }
            let file = entry.path();
            let Some(receipt) = self.read(&file).await? else {
                continue;
            };
            if self.file(&receipt.id) != file {
                return Err("任务收据 ID 不匹配".into());
            }
            if receipt.status != "running" {
                continue;
            }
            let interrupted = Receipt {
                status: "interrupted".into(),
                error: Some("服务曾中断，此任务不会自动重放。请检查历史和工作区后继续。".into()),
                ..receipt.clone()
            };
            let last = self.last(&receipt.session_id).await?;
            recover(interrupted.clone()).await?;
            write_atomic_json(&file, &interrupted, true)
                .await
                .map_err(|e| e.to_string())?;
            if !receipt.session_id.is_empty() && last.map(|l| l.id == receipt.id).unwrap_or(true) {
                write_atomic_json(&self.last_file(&receipt.session_id), &interrupted, true)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        self.sweep().await;
        Ok(())
    }

    async fn sweep(&self) {
        let cutoff = SystemTime::now() - Duration::from_millis(RETENTION_MS);
        let mut entries = match fs::read_dir(&self.directory).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let hash = name.strip_prefix("session-").unwrap_or(name);
            let bytes = hash.as_bytes();
            if bytes.len() != 69 || &bytes[64..] != b".json" || !is_hex64(&bytes[..64]) {
                continue;
            }
            let file = entry.path();
            let Some(mtime) = fs::metadata(&file)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
            else {
                continue; // unreadable → keep for manual inspection
            };
            if mtime > cutoff {
                continue;
            }
            if let Ok(Some(receipt)) = self.read(&file).await {
                if receipt.status == "running" {
                    continue;
                }
            }
            let _ = fs::remove_file(&file).await;
        }
        self.sweep_results(cutoff).await;
    }

    async fn sweep_results(&self, cutoff: SystemTime) {
        let mut referenced = HashSet::new();
        let Ok(mut receipts) = fs::read_dir(&self.directory).await else {
            return;
        };
        while let Ok(Some(entry)) = receipts.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let hash = name
                .strip_prefix("session-")
                .unwrap_or(name)
                .strip_suffix(".json");
            if !hash.is_some_and(|hash| is_hex64(hash.as_bytes())) {
                continue;
            }
            match self.read(&entry.path()).await {
                Ok(Some(receipt)) => {
                    if let Some(hash) = receipt.result_ref {
                        referenced.insert(hash);
                    }
                }
                Ok(None) => {}
                Err(_) => return, // Keep all payloads if ownership cannot be established.
            }
        }
        let Ok(mut results) = fs::read_dir(self.directory.join("results")).await else {
            return;
        };
        while let Ok(Some(entry)) = results.next_entry().await {
            let name = entry.file_name();
            let Some(hash) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if !is_hex64(hash.as_bytes()) || referenced.contains(hash) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(entry.path()).await else {
                continue;
            };
            // Recent unreferenced results may be evidence of a failed receipt
            // commit. Keep them for the same 30-day diagnosis window.
            if meta.is_file() && meta.modified().is_ok_and(|mtime| mtime <= cutoff) {
                let _ = fs::remove_file(entry.path()).await;
            }
        }
    }

    pub async fn drain(&self) {
        let senders: Vec<broadcast::Sender<Result<Value, String>>> = self
            .in_flight
            .lock()
            .await
            .values()
            .map(|p| p.task.clone())
            .collect();
        for sender in senders {
            let mut receiver = sender.subscribe();
            drop(sender); // don't hold the channel open against a dropped owner
            let _ = receiver.recv().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::oneshot;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("pi-journal-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn large_completed_results_replay_after_restart_without_reexecution() {
        let root = Root::new();
        let journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let queue = TaskQueue::new(1, 100);
        let value = json!({"id":"created-session","catalogue":"大".repeat(100_000)});
        let params = json!({"cwd":"/work"});
        let expected = value.clone();
        assert_eq!(
            journal
                .run("large", "create", &params, "", &queue, |_| async {
                    Ok(value)
                })
                .await
                .unwrap(),
            expected
        );
        let meta = journal.get("large").await.unwrap().unwrap();
        assert_eq!(meta.status, "completed");
        assert!(meta.result.is_none());
        assert!(meta.result_ref.is_some());
        assert!(std::fs::metadata(journal.file("large")).unwrap().len() < MAX_RECEIPT_BYTES as u64);
        let disk: Value =
            serde_json::from_str(&fs::read_to_string(journal.file("large")).await.unwrap())
                .unwrap();
        assert_eq!(disk["status"], COMPLETED_REF); // Legacy readers fail closed.
        let restarted = RequestJournal::new(root.0.clone());
        restarted.initialize(|_| async { Ok(()) }).await.unwrap();
        assert_eq!(
            restarted
                .run("large", "create", &params, "", &queue, |_| async {
                    panic!("large result reexecuted")
                })
                .await
                .unwrap(),
            expected
        );
    }

    #[tokio::test]
    async fn missing_corrupt_and_oversized_result_payloads_never_reexecute() {
        for damage in ["missing", "corrupt", "oversized"] {
            let root = Root::new();
            let journal = RequestJournal::new(root.0.clone());
            journal.initialize(|_| async { Ok(()) }).await.unwrap();
            let queue = TaskQueue::new(1, 100);
            let params = json!({"sessionId":"s"});
            journal
                .run("large", "setting", &params, "s", &queue, |_| async {
                    Ok(json!({"catalogue":"x".repeat(MAX_RECEIPT_BYTES)}))
                })
                .await
                .unwrap();
            let meta = journal.get("large").await.unwrap().unwrap();
            let file = journal.result_file(meta.result_ref.as_deref().unwrap());
            match damage {
                "missing" => fs::remove_file(&file).await.unwrap(),
                "corrupt" => fs::write(&file, "{}").await.unwrap(),
                _ => std::fs::File::options()
                    .write(true)
                    .open(&file)
                    .unwrap()
                    .set_len(MAX_RESULT_BYTES as u64 + 1)
                    .unwrap(),
            }
            let error = journal
                .run("large", "setting", &params, "s", &queue, |_| async {
                    panic!("damaged result replayed")
                })
                .await
                .unwrap_err();
            assert!(error.contains("任务结果"), "{damage}: {error}");
            assert!(journal.file("large").exists());
        }
    }

    #[tokio::test]
    async fn rejects_unsafe_or_ambiguous_result_references_without_modifying_evidence() {
        let root = Root::new();
        let journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        for (status, reference, inline) in [
            (COMPLETED_REF, "../escape", false),
            ("completed", &"a".repeat(64), false),
            (COMPLETED_REF, &"a".repeat(64), true),
            (COMPLETED_REF, "", false),
        ] {
            let mut value = json!({"id":"bad-ref","sessionId":"s","fingerprint":"a".repeat(64),"status":status,"resultRef":reference});
            if inline {
                value["result"] = json!({"mixed":true});
            }
            let body = value.to_string();
            fs::write(journal.file("bad-ref"), &body).await.unwrap();
            assert_eq!(journal.get("bad-ref").await.unwrap_err(), MALFORMED);
            assert_eq!(
                fs::read_to_string(journal.file("bad-ref")).await.unwrap(),
                body
            );
        }
    }

    #[tokio::test]
    async fn result_gc_keeps_live_references_and_recent_evidence() {
        let root = Root::new();
        let journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let queue = TaskQueue::new(1, 100);
        journal
            .run("live", "setting", &json!({}), "s", &queue, |_| async {
                Ok(json!({"catalogue":"x".repeat(MAX_RECEIPT_BYTES)}))
            })
            .await
            .unwrap();
        let live = journal
            .get("live")
            .await
            .unwrap()
            .unwrap()
            .result_ref
            .unwrap();
        let aged = SystemTime::now() - Duration::from_millis(RETENTION_MS + 60_000);
        let age = |path: &Path| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(aged))
                .unwrap()
        };
        age(&journal.result_file(&live));
        let old = hex::encode(Sha256::digest(b"old"));
        let recent = hex::encode(Sha256::digest(b"recent"));
        fs::write(journal.result_file(&old), b"old").await.unwrap();
        age(&journal.result_file(&old));
        fs::write(journal.result_file(&recent), b"recent")
            .await
            .unwrap();
        journal.sweep().await;
        assert!(journal.result_file(&live).exists());
        assert!(journal.result_file(&recent).exists());
        assert!(!journal.result_file(&old).exists());
    }

    #[tokio::test]
    async fn shares_in_flight_results_and_replays_after_restart_without_execution() {
        let root = Root::new();
        let journal = Arc::new(RequestJournal::new(root.0.clone()));
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let queue = Arc::new(TaskQueue::new(1, 100));
        let calls = Arc::new(AtomicUsize::new(0));
        let params = json!({"cwd":"/work","nested":{"a":1,"b":2}});
        let (release, held) = oneshot::channel();
        let (entered, started) = oneshot::channel();
        let j = journal.clone();
        let q = queue.clone();
        let count = calls.clone();
        let args = params.clone();
        let first = tokio::spawn(async move {
            j.run("id", "create", &args, "", &q, |_| async move {
                count.fetch_add(1, Ordering::SeqCst);
                entered.send(()).unwrap();
                held.await.unwrap();
                Ok(json!({"created":"one"}))
            })
            .await
        });
        started.await.unwrap();
        assert_eq!(journal.pending_count().await, 1);
        assert_eq!(
            journal
                .run(
                    "id",
                    "create",
                    &json!({"cwd":"/other"}),
                    "",
                    &queue,
                    |_| async { panic!("must not execute") }
                )
                .await
                .unwrap_err(),
            "请求 ID 已被其他操作使用"
        );
        let j = journal.clone();
        let q = queue.clone();
        let duplicate = tokio::spawn(async move {
            j.run(
                "id",
                "create",
                &json!({"nested":{"b":2,"a":1},"cwd":"/work"}),
                "",
                &q,
                |_| async { panic!("duplicate executed") },
            )
            .await
        });
        tokio::task::yield_now().await;
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap(), json!({"created":"one"}));
        assert_eq!(duplicate.await.unwrap().unwrap(), json!({"created":"one"}));
        assert_eq!(journal.pending_count().await, 0);
        let restarted = RequestJournal::new(root.0.clone());
        restarted.initialize(|_| async { Ok(()) }).await.unwrap();
        assert_eq!(
            restarted
                .run("id", "create", &params, "", &queue, |_| async {
                    panic!("replayed operation executed")
                })
                .await
                .unwrap(),
            json!({"created":"one"})
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        queue.close().await;
    }

    #[tokio::test]
    async fn preserves_invalid_receipts_without_migration_or_deletion() {
        let root = Root::new();
        let journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let file = journal.file("unsupported");
        let content =
            json!({"id":"unsupported","sessionId":"one","status":"completed","result":"old"})
                .to_string();
        fs::write(&file, &content).await.unwrap();
        assert_eq!(journal.get("unsupported").await.unwrap_err(), MALFORMED);
        assert_eq!(fs::read_to_string(&file).await.unwrap(), content);
    }

    #[tokio::test]
    async fn initial_receipt_failure_never_invokes_the_side_effect() {
        let root = Root::new();
        let mut journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        journal.fail_running_write = true;
        let queue = TaskQueue::new(1, 100);
        let calls = AtomicUsize::new(0);
        assert!(journal
            .run(
                "id",
                "create",
                &json!({"cwd":"/work"}),
                "",
                &queue,
                |_| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            )
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(journal.pending_count().await, 0);
        assert_eq!(queue.pending_count(), 0);
        assert!(journal.get("id").await.unwrap().is_none());
        journal.fail_running_write = false;
        journal
            .run(
                "id",
                "create",
                &json!({"cwd":"/work"}),
                "",
                &queue,
                |_| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                },
            )
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_after_durable_write_prevents_execution_but_allows_later_work() {
        let root = Root::new();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let mut journal = RequestJournal::new(root.0.clone());
        journal.after_running_write = Some(gate.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let journal = Arc::new(journal);
        let queue = Arc::new(TaskQueue::new(1, 100));
        let calls = Arc::new(AtomicUsize::new(0));
        let j = journal.clone();
        let q = queue.clone();
        let count = calls.clone();
        let task = tokio::spawn(async move {
            j.run(
                "one",
                "prompt",
                &json!({"sessionId":"s"}),
                "s",
                &q,
                |_| async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"ok":true}))
                },
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if journal
                    .get("one")
                    .await
                    .unwrap()
                    .is_some_and(|receipt| receipt.status == "running")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        queue.cancel("s").await;
        gate.add_permits(1);
        assert_eq!(task.await.unwrap().unwrap_err(), "排队请求已取消");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            journal.get("one").await.unwrap().unwrap().status,
            "interrupted"
        );
        gate.add_permits(1);
        assert_eq!(
            journal
                .run(
                    "two",
                    "prompt",
                    &json!({"sessionId":"s"}),
                    "s",
                    &queue,
                    |_| async { Ok(json!({"ok":true})) }
                )
                .await
                .unwrap(),
            json!({"ok":true})
        );
        assert_eq!(journal.pending_count().await, 0);
        queue.close().await;
    }

    #[tokio::test]
    async fn failed_execution_is_tombstoned_and_never_repeated() {
        let root = Root::new();
        let journal = RequestJournal::new(root.0.clone());
        journal.initialize(|_| async { Ok(()) }).await.unwrap();
        let queue = TaskQueue::new(1, 100);
        let params = json!({"sessionId":"s"});
        assert_eq!(
            journal
                .run("id", "prompt", &params, "s", &queue, |_| async {
                    Err("disk failure".into())
                })
                .await
                .unwrap_err(),
            "disk failure"
        );
        assert_eq!(
            journal.get("id").await.unwrap().unwrap().status,
            "interrupted"
        );
        assert!(journal
            .run("id", "prompt", &params, "s", &queue, |_| async {
                panic!("interrupted work replayed")
            })
            .await
            .unwrap_err()
            .contains("不会自动重放"));
        assert_eq!(journal.pending_count().await, 0);
    }
}
