//! Durable input admission, ordering and bounded dispatch.
use super::*;

impl Bridge {
    pub(super) async fn offset(&self) -> i64 {
        self.shared.store.read().await.offset.unwrap_or(0)
    }
    pub async fn poll(&self) -> Result<(), String> {
        // A crash after Started has an uncertain outcome. Never replay side effects.
        self.persist(|s| {
            for item in &mut s.inbox {
                if item.phase == InboxPhase::Started {
                    item.phase = InboxPhase::Interrupted;
                }
            }
        })
        .await?;
        let result = tokio::select! {
            result = self.poll_updates() => result,
            result = self.run_inbox() => result,
        };
        self.shared.opts.stop.cancel();
        match self.shared.fatal_error.lock().await.take() {
            Some(error) => Err(error),
            None => result,
        }
    }
    async fn poll_updates(&self) -> Result<(), String> {
        let mut failures = 0u32;
        while !self.shared.opts.stop.is_cancelled() {
            let updates = self
                .shared
                .api
                .call(
                    "getUpdates",
                    json!({ "offset": self.offset().await, "timeout": 25, "allowed_updates": ["message", "callback_query"] }),
                )
                .await;
            match updates {
                Err(error) => {
                    if self.shared.opts.stop.is_cancelled() {
                        return Ok(());
                    }
                    self.report(&error.message).await;
                    if matches!(error.code, 401 | 403 | 409) {
                        return Err(error.message);
                    }
                    failures += 1;
                    let backoff = Duration::from_millis(1000 * 2u64.pow(failures.min(5)))
                        .min(Duration::from_secs(30));
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = self.shared.opts.stop.cancelled() => return Ok(()),
                    }
                }
                Ok(list) => {
                    failures = 0;
                    for update in list.as_array().cloned().unwrap_or_default() {
                        if self.shared.opts.stop.is_cancelled() {
                            return Ok(());
                        }
                        let update_id = update.get("update_id").and_then(Value::as_i64);
                        let Some(update_id) = update_id else { continue };
                        if update_id < self.offset().await {
                            continue;
                        }
                        self.accept_update(update_id, update).await?;
                    }
                }
            }
        }
        Ok(())
    }

    pub(super) fn authorized(&self, update: &Value) -> bool {
        let callback = update.get("callback_query");
        let message = callback
            .and_then(|c| c.get("message"))
            .or_else(|| update.get("message"));
        let sender = callback
            .and_then(|c| c.get("from"))
            .or_else(|| message.and_then(|m| m.get("from")));
        match (message, sender) {
            (Some(message), Some(sender)) => {
                message.pointer("/chat/id").and_then(Value::as_i64)
                    == Some(self.shared.opts.chat_id)
                    && sender.get("is_bot").and_then(Value::as_bool) != Some(true)
                    && message.get("sender_chat").is_none()
                    && self
                        .shared
                        .opts
                        .allowed_user_ids
                        .contains(&sender.get("id").and_then(Value::as_i64).unwrap_or(0))
            }
            _ => false,
        }
    }
    pub(super) async fn accept_update(&self, id: i64, update: Value) -> Result<(), String> {
        let accepted = self.authorized(&update);
        let full = accepted
            && self.shared.store.read().await.inbox.len()
                >= INBOX_LIMIT
                    + if InputClass::classify(&update) == InputClass::Control {
                        CONTROL_LIMIT
                    } else {
                        0
                    };
        if full {
            // Do not acknowledge even rejected work until the user has received the rejection.
            self.send_plain(
                "接收队列已满，此消息未执行，请稍后重发。",
                thread_of(&update),
            )
            .await
            .map_err(|e| e.message)?;
        }
        self.persist(|s| {
            if accepted && !full {
                s.inbox.push(InboxItem {
                    id,
                    update,
                    phase: InboxPhase::Pending,
                    prompt: None,
                });
            }
            s.offset = Some(id + 1);
        })
        .await?;
        self.shared.inbox_wake.notify_one();
        Ok(())
    }
    pub(super) async fn run_inbox(&self) -> Result<(), String> {
        loop {
            if self.shared.opts.stop.is_cancelled() {
                return Ok(());
            }
            let items = self.shared.store.read().await.inbox.clone();
            for item in &items {
                if self.shared.opts.stop.is_cancelled() {
                    return Ok(());
                }
                if !item.ready(&items) {
                    continue;
                }
                let control = item.priority();
                let pool = if control {
                    &self.shared.controls
                } else {
                    &self.shared.handlers
                };
                let Ok(permit) = pool.clone().try_acquire_owned() else {
                    continue;
                };
                let mut claimed = false;
                self.persist(|s| {
                    if let Some(current) = s
                        .inbox
                        .iter_mut()
                        .find(|i| i.id == item.id && i.phase != InboxPhase::Started)
                    {
                        current.phase = InboxPhase::Started;
                        claimed = true;
                    }
                })
                .await?;
                if !claimed {
                    continue;
                }
                let bridge = self.clone();
                let item = item.clone();
                self.shared.tasks.spawn(async move {
                    let _permit = permit;
                    if bridge.shared.opts.stop.is_cancelled() {
                        return;
                    }
                    let result = pi_acp_core::panic_guard::run(async {
                        if item.phase == InboxPhase::Interrupted {
                            bridge.send_plain("服务重启前有一条消息的处理结果未确认，未自动重放。请先用 /status 检查，再决定是否重发。", thread_of(&item.update))
                                .await.map_err(|e| e.message)
                        } else if let Some(prompt) = &item.prompt {
                            let topic = bridge.shared.store.read().await.topics.iter()
                                .find(|t| Some(t.thread_id) == thread_of(&item.update)).cloned()
                                .ok_or("此话题已不再绑定会话。")?;
                            bridge.enqueue(&topic.session_id, topic.thread_id, prompt.clone()).await
                        } else {
                            bridge.dispatch(&item.update).await
                        }
                    }).await.unwrap_or_else(|_| Err("Telegram 消息处理异常，未自动重放。".into()));
                    if bridge.shared.opts.stop.is_cancelled() {
                        return;
                    }
                    if let Err(error) = result {
                        bridge.report(&error).await;
                        // Keep Started on disk; restart will report uncertainty rather than replay.
                        *bridge.shared.fatal_error.lock().await = Some(error);
                        bridge.shared.opts.stop.cancel();
                        return;
                    }
                    if let Err(error) = bridge
                        .persist(|s| {
                            s.inbox.retain(|i| {
                                i.id != item.id
                                    || i.phase != InboxPhase::Started
                                    || i.prompt != item.prompt
                                    || i.update != item.update
                            })
                        })
                        .await
                    {
                        bridge.report(&error).await;
                        *bridge.shared.fatal_error.lock().await = Some(error);
                        bridge.shared.opts.stop.cancel();
                    }
                    bridge.shared.inbox_wake.notify_one();
                }).await?;
            }
            tokio::select! {
                _ = self.shared.opts.stop.cancelled() => return Ok(()),
                _ = self.shared.inbox_wake.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
        }
    }
}
