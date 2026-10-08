//! Session creation, cold reads, settings and shared history operations.
use super::*;
use pi_acp_core::sync::MutexExt;

impl SessionService {
    pub async fn list(&self) -> Result<Vec<Snapshot>, String> {
        self.store.list().await
    }

    pub(super) async fn index(&self, id: &str) -> Result<Snapshot, String> {
        self.list()
            .await?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| "会话不存在".to_string())
    }

    pub async fn state(&self, id: &str) -> Result<Value, String> {
        let index = self.index(id).await?;
        if let Some(rt) = self.runtimes.lock_unpoisoned().get(id).cloned() {
            return Ok(view_state(&rt.lock_unpoisoned()));
        }
        let mut snapshot = self.store.read(&index).await?;
        snapshot.usage_records.clear();
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
            "commands": snapshot.commands.clone().unwrap_or_default(), "plan": [],
        });
        if interrupted {
            out["error"] = json!("上次任务被服务中断，未自动重放。");
        }
        Ok(out)
    }

    pub(super) async fn execute_session(
        &self,
        command: &ServiceCommand,
        request_id: &str,
    ) -> Result<Value, String> {
        let id = command_session_id(command);
        let index = self.index(id).await?;
        if let ServiceCommand::Request {
            request: AgentRequest::Inspect { cursor, .. },
            ..
        } = command
        {
            if matches!(index.harness.as_deref(), Some("codex" | "claude")) {
                let rt = self.runtimes.lock_unpoisoned().get(id).cloned();
                let snapshot = if let Some(rt) = rt {
                    let r = rt.lock_unpoisoned();
                    let mut snapshot = r.snapshot.clone();
                    snapshot.usage = r.state.usage.clone();
                    snapshot.usage_records = r.state.usage_records.clone();
                    snapshot
                } else {
                    self.store.read(&index).await?
                };
                return crate::usage::inspect(&snapshot, *cursor);
            }
        }
        match command {
            ServiceCommand::State { .. } => self.state(id).await,
            ServiceCommand::Permission {
                permission_id,
                option_id,
                ..
            } => {
                let rt = self.runtimes.lock_unpoisoned().get(id).cloned();
                let Some(rt) = rt else {
                    return Ok(Value::Bool(false));
                };
                let sender = {
                    let mut r = rt.lock_unpoisoned();
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
                    let rt = self.runtimes.lock_unpoisoned().get(id).cloned();
                    if let Some(rt) = rt {
                        self.evict(id, &rt).await;
                    }
                    self.store.remove(id).await
                })
                .await?;
                Ok(Value::Null)
            }
            ServiceCommand::Request {
                request: AgentRequest::CancelFork {},
                ..
            } => {
                let agent = self
                    .runtimes
                    .lock_unpoisoned()
                    .get(id)
                    .and_then(|rt| rt.lock_unpoisoned().agent.clone());
                match agent {
                    Some(agent) => {
                        if agent
                            .info()
                            .await
                            .unwrap_or(Value::Null)
                            .pointer("/agentCapabilities/_meta/pi-workbench/nativeFork")
                            != Some(&Value::Bool(true))
                        {
                            return Err("当前 ACP 适配器不支持此扩展操作".into());
                        }
                        agent
                            .request("_pi_workbench/cancel_fork", json!({ "sessionId": id }))
                            .await
                    }
                    None => Ok(json!({})),
                }
            }
            ServiceCommand::Request {
                request: AgentRequest::Inspect { force: false, .. },
                ..
            } => {
                let has_agent = self
                    .runtimes
                    .lock_unpoisoned()
                    .get(id)
                    .is_some_and(|rt| rt.lock_unpoisoned().agent.is_some());
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

    pub(super) async fn save_fork(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        new_id: String,
        index: usize,
    ) -> Result<(), String> {
        let mut snapshot = {
            let r = rt.lock_unpoisoned();
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
        rt.lock_unpoisoned().agent = None;
        let transient_state = Arc::new(Mutex::new(initial_state()));
        let fork = self.spawn_transient(
            Harness::parse(snapshot.harness.as_deref().unwrap_or(""))?,
            &snapshot.cwd,
            transient_state,
        )?;
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

    /// historyRemove {sessionId?}: remove one index entry (evicting a live
    /// runtime first), or clear the whole index when sessionId is absent.
    pub(super) async fn history_remove(&self, id: Option<&str>) -> Result<(), String> {
        match id {
            None => {
                // Collect inside exclusive(): a runtime created between
                // snapshotting and allocation would escape eviction and be
                // tombstoned by clear() while still holding its lease.
                self.exclusive(|| async {
                    let runtimes: Vec<(String, Arc<Mutex<Runtime>>)> = self
                        .runtimes
                        .lock_unpoisoned()
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    for (sid, rt) in runtimes {
                        self.evict(&sid, &rt).await;
                    }
                    self.store.clear().await
                })
                .await
            }
            Some(id) => {
                if !self.store.list().await?.iter().any(|s| s.id == id) {
                    return Err("会话不存在".into());
                }
                self.exclusive(|| async {
                    let rt = self.runtimes.lock_unpoisoned().get(id).cloned();
                    if let Some(rt) = rt {
                        self.evict(id, &rt).await;
                    }
                    self.store.remove(id).await
                })
                .await
            }
        }
    }

    pub(super) async fn create(&self, directory: &str, harness: Harness) -> Result<Value, String> {
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
            let agent = self.spawn_transient(harness, &cwd, initial.clone())?;
            let result = async {
                agent.initialize().await?;
                let preferences = self.preferences.read(harness.name()).await?;
                let mut session = agent.create_session(None).await?;
                agent.configure_session(&mut session).await?;
                let warning = apply_preferences(agent.as_ref(), &mut session, &preferences).await?;
                if warning.is_none() {
                    let prefs_state = ChatState {
                        configs: session
                            .get("configOptions")
                            .and_then(Value::as_array)
                            .cloned(),
                        modes: session.get("modes").cloned(),
                        ..Default::default()
                    };
                    self.preferences.save(harness.name(), &prefs_state).await?;
                }
                let session_id = session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let commands_cache = initial.lock_unpoisoned().commands.clone();
                self.store.claim(&session_id).await?;
                let written = self
                    .store
                    .write(&Snapshot {
                        id: session_id.clone(),
                        cwd,
                        harness: Some(harness.name().into()),
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
}
