//! Topic-scoped inline panels. Callback payloads carry short handles, never model IDs or paths.
use super::settings::selectors;
use super::*;

const PANEL_LIMIT: usize = 64;
const PANEL_TTL_MS: u64 = 15 * 60 * 1000;
const PAGE_SIZE: usize = 8;
const DIRECTORY_PROMPT: &str = "请输入服务器上的绝对目录路径，回复这条消息即可。";

#[derive(Clone)]
pub(super) enum View {
    Menu,
    Unbound,
    Settings(String),
    Workspaces,
    Harness {
        cwd: String,
        preferred: String,
    },
    Options {
        session: String,
        config: String,
        page: usize,
    },
    Sessions(usize),
    Connect(String),
    Closed,
}

#[derive(Clone)]
enum Action {
    Show(View),
    Workspace(String),
    Directory,
    Create {
        cwd: String,
        harness: String,
    },
    Set {
        session: String,
        config: String,
        value: String,
    },
    Open(String),
    Notifications(bool),
    Silent(bool),
    Help,
    Status(String),
    Stop(String),
    History(String),
    Sync,
    Close,
}

pub(super) struct Panel {
    key: String,
    user: i64,
    thread: Option<i64>,
    message: i64,
    revision: u64,
    pub(super) expires: u64,
    view: View,
    actions: Vec<Action>,
    reply: Option<i64>,
    waiting_directory: bool,
}

impl Panel {
    fn button(&mut self, label: &str, action: Action) -> Value {
        let index = self.actions.len();
        self.actions.push(action);
        json!({"text":utf16_head(label, 70),"callback_data":format!("ui:{}:{}:{index}",self.key,self.revision)})
    }
}

impl Bridge {
    pub(super) fn general(thread: Option<i64>) -> bool {
        thread.is_none() || thread == Some(1)
    }
    async fn session_bound(&self, id: &str, thread: Option<i64>) -> bool {
        !Self::general(thread)
            && self
                .shared
                .store
                .read()
                .await
                .topics
                .iter()
                .any(|t| Some(t.thread_id) == thread && t.session_id == id)
    }
    async fn view_allowed(&self, view: &View, thread: Option<i64>) -> bool {
        match view {
            View::Settings(id) | View::Options { session: id, .. } => {
                self.session_bound(id, thread).await
            }
            View::Unbound => {
                !Self::general(thread)
                    && !self
                        .shared
                        .store
                        .read()
                        .await
                        .topics
                        .iter()
                        .any(|t| Some(t.thread_id) == thread)
            }
            View::Closed => true,
            _ => Self::general(thread),
        }
    }
    async fn action_allowed(&self, action: &Action, thread: Option<i64>) -> bool {
        match action {
            Action::Show(view) => self.view_allowed(view, thread).await,
            Action::Set { session: id, .. }
            | Action::Status(id)
            | Action::Stop(id)
            | Action::History(id) => self.session_bound(id, thread).await,
            Action::Close => true,
            _ => Self::general(thread),
        }
    }
    pub(super) async fn menu_view(&self, thread: Option<i64>) -> View {
        self.shared
            .store
            .read()
            .await
            .topics
            .iter()
            .find(|topic| Some(topic.thread_id) == thread)
            .map(|topic| View::Settings(topic.session_id.clone()))
            .unwrap_or_else(|| {
                if Self::general(thread) {
                    View::Menu
                } else {
                    View::Unbound
                }
            })
    }

    pub(super) async fn open_panel(
        &self,
        user: i64,
        thread: Option<i64>,
        view: View,
    ) -> Result<(), String> {
        if !self.view_allowed(&view, thread).await {
            return Err("请在 General 中管理会话和全局开关；会话话题只能控制对应 Session。".into());
        }
        let key = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
        let mut panel = Panel {
            key: key.clone(),
            user,
            thread,
            message: 0,
            revision: 0,
            expires: now_ms() + PANEL_TTL_MS,
            view,
            actions: vec![],
            reply: None,
            waiting_directory: false,
        };
        self.render_panel(&mut panel, "").await?;
        let mut panels = self.shared.panels.lock().await;
        if panels.len() >= PANEL_LIMIT {
            panels.shift_remove_index(0);
        }
        panels.insert(key, Arc::new(Mutex::new(panel)));
        Ok(())
    }

