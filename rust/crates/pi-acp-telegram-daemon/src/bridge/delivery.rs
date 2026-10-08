//! Message delivery, stream caches and outbox acknowledgements.
use super::*;

impl Bridge {
    pub(super) async fn send(
        &self,
        text: &str,
        thread_id: Option<i64>,
        extra: Value,
    ) -> Result<(), ApiError> {
        for chunk in chunks(text) {
            let mut params = json!({
                "chat_id": self.shared.opts.chat_id,
                "text": chunk.text,
                "disable_notification": self.shared.store.silent.load(Ordering::SeqCst),
            });
            params["entities"] = serde_json::to_value(chunk.entities).unwrap();
            if let Some(t) = thread_id {
                params["message_thread_id"] = json!(t);
            }
            if let Value::Object(extra) = &extra {
                for (k, v) in extra {
                    params[k] = v.clone();
                }
            }
            self.shared.api.call("sendMessage", params).await?;
        }
        Ok(())
    }

    pub(super) async fn send_plain(
        &self,
        text: &str,
        thread_id: Option<i64>,
    ) -> Result<(), ApiError> {
        self.send(text, thread_id, json!({})).await
    }

    pub(super) async fn stream(&self, id: &str, thread_id: i64) -> Arc<TelegramStream> {
        self.prune().await;
        self.shared
            .touched
            .lock()
            .await
            .insert(id.to_string(), now_ms());
        let mut streams = self.shared.streams.lock().await;
        if let Some(stream) = streams.get(id) {
            return stream.clone();
        }
        if streams.len() >= STREAM_LIMIT {
            // Evict the least-recently-touched stream; HashMap has no insertion order.
            let touched = self.shared.touched.lock().await;
            if let Some(oldest) = streams
                .keys()
                .min_by_key(|id| touched.get(*id).copied().unwrap_or(0))
                .cloned()
            {
                drop(touched);
                streams.remove(&oldest);
                self.shared.touched.lock().await.remove(&oldest);
            }
        }
        let stream = Arc::new(TelegramStream::new(
            self.shared.api.clone(),
            self.shared.opts.chat_id,
            thread_id,
            self.shared.opts.stream_interval,
            self.shared.store.notifications.clone(),
            self.shared.store.silent.clone(),
            {
                let report = self.shared.opts.report.clone();
                Arc::new(move |e: &ApiError| report(&e.message))
            },
        ));
        streams.insert(id.to_string(), stream.clone());
        stream
    }

    pub(super) async fn drop_stream(&self, id: &str) {
        self.shared.streams.lock().await.remove(id);
        self.shared.touched.lock().await.remove(id);
    }

    pub(super) async fn prune(&self) {
        let now = now_ms();
        let touched = self.shared.touched.lock().await;
        let stale: Vec<String> = touched
            .iter()
            .filter(|(_, t)| now - **t > STREAM_IDLE_MS)
            .map(|(id, _)| id.clone())
            .collect();
        drop(touched);
        for id in stale {
            self.drop_stream(&id).await;
        }
        let mut tickets = self.shared.tickets.lock().await;
        tickets.retain(|_, t| t.expires > now);
    }

    /// Consume one cursor pass; failed delivery remains available on the next pass.
    pub async fn consume_outbox(&self) -> Result<(), String> {
        let mut cursor = None;
        while !self.shared.opts.stop.is_cancelled() {
            let next = tokio::select! {
                result = self.shared.host.next_event(cursor.as_deref()) => result.map_err(|e| e.to_string())?,
                _ = self.shared.opts.stop.cancelled() => return Ok(()),
            };
            let Some(delivery) = next else {
                break;
            };
            if cursor.as_ref() == Some(&delivery.cursor) {
                return Err("outbox cursor 未前进".into());
            }
            cursor = Some(delivery.cursor);
            if let (Some(event), Some(token)) = (delivery.event, delivery.token) {
                if self.consume(&event).await {
                    self.shared
                        .host
                        .ack_event(&event.id, &token)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    /// Returns true when this event revision may be acknowledged through the service.
    pub async fn consume(&self, event: &TurnEvent) -> bool {
        if self
            .shared
            .store
            .read()
            .await
            .delivered
            .iter()
            .any(|d| d == &event.id)
        {
            return true;
        }
        if self.shared.opts.stop.is_cancelled()
            || !self.shared.consuming.lock().await.insert(event.id.clone())
        {
            return false;
        }
        let result = self.consume_inner(event).await;
        self.shared.consuming.lock().await.remove(&event.id);
        result
    }

    pub(super) async fn consume_inner(&self, event: &TurnEvent) -> bool {
        let sessions = match self.shared.host.list().await {
            Ok(s) => s,
            Err(_) => return false,
        };
        let Some(session) = sessions
            .iter()
            .find(|s| s.id == event.session_id && s.cwd == event.cwd)
            .cloned()
        else {
            self.drop_stream(&event.id).await;
            return false;
        };
        if !self.shared.store.notifications.load(Ordering::SeqCst) {
            self.drop_stream(&event.id).await;
            if event.status != "running" {
                let id = event.id.clone();
                if self
                    .persist(|s| {
                        s.delivered.push(id);
                        trim(&mut s.delivered, DELIVERED_KEEP);
                    })
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            return true;
        }
        let thread_id = match self.ensure_topic(&session).await {
            Ok(t) => t,
            Err(_) => return false,
        };
        let stream = self.stream(&event.id, thread_id).await;
        let mut body = event.text.clone();
        if event.pending_permissions > 0 {
            body.push_str("\n🔐 等待工具授权，可在 VS Code 或 Telegram /status 中处理。");
        }
        let text = if let Some(input) = &event.input_text {
            let attachments = if event.non_text_blocks > 0 {
                format!(
                    "\n[附带 {} 个非文本内容，请在 VS Code 查看]",
                    event.non_text_blocks
                )
            } else {
                String::new()
            };
            let body = if body.is_empty() {
                if event.status == "running" {
                    "正在处理…"
                } else {
                    "本轮没有文本回复。"
                }
            } else {
                &body
            };
            format!("你（VS Code）：\n{input}{attachments}\n\nPi：\n{body}")
        } else {
            body
        };
        if event.status == "running" {
            stream
                .update(if text.is_empty() {
                    "正在处理…".into()
                } else {
                    text
                })
                .await;
            return false;
        }
        let label = match event.status.as_str() {
            "completed" => "✅ 任务完成",
            "cancelled" => "⏹ 任务已停止",
            _ => "❌ 任务失败",
        };
        let number = session
            .session_number
            .map(|n| format!(" · #{n}"))
            .unwrap_or_default();
        let suffix = event
            .error
            .as_ref()
            .map(|e| format!("\n{}", utf16_head(e, 700)))
            .unwrap_or_default();
        if let Err(error) = stream
            .finish(text, format!("{label}{number}{suffix}"))
            .await
        {
            self.drop_stream(&event.id).await;
            self.report(&error.message).await;
            return false; // durable event remains for retry
        }
        let id = event.id.clone();
        if self
            .persist(|s| {
                s.delivered.push(id);
                trim(&mut s.delivered, DELIVERED_KEEP);
            })
            .await
            .is_err()
        {
            return false;
        }
        self.drop_stream(&event.id).await;
        true
    }
}
