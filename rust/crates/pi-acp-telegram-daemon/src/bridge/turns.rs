//! Per-session prompt execution and cancellation generations.
use super::*;

impl Bridge {
    pub(super) async fn bump_generation(&self, session_id: &str) -> Result<(), String> {
        self.persist(|s| {
            let thread = s
                .topics
                .iter()
                .find(|t| t.session_id == session_id)
                .map(|t| t.thread_id);
            s.inbox.retain(|item| {
                item.phase != InboxPhase::Pending
                    || thread_of(&item.update) != thread
                    || !item.ordered()
            });
        })
        .await?;
        if self.shared.lanes.lock().await.contains_key(session_id) {
            *self
                .shared
                .generations
                .lock()
                .await
                .entry(session_id.to_string())
                .or_insert(0) += 1;
        }
        Ok(())
    }

    /// Per-session lane: queued callers run the prompt one at a time; /stop and
    /// /interrupt bump the generation so waiters drop out before starting. The
    /// lane stays mapped while the guard is held so a second prompt can never
    /// run concurrently — removal happens only under the lanes mutex when the
    /// queued count reaches zero.
    pub(super) async fn enqueue(
        &self,
        session_id: &str,
        thread_id: i64,
        prompt: String,
    ) -> Result<(), String> {
        let lane = {
            let mut lanes = self.shared.lanes.lock().await;
            let lane = lanes
                .entry(session_id.to_string())
                .or_insert_with(|| {
                    Arc::new(Lane {
                        lock: Mutex::new(()),
                        queued: AtomicUsize::new(0),
                    })
                })
                .clone();
            if lane.queued.load(Ordering::SeqCst) >= QUEUE_LIMIT {
                return Err("排队消息已满，请稍后重试。".into());
            }
            lane.queued.fetch_add(1, Ordering::SeqCst);
            lane
        };
        let generation = *self
            .shared
            .generations
            .lock()
            .await
            .get(session_id)
            .unwrap_or(&0);
        let guard = lane.lock.lock().await;
        self.shared
            .active
            .lock()
            .await
            .insert(session_id.to_string());
        let result = async {
            if self.shared.opts.stop.is_cancelled()
                || generation
                    != *self
                        .shared
                        .generations
                        .lock()
                        .await
                        .get(session_id)
                        .unwrap_or(&0)
            {
                return Ok(());
            }
            let run = self.shared.host.run(session_id, prompt);
            let session = session_id.to_string();
            let thread = thread_id;
            let bridge = self.clone();
            let mut permissions = run.permissions;
            let forward = OwnedTask::spawn(async move {
                while let Some(p) = permissions.recv().await {
                    if bridge.shared.store.notifications.load(Ordering::SeqCst) {
                        bridge.show_permission(&session, thread, p).await;
                    }
                }
            });
            let outcome = run
                .result
                .await
                .map_err(|_| "会话任务异常结束".to_string())?;
            forward.abort();
            outcome.map(|_| ()).map_err(|e| e.to_string())
        }
        .await;
        self.shared.active.lock().await.remove(session_id);
        {
            let mut tickets = self.shared.tickets.lock().await;
            tickets.retain(|_, t| t.session_id != session_id);
        }
        {
            let mut lanes = self.shared.lanes.lock().await;
            if lane.queued.fetch_sub(1, Ordering::SeqCst) == 1
                && lanes
                    .get(session_id)
                    .map(|l| Arc::ptr_eq(l, &lane))
                    .unwrap_or(false)
            {
                lanes.remove(session_id);
                self.shared.generations.lock().await.remove(session_id);
            }
        }
        drop(guard);
        result
    }
}