    async fn render_panel(&self, panel: &mut Panel, note: &str) -> Result<(), String> {
        panel.revision += 1;
        panel.expires = now_ms() + PANEL_TTL_MS;
        panel.actions.clear();
        let mut rows: Vec<Vec<Value>> = vec![];
        let body = match panel.view.clone() {
            View::Menu => {
                rows.push(vec![
                    panel.button("➕ 新建会话", Action::Show(View::Workspaces)),
                    panel.button("📂 已有会话", Action::Show(View::Sessions(0))),
                ]);
                rows.push(vec![panel.button("同步历史摘要", Action::Sync)]);
                let notifications = self.shared.store.notifications.load(Ordering::SeqCst);
                let silent = self.shared.store.silent.load(Ordering::SeqCst);
                rows.push(vec![panel.button(
                    if notifications {
                        "自动推送：开启"
                    } else {
                        "自动推送：关闭"
                    },
                    Action::Notifications(!notifications),
                )]);
                rows.push(vec![panel.button(
                    if silent {
                        "静音发送：开启"
                    } else {
                        "静音发送：关闭"
                    },
                    Action::Silent(!silent),
                )]);
                rows.push(vec![panel.button("命令帮助", Action::Help)]);
                "Pi Workbench · 管理菜单\n点击按钮创建或打开会话；进入对应话题后直接发文字即可对话。\n自动推送与静音开关作用于所有会话。".into()
            }
            View::Settings(id) => {
                let state = self
                    .shared
                    .host
                    .state(&id)
                    .await
                    .map_err(|e| e.to_string())?;
                let snapshot = &state["snapshot"];
                let controls = selectors(&state);
                let mut body = format!(
                    "会话 {} · {}\nHarness：{}\n项目：{}",
                    snapshot
                        .get("sessionNumber")
                        .and_then(Value::as_u64)
                        .map(|n| format!("#{n}"))
                        .unwrap_or_else(|| id.clone()),
                    utf16_head(
                        snapshot
                            .get("title")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                            .unwrap_or("新对话"),
                        100
                    ),
                    snapshot
                        .get("harness")
                        .and_then(Value::as_str)
                        .unwrap_or("pi"),
                    utf16_head(
                        snapshot
                            .get("cwd")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        400
                    )
                );
                for control in &controls {
                    body.push_str(&format!(
                        "\n{}：{}",
                        control.label,
                        utf16_head(control.current_label(), 150)
                    ));
                    rows.push(vec![panel.button(
                        &format!("选择{}", control.label),
                        Action::Show(View::Options {
                            session: id.clone(),
                            config: control.id.clone(),
                            page: 0,
                        }),
                    )]);
                }
                if !controls.iter().any(|c| c.kind == "model") {
                    body.push_str("\n模型：当前 Agent 未提供可切换选项");
                }
                if !controls.iter().any(|c| c.kind == "thinking") {
                    body.push_str("\n当前模型未提供思考强度选项");
                }
                body.push_str(
                    if state.get("busy").and_then(Value::as_bool) == Some(true) {
                        "\n状态：正在执行"
                    } else {
                        "\n状态：空闲"
                    },
                );
                if state.get("busy").and_then(Value::as_bool) == Some(true) {
                    body.push_str("\n正在执行任务；结束后可修改设置。");
                }
                rows.push(vec![
                    panel.button("状态", Action::Status(id.clone())),
                    panel.button("停止任务", Action::Stop(id.clone())),
                ]);
                rows.push(vec![
                    panel.button("同步最近的消息", Action::History(id.clone()))
                ]);
                rows.push(vec![
                    panel.button("刷新面板", Action::Show(View::Settings(id)))
                ]);
                body
            }
            View::Workspaces => {
                for (label, cwd) in self
                    .shared
                    .host
                    .workspace_choices()
                    .await
                    .map_err(|e| e.to_string())?
                {
                    rows.push(vec![panel.button(&label, Action::Workspace(cwd))]);
                }
                rows.push(vec![panel.button("输入其他目录", Action::Directory)]);
                rows.push(vec![
                    panel.button("返回", Action::Show(View::Menu)),
                    panel.button("取消", Action::Close),
                ]);
                "新建会话 · 选择项目\n选择工作区别名或最近使用的目录，也可以输入服务器上的绝对路径。".into()
            }
            View::Harness { cwd, preferred } => {
                for (id, label) in [("pi", "Pi"), ("codex", "Codex"), ("claude", "Claude")] {
                    rows.push(vec![panel.button(
                        &format!("{}{}", if id == preferred { "✓ " } else { "" }, label),
                        Action::Create {
                            cwd: cwd.clone(),
                            harness: id.into(),
                        },
                    )]);
                }
                rows.push(vec![
                    panel.button("更换目录", Action::Show(View::Workspaces)),
                    panel.button("取消", Action::Close),
                ]);
                format!("新建会话 · 选择 Harness\n项目：{}\n选择后创建会话，沿用该 Harness 保存的模型设置；随后可通过按钮调整。",utf16_head(&cwd,600))
            }
            View::Options {
                session,
                config,
                page,
            } => {
                let state = self
                    .shared
                    .host
                    .state(&session)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(control) = selectors(&state).into_iter().find(|c| c.id == config) {
                    let mut choices = control.choices.clone();
                    choices.sort_by_key(|c| c.id != control.current);
                    let pages = choices.len().max(1).div_ceil(PAGE_SIZE);
                    let page = page.min(pages - 1);
                    for choice in choices.iter().skip(page * PAGE_SIZE).take(PAGE_SIZE) {
                        rows.push(vec![panel.button(
                            &format!(
                                "{}{}",
                                if choice.id == control.current {
                                    "✓ "
                                } else {
                                    ""
                                },
                                choice.label
                            ),
                            Action::Set {
                                session: session.clone(),
                                config: config.clone(),
                                value: choice.id.clone(),
                            },
                        )]);
                    }
                    let mut navigation = vec![];
                    if page > 0 {
                        navigation.push(panel.button(
                            "上一页",
                            Action::Show(View::Options {
                                session: session.clone(),
                                config: config.clone(),
                                page: page - 1,
                            }),
                        ));
                    }
                    if page + 1 < pages {
                        navigation.push(panel.button(
                            "下一页",
                            Action::Show(View::Options {
                                session: session.clone(),
                                config: config.clone(),
                                page: page + 1,
                            }),
                        ));
                    }
                    if !navigation.is_empty() {
                        rows.push(navigation);
                    }
                    rows.push(vec![
                        panel.button("返回会话菜单", Action::Show(View::Settings(session)))
                    ]);
                    format!(
                        "选择{} · 第 {}/{} 页\n当前：{}",
                        control.label,
                        page + 1,
                        pages,
                        utf16_head(control.current_label(), 200)
                    )
                } else {
                    panel.view = View::Settings(session.clone());
                    rows.push(vec![
                        panel.button("刷新面板", Action::Show(View::Settings(session)))
                    ]);
                    "选项已变化，请刷新设置。".into()
                }
            }
            View::Sessions(page) => {
                let sessions = self.shared.host.list().await.map_err(|e| e.to_string())?;
                let pages = sessions.len().max(1).div_ceil(PAGE_SIZE);
                let page = page.min(pages - 1);
                for session in sessions.iter().skip(page * PAGE_SIZE).take(PAGE_SIZE) {
                    rows.push(vec![panel.button(
                        &format!(
                            "#{} · {} · {}",
                            session.session_number.unwrap_or(0),
                            session.harness,
                            session.title
                        ),
                        Action::Open(session.id.clone()),
                    )]);
                }
                let mut navigation = vec![];
                if page > 0 {
                    navigation.push(panel.button("上一页", Action::Show(View::Sessions(page - 1))));
                }
                if page + 1 < pages {
                    navigation.push(panel.button("下一页", Action::Show(View::Sessions(page + 1))));
                }
                if !navigation.is_empty() {
                    rows.push(navigation);
                }
                rows.push(vec![
                    panel.button("新建会话", Action::Show(View::Workspaces)),
                    panel.button("返回", Action::Show(View::Menu)),
                ]);
                format!(
                    "已有会话 · 第 {}/{} 页\n点击会话，进入对应话题继续对话。",
                    page + 1,
                    pages
                )
            }
            View::Connect(id) => {
                if let Some(topic) = self
                    .shared
                    .store
                    .read()
                    .await
                    .topics
                    .iter()
                    .find(|t| t.session_id == id)
                {
                    let chat = self.shared.opts.chat_id.to_string();
                    if let Some(chat) = chat.strip_prefix("-100") {
                        rows.push(vec![json!({"text":"进入会话 Topic", "url":format!("https://t.me/c/{chat}/{}", topic.thread_id)})]);
                    }
                }
                rows.push(vec![panel.button("返回管理菜单", Action::Show(View::Menu))]);
                "会话已连接。进入对应话题后使用 /menu 控制该会话。".into()
            }
            View::Unbound => "此话题未绑定会话。请前往 General，使用 /menu 创建或打开会话。".into(),
            View::Closed => "已取消。使用 /menu 重新打开面板。".into(),
        };
        let body = if note.is_empty() {
            body
        } else {
            format!("{}\n\n{body}", utf16_head(note, 500))
        };
        let mut params = json!({"chat_id":self.shared.opts.chat_id,"text":body,"disable_notification":true,"reply_markup":{"inline_keyboard":rows}});
        if let Some(thread) = panel.thread {
            params["message_thread_id"] = json!(thread);
        }
        if panel.message == 0 {
            let message = self
                .shared
                .api
                .call("sendMessage", params)
                .await
                .map_err(|e| e.message)?;
            panel.message = message
                .get("message_id")
                .and_then(Value::as_i64)
                .ok_or("Telegram 未返回消息 ID")?;
        } else {
            params["message_id"] = json!(panel.message);
            self.shared
                .api
                .call("editMessageText", params)
                .await
                .map_err(|e| e.message)?;
        }
        Ok(())
    }

