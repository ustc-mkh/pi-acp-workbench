//! Session orchestration. Worker allocation, session operations and turns have separate modules.
//! Runtime mutexes never span an await; queue lanes serialize each session.
use pi_acp_core::sync::MutexExt;
mod autonomous;
mod session_ops;
mod title;
mod turn;
mod worker_pool;

use crate::agent::{AgentOptions, AgentProcess};
use crate::diff::WorkspaceDiff;
use crate::error::ServiceError;
use crate::harness::Harness;
use crate::history::SharedHistoryStore;
use crate::journal::RequestJournal;
use crate::native::bind_native_forks;
use crate::outbox::{StateAccessor, TaskOutbox, TurnPublication};
use crate::phase::{Phase, Step};
use crate::prefs::{apply_preferences, model_preferences, SessionPreferences};
use crate::protocol::{
    durable_command, service_command, AgentRequest, ServiceCommand, ServiceState,
};
use crate::queue::{Check, TaskQueue};
use crate::types::{ChatState, Entry, Permission, Snapshot};
use crate::updates::{apply_update, initial_state, next_id};
use pi_acp_core::utf16::utf16_head;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

use pi_acp_core::util::now_ms;

type Rt = Arc<Mutex<Runtime>>;

/// Worker lifetime tiers by recent activity: the LONG_LIFE_WORKERS most
/// recently used runtimes may idle LONG_LIFE_MS; the rest only SHORT_LIFE_MS.
const LONG_LIFE_WORKERS: usize = 8;
const LONG_LIFE_MS: u64 = 16 * 24 * 60 * 60 * 1000;
const SHORT_LIFE_MS: u64 = 24 * 60 * 60 * 1000;

/// Runtime ids ranked most-recently-active first.
fn activity_order(runtimes: &HashMap<String, Rt>) -> Vec<String> {
    let mut ranked: Vec<(u64, String)> = runtimes
        .iter()
        .map(|(id, rt)| (rt.lock_unpoisoned().used, id.clone()))
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    ranked.into_iter().map(|(_, id)| id).collect()
}

fn life_tier_ms(rank: usize) -> u64 {
    if rank < LONG_LIFE_WORKERS {
        LONG_LIFE_MS
    } else {
        SHORT_LIFE_MS
    }
}
type Report = Arc<dyn Fn(&str) + Send + Sync>;
type Broadcast = Arc<dyn Fn(Value) + Send + Sync>;
/// Non-'static boxed future so operations may borrow &self/&command.
type OpFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>;

/// Permission callback that always resolves 'cancelled' — transient workers.
fn auto_cancel_permission() -> crate::agent::PermissionCb {
    Arc::new(
        |request| -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
            Box::pin(async move { request.cancelled() })
        },
    )
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerLaunch {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub max_workers: usize,
    pub idle_ms: u64,
    pub harnesses: HashMap<String, WorkerLaunch>,
}

pub struct Runtime {
    pub snapshot: Snapshot,
    pub state: ChatState,
    pub agent: Option<Arc<AgentProcess>>,
    pub phase: Phase,
    runs: autonomous::Runs,
    pub used: u64,
    /// permissionId → settle channel; send resolves the pending agent request.
    pub permissions: HashMap<String, oneshot::Sender<Option<Value>>>,
    pub error: Option<String>,
    snapshot_pending: bool,
}

pub struct SessionService {
    /// Runtime catalogue; std Mutex is never held across await.
    runtimes: Arc<Mutex<HashMap<String, Rt>>>,
    journal: RequestJournal,
    preferences: SessionPreferences,
    title_settings: crate::title::TitleStore,
    queue: TaskQueue,
    store: Arc<SharedHistoryStore>,
    events: Arc<TaskOutbox>,
    config: ServiceConfig,
    capabilities: Mutex<HashMap<Harness, Value>>,
    broadcast: Broadcast,
    report: Report,
    closed: Arc<AtomicBool>,
    sweeping: AtomicBool,
    allocation: tokio::sync::Mutex<()>,
    workspace_gate: crate::workspace_gate::WorkspaceGate,
}

