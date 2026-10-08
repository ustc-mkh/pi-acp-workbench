//! Telegram relay: polling, per-session lanes,
//! permission tickets, topic bindings, history sync and outbox consumption.
use crate::api::{ApiError, TelegramApi};
use crate::markdown::chunks;
use crate::sessions::{SessionStub, Sessions};
use crate::stream::TelegramStream;
use crate::task_scope::{OwnedTask, TaskScope};
use pi_acp_core::turn_event::TurnEvent;
use pi_acp_core::utf16::{utf16_head, utf16_tail};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify, OnceCell, Semaphore};
use tokio_util::sync::CancellationToken;

const HANDLER_LIMIT: usize = 64;
const CONTROL_LIMIT: usize = 8;
const INBOX_LIMIT: usize = 128;
const QUEUE_LIMIT: usize = 20;
const STREAM_LIMIT: usize = 32;
const TICKET_LIMIT: usize = 128;
const TICKET_TTL_MS: u64 = 5 * 60 * 1000;
const STREAM_IDLE_MS: u64 = 5 * 60 * 1000;
const DELIVERED_KEEP: usize = 2000;
const SYNC_BATCH: usize = 20;
const HISTORY_SLICE: usize = 20;
const HISTORY_MAX: usize = 100;

mod commands;
mod delivery;
mod history;
mod inbox;
mod permissions;
mod routing;
mod state;
mod store;
mod turns;
use routing::{parse_command, InputClass};
pub use state::BridgeState;
use state::{InboxItem, InboxPhase, Topic};
use store::StateStore;

#[cfg(test)]
mod tests;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

type Report = Arc<dyn Fn(&str) + Send + Sync>;

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
    store: StateStore,
    tasks: TaskScope,
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
    handlers: Arc<Semaphore>,
    controls: Arc<Semaphore>,
    inbox_wake: Notify,
    fatal_error: Mutex<Option<String>>,
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
            username: tokio::sync::RwLock::new(String::new()),
            store: StateStore::new(opts.state_file.clone(), data),
            tasks: TaskScope::new(opts.stop.clone()),
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
            handlers: Arc::new(Semaphore::new(HANDLER_LIMIT)),
            controls: Arc::new(Semaphore::new(CONTROL_LIMIT)),
            inbox_wake: Notify::new(),
            fatal_error: Mutex::new(None),
            opts,
        });
        Bridge { shared }
    }
    async fn report(&self, error: &str) {
        (self.shared.opts.report)(error);
    }
    /// Serialized durable state writes: publish only after the write succeeds.
    async fn persist<F: FnOnce(&mut BridgeState)>(&self, update: F) -> Result<(), String> {
        self.shared.store.update(update).await
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
        if self.shared.store.read().await.offset.is_none() {
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
                .store
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
        self.shared.host.dispose().await;
        self.shared.tasks.shutdown().await;
        self.shared.streams.lock().await.clear();
        self.shared.touched.lock().await.clear();
        self.shared.tickets.lock().await.clear();
    }
}

fn trim(list: &mut Vec<String>, keep: usize) {
    if list.len() > keep {
        let drop = list.len() - keep;
        list.drain(..drop);
    }
}
