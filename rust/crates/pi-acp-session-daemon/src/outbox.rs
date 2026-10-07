//! TelegramEvents writer + DesktopTelegramTurn port (src/telegram-events.ts).
//! The daemon is the ONLY writer; the telegram daemon consumes/deletes.
//!
//! File naming: telegram/events/<sha256(event.id)>.json — same as the reader.
//! write(): mkdir 0700; atomic write, durable iff status != 'running'.
//!
//! DesktopTelegramTurn — per-prompt durable publisher:
//! - ctor: event = {id:'service:'+requestId, sessionId, cwd, title (first user
//!   text ≤70 chars or 'Pi 任务'), sessionNumber, text:'', status:'running',
//!   updated:now}; source 'desktop' + input is a user entry → inputText =
//!   text + optional '\n[附带 N 个非文本内容，请在 VS Code 查看]' (contextBlocks
//!   non-text count). publish() immediately.
//! - publish(): latest-pending coalesced writes — never queue more than one
//!   pending event; errors reported, not thrown.
//! - update(): 2.5 s debounce → capture() + publish() (skipped after end).
//! - capture(): text = entries[start..] filtered assistant|diff, texts joined
//!   '\n\n'; permissions pending → append '\n🔐 等待工具授权，可在 VS Code 或 Telegram /status 中处理。';
//!   updated=now.
//! - cancel(): marks cancelled.
//! - discard(): end + remove the event file entirely.
//! - finish(error?, stopReason?): capture + status = error→'failed' |
//!   cancelled||stopReason=='cancelled'→'cancelled' | stopReason && !='end_turn'→'failed'
//!   | else 'completed'; set error; publish + await all writes.
use crate::types::Entry;
use pi_acp_core::utf16::utf16_head;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// (session_id, session_number, entries.clone(), permissions.len()) — polled by
/// capture(); service supplies a Weak<Mutex<Runtime>>-backed accessor so the
/// publication never owns state.
pub type StateAccessor =
    Arc<dyn Fn() -> Option<(String, Option<u64>, Vec<Entry>, usize)> + Send + Sync>;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvent {
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_text: Option<String>,
    pub text: String,
    pub status: String, // running | completed | cancelled | failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct TelegramEvents {
    directory: PathBuf,
}

impl TelegramEvents {
    pub fn new(directory: PathBuf) -> Self {
        TelegramEvents { directory }
    }

    /// events/<sha256(event.id)>.json — must match the consumer's reader rule.
    fn file(&self, id: &str) -> PathBuf {
        self.directory.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(id.as_bytes()))
        ))
    }

    pub async fn write(&self, event: &TurnEvent) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.directory)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        pi_acp_core::atomic::write_atomic_json(
            &self.file(&event.id),
            event,
            event.status != "running",
        )
        .await
        .map_err(|e| e.to_string())
    }

    /// rm(file, {force:true}) — the skeleton returns unit, so all errors are
    /// dropped here; ENOENT is the only expected one anyway.
    #[allow(dead_code)] // used by the fork path / tests; wired by service integration
    pub async fn remove(&self, id: &str) {
        let _ = tokio::fs::remove_file(self.file(id)).await;
    }
}

pub type Report = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

struct Inner {
    event: TurnEvent,
    pending: Option<TurnEvent>,
    writer_active: bool,
    ended: bool,
    cancelled: bool,
    debounce_scheduled: bool,
    /// ctor-time fields (title/inputText/sessionId/sessionNumber) still pending
    /// their first accessor() read — see DesktopTelegramTurn::new.
    needs_init: bool,
}

struct Shared {
    events: Arc<TelegramEvents>,
    accessor: StateAccessor,
    start: usize,
    /// source === 'desktop' gates the inputText attachment note.
    source_desktop: bool,
    report: Report,
    closed: Arc<AtomicBool>,
    state: Mutex<Inner>,
    /// bumped by the writer after every write and on drain — finish()/discard()
    /// subscribe to wait for the queue to empty.
    drained: watch::Sender<u64>,
}

