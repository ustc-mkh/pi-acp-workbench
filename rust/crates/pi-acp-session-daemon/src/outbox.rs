//! Latest-state-coalescing durable task publisher. Consumers own presentation.
//! The existing telegram/events directory is retained for disk compatibility.
//! Final writes are durable and their failures propagate to the task receipt.
use crate::types::Entry;
use pi_acp_core::sync::MutexExt;
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

pub use pi_acp_core::turn_event::TurnEvent;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct TaskOutbox {
    directory: PathBuf,
    storage: tokio::sync::Mutex<()>,
    #[cfg(test)]
    write_gate: Option<Arc<tokio::sync::Semaphore>>,
    #[cfg(test)]
    write_attempts: std::sync::atomic::AtomicUsize,
}

impl TaskOutbox {
    pub fn new(directory: PathBuf) -> Self {
        TaskOutbox {
            directory,
            storage: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            write_gate: None,
            #[cfg(test)]
            write_attempts: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// events/<sha256(event.id)>.json — must match the consumer's reader rule.
    fn file(&self, id: &str) -> PathBuf {
        self.directory.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(id.as_bytes()))
        ))
    }

    pub async fn next(&self, cursor: Option<&str>) -> Result<Value, String> {
        let _guard = self.storage.lock().await;
        crate::outbox_reader::next(&self.directory, cursor)
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
    }
    pub async fn ack(&self, id: &str, token: &str) -> Result<bool, String> {
        let _guard = self.storage.lock().await;
        crate::outbox_reader::ack(&self.directory, id, token)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn write(&self, event: &TurnEvent) -> Result<(), String> {
        let _guard = self.storage.lock().await;
        #[cfg(test)]
        {
            self.write_attempts.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &self.write_gate {
                gate.acquire().await.map_err(|e| e.to_string())?.forget();
            }
        }
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
}

pub type Report = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

struct Inner {
    event: TurnEvent,
    pending: Option<TurnEvent>,
    writer_active: bool,
    ended: bool,
    debounce_scheduled: bool,
    last_write_error: Option<String>,
    /// ctor-time fields (title/inputText/sessionId/sessionNumber) still pending
    /// their first accessor() read — see TurnPublication::new.
    needs_init: bool,
}

struct Shared {
    events: Arc<TaskOutbox>,
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

pub struct TurnPublication {
    inner: Arc<Shared>,
}

pub struct PublicationControl {
    pub report: Report,
    pub closed: Arc<std::sync::atomic::AtomicBool>,
}

impl TurnPublication {
    pub fn new(
        events: Arc<TaskOutbox>,
        accessor: StateAccessor,
        cwd: String,
        start: usize,
        id: String,
        source: String,
        control: PublicationControl,
    ) -> Self {
        let PublicationControl { report, closed } = control;
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
                    pending_permissions: 0,
                    non_text_blocks: 0,
                },
                pending: None,
                writer_active: false,
                ended: false,
                debounce_scheduled: false,
                last_write_error: None,
                needs_init: true,
            }),
        });
        let this = TurnPublication { inner };
        this.publish();
        this
    }

    fn init_capture(shared: &Shared) {
        let Some((session_id, session_number, entries, _)) = (shared.accessor)() else {
            return;
        };
        let mut s = shared.state.lock_unpoisoned();
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
                    s.event.non_text_blocks = attachments;
                    s.event.input_text = input.text.clone();
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
            let mut s = shared.state.lock_unpoisoned();
            s.pending = Some(s.event.clone());
            if s.writer_active {
                return;
            }
            s.writer_active = true;
        }
        let shared = shared.clone();
        tokio::spawn(async move {
            {
                let s = shared.state.lock_unpoisoned();
                if s.needs_init {
                    drop(s);
                    Self::init_capture(&shared);
                }
            }
            loop {
                let event = {
                    let mut s = shared.state.lock_unpoisoned();
                    match s.pending.take() {
                        Some(e) => e,
                        None => {
                            s.writer_active = false;
                            break;
                        }
                    }
                };
                let result = shared.events.write(&event).await;
                shared.state.lock_unpoisoned().last_write_error = result.as_ref().err().cloned();
                if let Err(error) = result {
                    (shared.report)(&error);
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
                let s = self.inner.state.lock_unpoisoned();
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
        let mut s = shared.state.lock_unpoisoned();
        s.event.text = entries
            .iter()
            .skip(shared.start)
            .filter(|e| e.role == "assistant" || e.role == "diff")
            .map(|e| e.text().to_string())
            .collect::<Vec<_>>()
            .join("\n\n");
        s.event.pending_permissions = permissions;
        s.event.updated = now_ms();
    }

    pub fn update(&self) {
        let shared = self.inner.clone();
        {
            let mut s = shared.state.lock_unpoisoned();
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
                let mut s = shared.state.lock_unpoisoned();
                s.debounce_scheduled = false;
                !s.ended
            };
            if fire {
                Self::capture_shared(&shared);
                Self::publish_shared(&shared);
            }
        });
    }

    pub async fn finish(
        &self,
        error: Option<String>,
        stop_reason: Option<&str>,
    ) -> Result<(), String> {
        if self.inner.state.lock_unpoisoned().ended {
            return Ok(());
        }
        Self::capture_shared(&self.inner);
        {
            let mut s = self.inner.state.lock_unpoisoned();
            s.ended = true;
            s.debounce_scheduled = false;
            s.event.status = if error.is_some() {
                "failed"
            } else if stop_reason == Some("cancelled") {
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
        self.inner
            .state
            .lock_unpoisoned()
            .last_write_error
            .clone()
            .map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stalled_storage_keeps_only_latest_pending_event_and_flushes_terminal_state() {
        let dir = test_dir();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let mut events = TaskOutbox::new(dir.clone());
        events.write_gate = Some(gate.clone());
        let events = Arc::new(events);
        let entries = Arc::new(Mutex::new(vec![entry("assistant", "initial")]));
        let current = entries.clone();
        let get: StateAccessor = Arc::new(move || {
            Some((
                "session-1".into(),
                Some(7),
                current.lock_unpoisoned().clone(),
                0,
            ))
        });
        let (report, errors) = report_sink();
        let turn = TurnPublication::new(
            events.clone(),
            get,
            "/work".into(),
            0,
            "coalesced".into(),
            "telegram".into(),
            PublicationControl {
                report,
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            while events.write_attempts.load(Ordering::SeqCst) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for i in 0..50 {
            *entries.lock_unpoisoned() = vec![entry("assistant", &format!("version {i}"))];
            TurnPublication::capture_shared(&turn.inner);
            turn.publish();
        }
        assert_eq!(events.write_attempts.load(Ordering::SeqCst), 1);
        let shared = turn.inner.clone();
        let end = tokio::spawn(async move {
            turn.finish(None, Some("end_turn")).await.unwrap();
            turn
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !shared.state.lock_unpoisoned().ended {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        gate.add_permits(2);
        let turn = tokio::time::timeout(Duration::from_secs(2), end)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(events.write_attempts.load(Ordering::SeqCst), 2);
        assert!(errors.lock_unpoisoned().is_empty());
        let event: Value =
            serde_json::from_slice(&tokio::fs::read(events.file("coalesced")).await.unwrap())
                .unwrap();
        assert_eq!(event["text"], "version 49");
        assert_eq!(event["status"], "completed");
        assert!(!turn.inner.state.lock_unpoisoned().writer_active);
        assert!(turn.inner.state.lock_unpoisoned().pending.is_none());
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test]
    async fn final_outbox_storage_failure_is_reported_and_writer_drains() {
        let dir = test_dir();
        let backup = dir.with_extension("backup");
        let events = Arc::new(TaskOutbox::new(dir.clone()));
        let (report, errors) = report_sink();
        let turn = TurnPublication::new(
            events.clone(),
            accessor(vec![entry("assistant", "final")], 0),
            "/work".into(),
            0,
            "failure".into(),
            "telegram".into(),
            PublicationControl {
                report,
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        turn.wait_writes().await;
        tokio::fs::rename(&dir, &backup).await.unwrap();
        tokio::fs::write(&dir, "not a directory").await.unwrap();
        assert!(turn.finish(None, Some("end_turn")).await.is_err());
        assert_eq!(errors.lock_unpoisoned().len(), 1);
        assert!(!turn.inner.state.lock_unpoisoned().writer_active);
        assert!(turn.inner.state.lock_unpoisoned().pending.is_none());
        let old: Value = serde_json::from_slice(
            &tokio::fs::read(backup.join(events.file("failure").file_name().unwrap()))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(old["status"], "running");
        tokio::fs::remove_file(&dir).await.unwrap();
        tokio::fs::remove_dir_all(&backup).await.unwrap();
    }

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
            Arc::new(move |e: &str| sink.lock_unpoisoned().push(e.to_string())),
            errors,
        )
    }

    #[tokio::test]
    async fn writes_running_then_terminal_event() {
        let dir = test_dir();
        let events = Arc::new(TaskOutbox::new(dir.clone()));
        let entries = vec![entry("user", "hello world")];
        let (report, errors) = report_sink();
        let turn = TurnPublication::new(
            events,
            accessor(entries, 0),
            "/tmp".into(),
            1,
            "service:req-1".into(),
            "desktop".into(),
            PublicationControl {
                report,
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        turn.finish(None, Some("end_turn")).await.unwrap();
        let name = format!("{}.json", hex::encode(Sha256::digest(b"service:req-1")));
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap();
        assert_eq!(raw["sessionId"], "session-1");
        assert_eq!(raw["sessionNumber"], 7);
        assert_eq!(raw["status"], "completed");
        assert_eq!(raw["title"], "hello world");
        assert_eq!(raw["inputText"], "hello world");
        assert!(errors.lock_unpoisoned().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancelled_and_error_mapping() {
        let dir = test_dir();
        let events = Arc::new(TaskOutbox::new(dir.clone()));
        let (report, _) = report_sink();
        let turn = TurnPublication::new(
            events.clone(),
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:a".into(),
            "telegram".into(),
            PublicationControl {
                report: report.clone(),
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        turn.finish(None, Some("cancelled")).await.unwrap();
        let file_a = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:a"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_a).unwrap()).unwrap();
        assert_eq!(raw["status"], "cancelled");
        // non-end_turn stopReason → failed
        let turn2 = TurnPublication::new(
            events.clone(),
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:b".into(),
            "telegram".into(),
            PublicationControl {
                report: report.clone(),
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        turn2.finish(None, Some("length")).await.unwrap();
        let file_b = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:b"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_b).unwrap()).unwrap();
        assert_eq!(raw["status"], "failed");
        // explicit error → failed
        let turn3 = TurnPublication::new(
            events,
            accessor(vec![entry("user", "t")], 0),
            "/tmp".into(),
            1,
            "service:c".into(),
            "desktop".into(),
            PublicationControl {
                report,
                closed: Arc::new(AtomicBool::new(false)),
            },
        );
        turn3.finish(Some("boom".into()), None).await.unwrap();
        let file_c = dir.join(format!(
            "{}.json",
            hex::encode(Sha256::digest(b"service:c"))
        ));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file_c).unwrap()).unwrap();
        assert_eq!(raw["status"], "failed");
        assert_eq!(raw["error"], "boom");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capture_text_appends_permission_notice() {
        // Direct exercise of the capture mapping (assistant|diff only + pending notice).
        let (drained, _) = watch::channel(0u64);
        let shared = Shared {
            events: Arc::new(TaskOutbox::new(test_dir())),
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
                    pending_permissions: 0,
                    non_text_blocks: 0,
                },
                pending: None,
                writer_active: false,
                ended: false,
                debounce_scheduled: false,
                last_write_error: None,
                needs_init: false,
            }),
            source_desktop: true,
        };
        TurnPublication::capture_shared(&shared);
        let s = shared.state.lock_unpoisoned();
        assert!(s.event.text.starts_with("a1\n\nd1"));
        assert_eq!(s.event.pending_permissions, 1);
        assert!(!s.event.text.contains("等待工具授权"));
    }
}