    async fn select_workspace(&self, panel: &mut Panel, cwd: &str) -> Result<(), String> {
        let cwd = self
            .shared
            .host
            .resolve_workspace(Some(cwd))
            .await
            .map_err(|e| e.to_string())?;
        let preferred = self
            .shared
            .host
            .list()
            .await
            .map_err(|e| e.to_string())?
            .first()
            .map(|s| s.harness.clone())
            .unwrap_or_else(|| "pi".into());
        panel.view = View::Harness { cwd, preferred };
        panel.waiting_directory = false;
        Ok(())
    }

    async fn connect_panel_session(&self, panel: &mut Panel, id: &str) -> Result<(), String> {
        let session = self
            .shared
            .host
            .list()
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or("会话不存在或不在允许的目录范围")?;
        let topic = self.ensure_topic(&session).await.map_err(|e| e.message)?;
        self.open_panel(panel.user, Some(topic), View::Settings(id.into()))
            .await?;
        panel.view = View::Connect(id.into());
        self.send_plain(
            &format!(
                "会话 #{} 已连接到话题。请进入该话题开始对话；设置卡片支持选择模型和思考强度。",
                session.session_number.unwrap_or(0)
            ),
            panel.thread,
        )
        .await
        .map_err(|e| e.message)
    }

    async fn perform_action(&self, panel: &mut Panel, action: Action) -> Result<String, String> {
        panel.waiting_directory = false;
        match action {
            Action::Show(view) => panel.view = view,
            Action::Workspace(cwd) => self.select_workspace(panel, &cwd).await?,
            Action::Directory => {
                let mut params = json!({"chat_id":self.shared.opts.chat_id,"text":DIRECTORY_PROMPT,"disable_notification":true,"reply_markup":{"force_reply":true,"input_field_placeholder":"/home/user/projects/app"}});
                if let Some(thread) = panel.thread {
                    params["message_thread_id"] = json!(thread);
                }
                let sent = self
                    .shared
                    .api
                    .call("sendMessage", params)
                    .await
                    .map_err(|e| e.message)?;
                panel.reply = sent.get("message_id").and_then(Value::as_i64);
                panel.waiting_directory = true;
                return Ok("回复目录提示消息即可；也可以选择下方已有目录。".into());
            }
            Action::Create { cwd, harness } => {
                let session = self
                    .shared
                    .host
                    .create_with_harness(Some(&cwd), &harness)
                    .await
                    .map_err(|e| {
                        format!(
                            "无法创建 {harness} 会话：{e}。请检查服务端的 Agent 安装和登录配置。"
                        )
                    })?;
                panel.view = View::Connect(session.id.clone());
                self.connect_panel_session(panel, &session.id).await?;
            }
            Action::Open(id) => self.connect_panel_session(panel, &id).await?,
            Action::Notifications(on) => {
                self.persist(|s| s.notifications = Some(on)).await?;
                if !on {
                    self.shared.streams.lock().await.clear();
                    self.shared.touched.lock().await.clear();
                }
                panel.view = View::Menu;
                return Ok(if on {
                    "已开启全部会话推送"
                } else {
                    "已暂停全部会话推送"
                }
                .into());
            }
            Action::Silent(on) => {
                self.persist(|s| s.silent = Some(on)).await?;
                panel.view = View::Menu;
                return Ok(if on {
                    "已开启静音发送"
                } else {
                    "已关闭静音发送"
                }
                .into());
            }
            Action::Help => {
                self.send(
                    super::commands::HELP,
                    panel.thread,
                    json!({"disable_notification":true}),
                )
                .await
                .map_err(|e| e.message)?;
                panel.view = View::Menu;
            }
            Action::Set {
                session,
                config,
                value,
            } => {
                panel.view = View::Settings(session.clone());
                let state = self
                    .shared
                    .host
                    .state(&session)
                    .await
                    .map_err(|e| e.to_string())?;
                let queued = self
                    .shared
                    .lanes
                    .lock()
                    .await
                    .get(&session)
                    .is_some_and(|lane| lane.queued.load(Ordering::SeqCst) > 0);
                if state.get("busy").and_then(Value::as_bool) == Some(true)
                    || queued
                    || self.shared.active.lock().await.contains(&session)
                {
                    return Err("任务正在执行或排队，请结束后再修改设置。".into());
                }
                if !selectors(&state)
                    .iter()
                    .any(|s| s.id == config && s.choices.iter().any(|c| c.id == value))
                {
                    return Err("选项已变化，请重新选择。".into());
                }
                self.shared
                    .host
                    .set_config(&session, &config, &value)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok("设置已更新，下面显示实际生效值。".into());
            }
            Action::Status(id) => {
                let state = self
                    .shared
                    .host
                    .status(&id)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(format!(
                    "{}\n{}",
                    if state["busy"] == true {
                        "正在执行"
                    } else {
                        "空闲"
                    },
                    utf16_tail(state["text"].as_str().unwrap_or_default(), 350)
                ));
            }
            Action::Stop(id) => {
                self.shared
                    .host
                    .authorize(&id)
                    .await
                    .map_err(|e| e.to_string())?;
                self.bump_generation(&id).await?;
                self.shared
                    .host
                    .cancel(&id)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok("已请求停止本话题任务并取消排队消息。".into());
            }
            Action::History(id) => {
                self.sync_history(
                    &id,
                    panel.thread.ok_or("请进入会话话题")?,
                    Some(HISTORY_SLICE),
                    false,
                )
                .await?;
                return Ok("已补充最近历史；/history all 可分批获取完整文字历史。".into());
            }
            Action::Sync => {
                self.command_sync(panel.thread).await?;
            }
            Action::Close => panel.view = View::Closed,
        }
        Ok(String::new())
    }

