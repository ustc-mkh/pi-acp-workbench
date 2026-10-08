//! Session orchestration. Worker allocation, session operations and turns have separate modules.
//! Runtime mutexes never span an await; queue lanes serialize each session.
mod session_ops;
mod turn;
mod worker_pool;

use crate::agent::{AgentOptions, AgentProcess};
use crate::diff::WorkspaceDiff;
use crate::error::ServiceError;
use crate::history::{SessionInUseError, SharedHistoryStore};
use crate::journal::RequestJournal;
use crate::native::bind_native_forks;
use crate::outbox::{StateAccessor, TaskOutbox, TurnPublication};
use crate::phase::{Phase, Step};
use crate::prefs::{apply_preferences, model_preferences, SessionPreferences};
use crate::protocol::{
    durable_command, service_command, AgentRequest, ServiceCommand, ServiceState,
};
use crate::queue::TaskQueue;
use crate::types::{ChatState, Entry, Permission, Snapshot};
use crate::updates::{apply_update, initial_state, next_id};
use pi_acp_core::utf16::utf16_head;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use uuid::Uuid;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

type Rt = Arc<Mutex<Runtime>>;
type Report = Arc<dyn Fn(&str) + Send + Sync>;
type Broadcast = Arc<dyn Fn(Value) + Send + Sync>;
/// Non-'static boxed future so operations may borrow &self/&command.
type OpFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>;

/// Permission callback that always resolves 'cancelled' — transient workers.
fn auto_cancel_permission() -> crate::agent::PermissionCb {
    Arc::new(
        |_| -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
            Box::pin(async { json!({ "outcome": { "outcome": "cancelled" } }) })
        },
    )
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub max_workers: usize,
    pub idle_ms: u64,
}

pub struct Runtime {
    pub snapshot: Snapshot,
    pub state: ChatState,
    pub agent: Option<Arc<AgentProcess>>,
    pub phase: Phase,
    pub used: u64,
    /// permissionId → settle channel; send resolves the pending agent request.
    pub permissions: HashMap<String, oneshot::Sender<Option<String>>>,
    pub error: Option<String>,
    snapshot_pending: bool,
}

pub struct SessionService {
    /// Shared with the lease-lost callback; std Mutex, never held across await.
    runtimes: Arc<Mutex<HashMap<String, Rt>>>,
    journal: RequestJournal,
    preferences: SessionPreferences,
    queue: TaskQueue,
    store: Arc<SharedHistoryStore>,
    events: Arc<TaskOutbox>,
    config: ServiceConfig,
    broadcast: Broadcast,
    report: Report,
    closed: Arc<AtomicBool>,
    sweeping: AtomicBool,
    allocation: tokio::sync::Mutex<()>,
}

impl SessionService {
    pub fn new(
        root: &std::path::Path,
        config: ServiceConfig,
        broadcast: Broadcast,
        report: Report,
    ) -> Arc<Self> {
        let runtimes: Arc<Mutex<HashMap<String, Rt>>> = Arc::new(Mutex::new(HashMap::new()));
        let map_for_lease = runtimes.clone();
        let runtimes_field = runtimes;
        let service = Arc::new(SessionService {
            store: Arc::new(SharedHistoryStore::new(
                root.join("history"),
                Some(Arc::new(move |id: &str| {
                    // Lease compromised mid-session: fail the live runtime loudly.
                    if let Some(rt) = map_for_lease.lock().unwrap().get(id).cloned() {
                        let mut r = rt.lock().unwrap();
                        r.error = Some("会话锁失效".into());
                        if let Some(agent) = r.agent.take() {
                            agent.dispose();
                        }
                    }
                })),
            )),
            preferences: SessionPreferences::new(root.join("preferences")),
            events: Arc::new(TaskOutbox::new(root.join("telegram").join("events"))),
            journal: RequestJournal::new(root.join("service").join("requests")),
            queue: TaskQueue::new(config.max_workers, 100),
            runtimes: runtimes_field,
            config,
            broadcast,
            report,
            closed: Arc::new(AtomicBool::new(false)),
            sweeping: AtomicBool::new(false),
            allocation: tokio::sync::Mutex::new(()),
        });
        service.spawn_idle_sweep();
        service
    }

