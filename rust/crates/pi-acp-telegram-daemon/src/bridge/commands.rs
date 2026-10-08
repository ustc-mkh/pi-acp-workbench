//! Telegram command parsing, permission gate and dispatch.
use super::*;

impl Bridge {
    pub(super) async fn dispatch_command(
        &self,
        command: Option<&str>,
        argument: Option<&str>,
        binding: Option<&Topic>,
        thread_id: Option<i64>,
        parsed: &Option<(String, Option<String>, Option<String>)>,
        text: &str,
    ) -> Result<(), String> {
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
                .send(HELP, thread_id, json!({ "disable_notification": true }))
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
}

/// `/cmd@bot args` — same shape as the TS regex `^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$`.
pub(super) fn parse_command(text: &str) -> Option<(String, Option<String>, Option<String>)> {
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
/sessions — 列出最近 50 个会话
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

在会话话题直接发文字即可对话。其他命令（如 /compact）原样转交当前 Agent；可用命令取决于 Agent 配置。";