pub struct DesktopTelegramTurn {
    inner: Arc<Shared>,
}

impl DesktopTelegramTurn {
    /// `accessor` returns (session_id, session_number, entries, pendingPermissions).
    /// `closed` mirrors service.closed: update() stops scheduling interim writes
    /// during shutdown, but finish() still serializes the final event.
    ///
    /// NOTE: the constructor must NOT call `accessor()` — service.rs invokes
    /// new() while holding the runtime Mutex, so a synchronous accessor call
    /// would deadlock. Ctor-time fields are instead resolved by the first
    /// writer pass (needs_init flag), matching the TS ordering: the event is
    /// still published immediately, just from the spawned writer task.
    pub fn new(
        events: Arc<TelegramEvents>,
        accessor: StateAccessor,
        cwd: String,
        start: usize,
        id: String,
        source: String,
        report: Report,
        closed: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let (drained, _) = watch::channel(0u64);
        let inner = Arc::new(Shared {
            events,
            accessor,
            start,
            report,
            closed,
            drained,
            source_desktop: source == "desktop",
            state: Mutex::new(Inner {
                event: TurnEvent {
                    id,
                    session_id: String::new(),
                    cwd,
                    title: "Pi 任务".into(),
                    session_number: None,
                    input_text: None,
                    text: String::new(),
                    status: "running".into(),
                    error: None,
                    updated: now_ms(),
                },
                pending: None,
                writer_active: false,
                ended: false,
                cancelled: false,
                debounce_scheduled: false,
                needs_init: true,
            }),
        });
        let this = DesktopTelegramTurn { inner };
        this.publish();
        this
    }

    /// Ctor-time capture from the accessor — fills sessionId, sessionNumber,
    /// title and inputText exactly like the TS constructor body, then replaces
    /// the queued pending event so the write carries the real fields.
    fn init_capture(shared: &Shared) {
        let Some((session_id, session_number, entries, _)) = (shared.accessor)() else {
            return;
        };
        let mut s = shared.state.lock().unwrap();
        s.needs_init = false;
        s.event.session_id = session_id;
        s.event.session_number = session_number;
        // title: first user entry's text sliced to 70 UTF-16 units, or 'Pi 任务'.
        let first = entries.iter().find(|e| e.role == "user");
        s.event.title = first
            .and_then(|e| e.text.as_deref())
            .map(|t| utf16_head(t, 70))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Pi 任务".into());
        if shared.source_desktop {
            // input = state.entries[start-1]
            if let Some(input) = shared.start.checked_sub(1).and_then(|i| entries.get(i)) {
                if input.role == "user" {
                    let attachments = input
                        .context_blocks
                        .as_ref()
                        .map(|blocks| {
                            blocks
                                .iter()
                                .filter(|b| b.get("type").and_then(Value::as_str) != Some("text"))
                                .count()
                        })
                        .unwrap_or(0);
                    let mut text = input.text.clone().unwrap_or_default();
                    if attachments > 0 {
                        text.push_str(&format!(
                            "\n[附带 {attachments} 个非文本内容，请在 VS Code 查看]"
                        ));
                    }
                    s.event.input_text = Some(text);
                }
            }
        }
        s.pending = Some(s.event.clone());
    }

    /// latest-pending coalesced writes — never queue more than one pending event.
    fn publish(&self) {
        Self::publish_shared(&self.inner);
    }

    fn publish_shared(shared: &Arc<Shared>) {
        {
            let mut s = shared.state.lock().unwrap();
            s.pending = Some(s.event.clone());
            if s.writer_active {
                return;
            }
            s.writer_active = true;
        }
        let shared = shared.clone();
        tokio::spawn(async move {
            {
                let s = shared.state.lock().unwrap();
                if s.needs_init {
                    drop(s);
                    Self::init_capture(&shared);
                }
            }
            loop {
                let event = {
                    let mut s = shared.state.lock().unwrap();
                    match s.pending.take() {
                        Some(e) => e,
                        None => {
                            s.writer_active = false;
                            break;
                        }
                    }
                };
                if let Err(error) = shared.events.write(&event).await {
                    (shared.report)(&error); // errors reported, not thrown
                }
                shared.drained.send_modify(|v| *v += 1);
            }
            shared.drained.send_modify(|v| *v += 1);
        });
    }

