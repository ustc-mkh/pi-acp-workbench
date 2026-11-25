//! Worker residency and eviction policy, separate from command execution.
use super::*;

impl WorkbenchApp {
    /// A released worker's last observation may predate a saved preference.
    /// Omit only that obsolete value from the desktop projection. The persisted
    /// catalogue remains the provider observation used for validation/recovery.
    pub(crate) async fn project_current_choices(
        &self,
        view: &mut crate::domain::query::SessionView,
    ) {
        if view.active_turn.is_some() {
            return;
        }
        let catalogue = &mut view.catalogue;
        let model_differs = view
            .config
            .model
            .as_ref()
            .zip(catalogue.current_model.as_ref())
            .is_some_and(|(saved, observed)| {
                saved != observed && catalogue.models.iter().any(|choice| &choice.id == saved)
            });
        let mode_differs = view
            .config
            .mode
            .as_ref()
            .zip(catalogue.current_mode.as_ref())
            .is_some_and(|(saved, observed)| {
                saved != observed && catalogue.modes.iter().any(|choice| &choice.id == saved)
            });
        if !model_differs && !mode_differs {
            return;
        }
        if self
            .core
            .coordinator
            .adapters
            .lock()
            .await
            .get(&view.id)
            .is_some_and(AdapterHandle::is_live)
        {
            return;
        }
        if model_differs {
            catalogue.current_model = None;
        }
        if mode_differs {
            catalogue.current_mode = None;
        }
    }
}

impl CommandCore {
    pub(super) async fn annotate_residency(&self, page: &mut crate::domain::query::ListPage) {
        let adapters = self.coordinator.adapters.lock().await;
        let recent = recent_workers(&adapters);
        for row in &mut page.sessions {
            row.retention_days = Some(
                if !adapters.get(&row.id).is_some_and(AdapterHandle::is_live) {
                    0
                } else if recent.contains(&row.id) {
                    4
                } else {
                    1
                },
            );
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
        let recent = recent_workers(&adapters);
        let now = worker_retention::now();
        let mut candidates: Vec<_> = adapters
            .iter()
            .filter(|(id, _)| exclude != Some(*id))
            .map(|(id, h)| (h.last_used, h.epoch, id.clone()))
            .collect();
        candidates.sort_by_key(|(order, epoch, _)| (*order, *epoch));
        for (_, _, id) in candidates {
            let Some(handle) = adapters.get(&id) else {
                continue;
            };
            if handle.pins.load(Ordering::Acquire) != 0
                || !handle.resumable.load(Ordering::Acquire)
                || !handle.is_live()
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
            // A fork can own the source worker while its session still looks idle.
            if self.coordinator.forks.owns_session(&id) {
                continue;
            }
            // The session owner checks active work, pending interactions and configuration
            // before fencing this epoch. Physical detachment follows the process join.
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

fn recent_workers(
    adapters: &HashMap<SessionId, AdapterHandle>,
) -> std::collections::HashSet<SessionId> {
    let mut used: Vec<_> = adapters
        .iter()
        .filter(|(_, handle)| handle.is_live())
        .map(|(id, handle)| (id, handle.last_used))
        .filter(|(_, order)| *order != 0)
        .collect();
    used.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
    used.into_iter().take(8).map(|(id, _)| id.clone()).collect()
}
