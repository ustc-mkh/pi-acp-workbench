//! Worker allocation, replay, eviction and notification delivery.
use super::*;
use pi_acp_core::sync::MutexExt;

impl SessionService {
    pub(super) fn spawn_idle_sweep(self: &Arc<Self>) {
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
                // Inspect activity and tier ranking only after acquiring the
                // allocation boundary. A prompt may have completed while this
                // sweep was waiting; never reuse its old expiration decision.
                let _guard = service.allocation.lock().await;
                let (idle, ranked) = {
                    let map = service.runtimes.lock_unpoisoned();
                    let ranked = activity_order(&map);
                    let now = now_ms();
                    (
                        map.iter()
                            .filter(|(_, r)| !r.lock_unpoisoned().busy())
                            .map(|(id, r)| (id.clone(), r.clone(), now))
                            .collect::<Vec<_>>(),
                        ranked,
                    )
                };
                let idle: Vec<(String, Rt)> = idle
                    .into_iter()
                    .filter(|(id, rt, now)| {
                        let rank = ranked.iter().position(|r| r == id).unwrap_or(usize::MAX);
                        now.saturating_sub(rt.lock_unpoisoned().used) >= life_tier_ms(rank)
                    })
                    .map(|(id, rt, _)| (id, rt))
                    .collect();
                for (id, rt) in idle {
                    service.evict_idle(&id, &rt).await;
                }
                service.sweeping.store(false, Ordering::SeqCst);
            }
        });
    }

    pub(super) async fn exclusive<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let _guard = self.allocation.lock().await;
        f().await
    }

    pub(super) async fn evict(&self, id: &str, rt: &Rt) {
        self.evict_matching(id, rt, false).await;
    }

    async fn evict_idle(&self, id: &str, rt: &Rt) {
        self.evict_matching(id, rt, true).await;
    }

    /// Caller holds allocation through removal, worker cleanup and lease release.
    async fn evict_matching(&self, id: &str, rt: &Rt, idle_only: bool) {
        let agent = {
            let mut map = self.runtimes.lock_unpoisoned();
            if !map.get(id).is_some_and(|current| Arc::ptr_eq(current, rt)) {
                return;
            }
            let mut runtime = rt.lock_unpoisoned();
            if idle_only && runtime.busy() {
                return;
            }
            runtime.runs.worker_epoch += 1;
            runtime.runs.clear();
            let agent = runtime.agent.take();
            map.remove(id);
            agent
        };
        if let Some(agent) = agent {
            agent.stop().await;
        }
        self.store.release(id).await;
    }

    pub(super) async fn make_room(&self) -> Result<(), String> {
        if self.runtimes.lock_unpoisoned().len() < self.config.max_workers {
            return Ok(());
        }
        let idle = {
            let map = self.runtimes.lock_unpoisoned();
            map.iter()
                .filter(|(_, r)| !r.lock_unpoisoned().busy())
                .min_by_key(|(_, r)| r.lock_unpoisoned().used)
                .map(|(id, rt)| (id.clone(), rt.clone()))
        };
        let Some((id, rt)) = idle else {
            return Err("工作进程均忙碌".into());
        };
        self.evict_idle(&id, &rt).await;
        if self.runtimes.lock_unpoisoned().len() >= self.config.max_workers {
            return Err("工作进程均忙碌".into());
        }
        Ok(())
    }

    fn launch(&self, harness: Harness) -> WorkerLaunch {
        if let Some(worker) = self.config.harnesses.get(harness.name()) {
            return worker.clone();
        }
        match harness {
            Harness::Pi => WorkerLaunch {
                command: self.config.command.clone(),
                args: self.config.args.clone(),
                env: self.config.env.clone(),
            },
            Harness::Codex => WorkerLaunch {
                command: "codex-acp".into(),
                args: vec![],
                env: HashMap::new(),
            },
            Harness::Claude => WorkerLaunch {
                command: "claude-agent-acp".into(),
                args: vec![],
                env: HashMap::new(),
            },
        }
    }
    fn worker_env(&self, worker: &WorkerLaunch) -> HashMap<String, String> {
        let mut env = worker.env.clone();
        env.insert("PI_TELEGRAM_BOT_TOKEN".into(), String::new());
        env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
        env
    }
    pub(super) async fn hello(&self, harness: Harness) -> Result<Value, String> {
        if let Some(info) = self.capabilities.lock_unpoisoned().get(&harness).cloned() {
            return Ok(info);
        }
        // Negotiate real upstream capabilities; do not advertise Pi extensions for other agents.
        self.exclusive(|| async {
            if let Some(info) = self.capabilities.lock_unpoisoned().get(&harness).cloned() {
                return Ok(info);
            }
            self.make_room().await?;
            let worker =
                self.spawn_transient(harness, "/", Arc::new(Mutex::new(initial_state())))?;
            let result = worker.initialize().await;
            worker.stop().await;
            let mut info = result?;
            info["agentCapabilities"]["_meta"]["session-service"] =
                json!({ "version": 4, "authoritative": true, "usageInspection": harness != Harness::Pi });
            self.capabilities
                .lock_unpoisoned()
                .insert(harness, info.clone());
            Ok(info)
        })
        .await
    }

    /// spawn() for a live runtime — update/permission/closed callbacks wired to it.
    pub(super) fn spawn_agent(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
        let weak = Arc::downgrade(rt);
        let broadcast = self.broadcast.clone();
        let report = self.report.clone();
        let autonomous_host = autonomous::Host {
            store: self.store.clone(),
            events: self.events.clone(),
            broadcast: broadcast.clone(),
            report: report.clone(),
            closed: self.closed.clone(),
        };
        let (snapshot, epoch) = {
            let mut r = rt.lock_unpoisoned();
            r.runs.worker_epoch += 1;
            (r.snapshot.clone(), r.runs.worker_epoch)
        };
        let harness = Harness::parse(snapshot.harness.as_deref().unwrap_or(""))?;
        let launch = self.launch(harness);
        let cwd = snapshot.cwd;
        let options = AgentOptions {
            harness,
            cwd,
            command: launch.command.clone(),
            args: launch.args.clone(),
            env: self.worker_env(&launch),
            update: {
                let rt = weak.clone();
                let broadcast = broadcast.clone();
                let host = autonomous_host.clone();
                Arc::new(move |notification: Value| {
                    let Some(rt) = rt.upgrade() else { return };
                    let event = {
                        let mut r = rt.lock_unpoisoned();
                        if r.runs.worker_epoch != epoch {
                            return;
                        }
                        let live = notification
                            .pointer("/update/_meta/pi-workbench-live")
                            .and_then(Value::as_str)
                            .is_some()
                            || notification
                                .pointer("/update/_meta/pi-workbench-run")
                                .is_some();
                        if r.phase.at(Step::Replaying) && !live {
                            // During session/load replay only commands are accepted;
                            // the persisted transcript stays authoritative. The worker
                            // serves exactly one session and a recreated session
                            // publishes under a fresh adapter id, so skip the id check.
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
                        if notification.get("sessionId").and_then(Value::as_str)
                            != Some(acp_session_id(&r))
                        {
                            return;
                        }
                        let update = notification.get("update").cloned().unwrap_or(Value::Null);
                        if update.get("sessionUpdate").and_then(Value::as_str)
                            == Some("session_info_update")
                            && r.snapshot.extra.get("titleSource").and_then(Value::as_str)
                                != Some("generated")
                        {
                            if let Some(title) = update
                                .get("title")
                                .and_then(Value::as_str)
                                .map(|s| crate::title::short_title(s, 64))
                                .filter(|s| !s.is_empty())
                            {
                                r.snapshot.title = title;
                                r.snapshot
                                    .extra
                                    .insert("titleSource".into(), json!("agent"));
                            }
                        }
                        autonomous::observe(&mut r, &rt, &update, &host);
                        apply_update(&mut r.state, &update, false);
                        autonomous::capture(&mut r, &update);
                        if let Some(publication) = r
                            .phase
                            .active()
                            .and_then(|active| active.publication.as_ref())
                        {
                            publication.update();
                        }
                        // Envelope sessionId is the LOCAL id — the ACP
                        // notification carries the adapter-side id, which
                        // differs for sessions recreated under a fresh adapter
                        // id (remoteSessionId); subscribers watch the local id.
                        json!({
                            "type": "update",
                            "sessionId": r.snapshot.id.clone(),
                            "notification": notification
                        })
                    };
                    broadcast(event);
                    // Coalesce authoritative snapshots; raw ACP events remain
                    // available to protocol consumers, while desktop clients
                    // never need to regenerate entry IDs or reduce Pi events.
                    let schedule = {
                        let mut r = rt.lock_unpoisoned();
                        if r.snapshot_pending {
                            false
                        } else {
                            r.snapshot_pending = true;
                            true
                        }
                    };
                    if schedule {
                        let rt = Arc::downgrade(&rt);
                        let broadcast = broadcast.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(40)).await;
                            if let Some(rt) = rt.upgrade() {
                                let event = {
                                    // lock_unpoisoned: a panic elsewhere must
                                    // not leave snapshot_pending stuck true,
                                    // which would stall all coalesced pushes.
                                    let mut r = rt.lock_unpoisoned();
                                    r.snapshot_pending = false;
                                    view_state_with_type(&r)
                                };
                                broadcast(event);
                            }
                        });
                    }
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
                        service_permission(&rt, request, broadcast, &closed, Some(epoch)).await
                    })
                        as std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>>
                })
            },
            log: report.clone(),
            closed: {
                let broadcast = broadcast.clone();
                let host = autonomous_host;
                Arc::new(move |error: String| {
                    let Some(rt) = weak.upgrade() else { return };
                    let event = {
                        let mut r = rt.lock_unpoisoned();
                        if r.runs.worker_epoch != epoch {
                            return;
                        }
                        if let Some(id) = r.runs.current.clone() {
                            let update = json!({ "_meta": { "pi-workbench-run": { "id": id, "autonomous": true, "running": false, "error": error.clone() } } });
                            autonomous::observe(&mut r, &rt, &update, &host);
                        }
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
    pub(super) fn spawn_transient(
        &self,
        harness: Harness,
        cwd: &str,
        state: Arc<Mutex<ChatState>>,
    ) -> Result<Arc<AgentProcess>, String> {
        let report = self.report.clone();
        let launch = self.launch(harness);
        Ok(Arc::new(AgentProcess::spawn(AgentOptions {
            harness,
            cwd: cwd.to_string(),
            command: launch.command.clone(),
            args: launch.args.clone(),
            env: self.worker_env(&launch),
            update: Arc::new(move |n| {
                apply_update(
                    &mut state.lock_unpoisoned(),
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

    pub(super) async fn runtime(&self, id: &str, check: Option<&Check>) -> Result<Rt, String> {
        let _guard = self.allocation.lock().await;
        // A stop may arrive while another session holds the allocation lock.
        // Do not forget that epoch merely because this runtime did not exist yet.
        if let Some(check) = check {
            check()?;
        }
        if let Some(rt) = self.runtimes.lock_unpoisoned().get(id).cloned() {
            {
                let mut r = rt.lock_unpoisoned();
                r.phase = Phase::begin();
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
                state.usage = snapshot.usage.clone();
                state.usage_records = snapshot.usage_records.clone();
                state.plan = snapshot
                    .extra
                    .get("plan")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let rt = Arc::new(Mutex::new(Runtime {
                    snapshot: Snapshot {
                        entries: vec![],
                        ..snapshot
                    },
                    state,
                    agent: None,
                    phase: Phase::begin(),
                    runs: Default::default(),
                    used: now_ms(),
                    permissions: HashMap::new(),
                    snapshot_pending: false,
                    error: None,
                }));
                self.runtimes
                    .lock_unpoisoned()
                    .insert(id.to_string(), rt.clone());
                Ok(rt)
            }
            Err(e) => {
                self.store.release(id).await;
                Err(e)
            }
        }
    }

    pub(super) async fn worker(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
        if let Some(agent) = rt.lock_unpoisoned().agent.clone() {
            if !agent.is_closed() {
                return Ok(agent);
            }
        }
        {
            let old = rt.lock_unpoisoned().agent.take();
            if let Some(old) = old {
                old.stop().await;
            }
            if let Some(active) = rt.lock_unpoisoned().phase.active_mut() {
                active.step = Step::Replaying;
            } else {
                return Err("会话操作已结束。".into());
            }
        }
        let session_id = acp_session_id(&rt.lock_unpoisoned()).to_string();
        let agent = self.spawn_agent(rt)?;
        rt.lock_unpoisoned().agent = Some(agent.clone());
        let started = async {
            agent.initialize().await?;
            let mut session = match agent.create_session(Some(&session_id)).await {
                Ok(session) => session,
                Err(load_error) => {
                    // Adapters cannot load a session that never persisted a turn
                    // (codex "no rollout found"). A session without assistant
                    // output loses nothing when recreated under a fresh adapter
                    // id — the daemon transcript stays authoritative. A session
                    // with real history must never be silently replaced.
                    if rt
                        .lock_unpoisoned()
                        .state
                        .entries
                        .iter()
                        .any(|e| e.is("assistant"))
                    {
                        return Err(load_error);
                    }
                    let session = agent.create_session(None).await?;
                    let remote = session
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if remote.is_empty() || remote == session_id {
                        return Err(load_error);
                    }
                    rt.lock_unpoisoned()
                        .snapshot
                        .extra
                        .insert("remoteSessionId".into(), json!(remote));
                    // Persist immediately so later turns resume this adapter
                    // session even if the worker is evicted before the next save.
                    self.save(rt).await?;
                    session
                }
            };
            // ACP load responses may omit selectors; retain the persisted selector
            // catalogue so successful settings can be restored through standard RPC.
            {
                let r = rt.lock_unpoisoned();
                if let Some(configs) = crate::catalogue::merge_catalogue(
                    r.state.configs.clone(),
                    session
                        .get("configOptions")
                        .and_then(Value::as_array)
                        .cloned(),
                    true,
                ) {
                    session["configOptions"] = json!(configs);
                } else if let Some(object) = session.as_object_mut() {
                    object.remove("configOptions");
                }
                if let Some(modes) = crate::catalogue::merge_catalogue(
                    r.state.modes.clone(),
                    session
                        .get("modes")
                        .filter(|value| value.is_object())
                        .cloned(),
                    true,
                ) {
                    session["modes"] = modes;
                } else if let Some(object) = session.as_object_mut() {
                    object.remove("modes");
                }
            }
            agent.configure_session(&mut session).await?;
            // A restore-time wake owns its model while running. Return promptly
            // so user admission can fail rather than silently wait and send later.
            if !rt.lock_unpoisoned().runs.busy() {
                let prefs = model_preferences(&rt.lock_unpoisoned().state);
                if let Some(warning) =
                    apply_preferences(agent.as_ref(), &mut session, &prefs).await?
                {
                    rt.lock_unpoisoned().state.entries.push(Entry::text_entry(
                        next_id(),
                        "notice",
                        warning,
                    ));
                }
            }
            let mut r = rt.lock_unpoisoned();
            // Cold fallback was applied before settings RPCs. Their live []
            // responses must still be allowed to clear the catalogue.
            r.state.configs = crate::catalogue::merge_catalogue(
                r.state.configs.take(),
                session
                    .get("configOptions")
                    .and_then(Value::as_array)
                    .cloned(),
                false,
            );
            r.state.modes = crate::catalogue::merge_catalogue(
                r.state.modes.take(),
                session
                    .get("modes")
                    .filter(|value| value.is_object())
                    .cloned(),
                false,
            );
            if let Some(active) = r.phase.active_mut() {
                active.step = Step::Preparing;
            } else {
                return Err("会话操作已结束。".into());
            }
            Ok(())
        }
        .await;
        match started {
            Ok(()) => Ok(agent),
            Err(e) => {
                // Failed initialization/replay is also a worker lifetime, not
                // just a rejected RPC. Complete its group cleanup before the
                // operation releases its lane or drops its last local owner.
                agent.stop().await;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod eviction_tests {
    use super::*;

    #[tokio::test]
    async fn sweep_rechecks_activity_and_tier_after_waiting_for_allocation() {
        for renew_activity in [true, false] {
            let root = std::env::temp_dir().join(format!("pi-idle-renew-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let service = SessionService::new(
                &root,
                ServiceConfig {
                    command: "unused".into(),
                    args: vec![],
                    env: HashMap::new(),
                    max_workers: 16,
                    idle_ms: 10,
                    harnesses: HashMap::new(),
                },
                Arc::new(|_| {}),
                Arc::new(|_| {}),
            );
            service.initialize().await.unwrap();
            let allocation = service.allocation.lock().await;
            let runtime = |used| {
                Arc::new(Mutex::new(Runtime {
                    snapshot: Snapshot::default(),
                    state: initial_state(),
                    agent: None,
                    phase: Phase::Idle,
                    runs: Default::default(),
                    used,
                    permissions: HashMap::new(),
                    error: None,
                    snapshot_pending: false,
                }))
            };
            let rt = runtime(if renew_activity {
                0
            } else {
                now_ms() - 2 * SHORT_LIFE_MS
            });
            {
                let mut map = service.runtimes.lock_unpoisoned();
                map.insert("target".into(), rt.clone());
                if !renew_activity {
                    for i in 0..LONG_LIFE_WORKERS {
                        map.insert(format!("recent-{i}"), runtime(now_ms()));
                    }
                }
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                while !service.sweeping.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            if renew_activity {
                let mut r = rt.lock_unpoisoned();
                r.phase = Phase::begin();
                r.used = now_ms();
                r.phase = Phase::Idle;
            } else {
                // An earlier allocation operation evicted other runtimes. The
                // target is now in the long-life tier, not the old one-day tier.
                service
                    .runtimes
                    .lock_unpoisoned()
                    .retain(|id, _| id == "target");
            }
            drop(allocation);
            tokio::time::timeout(Duration::from_secs(2), async {
                while service.sweeping.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            assert!(Arc::ptr_eq(
                service.runtimes.lock_unpoisoned().get("target").unwrap(),
                &rt
            ));
            service.dispose().await;
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn idle_eviction_rechecks_busy_under_the_removal_lock() {
        let root = std::env::temp_dir().join(format!("pi-idle-race-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let service = SessionService::new(
            &root,
            ServiceConfig {
                command: "unused".into(),
                args: vec![],
                env: HashMap::new(),
                max_workers: 1,
                idle_ms: 900000,
                harnesses: HashMap::new(),
            },
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );
        service.initialize().await.unwrap();
        let rt = Arc::new(Mutex::new(Runtime {
            snapshot: Snapshot::default(),
            state: initial_state(),
            agent: None,
            phase: Phase::Idle,
            runs: Default::default(),
            used: 0,
            permissions: HashMap::new(),
            error: None,
            snapshot_pending: false,
        }));
        service
            .runtimes
            .lock_unpoisoned()
            .insert("one".into(), rt.clone());
        // Simulate an idle candidate starting work while sweep awaits allocation.
        let allocation = service.allocation.lock().await;
        rt.lock_unpoisoned().phase = Phase::begin();
        service.evict_idle("one", &rt).await;
        assert!(Arc::ptr_eq(
            service.runtimes.lock_unpoisoned().get("one").unwrap(),
            &rt
        ));
        assert!(service.make_room().await.is_err());
        drop(allocation);
        service.dispose().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}