    /// Waits for `while(this.writing)await this.writing` — pending drained and
    /// no writer running.
    async fn wait_writes(&self) {
        let mut rx = self.inner.drained.subscribe();
        loop {
            {
                let s = self.inner.state.lock().unwrap();
                if !s.writer_active && s.pending.is_none() {
                    return;
                }
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    fn capture_shared(shared: &Shared) {
        let (_, _, entries, permissions) = (shared.accessor)().unwrap_or_default();
        let mut s = shared.state.lock().unwrap();
        s.event.text = entries
            .iter()
            .skip(shared.start)
            .filter(|e| e.role == "assistant" || e.role == "diff")
            .map(|e| e.text().to_string())
            .collect::<Vec<_>>()
            .join("\n\n");
        if permissions > 0 {
            s.event
                .text
                .push_str("\n🔐 等待工具授权，可在 VS Code 或 Telegram /status 中处理。");
        }
        s.event.updated = now_ms();
    }

    pub fn update(&self) {
        let shared = self.inner.clone();
        {
            let mut s = shared.state.lock().unwrap();
            if s.ended || s.debounce_scheduled {
                return;
            }
            // service.closed: interim debounce writes stop; finish() still writes.
            if shared.closed.load(Ordering::SeqCst) {
                return;
            }
            s.debounce_scheduled = true;
        }
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            let fire = {
                let mut s = shared.state.lock().unwrap();
                s.debounce_scheduled = false;
                !s.ended
            };
            if fire {
                Self::capture_shared(&shared);
                Self::publish_shared(&shared);
            }
        });
    }

    #[allow(dead_code)] // used by the fork path / tests; wired by service integration
    pub fn cancel(&self) {
        self.inner.state.lock().unwrap().cancelled = true;
    }

    #[allow(dead_code)] // used by the fork path / tests; wired by service integration
    pub async fn discard(&self) {
        {
            let mut s = self.inner.state.lock().unwrap();
            s.ended = true;
            s.debounce_scheduled = false;
        }
        self.wait_writes().await;
        let id = self.inner.state.lock().unwrap().event.id.clone();
        self.inner.events.remove(&id).await;
    }

    pub async fn finish(&self, error: Option<String>, stop_reason: Option<&str>) {
        if self.inner.state.lock().unwrap().ended {
            return;
        }
        Self::capture_shared(&self.inner);
        {
            let mut s = self.inner.state.lock().unwrap();
            s.ended = true;
            s.debounce_scheduled = false;
            s.event.status = if error.is_some() {
                "failed"
            } else if s.cancelled || stop_reason == Some("cancelled") {
                "cancelled"
            } else if stop_reason.is_some() && stop_reason != Some("end_turn") {
                "failed"
            } else {
                "completed"
            }
            .to_string();
            s.event.error = error;
        }
        self.publish();
        self.wait_writes().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("pi-outbox-test-{}", uuid::Uuid::new_v4().simple()))
    }

    fn accessor(entries: Vec<Entry>, permissions: usize) -> StateAccessor {
        Arc::new(move || {
            Some((
                "session-1".to_string(),
                Some(7u64),
                entries.clone(),
                permissions,
            ))
        })
    }

    fn entry(role: &str, text: &str) -> Entry {
        Entry::text_entry(format!("e-{role}-{text}"), role, text.to_string())
    }

    fn report_sink() -> (Report, Arc<Mutex<Vec<String>>>) {
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = errors.clone();
        (
            Arc::new(move |e: &str| sink.lock().unwrap().push(e.to_string())),
            errors,
        )
    }

