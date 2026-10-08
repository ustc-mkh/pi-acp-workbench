//! Permission ticket lifecycle and notification menus.
use super::*;

impl Bridge {
    pub(super) async fn show_permission(
        &self,
        session_id: &str,
        thread_id: i64,
        permission: Value,
    ) {
        let permission_id = permission
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let options: Vec<Value> = permission
            .pointer("/request/options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let key = {
            let mut tickets = self.shared.tickets.lock().await;
            let now = now_ms();
            tickets.retain(|_, t| t.expires > now);
            let mut opts: Vec<Option<String>> = options
                .iter()
                .filter_map(|o| {
                    o.get("optionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .map(Some)
                .collect();
            opts.push(None);
            let existing = tickets
                .iter()
                .find(|(_, t)| {
                    t.session_id == session_id
                        && t.permission_id == permission_id
                        && t.thread_id == thread_id
                })
                .map(|(k, _)| k.clone());
            if let Some(k) = existing {
                // Refresh the option list on the same ticket, keeping its expiry.
                if let Some(ticket) = tickets.get_mut(&k) {
                    ticket.options = opts;
                }
                k
            } else {
                let key = hex::encode(&uuid::Uuid::new_v4().as_bytes()[..10]);
                if tickets.len() >= TICKET_LIMIT {
                    tickets.shift_remove_index(0);
                }
                tickets.insert(
                    key.clone(),
                    Ticket {
                        session_id: session_id.to_string(),
                        permission_id,
                        thread_id,
                        options: opts,
                        expires: now + TICKET_TTL_MS,
                    },
                );
                key
            }
        };
        let mut keyboard: Vec<Value> = options
            .iter()
            .enumerate()
            .map(|(i, o)| {
                json!([{ "text": utf16_head(o.get("name").and_then(Value::as_str).unwrap_or("允许"), 60), "callback_data": format!("p:{key}:{i}") }])
            })
            .collect();
        let cancel_index = options.len();
        keyboard
            .push(json!([{ "text": "取消", "callback_data": format!("p:{key}:{cancel_index}") }]));
        let title = permission
            .pointer("/request/toolCall/title")
            .and_then(Value::as_str)
            .unwrap_or("工具操作");
        let detail = utf16_head(
            &serde_json::to_string_pretty(
                permission
                    .pointer("/request/toolCall")
                    .unwrap_or(&Value::Null),
            )
            .unwrap_or_default(),
            2600,
        );
        if let Err(e) = self
            .send(
                &format!("需要授权：{title}\n{detail}"),
                Some(thread_id),
                json!({ "reply_markup": { "inline_keyboard": keyboard } }),
            )
            .await
        {
            self.report(&e.message).await;
        }
    }

    pub(super) async fn answer_permission(
        &self,
        callback_id: &str,
        data: &str,
        thread_id: Option<i64>,
    ) {
        let accepted = async {
            let parts: Vec<&str> = data.split(':').collect();
            if parts.len() != 3 || parts[0] != "p" || parts[1].len() != 20 {
                return false;
            }
            let index: usize = match parts[2].parse() {
                Ok(i) => i,
                Err(_) => return false,
            };
            let ticket = {
                let tickets = self.shared.tickets.lock().await;
                tickets.get(parts[1]).and_then(|t| {
                    (Some(t.thread_id) == thread_id
                        && t.expires > now_ms()
                        && index < t.options.len())
                    .then(|| {
                        (
                            t.session_id.clone(),
                            t.permission_id.clone(),
                            t.options[index].clone(),
                        )
                    })
                })
            };
            let Some((session_id, permission_id, option)) = ticket else {
                return false;
            };
            match self
                .shared
                .host
                .permission(&session_id, &permission_id, option.as_deref())
                .await
            {
                Ok(true) => {
                    self.shared.tickets.lock().await.shift_remove(parts[1]);
                    true
                }
                _ => false,
            }
        }
        .await;
        self.answer_callback(
            callback_id,
            if accepted {
                "已提交"
            } else {
                "授权已失效或不属于此话题。"
            },
        )
        .await;
    }

    pub(super) async fn answer_callback(&self, callback_id: &str, text: &str) {
        let _ = self
            .shared
            .api
            .call(
                "answerCallbackQuery",
                json!({ "callback_query_id": callback_id, "text": text }),
            )
            .await;
    }

    pub(super) async fn notification_menu(&self, thread_id: Option<i64>) -> Result<(), ApiError> {
        let on = self.shared.store.notifications.load(Ordering::SeqCst);
        self.send(
            &format!(
                "全部会话自动推送（默认开启）：{}。关闭时不发送自动回复、完成通知或授权卡片；可用 /history、/status 主动查看。",
                if on { "开启" } else { "关闭" }
            ),
            thread_id,
            json!({
                "disable_notification": true,
                "reply_markup": { "inline_keyboard": [[{ "text": if on { "暂停全部推送" } else { "开启全部推送" }, "callback_data": if on { "notify:off" } else { "notify:on" } }]] },
            }),
        )
        .await
    }

    pub(super) async fn silent_menu(&self, thread_id: Option<i64>) -> Result<(), ApiError> {
        let on = self.shared.store.silent.load(Ordering::SeqCst);
        self.send(
            &format!("静音发送：{}（默认关闭）。静音不阻止消息投递，仅关闭通知声音；手机仍可能显示无声通知。自动投递总开关由 /notifications 控制。", if on { "开启" } else { "关闭" }),
            thread_id,
            json!({
                "disable_notification": true,
                "reply_markup": { "inline_keyboard": [[{ "text": if on { "关闭静音" } else { "开启静音" }, "callback_data": if on { "silent:off" } else { "silent:on" } }]] },
            }),
        )
        .await
    }
}
