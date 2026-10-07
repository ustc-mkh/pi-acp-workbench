//! SessionService port (src/session-service.ts) — worker/session orchestration.
//! Runtime locks are std::sync::Mutex and are NEVER held across .await; session
//! serialization comes from TaskQueue lanes + the busy flag, exactly like TS.
use crate::agent::{AgentOptions, AgentProcess};
use crate::diff::WorkspaceDiff;
use crate::history::{SessionInUseError, SharedHistoryStore};
use crate::journal::RequestJournal;
use crate::native::bind_native_forks;
use crate::outbox::{DesktopTelegramTurn, StateAccessor, TelegramEvents};
use crate::prefs::{apply_preferences, model_preferences, SessionPreferences};
use crate::protocol::{durable_command, service_command, ServiceCommand};
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
    pub busy: bool,
    pub cancelled: bool,
    pub prompting: bool,
    pub used: u64,
    pub replay: bool,
    /// permissionId → settle channel; send resolves the pending agent request.
    pub permissions: HashMap<String, oneshot::Sender<Option<String>>>,
    pub publication: Option<DesktopTelegramTurn>,
    pub cancel_task: Option<tokio::task::JoinHandle<()>>,
    pub error: Option<String>,
}

pub struct SessionService {
    /// Shared with the lease-lost callback; std Mutex, never held across await.
    runtimes: Arc<Mutex<HashMap<String, Rt>>>,
    journal: RequestJournal,
    preferences: SessionPreferences,
    queue: TaskQueue,
    store: Arc<SharedHistoryStore>,
    events: Arc<TelegramEvents>,
    config: ServiceConfig,
    broadcast: Broadcast,
    report: Report,
    closed: Arc<AtomicBool>,
    sweeping: AtomicBool,
    /// TS `exclusive()` — serializes runtime allocation/eviction.
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
            events: Arc::new(TelegramEvents::new(root.join("telegram").join("events"))),
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

