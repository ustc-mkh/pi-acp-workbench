//! TelegramBridge port (src/telegram-bridge.ts): polling, per-session lanes,
//! permission tickets, topic bindings, history sync and outbox consumption.
use crate::api::{chunks, ApiError, TelegramApi};
use crate::events::TurnEvent;
use crate::sessions::{SessionStub, Sessions};
use crate::stream::TelegramStream;
use pi_acp_core::atomic::write_atomic_json;
use pi_acp_core::utf16::{utf16_head, utf16_tail};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

const HANDLER_LIMIT: usize = 64;
const QUEUE_LIMIT: usize = 20;
const STREAM_LIMIT: usize = 32;
const TICKET_LIMIT: usize = 128;
const TICKET_TTL_MS: u64 = 5 * 60 * 1000;
const STREAM_IDLE_MS: u64 = 5 * 60 * 1000;
const DELIVERED_KEEP: usize = 2000;
const SYNC_BATCH: usize = 20;
const HISTORY_SLICE: usize = 20;
const HISTORY_MAX: usize = 100;

#[cfg(test)]
mod tests;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

type Report = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub session_id: String,
    pub thread_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    pub version: u32,
    pub bot_id: i64,
    pub chat_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    pub topics: Vec<Topic>,
    pub delivered: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_sent: Option<HashMap<String, Vec<String>>>,
}

struct Ticket {
    session_id: String,
    permission_id: String,
    thread_id: i64,
    options: Vec<Option<String>>,
    expires: u64,
}

struct Lane {
    lock: Mutex<()>,
    queued: AtomicUsize,
}

pub struct Options {
    pub chat_id: i64,
    pub allowed_user_ids: Vec<i64>,
    pub stream_interval: Duration,
    pub state_file: PathBuf,
    pub report: Report,
    pub stop: CancellationToken,
}

struct Shared {
    api: Arc<TelegramApi>,
    host: Sessions,
    opts: Options,
    data: tokio::sync::RwLock<BridgeState>,
    save_lock: Mutex<()>,
    topics: Mutex<HashMap<String, Arc<OnceCell<i64>>>>,
    streams: Mutex<HashMap<String, Arc<TelegramStream>>>,
    touched: Mutex<HashMap<String, u64>>,
    tickets: Mutex<indexmap::IndexMap<String, Ticket>>,
    lanes: Mutex<HashMap<String, Arc<Lane>>>,
    generations: Mutex<HashMap<String, u64>>,
    active: Mutex<HashSet<String>>,
    consuming: Mutex<HashSet<String>>,
    syncing: Mutex<HashSet<String>>,
    syncing_all: AtomicBool,
    handling: AtomicUsize,
    /// Mirrored into every live TelegramStream; updated by persist().
    notifications_on: Arc<AtomicBool>,
    silent_on: Arc<AtomicBool>,
    username: tokio::sync::RwLock<String>,
}

#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
}

fn thread_of(update: &Value) -> Option<i64> {
    update
        .pointer("/callback_query/message/message_thread_id")
        .or_else(|| update.pointer("/message/message_thread_id"))
        .and_then(Value::as_i64)
}

impl Bridge {
    pub fn new(api: Arc<TelegramApi>, host: Sessions, data: BridgeState, opts: Options) -> Self {
        let shared = Arc::new(Shared {
            api,
            host,
            notifications_on: Arc::new(AtomicBool::new(data.notifications != Some(false))),
            silent_on: Arc::new(AtomicBool::new(data.silent == Some(true))),
            username: tokio::sync::RwLock::new(String::new()),
            data: tokio::sync::RwLock::new(data),
            save_lock: Mutex::new(()),
            topics: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            touched: Mutex::new(HashMap::new()),
            tickets: Mutex::new(indexmap::IndexMap::new()),
            lanes: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            active: Mutex::new(HashSet::new()),
            consuming: Mutex::new(HashSet::new()),
            syncing: Mutex::new(HashSet::new()),
            syncing_all: AtomicBool::new(false),
            handling: AtomicUsize::new(0),
            opts,
        });
        Bridge { shared }
    }

    async fn report(&self, error: &str) {
        (self.shared.opts.report)(error);
    }

    /// Serialized durable state writes: publish only after the write succeeds.
    async fn persist<F: FnOnce(&mut BridgeState)>(&self, update: F) -> Result<(), String> {
        let _guard = self.shared.save_lock.lock().await;
        let mut snapshot = self.shared.data.read().await.clone();
        update(&mut snapshot);
        write_atomic_json(&self.shared.opts.state_file, &snapshot, true)
            .await
            .map_err(|e| format!("无法保存 Telegram 状态：{e}"))?;
        self.shared
            .notifications_on
            .store(snapshot.notifications != Some(false), Ordering::SeqCst);
        self.shared
            .silent_on
            .store(snapshot.silent == Some(true), Ordering::SeqCst);
        *self.shared.data.write().await = snapshot;
        Ok(())
    }