    pub async fn initialize(self: &Arc<Self>) -> Result<(), String> {
        let service = self.clone();
        self.journal
            .initialize(move |receipt| {
                let service = service.clone();
                async move {
                    let sessions = service.list().await?;
                    if let Some(snapshot) = sessions.iter().find(|s| s.id == receipt.session_id) {
                        let event = crate::outbox::TurnEvent {
                            id: format!("service:{}", receipt.id),
                            session_id: snapshot.id.clone(),
                            cwd: snapshot.cwd.clone(),
                            title: snapshot.title.clone(),
                            session_number: snapshot.session_number,
                            input_text: None,
                            text: String::new(),
                            status: "failed".into(),
                            error: receipt.error.clone(),
                            updated: now_ms(),
                            pending_permissions: 0,
                            non_text_blocks: 0,
                        };
                        let _ = service.events.write(&event).await;
                    }
                    Ok(())
                }
            })
            .await
    }

    pub async fn handle(
        &self,
        method: &str,
        params: Value,
        request_id: &str,
    ) -> Result<Value, ServiceError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(ServiceError::Stopping);
        }
        let command = service_command(method, &params)?;
        if durable_command(&command) {
            return self
                .journal
                .run(
                    request_id,
                    method,
                    &params,
                    command_session_id(&command),
                    &self.queue,
                    || self.execute(&command, request_id),
                )
                .await
                .map_err(ServiceError::from);
        }
        if matches!(
            command,
            ServiceCommand::Remove { .. }
                | ServiceCommand::HistoryWrite { .. }
                | ServiceCommand::HistoryRemove { .. }
        ) || matches!(
            &command,
            ServiceCommand::Request {
                request: AgentRequest::Inspect { .. },
                ..
            }
        ) {
            return self
                .queue
                .run(command_session_id(&command), |_check| {
                    self.execute(&command, request_id)
                })
                .await
                .map_err(ServiceError::from);
        }
        self.execute(&command, request_id)
            .await
            .map_err(ServiceError::from)
    }

    async fn execute(&self, command: &ServiceCommand, request_id: &str) -> Result<Value, String> {
        match command {
            ServiceCommand::Hello => Ok(json!({
                "protocolVersion": 1,
                "agentInfo": { "name": "pi-session-service", "title": "Pi 会话服务", "version": "1" },
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "embeddedContext": true },
                    "_meta": { "pi-workbench": { "version": 2, "inspect": true, "nativeFork": true, "history": true } },
                },
            })),
            ServiceCommand::List => Ok(json!(self.list().await?)),
            ServiceCommand::Create { cwd } => self.create(cwd).await,
            ServiceCommand::HistoryWrite { snapshot, .. } => self.history_write(snapshot).await,
            ServiceCommand::HistoryRemove { session_id } => {
                self.history_remove(session_id.as_deref()).await?;
                Ok(Value::Null)
            }
            _ => self.execute_session(command, request_id).await,
        }
    }

    pub async fn dispose(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.queue.mark_closed();
        let draining = self.queue.close();
        {
            let runtimes: Vec<Rt> = self.runtimes.lock().unwrap().values().cloned().collect();
            for rt in runtimes {
                let agent = {
                    let mut r = rt.lock().unwrap();
                    for (_, settle) in r.permissions.drain() {
                        let _ = settle.send(None);
                    }
                    r.agent.take()
                };
                if let Some(agent) = agent {
                    agent.dispose();
                }
            }
        }
        let ((), ()) = tokio::join!(draining, self.journal.drain());
        self.exclusive(|| async {
            let ids: Vec<String> = self.runtimes.lock().unwrap().keys().cloned().collect();
            for id in ids {
                // `if let` scrutinee temporaries live until the if-let ends —
                // the map guard would be held across evict().await and evict's
                // own self.runtimes.lock() would self-deadlock. Bind first.
                let rt = self.runtimes.lock().unwrap().get(&id).cloned();
                if let Some(rt) = rt {
                    self.evict(&id, &rt).await;
                }
            }
        })
        .await;
        self.store.release_all().await;
    }
}