    fn spawn_idle_sweep(self: &Arc<Self>) {
        let service = self.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(service.config.idle_ms.min(30_000)));
            interval.tick().await; // skip immediate tick
            loop {
                interval.tick().await;
                if service.closed.load(Ordering::SeqCst) {
                    return;
                }
                if service.sweeping.swap(true, Ordering::SeqCst) {
                    continue;
                }
                let idle: Vec<(String, Rt)> = {
                    let map = service.runtimes.lock().unwrap();
                    map.iter()
                        .filter(|(_, r)| {
                            let r = r.lock().unwrap();
                            !r.busy && now_ms().saturating_sub(r.used) >= service.config.idle_ms
                        })
                        .map(|(id, r)| (id.clone(), r.clone()))
                        .collect()
                };
                {
                    let _guard = service.allocation.lock().await;
                    for (id, rt) in idle {
                        if !rt.lock().unwrap().busy {
                            service.evict(&id, &rt).await;
                        }
                    }
                }
                service.sweeping.store(false, Ordering::SeqCst);
            }
        });
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
                        };
                        let _ = service.events.write(&event).await;
                    }
                    Ok(())
                }
            })
            .await
    }

    async fn exclusive<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = self.allocation.lock().await;
        f().await
    }

    async fn evict(&self, id: &str, rt: &Rt) {
        let agent = rt.lock().unwrap().agent.take();
        if let Some(agent) = agent {
            agent.stop().await;
        }
        self.runtimes.lock().unwrap().remove(id);
        self.store.release(id).await;
    }

    async fn make_room(&self) -> Result<(), String> {
        if self.runtimes.lock().unwrap().len() < self.config.max_workers {
            return Ok(());
        }
        let idle = {
            let map = self.runtimes.lock().unwrap();
            map.iter()
                .filter(|(_, r)| !r.lock().unwrap().busy)
                .min_by_key(|(_, r)| r.lock().unwrap().used)
                .map(|(id, rt)| (id.clone(), rt.clone()))
        };
        let Some((id, rt)) = idle else {
            return Err("工作进程均忙碌".into());
        };
        self.evict(&id, &rt).await;
        Ok(())
    }

    fn agent_env(&self) -> HashMap<String, String> {
        let mut env = self.config.env.clone();
        env.insert("PI_TELEGRAM_BOT_TOKEN".into(), String::new());
        env
    }

    /// spawn() for a live runtime — update/permission/closed callbacks wired to it.
    fn spawn_agent(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
        let weak = Arc::downgrade(rt);
        let broadcast = self.broadcast.clone();
        let report = self.report.clone();
        let cwd = rt.lock().unwrap().snapshot.cwd.clone();
        let options = AgentOptions {
            cwd,
            command: self.config.command.clone(),
            args: self.config.args.clone(),
            env: self.agent_env(),
            update: {
                let rt = weak.clone();
                let broadcast = broadcast.clone();
                Arc::new(move |notification: Value| {
                    let Some(rt) = rt.upgrade() else { return };
                    let event = {
                        let mut r = rt.lock().unwrap();
                        if notification.get("sessionId").and_then(Value::as_str)
                            != Some(r.snapshot.id.as_str())
                        {
                            return;
                        }
                        if r.replay {
                            // During session/load replay only commands are accepted;
                            // the persisted transcript stays authoritative.
                            if notification
                                .pointer("/update/sessionUpdate")
                                .and_then(Value::as_str)
                                == Some("available_commands_update")
                            {
                                r.state.commands = notification
                                    .pointer("/update/availableCommands")
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default();
                            }
                            return;
                        }
                        let update = notification.get("update").cloned().unwrap_or(Value::Null);
                        apply_update(&mut r.state, &update, false);
                        if let Some(publication) = &r.publication {
                            publication.update();
                        }
                        json!({ "type": "update", "notification": notification })
                    };
                    broadcast(event);
                })
            },
            permission: {
                let rt = weak.clone();
                let broadcast = broadcast.clone();
                let closed = self.closed.clone();
                Arc::new(move |request: Value| {
                    let rt = rt.clone();
                    let broadcast = broadcast.clone();
                    let closed = closed.clone();
                    Box::pin(async move {
                        let Some(rt) = rt.upgrade() else {
                            return json!({ "outcome": { "outcome": "cancelled" } });
                        };
                        service_permission(&rt, request, broadcast, &closed).await
                    })
                        as std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>>
                })
            },
            log: report.clone(),
            closed: {
                let broadcast = broadcast.clone();
                Arc::new(move |error: String| {
                    let Some(rt) = weak.upgrade() else { return };
                    let event = {
                        let mut r = rt.lock().unwrap();
                        r.error = Some(error);
                        view_state_with_type(&r)
                    };
                    broadcast(event);
                })
            },
            request_timeout: Duration::from_secs(30),
        };
        Ok(Arc::new(AgentProcess::spawn(options)?))
    }

    /// Disposable worker for create()/saveFork() — replaying updates into an
    /// owned initial state; permissions auto-cancelled.
    fn spawn_transient(
        &self,
        cwd: &str,
        state: Arc<Mutex<ChatState>>,
    ) -> Result<Arc<AgentProcess>, String> {
        let report = self.report.clone();
        Ok(Arc::new(AgentProcess::spawn(AgentOptions {
            cwd: cwd.to_string(),
            command: self.config.command.clone(),
            args: self.config.args.clone(),
            env: self.agent_env(),
            update: Arc::new(move |n| {
                apply_update(
                    &mut state.lock().unwrap(),
                    &n.get("update").cloned().unwrap_or(Value::Null),
                    true,
                )
            }),
            permission: auto_cancel_permission(),
            log: report,
            closed: Arc::new(|_| {}),
            request_timeout: Duration::from_secs(30),
        })?))
    }

    /// TS list(): only harness 'pi'.
    pub async fn list(&self) -> Result<Vec<Snapshot>, String> {
        Ok(self
            .store
            .list()
            .await?
            .into_iter()
            .filter(|s| s.harness.as_deref() == Some("pi"))
            .collect())
    }

    async fn index(&self, id: &str) -> Result<Snapshot, String> {
        self.list()
            .await?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "会话不存在".to_string())
    }

    async fn runtime(&self, id: &str) -> Result<Rt, String> {
        let _guard = self.allocation.lock().await;
        if let Some(rt) = self.runtimes.lock().unwrap().get(id).cloned() {
            {
                let mut r = rt.lock().unwrap();
                r.busy = true;
                r.cancelled = false;
            }
            return Ok(rt);
        }
        self.make_room().await?;
        let index = self.index(id).await?;
        self.store.claim(id).await?;
        match self.store.read(&index).await {
            Ok(snapshot) => {
                let mut state = initial_state();
                state.entries = snapshot.entries.clone();
                state.configs = snapshot.configs.clone();
                state.modes = snapshot.modes.clone();
                state.native_forks = snapshot.native_forks.clone();
                state.commands = snapshot.commands.clone().unwrap_or_default();
                let rt = Arc::new(Mutex::new(Runtime {
                    snapshot: Snapshot {
                        entries: vec![],
                        ..snapshot
                    },
                    state,
                    agent: None,
                    busy: true,
                    cancelled: false,
                    prompting: false,
                    used: now_ms(),
                    replay: false,
                    permissions: HashMap::new(),
                    publication: None,
                    cancel_task: None,
                    error: None,
                }));
                self.runtimes
                    .lock()
                    .unwrap()
                    .insert(id.to_string(), rt.clone());
                Ok(rt)
            }
            Err(e) => {
                self.store.release(id).await;
                Err(e)
            }
        }
    }

    async fn worker(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
        if let Some(agent) = rt.lock().unwrap().agent.clone() {
            if !agent.is_closed() {
                return Ok(agent);
            }
        }
        {
            let old = rt.lock().unwrap().agent.take();
            if let Some(old) = old {
                old.stop().await;
            }
            rt.lock().unwrap().replay = true;
        }
        let session_id = rt.lock().unwrap().snapshot.id.clone();
        let agent = self.spawn_agent(rt)?;
        rt.lock().unwrap().agent = Some(agent.clone());
        let started = async {
            agent.initialize().await?;
            let mut session = agent.create_session(Some(&session_id)).await?;
            let prefs = model_preferences(&rt.lock().unwrap().state);
            if let Some(warning) = apply_preferences(agent.as_ref(), &mut session, &prefs).await? {
                rt.lock().unwrap().state.entries.push(Entry::text_entry(
                    next_id(),
                    "notice",
                    warning,
                ));
            }
            let mut r = rt.lock().unwrap();
            if let Some(configs) = session
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
            {
                r.state.configs = Some(configs);
            }
            // TS: `r.state.modes = session.modes || r.state.modes` — a falsy
            // modes (null/false/0/"") keeps the previous value.
            if session.get("modes").is_some_and(js_truthy_value) {
                r.state.modes = session.get("modes").cloned();
            }
            r.replay = false;
            Ok(())
        }
        .await;
        match started {
            Ok(()) => Ok(agent),
            Err(e) => {
                agent.dispose();
                Err(e)
            }
        }
    }

    /// TS state(): live view or cold snapshot read + interrupted marker.
    pub async fn state(&self, id: &str) -> Result<Value, String> {
        let index = self.index(id).await?;
        if let Some(rt) = self.runtimes.lock().unwrap().get(id).cloned() {
            return Ok(view_state(&rt.lock().unwrap()));
        }
        let snapshot = self.store.read(&index).await?;
        let interrupted = self
            .journal
            .last(id)
            .await?
            .map(|r| r.status == "interrupted")
            .unwrap_or(false);
        let mut out = json!({
            "snapshot": snapshot,
            "busy": false,
            "permissions": [],
            "commands": snapshot.commands.clone().unwrap_or_default(),
        });
        if interrupted {
            out["error"] = json!("上次任务被服务中断，未自动重放。");
        }
        Ok(out)
    }

    /// TS handle(): validation → durability → queueing decision (once).
    pub async fn handle(
        &self,
        method: &str,
        params: Value,
        request_id: &str,
    ) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("会话服务正在停止".into());
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
                .await;
        }
        if matches!(
            command,
            ServiceCommand::Remove { .. }
                | ServiceCommand::HistoryWrite { .. }
                | ServiceCommand::HistoryRemove { .. }
        ) || matches!(&command, ServiceCommand::Request { method, .. } if method == "_pi_workbench/inspect")
        {
            return self
                .queue
                .run(command_session_id(&command), |_check| {
                    self.execute(&command, request_id)
                })
                .await;
        }
        self.execute(&command, request_id).await
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

    async fn execute_session(
        &self,
        command: &ServiceCommand,
        request_id: &str,
    ) -> Result<Value, String> {
        let id = command_session_id(command);
        self.index(id).await?;
        match command {
            ServiceCommand::State { .. } => self.state(id).await,
            ServiceCommand::Permission {
                permission_id,
                option_id,
                ..
            } => {
                let rt = self.runtimes.lock().unwrap().get(id).cloned();
                let Some(rt) = rt else {
                    return Ok(Value::Bool(false));
                };
                let sender = {
                    let mut r = rt.lock().unwrap();
                    let ticket = r.state.permissions.iter().find(|p| &p.id == permission_id);
                    let valid = match (ticket, option_id) {
                        (None, _) => false,
                        (Some(t), Some(opt)) => t
                            .request
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|opts| {
                                opts.iter()
                                    .any(|o| o.get("optionId").and_then(Value::as_str) == Some(opt))
                            })
                            .unwrap_or(false),
                        (Some(_), None) => true,
                    };
                    if valid {
                        r.permissions.remove(permission_id)
                    } else {
                        None
                    }
                };
                match sender {
                    Some(tx) => {
                        let _ = tx.send(option_id.clone());
                        Ok(Value::Bool(true))
                    }
                    None => Ok(Value::Bool(false)),
                }
            }
            ServiceCommand::Cancel { .. } => Ok(Value::Bool(self.cancel(id).await)),
            ServiceCommand::Remove { .. } => {
                self.exclusive(|| async {
                    let rt = self.runtimes.lock().unwrap().get(id).cloned();
                    if let Some(rt) = rt {
                        self.evict(id, &rt).await;
                    }
                })
                .await;
                self.store.remove(id).await?;
                Ok(Value::Null)
            }
            ServiceCommand::Request { method, params, .. }
                if method == "_pi_workbench/cancel_fork" =>
            {
                let agent = self
                    .runtimes
                    .lock()
                    .unwrap()
                    .get(id)
                    .and_then(|rt| rt.lock().unwrap().agent.clone());
                match agent {
                    // TS forwards only {sessionId:id} — client params dropped.
                    Some(agent) => agent.request(method, json!({ "sessionId": id })).await,
                    None => Ok(json!({})),
                }
            }
            ServiceCommand::Request { method, params, .. }
                if method == "_pi_workbench/inspect"
                    && !params
                        .get("force")
                        .and_then(Value::as_bool)
                        .unwrap_or(false) =>
            {
                let has_agent = self
                    .runtimes
                    .lock()
                    .unwrap()
                    .get(id)
                    .is_some_and(|rt| rt.lock().unwrap().agent.is_some());
                if !has_agent {
                    let state = self.state(id).await?;
                    return Ok(json!({
                        "records": [],
                        "contextWindow": state.pointer("/snapshot/contextWindow").cloned().unwrap_or(Value::Null),
                    }));
                }
                self.with_worker(id, |rt, agent| {
                    self.run_command(rt, agent, command, request_id)
                })
                .await
            }
            ServiceCommand::Prompt { .. } | ServiceCommand::Request { .. } => {
                self.with_worker(id, |rt, agent| {
                    self.run_command(rt, agent, command, request_id)
                })
                .await
            }
            _ => Err("无效服务操作".into()),
        }
    }

    async fn with_worker<'a, F>(&'a self, id: &'a str, operation: F) -> Result<Value, String>
    where
        F: FnOnce(Rt, Arc<AgentProcess>) -> OpFuture<'a>,
    {
        let rt = self.runtime(id).await?;
        let result: Result<Value, String> = async {
            let agent = self.worker(&rt).await?;
            rt.lock().unwrap().error = None;
            if rt.lock().unwrap().cancelled || self.closed.load(Ordering::SeqCst) {
                return Ok(json!({ "stopReason": "cancelled" }));
            }
            operation(rt.clone(), agent).await
        }
        .await;
        if let Err(error) = &result {
            let publication = {
                let mut r = rt.lock().unwrap();
                r.error = Some(error.clone());
                r.publication.take()
            };
            if let Some(publication) = publication {
                let _ = publication.finish(Some(error.clone()), None).await;
            }
        }
        {
            let mut r = rt.lock().unwrap();
            r.prompting = false;
            if let Some(task) = r.cancel_task.take() {
                task.abort();
            }
            for (_, settle) in r.permissions.drain() {
                let _ = settle.send(None);
            }
            r.busy = false;
            r.used = now_ms();
        }
        self.emit(&rt);
        result
    }

    fn run_command<'a>(
        &'a self,
        rt: Rt,
        agent: Arc<AgentProcess>,
        command: &'a ServiceCommand,
        request_id: &'a str,
    ) -> OpFuture<'a> {
        Box::pin(async move {
            match command {
                ServiceCommand::Prompt {
                    session_id,
                    prompt,
                    source,
                } => {
                    self.prompt(&rt, &agent, session_id, prompt, source, request_id)
                        .await
                }
                ServiceCommand::Request { .. } => self.agent_request(&rt, &agent, command).await,
                _ => unreachable!(),
            }
        })
    }

    async fn agent_request(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        command: &ServiceCommand,
    ) -> Result<Value, String> {
        let ServiceCommand::Request {
            method,
            params,
            session_id,
        } = command
        else {
            unreachable!()
        };
        let mut outgoing = params.clone();
        outgoing["sessionId"] = json!(session_id);
        let timeout = if method == "_pi_workbench/fork" {
            180_000
        } else {
            30_000
        };
        if method == "_pi_workbench/fork" {
            let wanted_entry = params.get("entryId").and_then(Value::as_str);
            let wanted_hash = params.get("hash").and_then(Value::as_str);
            let index = {
                let r = rt.lock().unwrap();
                r.state.entries.iter().position(|entry| {
                    r.state
                        .native_forks
                        .as_ref()
                        .and_then(|m| m.get(&entry.id))
                        .is_some_and(|p| {
                            Some(p.entry_id.as_str()) == wanted_entry
                                && Some(p.hash.as_str()) == wanted_hash
                        })
                })
            };
            let Some(index) = index else {
                return Err("原生分支位置无法匹配".into());
            };
            let result = agent
                .with_timeout(agent.request(method, outgoing), timeout)
                .await?;
            let new_id = result
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            self.save_fork(rt, agent, new_id, index).await?;
            self.save(rt).await?;
            return Ok(result);
        }
        let result = agent
            .with_timeout(agent.request(method, outgoing), timeout)
            .await?;
        if method == "_pi_workbench/inspect" {
            let points: Vec<crate::native::NativeForkPoint> =
                serde_json::from_value(result.get("forkPoints").cloned().unwrap_or(json!([])))
                    .unwrap_or_default();
            let mut r = rt.lock().unwrap();
            r.state.native_forks = Some(bind_native_forks(
                &r.state.entries,
                &points,
                &r.state.native_forks.clone().unwrap_or_default(),
            ));
            if let Some(cw) = result.get("contextWindow").and_then(Value::as_u64) {
                r.snapshot.context_window = Some(cw);
            }
        }
        if method == "session/set_config_option" {
            rt.lock().unwrap().state.configs = result
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned();
        }
        if method == "session/set_mode" {
            if let Some(modes) = &mut rt.lock().unwrap().state.modes {
                if let Some(mode_id) = params.get("modeId").cloned() {
                    modes["currentModeId"] = mode_id;
                }
            }
        }
        self.save(rt).await?;
        if matches!(
            method.as_str(),
            "session/set_config_option" | "session/set_mode"
        ) {
            let state = rt.lock().unwrap().state.clone();
            self.preferences.save("pi", &state).await?;
        }
        Ok(result)
    }

    async fn save_fork(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        new_id: String,
        index: usize,
    ) -> Result<(), String> {
        let mut snapshot = {
            let r = rt.lock().unwrap();
            Snapshot {
                entries: r.state.entries[..=index].to_vec(),
                native_forks: None,
                session_number: None,
                revision: None,
                id: new_id.clone(),
                conversation_id: Some(new_id.clone()),
                ..r.snapshot.clone()
            }
        };
        agent.stop().await;
        rt.lock().unwrap().agent = None;
        let transient_state = Arc::new(Mutex::new(initial_state()));
        let fork = self.spawn_transient(&snapshot.cwd, transient_state)?;
        let settings = async {
            fork.initialize().await?;
            fork.create_session(Some(&new_id)).await
        }
        .await;
        fork.stop().await;
        let settings = settings?;
        snapshot.configs = settings
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned();
        snapshot.modes = settings.get("modes").cloned();
        snapshot.title = snapshot
            .entries
            .iter()
            .find(|e| e.is("user"))
            .map(|e| utf16_head(e.text(), 70))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "新分支".into());
        self.store.claim(&new_id).await?;
        let written = self.store.write(&snapshot).await;
        self.store.release(&new_id).await;
        written.map(|_| ())
    }

    async fn prompt(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        session_id: &str,
        prompt: &[Value],
        source: &str,
        request_id: &str,
    ) -> Result<Value, String> {
        let image_capable = agent
            .info()
            .await
            .and_then(|i| {
                i.pointer("/agentCapabilities/promptCapabilities/image")
                    .and_then(Value::as_bool)
            })
            .unwrap_or(false);
        if prompt
            .iter()
            .any(|b| b.get("type").and_then(Value::as_str) == Some("image"))
            && !image_capable
        {
            return Err("当前 Pi 适配器不支持图片".into());
        }
        let prefs_state = rt.lock().unwrap().state.clone();
        self.preferences.save("pi", &prefs_state).await?;
        let settings_before = {
            let r = rt.lock().unwrap();
            serde_json::to_string(
                &model_preferences(&r.state)
                    .iter()
                    .map(|p| json!({"kind":p.kind,"value":p.value}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        };
        {
            let mut r = rt.lock().unwrap();
            let text = prompt
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            let mut entry = Entry::text_entry(next_id(), "user", text);
            entry.context_blocks = Some(prompt.to_vec());
            r.state.entries.push(entry);
        }
        self.save(rt).await?;
        let start = rt.lock().unwrap().state.entries.len();
        self.emit(rt);
        let cwd = rt.lock().unwrap().snapshot.cwd.clone();
        {
            let accessor: StateAccessor = {
                let weak = Arc::downgrade(rt);
                Arc::new(move || {
                    weak.upgrade().map(|rt| {
                        let r = rt.lock().unwrap();
                        // session_number: None — TS reads state.sessionNumber,
                        // which is never assigned, so the outbox event omits
                        // the key entirely (spec-optional; parity wins).
                        (
                            r.snapshot.id.clone(),
                            None,
                            r.state.entries.clone(),
                            r.state.permissions.len(),
                        )
                    })
                })
            };
            rt.lock().unwrap().publication = Some(DesktopTelegramTurn::new(
                self.events.clone(),
                accessor,
                cwd.clone(),
                start,
                format!("service:{request_id}"),
                source.to_string(),
                self.report.clone(),
                self.closed.clone(),
            ));
        }
        // Checkpoint saves every 2s; failures poison the turn like the TS
        // version. CancellationToken (not abort): TS `await saving` lets the
        // in-flight write finish — aborting mid-write_atomic_json would leave
        // *.tmp residue that the format contract forbids.
        let ckpt_cancel = tokio_util::sync::CancellationToken::new();
        let checkpoint = {
            let service_rt = rt.clone();
            let store_ref = self.store.clone();
            let report = self.report.clone();
            let cancel = ckpt_cancel.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {
                            if let Err(error) = save_snapshot(&store_ref, &service_rt).await {
                                let mut r = service_rt.lock().unwrap();
                                r.error = Some(error.clone());
                                if let Some(agent) = r.agent.clone() {
                                    drop(r);
                                    agent.dispose();
                                }
                                report(&error);
                            }
                        }
                    }
                }
            })
        };
        let mut changes = WorkspaceDiff::begin(&cwd).await;
        let mut result: Result<Value, String> = async {
            rt.lock().unwrap().prompting = true;
            let outcome = if rt.lock().unwrap().cancelled || self.closed.load(Ordering::SeqCst) {
                Ok(json!({ "stopReason": "cancelled" }))
            } else {
                agent.prompt(session_id, prompt.to_vec()).await
            };
            match outcome {
                Ok(result) => {
                    if result.get("stopReason").and_then(Value::as_str) != Some("end_turn") {
                        let reason = result
                            .get("stopReason")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        rt.lock().unwrap().state.entries.push(Entry::text_entry(
                            next_id(),
                            "notice",
                            format!("本轮结束：{reason}"),
                        ));
                    }
                    Ok(result)
                }
                Err(error) => {
                    let cancelled = rt.lock().unwrap().cancelled;
                    let mut r = rt.lock().unwrap();
                    // TS: r.error = r.cancelled ? undefined : msg — cancelled
                    // also CLEARS an error a racing closed callback just set.
                    if cancelled {
                        r.error = None;
                    } else {
                        r.error = Some(error.clone());
                    }
                    r.state.entries.push(Entry::text_entry(
                        next_id(),
                        "notice",
                        if cancelled {
                            "本轮已停止。".into()
                        } else {
                            format!("本轮失败：{error}")
                        },
                    ));
                    Ok(json!({ "stopReason": "cancelled" }))
                }
            }
        }
        .await;
        {
            let mut r = rt.lock().unwrap();
            r.prompting = false;
            if let Some(task) = r.cancel_task.take() {
                task.abort();
            }
        }
        if agent.is_closed() {
            agent.stop().await;
        }
        let diff_entry = changes.finish().await;
        rt.lock().unwrap().state.entries.push(diff_entry);
        // Drain the checkpoint task — an in-flight save completes and its
        // error still lands on r.error, matching TS `await saving`.
        ckpt_cancel.cancel();
        let _ = checkpoint.await;
        // Save failures during the turn surface the same way as TS.
        if let Some(error) = rt.lock().unwrap().error.clone() {
            result = Err(error);
        }
        self.save(rt).await?;
        let settings_after = {
            let r = rt.lock().unwrap();
            serde_json::to_string(
                &model_preferences(&r.state)
                    .iter()
                    .map(|p| json!({"kind":p.kind,"value":p.value}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        };
        if settings_before != settings_after {
            let state = rt.lock().unwrap().state.clone();
            self.preferences.save("pi", &state).await?;
        }
        let publication = rt.lock().unwrap().publication.take();
        if let Some(publication) = publication {
            let (error, stop_reason) = {
                let r = rt.lock().unwrap();
                (
                    r.error.clone(),
                    result
                        .as_ref()
                        .ok()
                        .and_then(|v| v.get("stopReason"))
                        .and_then(Value::as_str)
                        .map(String::from),
                )
            };
            publication.finish(error, stop_reason.as_deref()).await?;
        }
        result
    }

    /// Protocol-v2 historyWrite: the session lease may be held externally
    /// (calling extension) — the store verifies freshness; a runtime we own
    /// means the session is live here → SessionInUse like claim().
    async fn history_write(&self, snapshot: &Value) -> Result<Value, String> {
        let id = snapshot
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if self.runtimes.lock().unwrap().contains_key(&id) {
            return Err(SessionInUseError.to_string());
        }
        // TS persists whatever the caller sent; a known field with a wrong
        // type fails serde, so degrade to id + verbatim extras rather than
        // reject (Snapshot.extra round-trips unknown keys byte-for-byte).
        let snap: Snapshot = serde_json::from_value(snapshot.clone()).unwrap_or_else(|_| {
            let mut snap = Snapshot {
                id: id.clone(),
                ..Default::default()
            };
            if let Value::Object(map) = snapshot {
                snap.extra = map.clone();
            }
            snap
        });
        Ok(serde_json::to_value(self.store.write_delegated(&snap).await?).unwrap_or(Value::Null))
    }

    /// historyRemove {sessionId?}: remove one index entry (evicting a live
    /// runtime first), or clear the whole index when sessionId is absent.
    async fn history_remove(&self, id: Option<&str>) -> Result<(), String> {
        match id {
            None => {
                // Collect inside exclusive(): a runtime created between
                // snapshotting and allocation would escape eviction and be
                // tombstoned by clear() while still holding its lease.
                self.exclusive(|| async {
                    let runtimes: Vec<(String, Arc<Mutex<Runtime>>)> = self
                        .runtimes
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    for (sid, rt) in runtimes {
                        self.evict(&sid, &rt).await;
                    }
                })
                .await;
                self.store.clear().await
            }
            Some(id) => {
                if !self.store.list().await?.iter().any(|s| s.id == id) {
                    return Err("会话不存在".into());
                }
                self.exclusive(|| async {
                    let rt = self.runtimes.lock().unwrap().get(id).cloned();
                    if let Some(rt) = rt {
                        self.evict(id, &rt).await;
                    }
                })
                .await;
                self.store.remove(id).await
            }
        }
    }

    async fn cancel(&self, id: &str) -> bool {
        self.queue.cancel(id).await;
        let rt = self.runtimes.lock().unwrap().get(id).cloned();
        let Some(rt) = rt else { return false };
        let (prompting, agent) = {
            let mut r = rt.lock().unwrap();
            if !r.busy {
                return false;
            }
            r.cancelled = true;
            for (_, settle) in r.permissions.drain() {
                let _ = settle.send(None);
            }
            r.state.permissions.clear();
            (r.prompting, r.agent.clone())
        };
        // 5 s escalation: still busy with the SAME agent → dispose the worker.
        let weak = Arc::downgrade(&rt);
        let reference = agent.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(rt) = weak.upgrade() else { return };
            let kill = {
                let r = rt.lock().unwrap();
                r.busy
                    && reference.is_some()
                    && r.agent
                        .as_ref()
                        .zip(reference.as_ref())
                        .map(|(a, b)| Arc::ptr_eq(a, b))
                        .unwrap_or(false)
            };
            if kill {
                if let Some(agent) = rt.lock().unwrap().agent.take() {
                    agent.dispose();
                }
            }
        });
        rt.lock().unwrap().cancel_task = Some(task);
        if prompting {
            if let Some(agent) = agent {
                agent.cancel(id).await;
            }
        }
        true
    }

    async fn create(&self, directory: &str) -> Result<Value, String> {
        if !std::path::Path::new(directory).is_absolute() {
            return Err("工作区需要绝对目录路径".into());
        }
        let cwd = tokio::fs::canonicalize(directory)
            .await
            .map_err(|_| "工作区不是目录".to_string())?;
        if !cwd.is_dir() {
            return Err("工作区不是目录".into());
        }
        let cwd = cwd.to_string_lossy().into_owned();
        self.exclusive(|| async {
            self.make_room().await?;
            let initial = Arc::new(Mutex::new(initial_state()));
            let agent = self.spawn_transient(&cwd, initial.clone())?;
            let result = async {
                agent.initialize().await?;
                let preferences = self.preferences.read("pi").await?;
                let mut session = agent.create_session(None).await?;
                let warning = apply_preferences(agent.as_ref(), &mut session, &preferences).await?;
                if warning.is_none() {
                    let mut prefs_state = ChatState::default();
                    prefs_state.configs = session
                        .get("configOptions")
                        .and_then(Value::as_array)
                        .cloned();
                    prefs_state.modes = session.get("modes").cloned();
                    self.preferences.save("pi", &prefs_state).await?;
                }
                let session_id = session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let commands_cache = initial.lock().unwrap().commands.clone();
                self.store.claim(&session_id).await?;
                let written = self
                    .store
                    .write(&Snapshot {
                        id: session_id.clone(),
                        cwd,
                        harness: Some("pi".into()),
                        title: "新对话".into(),
                        updated: now_ms(),
                        entries: match &warning {
                            Some(w) => vec![Entry::text_entry(next_id(), "notice", w.clone())],
                            None => vec![],
                        },
                        commands: Some(commands_cache.clone()),
                        configs: session
                            .get("configOptions")
                            .and_then(Value::as_array)
                            .cloned(),
                        modes: session.get("modes").cloned(),
                        context_complete: Some(true),
                        ..Default::default()
                    })
                    .await;
                self.store.release(&session_id).await;
                written
            }
            .await;
            agent.stop().await;
            result.map(|s| json!(s))
        })
        .await
    }

    async fn save(&self, rt: &Rt) -> Result<(), String> {
        save_snapshot(&self.store, rt).await
    }

    fn emit(&self, rt: &Rt) {
        let event = view_state_with_type(&rt.lock().unwrap());
        (self.broadcast)(event);
    }

    pub async fn dispose(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // TS: close() is started but NOT awaited — agents are disposed first so
        // in-flight prompts fail fast and let the lanes drain (a busy worker
        // otherwise deadlocks the shutdown).
        // TS queue.close() sets closed synchronously — Rust futures are lazy,
        // so set the flag eagerly before the join! (L2 review finding).
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

/// r.snapshot + live state fields — the 'save' shape in the TS version.
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
        ServiceCommand::HistoryWrite { id, .. } => id,
        ServiceCommand::HistoryRemove { session_id } => session_id.as_deref().unwrap_or(""),
        _ => "",
    }
}

