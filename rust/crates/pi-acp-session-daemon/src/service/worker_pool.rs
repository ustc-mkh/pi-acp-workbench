//! Worker allocation, replay, eviction and notification delivery.
use super::*;

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
                let idle: Vec<(String, Rt)> = {
                    let map = service.runtimes.lock().unwrap();
                    map.iter()
                        .filter(|(_, r)| {
                            let r = r.lock().unwrap();
                            !r.phase.busy()
                                && now_ms().saturating_sub(r.used) >= service.config.idle_ms
                        })
                        .map(|(id, r)| (id.clone(), r.clone()))
                        .collect()
                };
                {
                    let _guard = service.allocation.lock().await;
                    for (id, rt) in idle {
                        if !rt.lock().unwrap().phase.busy() {
                            service.evict(&id, &rt).await;
                        }
                    }
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
        let agent = rt.lock().unwrap().agent.take();
        if let Some(agent) = agent {
            agent.stop().await;
        }
        self.runtimes.lock().unwrap().remove(id);
        self.store.release(id).await;
    }

    pub(super) async fn make_room(&self) -> Result<(), String> {
        if self.runtimes.lock().unwrap().len() < self.config.max_workers {
            return Ok(());
        }
        let idle = {
            let map = self.runtimes.lock().unwrap();
            map.iter()
                .filter(|(_, r)| !r.lock().unwrap().phase.busy())
                .min_by_key(|(_, r)| r.lock().unwrap().used)
                .map(|(id, rt)| (id.clone(), rt.clone()))
        };
        let Some((id, rt)) = idle else {
            return Err("工作进程均忙碌".into());
        };
        self.evict(&id, &rt).await;
        Ok(())
    }

    pub(super) fn agent_env(&self) -> HashMap<String, String> {
        let mut env = self.config.env.clone();
        env.insert("PI_TELEGRAM_BOT_TOKEN".into(), String::new());
        env
    }

    /// spawn() for a live runtime — update/permission/closed callbacks wired to it.
    pub(super) fn spawn_agent(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
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
                        if r.phase.at(Step::Replaying) {
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
                        if let Some(publication) = r
                            .phase
                            .active()
                            .and_then(|active| active.publication.as_ref())
                        {
                            publication.update();
                        }
                        json!({ "type": "update", "notification": notification })
                    };
                    broadcast(event);
                    // Coalesce authoritative snapshots; raw ACP events remain
                    // available to protocol consumers, while desktop clients
                    // never need to regenerate entry IDs or reduce Pi events.
                    let schedule = {
                        let mut r = rt.lock().unwrap();
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
                                    let mut r = rt.lock().unwrap();
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
    pub(super) fn spawn_transient(
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

    pub(super) async fn runtime(&self, id: &str) -> Result<Rt, String> {
        let _guard = self.allocation.lock().await;
        if let Some(rt) = self.runtimes.lock().unwrap().get(id).cloned() {
            {
                let mut r = rt.lock().unwrap();
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
                let rt = Arc::new(Mutex::new(Runtime {
                    snapshot: Snapshot {
                        entries: vec![],
                        ..snapshot
                    },
                    state,
                    agent: None,
                    phase: Phase::begin(),
                    used: now_ms(),
                    permissions: HashMap::new(),
                    snapshot_pending: false,
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

    pub(super) async fn worker(&self, rt: &Rt) -> Result<Arc<AgentProcess>, String> {
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
            rt.lock().unwrap().phase.active_mut().step = Step::Replaying;
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
            if session.get("modes").is_some_and(js_truthy_value) {
                r.state.modes = session.get("modes").cloned();
            }
            r.phase.active_mut().step = Step::Preparing;
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
}
