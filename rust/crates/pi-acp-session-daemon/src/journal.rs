//! RequestJournal port (src/request-journal.ts) — durable request receipts,
//! idempotent replay, 30-day sweep. Layout per docs/data-formats.md §6:
//!   requests/<sha256(requestId)>.json           — receipt by request id
//!   requests/session-<sha256(sessionId)>.json   — last receipt per session
//! Receipt: {id, sessionId, fingerprint(64hex), status: running|completed|interrupted,
//!           result?, error?} — written via write_atomic_json(..., durable=true).
//!
//! Invariants:
//! - fingerprint = core::canonical::request_fingerprint(method, params).
//! - MAX_RECEIPT_BYTES = 256*1024; oversized read/write → '任务收据过大'.
//! - read(): malformed → '任务收据格式不受支持或已损坏，拒绝执行；请保留原文件检查。'
//!   ENOENT → Ok(None). Wrong id inside file → '任务收据 ID 不匹配' (get) /
//!   '任务收据会话不匹配' (last).
//! - run(): in-flight dedup — same id + same fingerprint returns the pending
//!   operation's result; same id + different fingerprint → '请求 ID 已被其他操作使用'.
//!   inFlight cap 100 → '服务请求已满'.
//! - Inside queue.run: get(id) first; existing receipt: sessionId/fingerprint
//!   mismatch → '请求 ID 已被其他操作使用'; status!=completed → '此请求曾中断，不会自动重放'
//!   (or existing.error); completed → return existing.result (or existing.error if set).
//! - Write 'running' receipt BEFORE execute; on success write 'completed'+result;
//!   on error write 'interrupted' with '请求未完成，不会自动重放：{msg}'.
//! - initialize(recover): every receipt file matching [a-f0-9]{64}.json is read;
//!   filename must equal sha256(r.id) else '任务收据 ID 不匹配'; running →
//!   recover(interrupted receipt) then rewrite as 'interrupted' with
//!   '服务曾中断，此任务不会自动重放。请检查历史和工作区后继续。' — also update the
//!   session- marker when it points at this id. Then sweep().
//! - sweep(): files older than 30 days (mtime) removed unless status=='running'
//!   or unreadable. Errors ignored.
use crate::queue::{Check, TaskQueue};
use pi_acp_core::atomic::write_atomic_json;
use pi_acp_core::canonical::{request_fingerprint, sha256_hex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::fs;
use tokio::sync::{broadcast, Mutex};

pub const MAX_RECEIPT_BYTES: usize = 256 * 1024;
const RETENTION_MS: u64 = 30 * 86_400_000;
/// TS: '任务收据格式不受支持或已损坏，拒绝执行；请保留原文件检查。'
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
    pub error: Option<String>,
}

struct Pending {
    fingerprint: String,
    task: broadcast::Sender<Result<Value, String>>,
}

pub struct RequestJournal {
    directory: PathBuf,
    in_flight: Mutex<HashMap<String, Pending>>,
}