    pub(super) async fn panel_callback(&self, callback: &Value) -> Result<(), String> {
        let callback_id = callback["id"].as_str().unwrap_or_default();
        let parts: Vec<_> = callback["data"]
            .as_str()
            .unwrap_or_default()
            .split(':')
            .collect();
        let invalid = || "此按钮已失效，请用 /menu 重新打开面板。";
        let (Some(key), Some(revision), Some(index)) = (
            parts.get(1),
            parts.get(2).and_then(|s| s.parse::<u64>().ok()),
            parts.get(3).and_then(|s| s.parse::<usize>().ok()),
        ) else {
            self.answer_callback(callback_id, invalid()).await;
            return Ok(());
        };
        let cell = self.shared.panels.lock().await.get(*key).cloned();
        let Some(cell) = cell else {
            self.answer_callback(callback_id, invalid()).await;
            return Ok(());
        };
        let mut panel = cell.lock().await;
        let thread = callback
            .pointer("/message/message_thread_id")
            .and_then(Value::as_i64)
            .filter(|id| *id != 1);
        if parts.len() != 4
            || panel.expires < now_ms()
            || panel.user != callback["from"]["id"].as_i64().unwrap_or(0)
            || panel.thread != thread
            || callback["message"]["message_id"].as_i64() != Some(panel.message)
            || panel.revision != revision
            || index >= panel.actions.len()
        {
            self.answer_callback(callback_id, invalid()).await;
            return Ok(());
        }
        let action = panel.actions[index].clone();
        if !self.view_allowed(&panel.view, panel.thread).await
            || !self.action_allowed(&action, panel.thread).await
        {
            self.answer_callback(callback_id, invalid()).await;
            return Ok(());
        }
        panel.revision += 1; // consume before awaiting: repeated clicks cannot create two sessions
        self.answer_callback(callback_id, "正在处理…").await;
        let note = match self.perform_action(&mut panel, action).await {
            Ok(note) => note,
            Err(error) => error,
        };
        self.render_panel(&mut panel, &note).await
    }