    #[tokio::test]
    async fn writes_running_then_terminal_event() {
        let dir = test_dir();
        let events = Arc::new(TelegramEvents::new(dir.clone()));
        let entries = vec![entry("user", "hello world")];
        let (report, errors) = report_sink();
        let turn = DesktopTelegramTurn::new(
            events,
            accessor(entries, 0),
            "/tmp".into(),
            1,
            "service:req-1".into(),
            "desktop".into(),
            report,
            Arc::new(AtomicBool::new(false)),
        );
        turn.finish(None, Some("end_turn")).await;
        let name = format!("{}.json", hex::encode(Sha256::digest(b"service:req-1")));
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap();
        assert_eq!(raw["sessionId"], "session-1");
        assert_eq!(raw["sessionNumber"], 7);
        assert_eq!(raw["status"], "completed");
        assert_eq!(raw["title"], "hello world");
        assert_eq!(raw["inputText"], "hello world");
        assert!(errors.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancelled_and_error_mapping() {
        let dir = test_dir();
        let events = Arc::new(TelegramEvents::new(dir.clone()));
        let (report, _) = report_sink();
        let turn = DesktopTelegramTurn::new(
            events.clone(),
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:a".into(),
            "telegram".into(),
            report.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        turn.cancel();
        turn.finish(None, Some("end_turn")).await;
        let file_a = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:a"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_a).unwrap()).unwrap();
        assert_eq!(raw["status"], "cancelled");
        // non-end_turn stopReason → failed
        let turn2 = DesktopTelegramTurn::new(
            events.clone(),
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:b".into(),
            "telegram".into(),
            report.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        turn2.finish(None, Some("length")).await;
        let file_b = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:b"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_b).unwrap()).unwrap();
        assert_eq!(raw["status"], "failed");
        // explicit error → failed
        let turn3 = DesktopTelegramTurn::new(
            events,
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:c".into(),
            "desktop".into(),
            report,
            Arc::new(AtomicBool::new(false)),
        );
        turn3.finish(Some("boom".into()), None).await;
        let file_c = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:c"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_c).unwrap()).unwrap();
        assert_eq!(raw["status"], "failed");
        assert_eq!(raw["error"], "boom");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn discard_removes_the_file() {
        let dir = test_dir();
        let events = Arc::new(TelegramEvents::new(dir.clone()));
        let (report, _) = report_sink();
        let turn = DesktopTelegramTurn::new(
            events.clone(),
            accessor(vec![entry("user", "x")], 0),
            "/tmp".into(),
            1,
            "service:d".into(),
            "desktop".into(),
            report,
            Arc::new(AtomicBool::new(false)),
        );
        turn.discard().await;
        let file = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:d"))
        ));
        // give the writer a moment if the file write raced the removal — the
        // contract is only that nothing survives discard().
        for _ in 0..20 {
            if !file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capture_text_appends_permission_notice() {
        // Direct exercise of the capture mapping (assistant|diff only + pending notice).
        let (drained, _) = watch::channel(0u64);
        let shared = Shared {
            events: Arc::new(TelegramEvents::new(test_dir())),
            accessor: accessor(
                vec![
                    entry("user", "q"),
                    entry("assistant", "a1"),
                    entry("thought", "skip"),
                    entry("diff", "d1"),
                ],
                1,
            ),
            start: 1,
            report: Arc::new(|_| {}),
            closed: Arc::new(AtomicBool::new(false)),
            drained,
            state: Mutex::new(Inner {
                event: TurnEvent {
                    id: "e".into(),
                    session_id: "s".into(),
                    cwd: "/".into(),
                    title: "t".into(),
                    session_number: None,
                    input_text: None,
                    text: String::new(),
                    status: "running".into(),
                    error: None,
                    updated: 0,
                },
                pending: None,
                writer_active: false,
                ended: false,
                cancelled: false,
                debounce_scheduled: false,
                needs_init: false,
            }),
            source_desktop: true,
        };
        DesktopTelegramTurn::capture_shared(&shared);
        let s = shared.state.lock().unwrap();
        assert!(s.event.text.starts_with("a1\n\nd1"));
        assert!(s.event.text.contains("等待工具授权"));
    }
}
