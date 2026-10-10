//! Telegram command parsing, permission gate and dispatch.
use super::*;

impl Bridge {
    pub(super) async fn dispatch_command(
        &self,
        user_id: i64,
        command: Option<&str>,
        argument: Option<&str>,
        binding: Option<&Topic>,
        thread_id: Option<i64>,
        text: &str,
    ) -> Result<(), String> {
        if command == Some("settings") {
            return self
                .send_plain("/settings 已移除，请使用 /menu。", thread_id)
                .await
                .map_err(|e| e.message);
        }
        if matches!(
            command,
            Some("new" | "open" | "sessions" | "sync" | "silent" | "notifications")
        ) && !Self::general(thread_id)
        {
            return self
                .send_plain(
                    "请在 General 使用 /menu 管理会话、同步摘要和全局开关。",
                    thread_id,
                )
                .await
                .map_err(|e| e.message);
        }
        // Session-bound commands share one policy gate. Sessions also checks
        // at RPC boundaries so callbacks and queued work cannot bypass it.
        if !matches!(
            command,
            Some(
                "start"
                    | "help"
                    | "commands"
                    | "new"
                    | "open"
                    | "sessions"
                    | "sync"
                    | "menu"
                    | "silent"
                    | "notifications"
            )
        ) {
            if let Some(binding) = binding {
                self.shared
                    .host
                    .authorize(&binding.session_id)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        match command {
            Some("start" | "help" | "commands") => self
                .help_panel(user_id, thread_id).await,
            Some("menu") => self.open_panel(user_id, thread_id, self.menu_view(thread_id).await).await,
            Some("silent") => self.silent_menu(thread_id).await.map_err(|e| e.message),
            Some("notifications") => self
                .notification_menu(thread_id)
                .await
                .map_err(|e| e.message),
            Some("sync") => self
                .command_sync(thread_id)
                .await
                .map(|_| ()),
            Some("syncall") => self.send_plain("/syncall 已移除。使用 /sync 同步摘要，在会话话题使用 /history 或 /history all 获取更多历史。", thread_id).await.map_err(|e| e.message),
            Some("history") => {
                let Some(binding) = binding else {
                    return Err("请先用 /open 编号进入会话话题。".into());
                };
                self.sync_history(
                    &binding.session_id,
                    thread_id.unwrap_or(0),
                    if argument == Some("all") { None } else { Some(HISTORY_SLICE) },
                    false,
                )
                .await
            }
            Some("interrupt") => {
                let (Some(binding), Some(argument)) = (binding, argument) else {
                    return Err("用法：/interrupt 要发送的新消息".into());
                };
                self.bump_generation(&binding.session_id).await?;
                let _ = self.shared.host.cancel(&binding.session_id).await;
                self.enqueue(&binding.session_id, binding.thread_id, argument.to_string())
                    .await
            }
            Some("stop") => {
                let stopped = if let Some(binding) = binding {
                    self.bump_generation(&binding.session_id).await?;
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
                    .unwrap_or(0)
                    + self
                        .shared
                        .store
                        .read()
                        .await
                        .inbox
                        .iter()
                        .filter(|item| {
                            item.phase == InboxPhase::Pending
                                && item.ordered()
                                && thread_of(&item.update) == Some(binding.thread_id)
                        })
                        .count();
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
                if command == Some("new") {
                    let view = if let Some(workspace) = argument {
                        let cwd = self.shared.host.resolve_workspace(Some(workspace)).await.map_err(|e| e.to_string())?;
                        ui::View::Harness { cwd, preferred: "pi".into() }
                    } else { ui::View::Workspaces };
                    return self.open_panel(user_id, thread_id, view).await;
                }
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
                .map_err(|e| e.message)?;
                self.open_panel(user_id, Some(topic), ui::View::Settings(session.id.clone())).await
            }
            _ => {
                let Some(binding) = binding else {
                    return Err(
                        "此话题尚未绑定会话，请先发送 /new 或 /open 编号，再进入新话题。".into(),
                    );
                };
                let prompt = if let Some((cmd, _bot, _)) = parse_command(text) {
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
}

pub(super) const HELP: &str = "会话与历史
/menu — General：管理会话与全局开关；会话 Topic：模型、思考强度和本会话控制
/new [绝对路径或工作区名] — General 中打开新建向导，选择项目和 Harness
/sessions — General 中列出最近 50 个会话
/open 编号或 Session ID — General 中打开已有会话话题
/sync — General 中同步摘要：最新 5 个会话各取最后 10 条，其余各取最后 2 条（含图片）
/history — 同步本话题最近 20 条消息（含支持的图片）
/history all — 同步本话题完整历史，每次最多 100 条

任务控制
/status — 查看本话题状态、当前回复和待授权操作
/stop — 停止本话题任务并取消排队消息
/interrupt 新消息 — 停止当前任务后发送新指令
/notifications — General 中调整自动投递总开关（默认开启）；关闭后暂停自动回复和授权卡片
/silent — General 中调整静音发送（默认关闭）；保留消息，仅关闭通知声音

帮助
/help 或 /commands — 显示全部服务命令
/start — 显示本帮助

在会话话题直接发文字即可对话。其他命令（如 /compact）原样转交当前 Agent；可用命令取决于 Agent 配置。";

impl Bridge {
    async fn help_panel(&self, user: i64, thread: Option<i64>) -> Result<(), String> {
        self.send(HELP, thread, json!({"disable_notification":true}))
            .await
            .map_err(|e| e.message)?;
        self.open_panel(user, thread, self.menu_view(thread).await)
            .await
    }
    pub(super) async fn dispatch(&self, update: &Value) -> Result<(), String> {
        if self.shared.opts.stop.is_cancelled() {
            return Ok(());
        }
        let callback = update.get("callback_query");
        let message = callback
            .and_then(|c| c.get("message"))
            .or_else(|| update.get("message"));
        let Some(message) = message else {
            return Ok(());
        };
        if !self.authorized(update) {
            return Ok(());
        }
        let thread_id = thread_of(update);
        if let Some(callback) = callback {
            let data = callback.get("data").and_then(Value::as_str).unwrap_or("");
            let callback_id = callback
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if data.starts_with("ui:") {
                if let Err(error) = self.panel_callback(callback).await {
                    self.report(&error).await;
                    let _ = self
                        .send_plain(
                            &format!("面板操作失败：{error}。使用 /menu 重新打开。"),
                            thread_id,
                        )
                        .await;
                }
                return Ok(());
            }
            if matches!(
                data,
                "notify:on" | "notify:off" | "silent:on" | "silent:off"
            ) && !Self::general(thread_id)
            {
                self.answer_callback(callback_id, "全局开关仅可在 General 操作，请使用 /menu。")
                    .await;
                return Ok(());
            }
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
        let relay_reply = parsed.as_ref().is_some_and(|(cmd, _, _)| {
            matches!(
                cmd.to_ascii_lowercase().as_str(),
                "menu"
                    | "settings"
                    | "new"
                    | "open"
                    | "start"
                    | "help"
                    | "commands"
                    | "stop"
                    | "interrupt"
                    | "status"
                    | "sessions"
                    | "sync"
                    | "syncall"
                    | "history"
            )
        });
        if !relay_reply && self.directory_reply(update).await? {
            return Ok(());
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
            .store
            .read()
            .await
            .topics
            .iter()
            .find(|t| Some(t.thread_id) == thread_id)
            .cloned();
        // Release the control slot after cancellation; the replacement prompt waits durably
        // in the ordinary lane instead of occupying a control slot for the whole model turn.
        if command.as_deref() == Some("interrupt") {
            if let (Some(binding), Some(argument), Some(id)) = (
                binding.as_ref(),
                argument.as_ref(),
                update.get("update_id").and_then(Value::as_i64),
            ) {
                self.shared
                    .host
                    .authorize(&binding.session_id)
                    .await
                    .map_err(|e| e.to_string())?;
                self.bump_generation(&binding.session_id).await?;
                self.shared
                    .host
                    .cancel(&binding.session_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut deferred = false;
                self.persist(|s| {
                    if let Some(item) = s.inbox.iter_mut().find(|i| i.id == id) {
                        item.prompt = Some(argument.clone());
                        item.phase = InboxPhase::Pending;
                        deferred = true;
                    }
                })
                .await?;
                if deferred {
                    return Ok(());
                }
            }
        }
        match self
            .dispatch_command(
                message["from"]["id"].as_i64().unwrap_or(0),
                command.as_deref(),
                argument.as_deref(),
                binding.as_ref(),
                thread_id,
                text,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                self.report(&error).await;
                if command.is_some() || self.shared.store.notifications.load(Ordering::SeqCst) {
                    let _ = self.send_plain(&error, thread_id).await;
                }
                Ok(())
            }
        }
    }
}