    async fn send(&self, text: &str, thread_id: Option<i64>, extra: Value) -> Result<(), ApiError> {
        for chunk in chunks(text) {
            let mut params = json!({
                "chat_id": self.shared.opts.chat_id,
                "text": chunk,
                "disable_notification": self.shared.silent_on.load(Ordering::SeqCst),
            });
            if let Some(t) = thread_id {
                params["message_thread_id"] = json!(t);
            }
            if let Value::Object(extra) = &extra {
                for (k, v) in extra {
                    params[k] = v.clone();
                }
            }
            self.shared.api.call("sendMessage", params).await?;
        }
        Ok(())
    }

    async fn send_plain(&self, text: &str, thread_id: Option<i64>) -> Result<(), ApiError> {
        self.send(text, thread_id, json!({})).await
    }

    pub async fn initialize(&self, username: &str) -> Result<(), String> {
        *self.shared.username.write().await = username.to_string();
        let webhook = self
            .shared
            .api
            .call("getWebhookInfo", json!({}))
            .await
            .map_err(|e| e.message)?;
        if webhook
            .get("url")
            .and_then(Value::as_str)
            .map(|u| !u.is_empty())
            .unwrap_or(false)
        {
            return Err(
                "此 Bot 已配置 webhook，请使用独立 Bot 或先在原服务中关闭 webhook。".into(),
            );
        }
        let chat = self
            .shared
            .api
            .call("getChat", json!({ "chat_id": self.shared.opts.chat_id }))
            .await
            .map_err(|e| e.message)?;
        if chat.get("type").and_then(Value::as_str) != Some("supergroup")
            || chat.get("is_forum").and_then(Value::as_bool) != Some(true)
        {
            return Err("请使用已启用 Topics 的私人超级群组，并授予 Bot 管理话题权限。".into());
        }
        if self.shared.data.read().await.offset.is_none() {
            let updates = self
                .shared
                .api
                .call("getUpdates", json!({ "offset": -1, "limit": 1, "timeout": 0, "allowed_updates": ["message", "callback_query"] }))
                .await
                .map_err(|e| e.message)?;
            let next = updates
                .as_array()
                .and_then(|a| a.last())
                .and_then(|u| u.get("update_id"))
                .and_then(Value::as_i64)
                .map(|id| id + 1)
                .unwrap_or(0);
            self.persist(|s| s.offset = Some(next)).await?;
        }
        // Prune bindings for sessions the service no longer knows; tolerate the
        // service still starting up.
        if let Ok(sessions) = self.shared.host.list().await {
            let known: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
            if self
                .shared
                .data
                .read()
                .await
                .topics
                .iter()
                .any(|t| !known.contains(t.session_id.as_str()))
            {
                let _ = self
                    .persist(|s| s.topics.retain(|t| known.contains(t.session_id.as_str())))
                    .await;
            }
        }
        Ok(())
    }

    async fn offset(&self) -> i64 {
        self.shared.data.read().await.offset.unwrap_or(0)
    }