    pub(super) async fn directory_reply(&self, update: &Value) -> Result<bool, String> {
        let message = &update["message"];
        if message
            .pointer("/reply_to_message/text")
            .and_then(Value::as_str)
            != Some(DIRECTORY_PROMPT)
            || message
                .pointer("/reply_to_message/from/id")
                .and_then(Value::as_i64)
                != Some(self.shared.store.read().await.bot_id)
        {
            return Ok(false);
        }
        let reply = message
            .pointer("/reply_to_message/message_id")
            .and_then(Value::as_i64);
        let user = message["from"]["id"].as_i64().unwrap_or(0);
        let thread = thread_of(update);
        let cells: Vec<_> = self.shared.panels.lock().await.values().cloned().collect();
        for cell in cells {
            let mut panel = cell.lock().await;
            if panel.user != user || panel.thread != thread || panel.reply != reply {
                continue;
            }
            if !panel.waiting_directory || panel.expires < now_ms() {
                break;
            }
            let text = message["text"].as_str().unwrap_or_default().trim();
            let note = match self.select_workspace(&mut panel, text).await {
                Ok(()) => String::new(),
                Err(error) => error,
            };
            self.render_panel(&mut panel, &note).await?;
            return Ok(true);
        }
        self.send_plain("此目录输入已失效，请用 /menu 重新开始新建会话。", thread)
            .await
            .map_err(|e| e.message)?;
        Ok(true)
    }
}
