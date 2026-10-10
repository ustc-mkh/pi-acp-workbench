//! Turn execution, cancellation, publications and workspace diff.
use super::*;
use pi_acp_core::sync::MutexExt;

impl SessionService {
    pub(super) async fn with_worker<'a, F>(
        &'a self,
        id: &'a str,
        operation: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Rt, Arc<AgentProcess>) -> OpFuture<'a>,
    {
        let rt = self.runtime(id).await?;
        let guarded = pi_acp_core::panic_guard::run(async {
            let agent = self.worker(&rt).await?;
            rt.lock_unpoisoned().error = None;
            if rt.lock_unpoisoned().phase.cancelled() || self.closed.load(Ordering::SeqCst) {
                return Ok(json!({ "stopReason": "cancelled" }));
            }
            operation(rt.clone(), agent).await
        })
        .await;
        let panicked = guarded.is_err();
        let result = guarded
            .unwrap_or_else(|_| Err("会话处理异常，工作进程已关闭；未自动重放任务。".into()));
        if panicked || rt.is_poisoned() {
            // Restore only this runtime from its last committed snapshot. Do not
            // continue with partially mutated state after an unwound callback.
            let (agent, committed) = {
                let mut r = rt.lock_unpoisoned();
                r.snapshot_pending = false;
                (r.agent.take(), r.snapshot.clone())
            };
            rt.clear_poison();
            if let Some(agent) = agent {
                agent.stop().await;
            }
            let restored = match self.store.read(&committed).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    // Storage failed closed: remove this unusable runtime so
                    // subsequent state reads report the disk error directly.
                    self.exclusive(|| async { self.evict(id, &rt).await }).await;
                    return Err(error);
                }
            };
            rt.lock_unpoisoned().state = ChatState {
                entries: restored.entries,
                configs: restored.configs,
                modes: restored.modes,
                commands: restored.commands.unwrap_or_default(),
                native_forks: restored.native_forks,
                usage: restored.usage,
                usage_records: restored.usage_records,
                ..Default::default()
            };
        }
        if let Err(error) = &result {
            let publication = {
                let mut r = rt.lock_unpoisoned();
                r.error = Some(error.clone());
                r.phase.take_publication()
            };
            if let Some(publication) = publication {
                let _ = publication.finish(Some(error.clone()), None).await;
            }
        }
        {
            let mut r = rt.lock_unpoisoned();
            if let Some(active) = r.phase.active_mut() {
                active.step = Step::Finishing;
            }
            r.phase.stop_cancel_timer();
            for (_, settle) in r.permissions.drain() {
                let _ = settle.send(None);
            }
            r.phase = Phase::Idle;
            r.used = now_ms();
        }
        self.emit(&rt);
        result
    }

    pub(super) fn run_command<'a>(
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
                    self.prompt(&rt, &agent, session_id, prompt, source.as_str(), request_id)
                        .await
                }
                ServiceCommand::Request { .. } => self.agent_request(&rt, &agent, command).await,
                _ => Err("无效会话操作".into()),
            }
        })
    }

    pub(super) async fn agent_request(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        command: &ServiceCommand,
    ) -> Result<Value, String> {
        let ServiceCommand::Request {
            request,
            session_id,
        } = command
        else {
            return Err("无效 ACP 操作".into());
        };
        let harness = rt
            .lock_unpoisoned()
            .snapshot
            .harness
            .clone()
            .unwrap_or_default();
        let method = request.method();
        if method.starts_with("_pi_workbench/") {
            let info = agent.info().await.unwrap_or(Value::Null);
            let capability = if method == "_pi_workbench/inspect" {
                "inspect"
            } else {
                "nativeFork"
            };
            if info.pointer(&format!(
                "/agentCapabilities/_meta/pi-workbench/{capability}"
            )) != Some(&Value::Bool(true))
            {
                return Err("当前 ACP 适配器不支持此扩展操作".into());
            }
        }
        if harness == "codex"
            && matches!(request, AgentRequest::SetConfig { config_id, value } if config_id == "collaboration_mode" && value != "default")
        {
            return Err("Codex 仅支持默认协作模式".into());
        }
        let params = request.params();
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
                let r = rt.lock_unpoisoned();
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
            let mut r = rt.lock_unpoisoned();
            r.state.native_forks = Some(bind_native_forks(
                &r.state.entries,
                &points,
                &r.state.native_forks.clone().unwrap_or_default(),
            ));
            if let Some(cw) = result.get("contextWindow").and_then(Value::as_u64) {
                if cw > 0 {
                    r.snapshot.context_window = Some(cw);
                    if let Some(Value::Object(usage)) = &mut r.state.usage {
                        usage.insert("size".into(), json!(cw));
                    }
                }
            }
        }
        if method == "session/set_config_option" {
            rt.lock_unpoisoned().state.configs = result
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned();
        }
        if method == "session/set_mode" {
            if let Some(Value::Object(modes)) = &mut rt.lock_unpoisoned().state.modes {
                if let Some(mode_id) = params.get("modeId").cloned() {
                    modes.insert("currentModeId".into(), mode_id);
                }
            }
        }
        self.save(rt).await?;
        if matches!(method, "session/set_config_option" | "session/set_mode") {
            let state = rt.lock_unpoisoned().state.clone();
            self.preferences.save(&harness, &state).await?;
        }
        Ok(result)
    }

    pub(super) async fn prompt(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        session_id: &str,
        prompt: &[Value],
        source: &str,
        request_id: &str,
    ) -> Result<Value, String> {
        let harness = rt
            .lock_unpoisoned()
            .snapshot
            .harness
            .clone()
            .unwrap_or_default();
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
            return Err("当前 ACP 适配器不支持图片".into());
        }
        let prefs_state = rt.lock_unpoisoned().state.clone();
        self.preferences.save(&harness, &prefs_state).await?;
        let settings_before = {
            let r = rt.lock_unpoisoned();
            serde_json::to_string(
                &model_preferences(&r.state)
                    .iter()
                    .map(|p| json!({"kind":p.kind,"value":p.value}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        };
        {
            let mut r = rt.lock_unpoisoned();
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
        let start = rt.lock_unpoisoned().state.entries.len();
        self.emit(rt);
        let cwd = rt.lock_unpoisoned().snapshot.cwd.clone();
        {
            let accessor: StateAccessor = {
                let weak = Arc::downgrade(rt);
                Arc::new(move || {
                    weak.upgrade().map(|rt| {
                        let r = rt.lock_unpoisoned();
                        (
                            r.snapshot.id.clone(),
                            None,
                            r.state.entries.clone(),
                            r.state.permissions.len(),
                        )
                    })
                })
            };
            let publication = TurnPublication::new(
                self.events.clone(),
                accessor,
                cwd.clone(),
                start,
                format!("service:{request_id}"),
                source.to_string(),
                crate::outbox::PublicationControl {
                    report: self.report.clone(),
                    closed: self.closed.clone(),
                },
            );
            let mut r = rt.lock_unpoisoned();
            let Some(active) = r.phase.active_mut() else {
                return Err("会话操作已结束，未启动本轮任务。".into());
            };
            active.publication = Some(publication);
        }
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
                                let mut r = service_rt.lock_unpoisoned();
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
            if let Some(active) = rt.lock_unpoisoned().phase.active_mut() {
                active.step = Step::Prompting;
            } else {
                return Err("会话操作已结束。".into());
            }
            let outcome =
                if rt.lock_unpoisoned().phase.cancelled() || self.closed.load(Ordering::SeqCst) {
                    Ok(json!({ "stopReason": "cancelled" }))
                } else {
                    agent.prompt(session_id, prompt.to_vec()).await
                };
            match outcome {
                Ok(result) => {
                    {
                        let mut r = rt.lock_unpoisoned();
                        let snapshot = r.snapshot.clone();
                        crate::usage::capture(
                            &snapshot,
                            &mut r.state,
                            &result,
                            request_id,
                            now_ms(),
                        );
                    }
                    if result.get("stopReason").and_then(Value::as_str) != Some("end_turn") {
                        let reason = result
                            .get("stopReason")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        rt.lock_unpoisoned().state.entries.push(Entry::text_entry(
                            next_id(),
                            "notice",
                            format!("本轮结束：{reason}"),
                        ));
                    }
                    Ok(result)
                }
                Err(error) => {
                    let cancelled = rt.lock_unpoisoned().phase.cancelled();
                    let mut r = rt.lock_unpoisoned();
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
            let mut r = rt.lock_unpoisoned();
            if let Some(active) = r.phase.active_mut() {
                active.step = Step::Finishing;
            }
            r.phase.stop_cancel_timer();
        }
        if agent.is_closed() {
            agent.stop().await;
        }
        let diff_entry = changes.finish().await;
        rt.lock_unpoisoned().state.entries.push(diff_entry);
        ckpt_cancel.cancel();
        let _ = checkpoint.await;
        if let Some(error) = rt.lock_unpoisoned().error.clone() {
            result = Err(error);
        }
        self.save(rt).await?;
        let settings_after = {
            let r = rt.lock_unpoisoned();
            serde_json::to_string(
                &model_preferences(&r.state)
                    .iter()
                    .map(|p| json!({"kind":p.kind,"value":p.value}))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        };
        if settings_before != settings_after {
            let state = rt.lock_unpoisoned().state.clone();
            self.preferences.save(&harness, &state).await?;
        }
        let publication = rt.lock_unpoisoned().phase.take_publication();
        if let Some(publication) = publication {
            let (error, stop_reason) = {
                let r = rt.lock_unpoisoned();
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

    pub(super) async fn cancel(&self, id: &str) -> bool {
        self.queue.cancel(id).await;
        let rt = self.runtimes.lock_unpoisoned().get(id).cloned();
        let Some(rt) = rt else { return false };
        let (token, prompting, agent) = {
            let mut r = rt.lock_unpoisoned();
            if !r.phase.busy() {
                return false;
            }
            r.phase.stop_cancel_timer();
            let Some(active) = r.phase.active_mut() else {
                return false;
            };
            active.cancelled = true;
            for (_, settle) in r.permissions.drain() {
                let _ = settle.send(None);
            }
            r.state.permissions.clear();
            (
                r.phase.token(),
                r.phase.at(Step::Prompting),
                r.agent.clone(),
            )
        };
        // 5 s escalation: still busy with the SAME agent → dispose the worker.
        let weak = Arc::downgrade(&rt);
        let reference = agent.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(rt) = weak.upgrade() else { return };
            let kill = {
                let r = rt.lock_unpoisoned();
                r.phase.token() == token
                    && reference.is_some()
                    && r.agent
                        .as_ref()
                        .zip(reference.as_ref())
                        .map(|(a, b)| Arc::ptr_eq(a, b))
                        .unwrap_or(false)
            };
            if kill {
                if let Some(agent) = rt.lock_unpoisoned().agent.take() {
                    agent.dispose();
                }
            }
        });
        {
            let mut r = rt.lock_unpoisoned();
            if r.phase.token() == token {
                if let Some(active) = r.phase.active_mut() {
                    active.cancel_task = Some(task);
                } else {
                    task.abort();
                }
            } else {
                task.abort();
            }
        }
        if prompting {
            if let Some(agent) = agent {
                agent.cancel(id).await;
            }
        }
        true
    }

    pub(super) async fn save(&self, rt: &Rt) -> Result<(), String> {
        save_snapshot(&self.store, rt).await
    }

    pub(super) fn emit(&self, rt: &Rt) {
        let event = view_state_with_type(&rt.lock_unpoisoned());
        (self.broadcast)(event);
    }
}