    pub async fn poll(&self) -> Result<(), String> {
        let mut failures = 0u32;
        while !self.shared.opts.stop.is_cancelled() {
            let updates = self
                .shared
                .api
                .call(
                    "getUpdates",
                    json!({ "offset": self.offset().await, "timeout": 25, "allowed_updates": ["message", "callback_query"] }),
                )
                .await;
            match updates {
                Err(error) => {
                    if self.shared.opts.stop.is_cancelled() {
                        return Ok(());
                    }
                    self.report(&error.message).await;
                    if matches!(error.code, 401 | 403 | 409) {
                        return Err(error.message);
                    }
                    failures += 1;
                    let backoff = Duration::from_millis(1000 * 2u64.pow(failures.min(5)))
                        .min(Duration::from_secs(30));
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = self.shared.opts.stop.cancelled() => return Ok(()),
                    }
                }
                Ok(list) => {
                    failures = 0;
                    for update in list.as_array().cloned().unwrap_or_default() {
                        if self.shared.opts.stop.is_cancelled() {
                            return Ok(());
                        }
                        let update_id = update.get("update_id").and_then(Value::as_i64);
                        let Some(update_id) = update_id else { continue };
                        if update_id < self.offset().await {
                            continue;
                        }
                        if let Err(e) = self.persist(|s| s.offset = Some(update_id + 1)).await {
                            return Err(format!(
                                "无法保存 Telegram 游标，已停止接收，避免重复执行任务。{e}"
                            ));
                        }
                        if self.shared.handling.fetch_add(1, Ordering::SeqCst) >= HANDLER_LIMIT {
                            self.shared.handling.fetch_sub(1, Ordering::SeqCst);
                            self.report("Telegram 处理队列已满，请稍后重试。").await;
                            continue;
                        }
                        let bridge = self.clone();
                        tokio::spawn(async move {
                            if let Err(error) = bridge.dispatch(&update).await {
                                bridge.report(&error).await;
                            }
                            bridge.shared.handling.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                }
            }
        }
        Ok(())
    }

    async fn ensure_topic(&self, session: &SessionStub) -> Result<i64, ApiError> {
        if let Some(saved) = self
            .shared
            .data
            .read()
            .await
            .topics
            .iter()
            .find(|t| t.session_id == session.id)
            .map(|t| t.thread_id)
        {
            return Ok(saved);
        }
        let cell = {
            let mut topics = self.shared.topics.lock().await;
            topics
                .entry(session.id.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let session_id = session.id.clone();
        let created = cell
            .get_or_try_init(|| async {
                let number = session
                    .session_number
                    .map(|n| format!("#{n}"))
                    .unwrap_or_else(|| "Pi".into());
                let name = utf16_head(
                    &format!(
                        "{number} · {}",
                        if session.title.is_empty() {
                            "新对话"
                        } else {
                            &session.title
                        }
                    ),
                    128,
                );
                let topic = self
                    .shared
                    .api
                    .call(
                        "createForumTopic",
                        json!({ "chat_id": self.shared.opts.chat_id, "name": name }),
                    )
                    .await?;
                let thread_id = topic
                    .get("message_thread_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                self.persist(|s| {
                    s.topics.push(Topic {
                        session_id,
                        thread_id,
                    })
                })
                .await
                .map_err(|e| ApiError {
                    code: 0,
                    message: e,
                })?;
                Ok(thread_id)
            })
            .await;
        let mut topics = self.shared.topics.lock().await;
        if topics
            .get(&session.id)
            .map(|c| Arc::ptr_eq(c, &cell))
            .unwrap_or(false)
        {
            topics.remove(&session.id);
        }
        created.copied()
    }

    async fn stream(&self, id: &str, thread_id: i64) -> Arc<TelegramStream> {
        self.prune().await;
        self.shared
            .touched
            .lock()
            .await
            .insert(id.to_string(), now_ms());
        let mut streams = self.shared.streams.lock().await;
        if let Some(stream) = streams.get(id) {
            return stream.clone();
        }
        if streams.len() >= STREAM_LIMIT {
            // Evict the least-recently-touched stream; HashMap has no insertion order.
            let touched = self.shared.touched.lock().await;
            if let Some(oldest) = streams
                .keys()
                .min_by_key(|id| touched.get(*id).copied().unwrap_or(0))
                .cloned()
            {
                drop(touched);
                streams.remove(&oldest);
                self.shared.touched.lock().await.remove(&oldest);
            }
        }
        let stream = Arc::new(TelegramStream::new(
            self.shared.api.clone(),
            self.shared.opts.chat_id,
            thread_id,
            self.shared.opts.stream_interval,
            self.shared.notifications_on.clone(),
            self.shared.silent_on.clone(),
            {
                let report = self.shared.opts.report.clone();
                Arc::new(move |e: &ApiError| report(&e.message))
            },
        ));
        streams.insert(id.to_string(), stream.clone());
        stream
    }

    async fn drop_stream(&self, id: &str) {
        self.shared.streams.lock().await.remove(id);
        self.shared.touched.lock().await.remove(id);
    }

    async fn prune(&self) {
        let now = now_ms();
        let touched = self.shared.touched.lock().await;
        let stale: Vec<String> = touched
            .iter()
            .filter(|(_, t)| now - **t > STREAM_IDLE_MS)
            .map(|(id, _)| id.clone())
            .collect();
        drop(touched);
        for id in stale {
            self.drop_stream(&id).await;
        }
        let mut tickets = self.shared.tickets.lock().await;
        tickets.retain(|_, t| t.expires > now);
    }

    /// Outbox consumer: returns true when the event file can be deleted.
    pub async fn consume(&self, event: &TurnEvent) -> bool {
        if self
            .shared
            .data
            .read()
            .await
            .delivered
            .iter()
            .any(|d| d == &event.id)
        {
            return true;
        }
        if self.shared.opts.stop.is_cancelled()
            || !self.shared.consuming.lock().await.insert(event.id.clone())
        {
            return false;
        }
        let result = self.consume_inner(event).await;
        self.shared.consuming.lock().await.remove(&event.id);
        result
    }

    async fn consume_inner(&self, event: &TurnEvent) -> bool {
        let sessions = match self.shared.host.list().await {
            Ok(s) => s,
            Err(_) => return false,
        };
        let Some(session) = sessions
            .iter()
            .find(|s| s.id == event.session_id && s.cwd == event.cwd)
            .cloned()
        else {
            self.drop_stream(&event.id).await;
            return false;
        };
        if !self.shared.notifications_on.load(Ordering::SeqCst) {
            self.drop_stream(&event.id).await;
            if event.status != "running" {
                let id = event.id.clone();
                if self
                    .persist(|s| {
                        s.delivered.push(id);
                        trim(&mut s.delivered, DELIVERED_KEEP);
                    })
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            return true;
        }
        let thread_id = match self.ensure_topic(&session).await {
            Ok(t) => t,
            Err(_) => return false,
        };
        let stream = self.stream(&event.id, thread_id).await;
        let text = if let Some(input) = &event.input_text {
            let body = if event.text.is_empty() && event.status == "running" {
                "正在处理…"
            } else if event.text.is_empty() {
                "本轮没有文本回复。"
            } else {
                &event.text
            };
            format!("你（VS Code）：\n{input}\n\nPi：\n{body}")
        } else {
            event.text.clone()
        };
        if event.status == "running" {
            stream
                .update(if text.is_empty() {
                    "正在处理…".into()
                } else {
                    text
                })
                .await;
            return false;
        }
        let label = match event.status.as_str() {
            "completed" => "✅ 任务完成",
            "cancelled" => "⏹ 任务已停止",
            _ => "❌ 任务失败",
        };
        let number = session
            .session_number
            .map(|n| format!(" · #{n}"))
            .unwrap_or_default();
        let suffix = event
            .error
            .as_ref()
            .map(|e| format!("\n{}", utf16_head(e, 700)))
            .unwrap_or_default();
        if let Err(error) = stream
            .finish(text, format!("{label}{number}{suffix}"))
            .await
        {
            self.drop_stream(&event.id).await;
            self.report(&error.message).await;
            return false; // durable event remains for retry
        }
        let id = event.id.clone();
        if self
            .persist(|s| {
                s.delivered.push(id);
                trim(&mut s.delivered, DELIVERED_KEEP);
            })
            .await
            .is_err()
        {
            return false;
        }
        self.drop_stream(&event.id).await;
        true
    }

    async fn dispatch(&self, update: &Value) -> Result<(), String> {
        if self.shared.opts.stop.is_cancelled() {
            return Ok(());
        }
        let callback = update.get("callback_query");
        let message = callback
            .and_then(|c| c.get("message"))
            .or_else(|| update.get("message"));
        let sender = callback
            .and_then(|c| c.get("from"))
            .or_else(|| message.and_then(|m| m.get("from")));
        let Some(message) = message else {
            return Ok(());
        };
        if message.pointer("/chat/id").and_then(Value::as_i64) != Some(self.shared.opts.chat_id) {
            return Ok(());
        }
        let Some(sender) = sender else { return Ok(()) };
        if sender.get("is_bot").and_then(Value::as_bool) == Some(true)
            || message.get("sender_chat").is_some()
            || !self
                .shared
                .opts
                .allowed_user_ids
                .contains(&sender.get("id").and_then(Value::as_i64).unwrap_or(0))
        {
            return Ok(());
        }
        let thread_id = thread_of(update);
        if let Some(callback) = callback {
            let data = callback.get("data").and_then(Value::as_str).unwrap_or("");
            let callback_id = callback
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match data {
                "notify:on" | "notify:off" => {
                    let on = data == "notify:on";
                    self.persist(|s| s.notifications = Some(on)).await?;
                    if !on {
                        self.shared.streams.lock().await.clear();
                        self.shared.touched.lock().await.clear();
                    }
                    self.answer_callback(
                        callback_id,
                        if on {
                            "已开启全部会话推送"
                        } else {
                            "已暂停全部会话推送"
                        },
                    )
                    .await;
                    return self
                        .notification_menu(thread_id)
                        .await
                        .map_err(|e| e.message);
                }
                "silent:on" | "silent:off" => {
                    let on = data == "silent:on";
                    self.persist(|s| s.silent = Some(on)).await?;
                    self.answer_callback(
                        callback_id,
                        if on {
                            "已开启静音发送"
                        } else {
                            "已关闭静音发送"
                        },
                    )
                    .await;
                    return self.silent_menu(thread_id).await.map_err(|e| e.message);
                }
                _ => {
                    self.answer_permission(callback_id, data, thread_id).await;
                    return Ok(());
                }
            }
        }
        let text = message
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            return Ok(());
        }
        let parsed = parse_command(text);
        if let Some((_, Some(bot), _)) = &parsed {
            let mine = self.shared.username.read().await.clone();
            if !bot.eq_ignore_ascii_case(&mine) {
                return Ok(());
            }
        }
        let (command, argument) = parsed
            .as_ref()
            .map(|(c, _, a)| {
                (
                    Some(c.to_lowercase()),
                    a.clone()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                )
            })
            .unwrap_or((None, None));
        let binding = self
            .shared
            .data
            .read()
            .await
            .topics
            .iter()
            .find(|t| Some(t.thread_id) == thread_id)
            .cloned();
        match self
            .dispatch_command(
                command.as_deref(),
                argument.as_deref(),
                binding.as_ref(),
                thread_id,
                &parsed,
                text,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                self.report(&error).await;
                if command.is_some() || self.shared.notifications_on.load(Ordering::SeqCst) {
                    let _ = self.send_plain(&error, thread_id).await;
                }
                Ok(())
            }
        }
    }

    async fn dispatch_command(
        &self,
        command: Option<&str>,
        argument: Option<&str>,
        binding: Option<&Topic>,
        thread_id: Option<i64>,
        parsed: &Option<(String, Option<String>, Option<String>)>,
        text: &str,
    ) -> Result<(), String> {
        match command {
            Some("start" | "help" | "commands") => self
                .send(&HELP, thread_id, json!({ "disable_notification": true }))
                .await
                .map_err(|e| e.message),
            Some("silent") => self.silent_menu(thread_id).await.map_err(|e| e.message),
            Some("notifications") => self
                .notification_menu(thread_id)
                .await
                .map_err(|e| e.message),
            Some("sync") => self.command_sync(thread_id).await,
            Some("history") => {
                let Some(binding) = binding else {
                    return Err("请先用 /open 编号进入会话话题。".into());
                };
                self.sync_history(
                    &binding.session_id,
                    thread_id.unwrap_or(0),
                    argument == Some("all"),
                )
                .await
            }
            Some("interrupt") => {
                let (Some(binding), Some(argument)) = (binding, argument) else {
                    return Err("用法：/interrupt 要发送的新消息".into());
                };
                self.bump_generation(&binding.session_id).await;
                let _ = self.shared.host.cancel(&binding.session_id).await;
                self.enqueue(&binding.session_id, binding.thread_id, argument.to_string())
                    .await
            }
            Some("stop") => {
                let stopped = if let Some(binding) = binding {
                    self.bump_generation(&binding.session_id).await;
                    self.shared
                        .host
                        .cancel(&binding.session_id)
                        .await
                        .unwrap_or(false)
                } else {
                    false
                };
                self.send_plain(
                    if stopped {
                        "正在停止本话题任务…"
                    } else {
                        "本话题没有可停止的任务。"
                    },
                    thread_id,
                )
                .await
                .map_err(|e| e.message)
            }
            Some("status") => {
                let Some(binding) = binding else {
                    return self
                        .send_plain("请用 /new 或 /open 创建会话话题。", thread_id)
                        .await
                        .map_err(|e| e.message);
                };
                let status = self
                    .shared
                    .host
                    .status(&binding.session_id)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(perms) = status.get("permissions").and_then(Value::as_array) {
                    for p in perms {
                        self.show_permission(
                            &binding.session_id,
                            thread_id.unwrap_or(0),
                            p.clone(),
                        )
                        .await;
                    }
                }
                let busy = status.get("busy").and_then(Value::as_bool).unwrap_or(false)
                    || self
                        .shared
                        .active
                        .lock()
                        .await
                        .contains(&binding.session_id);
                let queued = self
                    .shared
                    .lanes
                    .lock()
                    .await
                    .get(&binding.session_id)
                    .map(|l| l.queued.load(Ordering::SeqCst))
                    .unwrap_or(0);
                let body = utf16_tail(
                    status
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    3000,
                );
                self.send(
                    &format!(
                        "会话 {}\n{}；排队消息：{queued}\n{body}",
                        binding.session_id,
                        if busy { "正在执行" } else { "空闲" },
                    ),
                    thread_id,
                    json!({ "disable_notification": true }),
                )
                .await
                .map_err(|e| e.message)
            }
            Some("sessions") => {
                let sessions = self.shared.host.list().await.map_err(|e| e.to_string())?;
                let body = if sessions.is_empty() {
                    "暂无会话。发送 /new 创建。".to_string()
                } else {
                    sessions
                        .iter()
                        .take(50)
                        .map(|s| {
                            format!(
                                "/open {} — {}",
                                s.session_number
                                    .map(|n| n.to_string())
                                    .unwrap_or_else(|| s.id.clone()),
                                utf16_head(&s.title, 70)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                self.send_plain(&body, thread_id)
                    .await
                    .map_err(|e| e.message)
            }
            Some("new" | "open") => {
                let session = if command == Some("new") {
                    self.shared
                        .host
                        .create(argument)
                        .await
                        .map_err(|e| e.to_string())?
                } else {
                    self.shared
                        .host
                        .list()
                        .await
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .find(|s| {
                            argument
                                .map(|a| {
                                    s.session_number.map(|n| n.to_string()) == Some(a.to_string())
                                        || s.id == a
                                })
                                .unwrap_or(false)
                        })
                        .ok_or("找不到会话，请先用 /sessions 查看编号。")?
                };
                let topic = self.ensure_topic(&session).await.map_err(|e| e.message)?;
                self.send_plain(
                    &format!(
                        "会话 {} 已连接到此话题。直接发文字开始；/stop 停止任务。",
                        session
                            .session_number
                            .map(|n| format!("#{n}"))
                            .unwrap_or_else(|| session.id.clone())
                    ),
                    Some(topic),
                )
                .await
                .map_err(|e| e.message)
            }
            _ => {
                let Some(binding) = binding else {
                    return Err(
                        "此话题尚未绑定会话，请先发送 /new 或 /open 编号，再进入新话题。".into(),
                    );
                };
                let prompt = if let Some((cmd, _bot, _)) = parsed {
                    format!(
                        "/{cmd}{}",
                        argument.map(|a| format!(" {a}")).unwrap_or_default()
                    )
                } else {
                    text.to_string()
                };
                self.enqueue(&binding.session_id, binding.thread_id, prompt)
                    .await
            }
        }
    }

    async fn bump_generation(&self, session_id: &str) {
        if self.shared.lanes.lock().await.contains_key(session_id) {
            *self
                .shared
                .generations
                .lock()
                .await
                .entry(session_id.to_string())
                .or_insert(0) += 1;
        }
    }

    /// Per-session lane: queued callers run the prompt one at a time; /stop and
    /// /interrupt bump the generation so waiters drop out before starting. The
    /// lane stays mapped while the guard is held so a second prompt can never
    /// run concurrently — removal happens only under the lanes mutex when the
    /// queued count reaches zero.
    async fn enqueue(
        &self,
        session_id: &str,
        thread_id: i64,
        prompt: String,
    ) -> Result<(), String> {
        let lane = {
            let mut lanes = self.shared.lanes.lock().await;
            let lane = lanes
                .entry(session_id.to_string())
                .or_insert_with(|| {
                    Arc::new(Lane {
                        lock: Mutex::new(()),
                        queued: AtomicUsize::new(0),
                    })
                })
                .clone();
            if lane.queued.load(Ordering::SeqCst) >= QUEUE_LIMIT {
                return Err("排队消息已满，请稍后重试。".into());
            }
            lane.queued.fetch_add(1, Ordering::SeqCst);
            lane
        };
        let generation = *self
            .shared
            .generations
            .lock()
            .await
            .get(session_id)
            .unwrap_or(&0);
        let guard = lane.lock.lock().await;
        self.shared
            .active
            .lock()
            .await
            .insert(session_id.to_string());
        let result = async {
            if self.shared.opts.stop.is_cancelled()
                || generation
                    != *self
                        .shared
                        .generations
                        .lock()
                        .await
                        .get(session_id)
                        .unwrap_or(&0)
            {
                return Ok(());
            }
            let run = self.shared.host.run(session_id, prompt);
            let session = session_id.to_string();
            let thread = thread_id;
            let bridge = self.clone();
            let mut permissions = run.permissions;
            let forward = tokio::spawn(async move {
                while let Some(p) = permissions.recv().await {
                    if bridge.shared.notifications_on.load(Ordering::SeqCst) {
                        bridge.show_permission(&session, thread, p).await;
                    }
                }
            });
            let outcome = run
                .result
                .await
                .map_err(|_| "会话任务异常结束".to_string())?;
            forward.abort();
            outcome.map(|_| ()).map_err(|e| e.to_string())
        }
        .await;
        self.shared.active.lock().await.remove(session_id);
        {
            let mut tickets = self.shared.tickets.lock().await;
            tickets.retain(|_, t| t.session_id != session_id);
        }
        {
            let mut lanes = self.shared.lanes.lock().await;
            if lane.queued.fetch_sub(1, Ordering::SeqCst) == 1
                && lanes
                    .get(session_id)
                    .map(|l| Arc::ptr_eq(l, &lane))
                    .unwrap_or(false)
            {
                lanes.remove(session_id);
                self.shared.generations.lock().await.remove(session_id);
            }
        }
        drop(guard);
        result
    }

    async fn command_sync(&self, thread_id: Option<i64>) -> Result<(), String> {
        if self.shared.syncing_all.swap(true, Ordering::SeqCst) {
            return self
                .send(
                    "历史同步正在进行，请稍候。",
                    thread_id,
                    json!({ "disable_notification": true }),
                )
                .await
                .map_err(|e| e.message);
        }
        let result = async {
            let sessions = self.shared.host.list().await.map_err(|e| e.to_string())?;
            let mut processed = 0usize;
            let mut created = 0usize;
            for session in &sessions {
                if self.shared.opts.stop.is_cancelled() {
                    break;
                }
                let bound = self
                    .shared
                    .data
                    .read()
                    .await
                    .topics
                    .iter()
                    .any(|t| t.session_id == session.id);
                if bound && self.pending_history(&session.id, true).await?.is_empty() {
                    continue;
                }
                let topic = self.ensure_topic(session).await.map_err(|e| e.message)?;
                if !bound {
                    created += 1;
                }
                self.sync_history(&session.id, topic, true).await?;
                processed += 1;
                if processed >= SYNC_BATCH {
                    break;
                }
            }
            self.send(
                &format!("已同步 {processed} 个会话，其中新建 {created} 个话题。每次最多 20 个会话、每个会话 100 条文字消息；再次 /sync 会跳过已同步内容并继续，无需另发 /history。"),
                thread_id,
                json!({ "disable_notification": true }),
            )
            .await
            .map_err(|e| e.message)
        }
        .await;
        self.shared.syncing_all.store(false, Ordering::SeqCst);
        result
    }

    /// History entries not yet sent, oldest first: user/assistant/diff roles with
    /// a sha256 dedup key over `entry.id + '\0' + entry.text`.
    async fn pending_history(
        &self,
        session_id: &str,
        all: bool,
    ) -> Result<Vec<(String, String)>, String> {
        let entries: Vec<Value> = self
            .shared
            .host
            .history(session_id)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|e| {
                matches!(
                    e.get("role").and_then(Value::as_str),
                    Some("user" | "assistant" | "diff")
                )
            })
            .collect();
        let sent: Vec<String> = self
            .shared
            .data
            .read()
            .await
            .history_sent
            .as_ref()
            .and_then(|h| h.get(session_id))
            .cloned()
            .unwrap_or_default();
        let sliced = if all {
            entries
        } else {
            entries
                .into_iter()
                .rev()
                .take(HISTORY_SLICE)
                .rev()
                .collect()
        };
        Ok(sliced
            .into_iter()
            .filter_map(|e| {
                let role = e.get("role").and_then(Value::as_str)?;
                let text = e.get("text").and_then(Value::as_str).unwrap_or_default();
                let key = hex::encode(Sha256::digest(
                    format!(
                        "{}\0{text}",
                        e.get("id").and_then(Value::as_str).unwrap_or_default()
                    )
                    .as_bytes(),
                ));
                let who = if role == "user" {
                    "你"
                } else if role == "diff" {
                    "修改汇总"
                } else {
                    "Pi"
                };
                Some((key, format!("{who}：\n{text}")))
            })
            .filter(|(key, _)| !sent.contains(key))
            .take(HISTORY_MAX)
            .collect())
    }

    async fn sync_history(
        &self,
        session_id: &str,
        thread_id: i64,
        all: bool,
    ) -> Result<(), String> {
        if !self
            .shared
            .syncing
            .lock()
            .await
            .insert(session_id.to_string())
        {
            return Err("此话题正在同步历史。".into());
        }
        let result = async {
            let selected = self.pending_history(session_id, all).await?;
            for (key, body) in &selected {
                self.send(
                    body,
                    Some(thread_id),
                    json!({ "disable_notification": true }),
                )
                .await
                .map_err(|e| e.message)?;
                let key = key.clone();
                let sid = session_id.to_string();
                self.persist(|s| {
                    s.history_sent
                        .get_or_insert_with(HashMap::new)
                        .entry(sid)
                        .or_default()
                        .push(key);
                })
                .await?;
            }
            self.send(
                &format!(
                    "已同步 {} 条历史消息。{}",
                    selected.len(),
                    if selected.len() == HISTORY_MAX {
                        "可再次 /history all 继续。"
                    } else {
                        ""
                    }
                ),
                Some(thread_id),
                json!({ "disable_notification": true }),
            )
            .await
            .map_err(|e| e.message)
        }
        .await;
        self.shared.syncing.lock().await.remove(session_id);
        result
    }

    async fn show_permission(&self, session_id: &str, thread_id: i64, permission: Value) {
        let permission_id = permission
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let options: Vec<Value> = permission
            .pointer("/request/options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let key = {
            let mut tickets = self.shared.tickets.lock().await;
            let now = now_ms();
            tickets.retain(|_, t| t.expires > now);
            let mut opts: Vec<Option<String>> = options
                .iter()
                .filter_map(|o| {
                    o.get("optionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .map(Some)
                .collect();
            opts.push(None);
            let existing = tickets
                .iter()
                .find(|(_, t)| {
                    t.session_id == session_id
                        && t.permission_id == permission_id
                        && t.thread_id == thread_id
                })
                .map(|(k, _)| k.clone());
            if let Some(k) = existing {
                // Refresh the option list on the same ticket, keeping its expiry.
                if let Some(ticket) = tickets.get_mut(&k) {
                    ticket.options = opts;
                }
                k
            } else {
                let key = hex::encode(&uuid::Uuid::new_v4().as_bytes()[..10]);
                if tickets.len() >= TICKET_LIMIT {
                    tickets.shift_remove_index(0);
                }
                tickets.insert(
                    key.clone(),
                    Ticket {
                        session_id: session_id.to_string(),
                        permission_id,
                        thread_id,
                        options: opts,
                        expires: now + TICKET_TTL_MS,
                    },
                );
                key
            }
        };
        let mut keyboard: Vec<Value> = options
            .iter()
            .enumerate()
            .map(|(i, o)| {
                json!([{ "text": utf16_head(o.get("name").and_then(Value::as_str).unwrap_or("允许"), 60), "callback_data": format!("p:{key}:{i}") }])
            })
            .collect();
        let cancel_index = options.len();
        keyboard
            .push(json!([{ "text": "取消", "callback_data": format!("p:{key}:{cancel_index}") }]));
        let title = permission
            .pointer("/request/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("工具操作");
        let detail = utf16_head(
            &serde_json::to_string_pretty(
                permission
                    .pointer("/request/toolCall")
                    .unwrap_or(&Value::Null),
            )
            .unwrap_or_default(),
            2600,
        );
        if let Err(e) = self
            .send(
                &format!("需要授权：{title}\n{detail}"),
                Some(thread_id),
                json!({ "reply_markup": { "inline_keyboard": keyboard } }),
            )
            .await
        {
            self.report(&e.message).await;
        }
    }

    async fn answer_permission(&self, callback_id: &str, data: &str, thread_id: Option<i64>) {
        let accepted = async {
            let parts: Vec<&str> = data.split(':').collect();
            if parts.len() != 3 || parts[0] != "p" || parts[1].len() != 20 {
                return false;
            }
            let index: usize = match parts[2].parse() {
                Ok(i) => i,
                Err(_) => return false,
            };
            let ticket = {
                let tickets = self.shared.tickets.lock().await;
                tickets.get(parts[1]).and_then(|t| {
                    (Some(t.thread_id) == thread_id
                        && t.expires > now_ms()
                        && index < t.options.len())
                    .then(|| {
                        (
                            t.session_id.clone(),
                            t.permission_id.clone(),
                            t.options[index].clone(),
                        )
                    })
                })
            };
            let Some((session_id, permission_id, option)) = ticket else {
                return false;
            };
            match self
                .shared
                .host
                .permission(&session_id, &permission_id, option.as_deref())
                .await
            {
                Ok(true) => {
                    self.shared.tickets.lock().await.shift_remove(parts[1]);
                    true
                }
                _ => false,
            }
        }
        .await;
        self.answer_callback(
            callback_id,
            if accepted {
                "已提交"
            } else {
                "授权已失效或不属于此话题。"
            },
        )
        .await;
    }

    async fn answer_callback(&self, callback_id: &str, text: &str) {
        let _ = self
            .shared
            .api
            .call(
                "answerCallbackQuery",
                json!({ "callback_query_id": callback_id, "text": text }),
            )
            .await;
    }

    async fn notification_menu(&self, thread_id: Option<i64>) -> Result<(), ApiError> {
        let on = self.shared.notifications_on.load(Ordering::SeqCst);
        self.send(
            &format!(
                "全部会话自动推送（默认开启）：{}。关闭时不发送自动回复、完成通知或授权卡片；可用 /history、/status 主动查看。",
                if on { "开启" } else { "关闭" }
            ),
            thread_id,
            json!({
                "disable_notification": true,
                "reply_markup": { "inline_keyboard": [[{ "text": if on { "暂停全部推送" } else { "开启全部推送" }, "callback_data": if on { "notify:off" } else { "notify:on" } }]] },
            }),
        )
        .await
    }

    async fn silent_menu(&self, thread_id: Option<i64>) -> Result<(), ApiError> {
        let on = self.shared.silent_on.load(Ordering::SeqCst);
        self.send(
            &format!("静音发送：{}（默认关闭）。静音不阻止消息投递，仅关闭通知声音；手机仍可能显示无声通知。自动投递总开关由 /notifications 控制。", if on { "开启" } else { "关闭" }),
            thread_id,
            json!({
                "disable_notification": true,
                "reply_markup": { "inline_keyboard": [[{ "text": if on { "关闭静音" } else { "开启静音" }, "callback_data": if on { "silent:off" } else { "silent:on" } }]] },
            }),
        )
        .await
    }

    /// Periodic cleanup equivalent to the 30s maintenance timer.
    pub async fn maintenance(&self) {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await; // skip immediate first tick
        loop {
            tokio::select! {
                _ = interval.tick() => self.prune().await,
                _ = self.shared.opts.stop.cancelled() => return,
            }
        }
    }

    pub async fn dispose(&self) {
        self.shared.opts.stop.cancel();
        self.shared.streams.lock().await.clear();
        self.shared.touched.lock().await.clear();
        self.shared.tickets.lock().await.clear();
        self.shared.host.dispose().await;
    }
}

fn trim(list: &mut Vec<String>, keep: usize) {
    if list.len() > keep {
        let drop = list.len() - keep;
        list.drain(..drop);
    }
}

/// `/cmd@bot args` — same shape as the TS regex `^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$`.
fn parse_command(text: &str) -> Option<(String, Option<String>, Option<String>)> {
    let body = text.strip_prefix('/')?;
    let (head, argument) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], Some(body[i..].trim_start().to_string())),
        None => (body, None),
    };
    let (command, bot) = match head.find('@') {
        Some(i) => (&head[..i], Some(head[i + 1..].to_string())),
        None => (head, None),
    };
    if command.is_empty()
        || !command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    if let Some(b) = &bot {
        if b.is_empty() || !b.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
    }
    Some((command.to_string(), bot, argument))
}

const HELP: &str = "会话与历史
/new 绝对路径或工作区名 — 新建会话及话题；仅一个别名时可省略参数
/sessions — 列出最近 50 个 Pi 会话
/open 编号或 Session ID — 打开已有会话话题
/sync — 自动建立话题并同步未导出的文字历史；大批量时重复执行继续
/history — 补充本话题最近 20 条文字历史
/history all — 补充本话题完整文字历史，每次最多 100 条

任务控制
/status — 查看本话题状态、当前回复和待授权操作
/stop — 停止本话题任务并取消排队消息
/interrupt 新消息 — 停止当前任务后发送新指令
/notifications — 自动投递总开关（默认开启）；关闭后暂停自动回复和授权卡片
/silent — 静音发送开关（默认关闭）；保留消息，仅关闭通知声音

帮助
/help 或 /commands — 显示全部服务命令
/start — 显示本帮助

在会话话题直接发文字即可对话。其他命令（如 /compact）原样转交 Pi；可用命令取决于 Pi 配置。";