impl SessionService {
    pub fn new(
        root: &std::path::Path,
        config: ServiceConfig,
        broadcast: Broadcast,
        report: Report,
    ) -> Arc<Self> {
        let runtimes: Arc<Mutex<HashMap<String, Rt>>> = Arc::new(Mutex::new(HashMap::new()));
        let runtimes_field = runtimes;
        let service = Arc::new(SessionService {
            capabilities: Mutex::new(HashMap::new()),
            store: Arc::new(SharedHistoryStore::new(root.join("history"))),
            preferences: SessionPreferences::new(root.join("preferences")),
            title_settings: crate::title::TitleStore::new(
                root.join("preferences").join("title.json"),
            ),
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
            workspace_gate: crate::workspace_gate::WorkspaceGate::default(),
        });
        service.spawn_idle_sweep();
        service
    }

    pub async fn initialize(self: &Arc<Self>) -> Result<(), String> {
        self.store.recover_orphans().await?;
        self.title_settings.initialize().await?;
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
                            image_entry_ids: vec![],
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
        let rejected_at_admission = matches!(&command, ServiceCommand::Prompt { .. })
            && self
                .runtimes
                .lock_unpoisoned()
                .get(command_session_id(&command))
                .is_some_and(|rt| rt.lock_unpoisoned().runs.busy());
        if durable_command(&command) {
            return self
                .journal
                .run(
                    request_id,
                    method,
                    &params,
                    command_session_id(&command),
                    &self.queue,
                    |check| async {
                        if rejected_at_admission {
                            if let ServiceCommand::Prompt {
                                session_id, prompt, ..
                            } = &command
                            {
                                check()?;
                                return self.reject_prompt(session_id, prompt, request_id).await;
                            }
                        }
                        self.execute(&command, request_id, Some(check)).await
                    },
                )
                .await
                .map_err(ServiceError::from);
        }
        if matches!(
            command,
            ServiceCommand::Remove { .. } | ServiceCommand::HistoryRemove { .. }
        ) {
            let id = command_session_id(&command);
            if !id.is_empty() {
                // Stop live work and invalidate old waiters BEFORE joining its
                // lane. Otherwise deletion waits forever behind a live prompt.
                self.cancel(id).await;
            }
            return self
                .queue
                .run_control(id, |_check| self.execute(&command, request_id, None))
                .await
                .map_err(ServiceError::from);
        }
        if matches!(
            &command,
            ServiceCommand::Request {
                request: AgentRequest::Inspect { .. },
                ..
            }
        ) {
            // An inspection during a live run is read-only.
            // Do not enter its request lane or change phase/permissions/busy;
            // otherwise the UI cannot synchronize until the prompt ends.
            if matches!(
                &command,
                ServiceCommand::Request {
                    request: AgentRequest::Inspect { .. },
                    ..
                }
            ) {
                let live = self
                    .runtimes
                    .lock_unpoisoned()
                    .get(command_session_id(&command))
                    .and_then(|rt| {
                        let r = rt.lock_unpoisoned();
                        if r.busy() {
                            r.agent.clone().map(|agent| {
                                (
                                    rt.clone(),
                                    agent,
                                    r.snapshot.harness.as_deref() == Some("pi"),
                                )
                            })
                        } else {
                            None
                        }
                    });
                if let Some((rt, agent, pi)) = live {
                    let result = if pi {
                        self.agent_request(&rt, &agent, &command).await
                    } else {
                        self.execute_session(&command, request_id, None).await
                    };
                    if pi && result.is_ok() {
                        self.emit(&rt);
                    }
                    return result.map_err(ServiceError::from);
                }
            }
            return self
                .queue
                .run(command_session_id(&command), |check| {
                    self.execute(&command, request_id, Some(check))
                })
                .await
                .map_err(ServiceError::from);
        }
        self.execute(&command, request_id, None)
            .await
            .map_err(ServiceError::from)
    }