/// `{snapshot{+entries,configs,modes,nativeForks}, busy, permissions, commands, error?}`
fn view_state(r: &Runtime) -> Value {
    let mut snapshot = serde_json::to_value(&r.snapshot).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut snapshot {
        map.insert(
            "entries".into(),
            serde_json::to_value(&r.state.entries).unwrap_or(json!([])),
        );
        // TS: `configs: undefined` → JSON.stringify drops the key entirely;
        // emit absent rather than null so wire bytes match.
        if let Some(v) = &r.state.configs {
            map.insert("configs".into(), v.clone().into());
        }
        if let Some(v) = &r.state.modes {
            map.insert("modes".into(), v.clone());
        }
        if let Some(m) = &r.state.native_forks {
            map.insert(
                "nativeForks".into(),
                serde_json::to_value(m).unwrap_or(Value::Null),
            );
        }
    }
    let mut state = json!({
        "snapshot": snapshot,
        "busy": r.busy,
        "permissions": r.state.permissions.iter().map(|p| json!({"id": p.id, "request": p.request})).collect::<Vec<_>>(),
        "commands": r.state.commands,
    });
    if let Some(error) = &r.error {
        state["error"] = json!(error);
    }
    state
}

fn view_state_with_type(r: &Runtime) -> Value {
    let mut v = view_state(r);
    v.as_object_mut()
        .unwrap()
        .insert("type".into(), json!("state"));
    v
}

/// TS permission(): ticket + 5 min timeout + resolve-on-settle.
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
        if closed.load(Ordering::SeqCst) || r.replay || r.permissions.len() >= 32 || too_big {
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