async fn save_snapshot(store: &SharedHistoryStore, rt: &Rt) -> Result<(), String> {
    let snapshot = {
        let r = rt.lock().unwrap();
        let title = r
            .state
            .entries
            .iter()
            .find(|e| e.is("user"))
            .map(|e| utf16_head(e.text(), 70))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| r.snapshot.title.clone());
        Snapshot {
            entries: r.state.entries.clone(),
            configs: r.state.configs.clone(),
            modes: r.state.modes.clone(),
            commands: Some(r.state.commands.clone()),
            native_forks: r.state.native_forks.clone(),
            usage: r.state.usage.clone(),
            context_window: r
                .state
                .usage
                .as_ref()
                .and_then(|u| u["size"].as_u64())
                .or(r.snapshot.context_window),
            updated: now_ms(),
            title,
            ..r.snapshot.clone()
        }
    };
    let stub = store.write(&snapshot).await?;
    rt.lock().unwrap().snapshot = stub;
    Ok(())
}

/// JS truthiness for JSON values (null/false/0/"" are falsy).
fn js_truthy_value(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn command_session_id(command: &ServiceCommand) -> &str {
    match command {
        ServiceCommand::State { session_id }
        | ServiceCommand::Cancel { session_id }
        | ServiceCommand::Remove { session_id }
        | ServiceCommand::Permission { session_id, .. }
        | ServiceCommand::Prompt { session_id, .. }
        | ServiceCommand::Request { session_id, .. } => session_id,
        ServiceCommand::HistoryWrite { snapshot } => &snapshot.id,
        ServiceCommand::HistoryRemove { session_id } => session_id.as_deref().unwrap_or(""),
        _ => "",
    }
}

/// `{snapshot{+entries,configs,modes,nativeForks}, busy, permissions, commands, error?}`
fn view_state(r: &Runtime) -> Value {
    let snapshot = Snapshot {
        entries: r.state.entries.clone(),
        configs: r.state.configs.clone(),
        modes: r.state.modes.clone(),
        native_forks: r.state.native_forks.clone(),
        usage: r.state.usage.clone(),
        ..r.snapshot.clone()
    };
    serde_json::to_value(ServiceState {
        snapshot,
        busy: r.phase.busy(),
        permissions: r
            .state
            .permissions
            .iter()
            .map(|p| json!({"id":p.id, "request":p.request}))
            .collect(),
        commands: r.state.commands.clone(),
        plan: r.state.plan.clone(),
        error: r.error.clone(),
    })
    .expect("serializable service state")
}

fn view_state_with_type(r: &Runtime) -> Value {
    let mut v = view_state(r);
    v.as_object_mut()
        .unwrap()
        .insert("type".into(), json!("state"));
    v
}

async fn service_permission(
    rt: &Rt,
    request: Value,
    broadcast: Broadcast,
    closed: &AtomicBool,
) -> Value {
    let cancelled = || json!({ "outcome": { "outcome": "cancelled" } });
    let too_big = serde_json::to_vec(&request)
        .map(|v| v.len() > 256 * 1024)
        .unwrap_or(true);
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Option<String>>();
    {
        let mut r = rt.lock().unwrap();
        if closed.load(Ordering::SeqCst)
            || r.phase.at(Step::Replaying)
            || r.permissions.len() >= 32
            || too_big
        {
            return cancelled();
        }
        r.permissions.insert(id.clone(), tx);
        r.state.permissions.push(Permission {
            id: id.clone(),
            request,
        });
    }
    {
        let r = rt.lock().unwrap();
        broadcast(view_state_with_type(&r));
    }
    let outcome = tokio::time::timeout(Duration::from_secs(300), rx).await;
    let chosen = outcome.ok().and_then(|r| r.ok()).flatten();
    {
        let mut r = rt.lock().unwrap();
        r.permissions.remove(&id);
        r.state.permissions.retain(|p| p.id != id);
    }
    {
        let r = rt.lock().unwrap();
        broadcast(view_state_with_type(&r));
    }
    match chosen {
        Some(option_id) => json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        None => cancelled(),
    }
}