    async fn execute(
        &self,
        command: &ServiceCommand,
        request_id: &str,
        check: Option<Check>,
    ) -> Result<Value, String> {
        // The journal/session lane is acquired first. Workspace conflicts fail
        // visibly rather than holding global queue slots while waiting.
        let cwd = match command {
            ServiceCommand::Create { cwd, .. } => Some(cwd.clone()),
            ServiceCommand::Prompt { .. }
            | ServiceCommand::UndoTurn { .. }
            | ServiceCommand::Request {
                request:
                    AgentRequest::Fork { .. }
                    | AgentRequest::SetMode { .. }
                    | AgentRequest::SetConfig { .. },
                ..
            } => Some(self.index(command_session_id(command)).await?.cwd),
            _ => None,
        };
        let _workspace = match cwd {
            Some(cwd) => Some(
                self.workspace_gate
                    .enter(&cwd, matches!(command, ServiceCommand::UndoTurn { .. }))
                    .await?,
            ),
            None => None,
        };
        match command {
            ServiceCommand::EventsNext { cursor } => self.events.next(cursor.as_deref()).await,
            ServiceCommand::EventsAck { id, token } => Ok(json!(self.events.ack(id, token).await?)),
            ServiceCommand::Hello { harness } => self.hello(*harness).await,
            ServiceCommand::List => Ok(json!(self.list().await?)),
            ServiceCommand::TitleSettings {} => Ok(json!(self.title_settings.get().await)),
            ServiceCommand::SetTitleModel { model } => {
                Ok(json!(self.title_settings.set(model).await?))
            }
            ServiceCommand::Create { cwd, harness } => self.create(cwd, *harness).await,
            ServiceCommand::HistoryRemove { session_id } => {
                self.history_remove(session_id.as_deref()).await?;
                Ok(Value::Null)
            }
            _ => self.execute_session(command, request_id, check).await,
        }
    }

