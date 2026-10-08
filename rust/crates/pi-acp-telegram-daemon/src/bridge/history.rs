//! Topic bindings and explicit history synchronization.
use super::*;

impl Bridge {
    pub(super) async fn ensure_topic(&self, session: &SessionStub) -> Result<i64, ApiError> {
        if let Some(saved) = self
            .shared
            .store
            .read()
            .await
            .topics
            .iter()
            .find(|t| t.session_id == session.id)
            .map(|t| t.thread_id)
        {
            return Ok(saved);
        }
        let cell = {
            let mut topics = self.shared.topics.lock().await;
            topics
                .entry(session.id.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let session_id = session.id.clone();
        let created = cell
            .get_or_try_init(|| async {
                let number = session
                    .session_number
                    .map(|n| format!("#{n}"))
                    .unwrap_or_else(|| "Pi".into());
                let name = utf16_head(
                    &format!(
                        "{number} · {}",
                        if session.title.is_empty() {
                            "新对话"
                        } else {
                            &session.title
                        }
                    ),
                    128,
                );
                let topic = self
                    .shared
                    .api
                    .call(
                        "createForumTopic",
                        json!({ "chat_id": self.shared.opts.chat_id, "name": name }),
                    )
                    .await?;
                let thread_id = topic
                    .get("message_thread_id")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                self.persist(|s| {
                    s.topics.push(Topic {
                        session_id,
                        thread_id,
                    })
                })
                .await
                .map_err(|e| ApiError {
                    code: 0,
                    message: e,
                })?;
                Ok(thread_id)
            })
            .await;
        let mut topics = self.shared.topics.lock().await;
        if topics
            .get(&session.id)
            .map(|c| Arc::ptr_eq(c, &cell))
            .unwrap_or(false)
        {
            topics.remove(&session.id);
        }
        created.copied()
    }

    /// Returns false if another global sync already owns the operation.
    pub async fn command_sync(&self, thread_id: Option<i64>) -> Result<bool, String> {
        if self.shared.syncing_all.swap(true, Ordering::SeqCst) {
            return self
                .send(
                    "历史同步正在进行，请稍候。",
                    thread_id,
                    json!({ "disable_notification": true }),
                )
                .await
                .map(|()| false)
                .map_err(|e| e.message);
        }
        let result = async {
            self.send(
                "正在同步：最新 5 个会话各取最后 10 条，其余会话各取最后 2 条文字历史。",
                thread_id,
                json!({ "disable_notification": true }),
            )
            .await
            .map_err(|e| e.message)?;
            let sessions = self.shared.host.list().await.map_err(|e| e.to_string())?;
            let mut processed = 0usize;
            let mut created = 0usize;
            for (index, session) in sessions.iter().enumerate() {
                let limit = if index < 5 { 10 } else { 2 };
                if self.shared.opts.stop.is_cancelled() {
                    return Err("历史同步已中断，可重新执行命令继续。".into());
                }
                let bound = self
                    .shared
                    .store
                    .read()
                    .await
                    .topics
                    .iter()
                    .any(|t| t.session_id == session.id);
                if bound && self.pending_history(&session.id, Some(limit)).await?.is_empty() {
                    continue;
                }
                let topic = self.ensure_topic(session).await.map_err(|e| e.message)?;
                if !bound {
                    created += 1;
                }
                self.sync_history(&session.id, topic, Some(limit), true).await?;
                processed += 1;
            }
            self.send(
                &format!("已同步 {processed} 个会话，其中新建 {created} 个话题。最新 5 个会话各取最后 10 条，其余各取最后 2 条；已同步内容自动跳过。在会话话题手动执行 /history 获取更多消息，/history all 分批获取完整历史。"),
                thread_id,
                json!({ "disable_notification": true }),
            )
            .await
            .map(|()| true)
            .map_err(|e| e.message)
        }
        .await;
        self.shared.syncing_all.store(false, Ordering::SeqCst);
        result
    }

    /// History entries not yet sent, oldest first: user/assistant/diff roles with
    /// a sha256 dedup key over `entry.id + '\0' + entry.text`.
    pub(super) async fn pending_history(
        &self,
        session_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<(String, String)>, String> {
        let entries: Vec<Value> = self
            .shared
            .host
            .history(session_id)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|e| {
                matches!(
                    e.get("role").and_then(Value::as_str),
                    Some("user" | "assistant" | "diff")
                )
            })
            .collect();
        let sent: Vec<String> = self
            .shared
            .store
            .read()
            .await
            .history_sent
            .as_ref()
            .and_then(|h| h.get(session_id))
            .cloned()
            .unwrap_or_default();
        let sliced = if let Some(limit) = limit {
            entries.into_iter().rev().take(limit).rev().collect()
        } else {
            entries
        };
        Ok(sliced
            .into_iter()
            .filter_map(|e| {
                let role = e.get("role").and_then(Value::as_str)?;
                let text = e.get("text").and_then(Value::as_str).unwrap_or_default();
                let key = hex::encode(Sha256::digest(
                    format!(
                        "{}\0{text}",
                        e.get("id").and_then(Value::as_str).unwrap_or_default()
                    )
                    .as_bytes(),
                ));
                let who = if role == "user" {
                    "你"
                } else if role == "diff" {
                    "修改汇总"
                } else {
                    "Pi"
                };
                Some((key, format!("{who}：\n{text}")))
            })
            .filter(|(key, _)| !sent.contains(key))
            .take(HISTORY_MAX)
            .collect())
    }

    pub(super) async fn sync_history(
        &self,
        session_id: &str,
        thread_id: i64,
        limit: Option<usize>,
        sync_preview: bool,
    ) -> Result<(), String> {
        if !self
            .shared
            .syncing
            .lock()
            .await
            .insert(session_id.to_string())
        {
            return Err("此话题正在同步历史。".into());
        }
        let result = async {
            let selected = self.pending_history(session_id, limit).await?;
            for (key, body) in &selected {
                self.send(
                    body,
                    Some(thread_id),
                    json!({ "disable_notification": true }),
                )
                .await
                .map_err(|e| e.message)?;
                let key = key.clone();
                let sid = session_id.to_string();
                self.persist(|s| {
                    s.history_sent
                        .get_or_insert_with(HashMap::new)
                        .entry(sid)
                        .or_default()
                        .push(key);
                })
                .await?;
            }
            self.send(
                &format!(
                    "已同步 {} 条历史消息。{}",
                    selected.len(),
                    if sync_preview {
                        "手动执行 /history 获取更多消息，/history all 分批获取完整历史。"
                    } else if selected.len() == HISTORY_MAX {
                        "可再次 /history all 继续。"
                    } else {
                        ""
                    }
                ),
                Some(thread_id),
                json!({ "disable_notification": true }),
            )
            .await
            .map_err(|e| e.message)
        }
        .await;
        self.shared.syncing.lock().await.remove(session_id);
        result
    }
}
