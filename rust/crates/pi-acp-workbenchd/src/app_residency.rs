//! Worker residency and eviction policy, separate from command execution.
use super::*;

impl CommandCore {
    pub(super) async fn annotate_residency(&self, page: &mut crate::domain::query::ListPage) {
        let adapters = self.coordinator.adapters.lock().await;
        let mut recent: Vec<_> = adapters
            .iter()
            .filter(|(_, h)| {
                h.last_used.load(Ordering::Relaxed) != 0
                    && !h.stop.is_cancelled()
                    && !h.task.is_finished()
                    && !h.tx.is_closed()
            })
            .map(|(id, h)| (id, h.last_used.load(Ordering::Relaxed)))
            .collect();
        recent.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
        let recent: std::collections::HashSet<_> =
            recent.into_iter().take(8).map(|(id, _)| id).collect();
        for row in &mut page.sessions {
            row.retention_days = adapters
                .get(&row.id)
                .filter(|h| !h.stop.is_cancelled() && !h.task.is_finished() && !h.tx.is_closed())
                .map(|_| if recent.contains(&row.id) { 4 } else { 1 })
                .or(Some(0));
        }
    }
    // Caller owns admission. Capacity reclaims one oldest idle resident; expiry
    // reclaims all expired idle residents. Reads/discovery never refresh the clock.
    pub(super) async fn reclaim_workers(
        &self,
        exclude: Option<&SessionId>,
        expired_only: bool,
    ) -> Result<(), DomainError> {
        let mut adapters = self.coordinator.adapters.lock().await;
        let mut recent: Vec<_> = adapters
            .iter()
            .filter(|(_, h)| {
                h.last_used.load(Ordering::Relaxed) != 0
                    && !h.stop.is_cancelled()
                    && !h.task.is_finished()
                    && !h.tx.is_closed()
            })
            .map(|(id, h)| (id.clone(), h.last_used.load(Ordering::Relaxed)))
            .collect();
        recent.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
        let recent: std::collections::HashSet<_> =
            recent.into_iter().take(8).map(|(id, _)| id).collect();
        let now = worker_retention::now();
        let mut candidates: Vec<_> = adapters
            .keys()
            .filter(|id| exclude != Some(*id))
            .cloned()
            .collect();
        candidates.sort_by_key(|id| {
            adapters
                .get(id)
                .map(|handle| (handle.last_used.load(Ordering::Relaxed), handle.epoch))
                .unwrap_or((u64::MAX, u64::MAX))
        });
        for id in candidates {
            let Some(handle) = adapters.get(&id) else {
                continue;
            };
            if handle.pins.load(Ordering::Acquire) != 0
                || !handle.resumable.load(Ordering::Acquire)
                || handle.stop.is_cancelled()
                || handle.task.is_finished()
                || handle.tx.is_closed()
            {
                continue;
            }
            if expired_only
                && !worker_retention::expired(
                    now,
                    handle.resident_since,
                    handle.last_user_input_at,
                    recent.contains(&id),
                )
            {
                continue;
            }
            let view = match self.database.view(id.clone()).await {
                Ok(view) => view,
                Err(_) => continue,
            };
            if view.active_turn.is_some()
                || !view.pending_interactions.is_empty()
                || view.configuration_intent.is_some()
            {
                continue;
            }
            // Fork work does not mark the source as an active turn. Its
            // admission lease protects inspection, remote mutation and adopt
            // even while the stored session still looks idle. Recheck after
            // the database await; admission/map locks serialize worker starts.
            if self.coordinator.forks.owns_session(&id) {
                continue;
            }
            // The owner atomically rejects retirement if a user/background turn
            // or permission arrived after the snapshot. Its epoch fence rejects
            // later peer events; the physical pin is released only after join.
            if self
                .runtime
                .registry
                .retire_idle_worker(id.clone(), handle.epoch)
                .await
                .is_err()
            {
                continue;
            }
            let handle = adapters.remove(&id).expect("candidate is still registered");
            crate::diagnostics::gauge(
                "last_reclaimed_background_capable",
                usize::from(!handle.background_safe.load(Ordering::Acquire)),
            );
            // Fence map ownership before requesting physical termination. The
            // admission lock prevents a concurrent session start from replacing it.
            handle.stop.cancel();
            // Queries can observe the logical release while physical join is
            // still pending. Admission and the owner's attachment pin continue
            // to prevent slot reuse or owner eviction until that join finishes.
            drop(adapters);
            handle.stop().await;
            if !expired_only {
                return Ok(());
            }
            adapters = self.coordinator.adapters.lock().await;
        }
        if expired_only {
            Ok(())
        } else {
            Err(DomainError::WorkerCapacity)
        }
    }
}