    pub async fn dispose(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.queue.mark_closed();
        let draining = self.queue.close();
        let mut stopping_agents = Vec::new();
        {
            let runtimes: Vec<Rt> = self.runtimes.lock_unpoisoned().values().cloned().collect();
            for rt in runtimes {
                let agent = {
                    let mut r = rt.lock_unpoisoned();
                    for (_, settle) in r.permissions.drain() {
                        let _ = settle.send(None);
                    }
                    r.agent.take()
                };
                if let Some(agent) = agent {
                    agent.dispose();
                    stopping_agents.push(agent);
                }
            }
        }
        // Retain and await every worker's group cleanup before the daemon's
        // runtime can exit, even though its runtime directory no longer owns it.
        let cleanup = async {
            for agent in stopping_agents {
                agent.stop().await;
            }
        };
        let ((), (), ()) = tokio::join!(draining, self.journal.drain(), cleanup);
        self.exclusive(|| async {
            let ids: Vec<String> = self.runtimes.lock_unpoisoned().keys().cloned().collect();
            for id in ids {
                // `if let` scrutinee temporaries live until the if-let ends —
                // the map guard would be held across evict().await and evict's
                // own self.runtimes.lock() would self-deadlock. Bind first.
                let rt = self.runtimes.lock_unpoisoned().get(&id).cloned();
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
    let gate = rt.lock_unpoisoned().runs.persistence.clone();
    let _guard = gate.lock().await;
    let snapshot = {
        let r = rt.lock_unpoisoned();
        let title = if r.snapshot.extra.contains_key("titleSource") {
            r.snapshot.title.clone()
        } else {
            r.state
                .entries
                .iter()
                .find(|e| e.is("user") && e.send_error.is_none())
                .map(|e| crate::title::short_title(e.text(), 32))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| r.snapshot.title.clone())
        };
        let mut snapshot = Snapshot {
            entries: r.state.entries.clone(),
            configs: r.state.configs.clone(),
            modes: r.state.modes.clone(),
            commands: Some(r.state.commands.clone()),
            native_forks: r.state.native_forks.clone(),
            usage: r.state.usage.clone(),
            usage_records: r.state.usage_records.clone(),
            context_window: r
                .state
                .usage
                .as_ref()
                .and_then(|u| u["size"].as_u64())
                .or(r.snapshot.context_window),
            updated: now_ms(),
            title,
            ..r.snapshot.clone()
        };
        snapshot.extra.insert("plan".into(), json!(r.state.plan));
        snapshot
    };
    let stub = store.write(&snapshot).await?;
    rt.lock_unpoisoned().snapshot = stub;
    Ok(())
}

/// Adapter-side session id; differs from `snapshot.id` when a session without
/// persisted turns had to be recreated — adapters cannot load unwritten
/// rollouts (e.g. codex "no rollout found"). Persisted in `snapshot.extra` so
/// later turns keep resuming the same adapter session.
fn acp_session_id(r: &Runtime) -> &str {
    r.snapshot
        .extra
        .get("remoteSessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or(&r.snapshot.id)
}

fn command_session_id(command: &ServiceCommand) -> &str {
    match command {
        ServiceCommand::State { session_id }
        | ServiceCommand::UndoTurn { session_id, .. }
        | ServiceCommand::TurnDiff { session_id, .. }
        | ServiceCommand::HistoryPage { session_id, .. }
        | ServiceCommand::Cancel { session_id }
        | ServiceCommand::Remove { session_id }
        | ServiceCommand::Permission { session_id, .. }
        | ServiceCommand::Prompt { session_id, .. }
        | ServiceCommand::Request { session_id, .. } => session_id,
        ServiceCommand::HistoryRemove { session_id } => session_id.as_deref().unwrap_or(""),
        _ => "",
    }
}

/// `{snapshot{+entries,configs,modes,nativeForks}, busy, permissions, commands, error?}`
fn view_state(r: &Runtime) -> Value {
    let (entries, before) = crate::history_page::window(&r.state.entries, r.state.entries.len());
    let mut snapshot = Snapshot {
        entries,
        // Fall back only on omission: a live [] must reach clients unchanged.
        configs: crate::catalogue::merge_catalogue(
            r.snapshot.configs.clone(),
            r.state.configs.clone(),
            false,
        ),
        modes: r.state.modes.clone().or_else(|| r.snapshot.modes.clone()),
        native_forks: r.state.native_forks.clone(),
        usage: r.state.usage.clone(),
        usage_records: Vec::new(), // Detailed billing is paginated via inspect.
        ..r.snapshot.clone()
    };
    snapshot.extra.insert("historyBefore".into(), json!(before));
    snapshot
        .extra
        .insert("activeTurnId".into(), json!(r.state.active_turn_id));
    snapshot.extra.insert("plan".into(), json!(r.state.plan));
    serde_json::to_value(ServiceState {
        snapshot,
        busy: r.busy(),
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
    if let Some(object) = v.as_object_mut() {
        object.insert("type".into(), json!("state"));
    }
    v
}

async fn service_permission(
    rt: &Rt,
    request: Value,
    broadcast: Broadcast,
    closed: &AtomicBool,
    worker_epoch: Option<u64>,
) -> Value {
    let cancelled = || json!({ "outcome": { "outcome": "cancelled" } });
    let too_big = serde_json::to_vec(&request)
        .map(|v| v.len() > 256 * 1024)
        .unwrap_or(true);
    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<Option<Value>>();
    {
        let mut r = rt.lock_unpoisoned();
        if worker_epoch.is_some_and(|epoch| r.runs.worker_epoch != epoch)
            || closed.load(Ordering::SeqCst)
            || !r.busy()
            || (r.runs.running() && r.runs.cancelled())
            || (!r.runs.running()
                && (r.phase.cancelled()
                    || r.phase.at(Step::Finishing)
                    || r.phase.at(Step::Replaying)))
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
        let r = rt.lock_unpoisoned();
        broadcast(view_state_with_type(&r));
    }
    let outcome = tokio::time::timeout(Duration::from_secs(300), rx).await;
    let chosen = outcome.ok().and_then(|r| r.ok()).flatten();
    {
        let mut r = rt.lock_unpoisoned();
        r.permissions.remove(&id);
        r.state.permissions.retain(|p| p.id != id);
    }
    {
        let r = rt.lock_unpoisoned();
        broadcast(view_state_with_type(&r));
    }
    match chosen {
        Some(response) => response,
        None => cancelled(),
    }
}

mod interactions;
use interactions::service_interaction;

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[tokio::test]
    async fn panicking_operation_restores_committed_history_and_releases_the_worker() {
        let root = std::env::temp_dir().join(format!("pi-runtime-recovery-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        let service = SessionService::new(
            &root,
            ServiceConfig {
                command: "node".into(),
                args: vec![worker.to_string_lossy().into_owned()],
                env: HashMap::new(),
                max_workers: 2,
                idle_ms: 900000,
                harnesses: HashMap::new(),
            },
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        service.initialize().await.unwrap();
        let snapshot = service
            .create(root.to_str().unwrap(), Harness::Pi)
            .await
            .unwrap();
        let id = snapshot["id"].as_str().unwrap();
        service
            .handle(
                "prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":"retained"}]}),
                "before",
            )
            .await
            .unwrap();
        let before = service.state(id).await.unwrap()["snapshot"]["entries"].clone();
        let result = service
            .with_worker(id, None, |rt, _agent| {
                Box::pin(async move {
                    let mut r = rt.lock_unpoisoned();
                    r.state.entries.clear();
                    panic!("simulated worker logic bug while holding the runtime mutex");
                })
            })
            .await;
        assert!(result.is_err());
        let restored = service.state(id).await.unwrap();
        assert_eq!(restored["snapshot"]["entries"], before);
        assert_eq!(restored["busy"], false);
        assert_eq!(restored["permissions"], json!([]));
        service
            .handle(
                "prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":"after"}]}),
                "after",
            )
            .await
            .unwrap();
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod control_tests {
    use super::*;
    use tokio::time::{timeout, Duration};

    async fn fixture() -> (Arc<SessionService>, std::path::PathBuf, String) {
        let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        fixture_with_args(vec![worker.to_string_lossy().into_owned()]).await
    }

    async fn fixture_with_args(
        args: Vec<String>,
    ) -> (Arc<SessionService>, std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("pi-control-race-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let service = SessionService::new(
            &root,
            ServiceConfig {
                command: "node".into(),
                args,
                env: HashMap::new(),
                max_workers: 3,
                idle_ms: 900000,
                harnesses: HashMap::new(),
            },
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        service.initialize().await.unwrap();
        let session = service
            .create(root.to_str().unwrap(), Harness::Pi)
            .await
            .unwrap();
        (service, root, session["id"].as_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn service_shutdown_waits_for_term_resistant_worker_descendants() {
        let pid_file = std::env::temp_dir().join(format!("pi-shutdown-{}", Uuid::new_v4()));
        let descendant = format!(
            r#"
            process.on('SIGTERM', () => {{}});
            require('node:fs').writeFileSync({}, String(process.pid));
            setInterval(() => {{}}, 1000);
        "#,
            serde_json::to_string(&pid_file.to_str().unwrap()).unwrap()
        );
        let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        let script = format!(
            r#"
            require('node:child_process').spawn(process.execPath, ['-e', {}], {{stdio:'ignore'}});
            import({});
        "#,
            serde_json::to_string(&descendant).unwrap(),
            serde_json::to_string(&contract.to_str().unwrap()).unwrap()
        );
        let (service, root, id) = fixture_with_args(vec!["-e".into(), script]).await;
        let _ = std::fs::remove_file(&pid_file);
        let rt = service.runtime(&id, None).await.unwrap();
        let _agent = service.worker(&rt).await.unwrap();
        let child: i32 = timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid_file) {
                    break pid.parse().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        timeout(Duration::from_secs(5), service.dispose())
            .await
            .unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                #[cfg(target_os = "linux")]
                {
                    let stat = std::fs::read_to_string(format!("/proc/{child}/stat"));
                    if stat.is_err() || stat.unwrap().split(") ").nth(1).unwrap().starts_with('Z') {
                        break;
                    }
                }
                #[cfg(not(target_os = "linux"))]
                if unsafe { libc::kill(child, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        std::fs::remove_file(pid_file).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stale_eviction_cannot_remove_replacement_or_release_its_lease() {
        let (service, root, id) = fixture().await;
        let old = service.runtime(&id, None).await.unwrap();
        service
            .exclusive(|| async { service.evict(&id, &old).await })
            .await;
        let new = service.runtime(&id, None).await.unwrap();
        new.lock_unpoisoned().phase = Phase::begin();
        service
            .exclusive(|| async { service.evict(&id, &old).await })
            .await;
        assert!(Arc::ptr_eq(
            service.runtimes.lock_unpoisoned().get(&id).unwrap(),
            &new
        ));
        save_snapshot(&service.store, &new).await.unwrap();
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn late_permissions_after_stop_or_completion_are_cancelled_without_publication() {
        for kind in 0..4 {
            let mut phase = if kind == 0 {
                Phase::Idle
            } else {
                Phase::begin()
            };
            if kind == 1 {
                phase.active_mut().unwrap().cancelled = true;
            }
            if kind == 2 {
                phase.active_mut().unwrap().step = Step::Finishing;
            }
            let rt = Arc::new(Mutex::new(Runtime {
                snapshot: Snapshot::default(),
                state: initial_state(),
                agent: None,
                phase,
                runs: Default::default(),
                used: 0,
                permissions: HashMap::new(),
                error: None,
                snapshot_pending: false,
            }));
            let outcome = service_permission(
                &rt,
                json!({"sessionId":"one","options":[]}),
                Arc::new(|_| panic!("late permission was published")),
                &AtomicBool::new(false),
                (kind == 3).then_some(1),
            )
            .await;
            assert_eq!(outcome["outcome"]["outcome"], "cancelled");
            assert!(rt.lock_unpoisoned().permissions.is_empty());
            assert!(rt.lock_unpoisoned().state.permissions.is_empty());
        }
    }

    #[tokio::test]
    async fn repeated_stops_do_not_postpone_deleting_an_unresponsive_worker() {
        let script = r#"
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
let sid;
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize') reply(r.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
 else if(r.method==='session/new'){sid=randomUUID();reply(r.id,{sessionId:sid});}
 else if(r.method==='session/load'){sid=r.params.sessionId;reply(r.id,{});}
 else if(r.method==='session/prompt') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'started'}}}})+'\n');
 // Deliberately never answer prompt or react to session/cancel.
});
"#;
        let (service, root, id) = fixture_with_args(vec!["-e".into(), script.into()]).await;
        let running_service = service.clone();
        let key = id.clone();
        let turn = tokio::spawn(async move {
            running_service
                .handle(
                    "prompt",
                    json!({"sessionId":key,"prompt":[{"type":"text","text":"wait"}]}),
                    "unresponsive-turn",
                )
                .await
        });
        timeout(Duration::from_secs(3), async {
            loop {
                if service.state(&id).await.unwrap()["snapshot"]["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["text"] == "started")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let deleting_service = service.clone();
        let key = id.clone();
        let deletion = tokio::spawn(async move {
            deleting_service
                .handle(
                    "historyRemove",
                    json!({"sessionId":key}),
                    "delete-unresponsive",
                )
                .await
        });
        let rt = service.runtimes.lock_unpoisoned().get(&id).unwrap().clone();
        let original = timeout(Duration::from_secs(1), async {
            loop {
                if let Some(id) = rt
                    .lock_unpoisoned()
                    .phase
                    .active()
                    .and_then(|active| active.cancel_task.as_ref().map(|task| task.id()))
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(service.cancel(&id).await);
            assert_eq!(
                rt.lock_unpoisoned()
                    .phase
                    .active()
                    .unwrap()
                    .cancel_task
                    .as_ref()
                    .unwrap()
                    .id(),
                original
            );
        }
        // Includes the cancellation deadline plus process-group escalation.
        timeout(Duration::from_secs(5), deletion)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(turn.await.unwrap().unwrap()["stopReason"], "cancelled");
        assert!(service.list().await.unwrap().is_empty());
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_lane_entry_survives_waiting_for_runtime_allocation() {
        let (service, root, id) = fixture().await;
        let allocation = service.allocation.lock().await;
        let (entered, started) = oneshot::channel();
        let queue_service = service.clone();
        let worker_service = service.clone();
        let key = id.clone();
        let task = tokio::spawn(async move {
            queue_service
                .queue
                .run(&key, |check| async {
                    check()?; // The original pre-execution check already passed.
                    entered.send(()).unwrap();
                    worker_service
                        .with_worker(&key, Some(check), |_rt, _agent| {
                            Box::pin(async { panic!("cancelled operation reached the worker") })
                        })
                        .await
                })
                .await
        });
        started.await.unwrap();
        assert!(
            service.cancel(&id).await,
            "queued work must acknowledge stop even without a runtime"
        );
        drop(allocation);
        assert_eq!(task.await.unwrap().unwrap_err(), "排队请求已取消");
        assert!(!service.runtimes.lock_unpoisoned().contains_key(&id));
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn deleting_one_live_session_stops_it_without_waiting_for_user_cancellation() {
        for method in ["remove", "historyRemove"] {
            let (service, root, id) = fixture().await;
            let running_service = service.clone();
            let running_id = id.clone();
            let turn = tokio::spawn(async move {
                running_service
                    .handle(
                        "prompt",
                        json!({"sessionId":running_id,
                    "prompt":[{"type":"text","text":"permission"}]}),
                        "live-turn",
                    )
                    .await
            });
            // A permission proves the prompt has reached the upstream worker.
            timeout(Duration::from_secs(3), async {
                loop {
                    if !service.state(&id).await.unwrap()["permissions"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            timeout(
                Duration::from_secs(3),
                service.handle(method, json!({"sessionId":id}), "delete"),
            )
            .await
            .unwrap()
            .unwrap();
            turn.await.unwrap().unwrap();
            assert!(service.state(&id).await.is_err());
            assert!(service.list().await.unwrap().is_empty());
            assert!(service.runtimes.lock_unpoisoned().is_empty());
            service.dispose().await;
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(test)]
mod usage_tests {
    use super::*;

    #[test]
    fn state_views_fall_back_on_omission_but_publish_live_empty_catalogues() {
        let mut runtime = Runtime {
            snapshot: Snapshot {
                configs: Some(vec![json!({"id":"model"})]),
                ..Default::default()
            },
            state: initial_state(),
            agent: None,
            phase: Phase::begin(),
            runs: Default::default(),
            used: 0,
            permissions: HashMap::new(),
            error: None,
            snapshot_pending: false,
        };
        assert_eq!(
            view_state(&runtime)["snapshot"]["configs"],
            json!([{"id":"model"}])
        );
        runtime.state.configs = Some(vec![]);
        assert_eq!(view_state(&runtime)["snapshot"]["configs"], json!([]));
    }

    #[tokio::test]
    async fn usage_survives_eviction_and_restart_without_loading_a_worker() {
        let root = std::env::temp_dir().join(format!("pi-usage-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/contract-agent.mjs");
        let launch = WorkerLaunch {
            command: "node".into(),
            args: vec![worker.to_string_lossy().into_owned()],
            env: HashMap::new(),
        };
        let config = ServiceConfig {
            command: launch.command.clone(),
            args: launch.args.clone(),
            env: HashMap::new(),
            max_workers: 2,
            idle_ms: 900000,
            harnesses: HashMap::from([
                (String::from("codex"), launch.clone()),
                (String::from("claude"), launch),
            ]),
        };
        let service =
            SessionService::new(&root, config.clone(), Arc::new(|_| {}), Arc::new(|_| {}));
        service.initialize().await.unwrap();
        let mut ids = Vec::new();
        for harness in [Harness::Codex, Harness::Claude] {
            let hello = service.hello(harness).await.unwrap();
            assert_eq!(
                hello["agentCapabilities"]["_meta"]["session-service"]["usageInspection"],
                true
            );
            let snapshot = service
                .create(root.to_str().unwrap(), harness)
                .await
                .unwrap();
            let id = snapshot["id"].as_str().unwrap().to_string();
            for turn in ["one", "two"] {
                service
                    .handle(
                        "prompt",
                        json!({"sessionId":id,"prompt":[{"type":"text","text":"usage-report"}]}),
                        &format!("{id}-{turn}"),
                    )
                    .await
                    .unwrap();
            }
            let records = service
                .handle(
                    "request",
                    json!({"sessionId":id,"method":"_pi_workbench/inspect","params":{}}),
                    "inspect-live",
                )
                .await
                .unwrap();
            assert_eq!(records["records"].as_array().unwrap().len(), 2);
            assert!(service.state(&id).await.unwrap()["snapshot"]
                .get("usageRecords")
                .is_none());
            ids.push(id);
        }
        assert!(service
            .list()
            .await
            .unwrap()
            .iter()
            .all(|s| s.usage_records.is_empty()));
        service.dispose().await;
        let service = SessionService::new(&root, config, Arc::new(|_| {}), Arc::new(|_| {}));
        service.initialize().await.unwrap();
        for id in ids {
            let records = service
                .handle(
                    "request",
                    json!({"sessionId":id,"method":"_pi_workbench/inspect","params":{}}),
                    "inspect-cold",
                )
                .await
                .unwrap();
            assert_eq!(records["records"].as_array().unwrap().len(), 2);
            assert_eq!(records["records"][0]["input"], 100);
            assert_eq!(records["contextWindow"], 200000);
            assert_eq!(records["usage"]["used"], 500);
        }
        assert!(service.runtimes.lock_unpoisoned().is_empty());
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