/// TS `/^[a-f0-9]{64}$/` — lowercase hex only.
fn is_hex64(bytes: &[u8]) -> bool {
    bytes.len() == 64 && bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl RequestJournal {
    pub fn new(directory: PathBuf) -> Self {
        RequestJournal { directory, in_flight: Mutex::new(HashMap::new()) }
    }

    #[allow(dead_code)] // TS pendingCount parity (diagnostics)
    pub async fn pending_count(&self) -> usize {
        self.in_flight.lock().await.len()
    }

    /// TS file(id) = join(directory, sha256(id) + '.json').
    fn file(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{}.json", sha256_hex(id)))
    }

    /// TS lastFile(sessionId) = join(directory, 'session-' + sha256(sessionId) + '.json').
    fn last_file(&self, session_id: &str) -> PathBuf {
        self.directory.join(format!("session-{}.json", sha256_hex(session_id)))
    }

    /// TS read(file): ENOENT → None; >MAX_RECEIPT_BYTES → '任务收据过大';
    /// any parse/shape failure → MALFORMED. Validation is done field by field
    /// (not via serde derive) so only the four checked fields reject the file —
    /// extra keys and an untyped `result` are tolerated exactly as in TS.
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
            // TS catches ENOENT from either stat or readFile (rename race).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let value: Value = serde_json::from_str(&text).map_err(|_| MALFORMED.to_string())?;
        // TS: typeof r.id==='string' && typeof r.sessionId==='string' &&
        //     status ∈ {running,completed,interrupted} && /^[a-f0-9]{64}$/ fingerprint.
        let id = value.get("id").and_then(Value::as_str);
        let session_id = value.get("sessionId").and_then(Value::as_str);
        let status = value.get("status").and_then(Value::as_str);
        let fingerprint = value.get("fingerprint").and_then(Value::as_str);
        let (Some(id), Some(session_id), Some(status), Some(fingerprint)) =
            (id, session_id, status, fingerprint)
        else {
            return Err(MALFORMED.into());
        };
        if !matches!(status, "running" | "completed" | "interrupted") || !is_hex64(fingerprint.as_bytes())
        {
            return Err(MALFORMED.into());
        }
        Ok(Some(Receipt {
            id: id.to_string(),
            session_id: session_id.to_string(),
            fingerprint: fingerprint.to_string(),
            status: status.to_string(),
            result: value.get("result").cloned(),
            // TS uses truthiness for `error` (`existing.error || '此请求曾中断…'`):
            // null/false/0/"" behave as absent; non-string scalars stringify.
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
        // TS: r.id !== id → '任务收据 ID 不匹配'
        if let Some(receipt) = &receipt {
            if receipt.id != id {
                return Err("任务收据 ID 不匹配".into());
            }
        }
        Ok(receipt)
    }

    pub async fn last(&self, session_id: &str) -> Result<Option<Receipt>, String> {
        let receipt = self.read(&self.last_file(session_id)).await?;
        // TS: r.sessionId !== sessionId → '任务收据会话不匹配'
        if let Some(receipt) = &receipt {
            if receipt.session_id != session_id {
                return Err("任务收据会话不匹配".into());
            }
        }
        Ok(receipt)
    }

    pub async fn write(&self, receipt: &Receipt) -> Result<(), String> {
        // TS: Buffer.byteLength(JSON.stringify(r)) > MAX → '任务收据过大'.
        // serde_json emits the same compact UTF-8 shape (camelCase keys, absent
        // option fields), so byte length matches byteLength(JSON.stringify).
        let body = serde_json::to_string(receipt).map_err(|e| e.to_string())?;
        if body.len() > MAX_RECEIPT_BYTES {
            return Err("任务收据过大".into());
        }
        // Write order is contractual (docs/data-formats.md §4): receipt first,
        // then the session- marker.
        write_atomic_json(&self.file(&receipt.id), receipt, true)
            .await
            .map_err(|e| e.to_string())?;
        if !receipt.session_id.is_empty() {
            write_atomic_json(&self.last_file(&receipt.session_id), receipt, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Run `execute` under the session queue with receipt deduplication.
    /// `recover` usage is initialize-only.
    ///
    /// TS run(id, method, params, sessionId, queue, execute, report) — the Rust
    /// signature drops `report`; the failed-write tombstone path is best-effort
    /// (its result is discarded like `.catch(() => {})`).
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
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let fingerprint = request_fingerprint(method, params);
        enum Dedup {
            /// Same id + same fingerprint: await the owner's broadcast result
            /// (TS returns the shared `pending.operation` promise).
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
                        Pending { fingerprint: fingerprint.clone(), task },
                    );
                    Dedup::Owner
                }
            }
        };
        if let Dedup::Wait(mut receiver) = dedup {
            // Lagged is unreachable (single send into a capacity-1 channel);
            // Closed means the owner future was dropped mid-flight — a state JS
            // cannot express — so it maps to the shutdown error.
            return receiver.recv().await.map_err(|_| "会话服务正在停止".to_string()).and_then(|r| r);
        }
        // TS: queue.run(sessionId || 'create:' + id, async check => { ... })
        let lane_id =
            if session_id.is_empty() { format!("create:{request_id}") } else { session_id.to_string() };
        let request_id_owned = request_id.to_string();
        let session_id_owned = session_id.to_string();
        let result = queue
            .run(&lane_id, |check: Check| async move {
                // TS: existing receipt → verify identity, then replay rules.
                let existing = self.get(&request_id_owned).await?;
                check()?;
                if let Some(existing) = existing {
                    if existing.session_id != session_id_owned || existing.fingerprint != fingerprint {
                        return Err("请求 ID 已被其他操作使用".into());
                    }
                    if existing.status != "completed" {
                        return Err(existing
                            .error
                            .unwrap_or_else(|| "此请求曾中断，不会自动重放".into()));
                    }
                    if let Some(error) = existing.error {
                        return Err(error);
                    }
                    return Ok(existing.result.unwrap_or(Value::Null));
                }
                // 'running' receipt lands BEFORE execute — durability contract.
                let receipt = Receipt {
                    id: request_id_owned.clone(),
                    session_id: session_id_owned.clone(),
                    fingerprint: fingerprint.clone(),
                    status: "running".into(),
                    result: None,
                    error: None,
                };
                self.write(&receipt).await?;
                match async {
                    check()?;
                    execute().await
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
                        // TS: write('interrupted').catch(report) — best-effort.
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
        // TS: finally { inFlight.delete(id) }. The send precedes the remove under
        // the same lock, so every receiver obtained via `Wait` above is
        // guaranteed to observe the outcome (send into capacity-1 channel).
        let pending = self.in_flight.lock().await.remove(request_id);
        if let Some(pending) = pending {
            let _ = pending.task.send(result.clone());
        }
        result
    }

    /// Startup: scan receipts, mark stale 'running' as interrupted (via `recover`
    /// for outbox notification), verify filename↔id hash, then sweep().
    /// recover() errors propagate (TS does the same — a corrupt index must
    /// refuse startup rather than silently dropping interrupted outbox events).
    pub async fn initialize<R, Fut>(&self, recover: R) -> Result<(), String>
    where
        R: Fn(Receipt) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        // TS: mkdir(directory, {recursive:true, mode:0o700}).
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)
            .map_err(|e| e.to_string())?;
        let mut entries = fs::read_dir(&self.directory).await.map_err(|e| e.to_string())?;
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // TS: /^[a-f0-9]{64}\.json$/ — session- markers are handled by sweep.
            let bytes = name.as_bytes();
            if bytes.len() != 69 || &bytes[64..] != b".json" || !is_hex64(&bytes[..64]) {
                continue;
            }
            let file = entry.path();
            let Some(receipt) = self.read(&file).await? else { continue };
            // TS: this.file(r.id) !== file → '任务收据 ID 不匹配'
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
            // TS order: last() read → recover → rewrite receipt → maybe marker.
            let last = self.last(&receipt.session_id).await?;
            recover(interrupted.clone()).await?;
            write_atomic_json(&file, &interrupted, true).await.map_err(|e| e.to_string())?;
            // TS: if (r.sessionId && (!last || last.id === r.id)) rewrite marker.
            if !receipt.session_id.is_empty()
                && last.map(|l| l.id == receipt.id).unwrap_or(true)
            {
                write_atomic_json(&self.last_file(&receipt.session_id), &interrupted, true)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        // TS: await this.sweep().catch(() => {}) — sweep never returns Err;
        // it swallows its own failures internally.
        self.sweep().await;
        Ok(())
    }

    /// Finished receipts and session markers are diagnostic only; expire them
    /// after the retention window. TS sweep(): mtime older than 30 days removed
    /// unless status=='running' or the file is unreadable; all errors ignored.
    async fn sweep(&self) {
        let cutoff = SystemTime::now() - Duration::from_millis(RETENTION_MS);
        let mut entries = match fs::read_dir(&self.directory).await {
            Ok(entries) => entries,
            Err(_) => return,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            // TS: /^(?:session-)?[a-f0-9]{64}\.json$/
            let hash = name.strip_prefix("session-").unwrap_or(name);
            let bytes = hash.as_bytes();
            if bytes.len() != 69 || &bytes[64..] != b".json" || !is_hex64(&bytes[..64]) {
                continue;
            }
            let file = entry.path();
            let Some(mtime) =
                fs::metadata(&file).await.ok().and_then(|m| m.modified().ok())
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
            // TS: rm(file, {force:true}) inside try — failure keeps the file.
            let _ = fs::remove_file(&file).await;
        }
    }

    /// TS drain(): Promise.allSettled over every in-flight operation. Each
    /// pending sender is dropped right after broadcasting its run() outcome, so
    /// subscribing then dropping our own clone resolves on send or close.
    pub async fn drain(&self) {
        let senders: Vec<broadcast::Sender<Result<Value, String>>> =
            self.in_flight.lock().await.values().map(|p| p.task.clone()).collect();
        for sender in senders {
            let mut receiver = sender.subscribe();
            drop(sender); // don't hold the channel open against a dropped owner
            let _ = receiver.recv().await;
        }
    }
}
