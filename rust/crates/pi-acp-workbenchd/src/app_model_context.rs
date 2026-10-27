//! Profile writes are serialized; read-only worker refreshes never hold the profile lock.
use super::*;
use crate::domain::{management::*, query::SessionView};
use std::time::Duration;
use tokio::time::Instant;

const MODEL_RPC_TIMEOUT: Duration = Duration::from_secs(20);
const PROFILE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const PROJECTION_BATCH_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PROJECTION_BATCH: usize = 16;

impl CommandCore {
    pub(super) async fn provider_models(
        &self,
        session: &SessionId,
        action: ManagementAction,
        projection: Option<ContextProjection>,
    ) -> Result<ProviderModels, DomainError> {
        self.provider_models_before(
            session,
            action,
            projection,
            Instant::now() + MODEL_RPC_TIMEOUT,
        )
        .await
    }

    async fn provider_models_before(
        &self,
        session: &SessionId,
        action: ManagementAction,
        projection: Option<ContextProjection>,
        deadline: Instant,
    ) -> Result<ProviderModels, DomainError> {
        // A batch deadline bounds RPC admission and observation. Do not wrap
        // SQLite settlement in a timeout: accepted transactions must drain.
        let (sender, _) = self.adapter_sender(session.clone()).await?;
        if Instant::now() >= deadline {
            return Err(DomainError::OperationInterrupted);
        }
        let (reply, wait) = tokio::sync::oneshot::channel();
        sender
            .try_send(AdapterCommand::Models {
                action,
                projection: projection.clone(),
                reply,
            })
            .map_err(DomainError::mailbox)?;
        let response =
            tokio::time::timeout_at(deadline.min(Instant::now() + MODEL_RPC_TIMEOUT), wait)
                .await
                .map_err(|_| DomainError::OperationInterrupted)?
                .map_err(|_| DomainError::OperationInterrupted)??;
        if projection.is_some() && response.context_ack != projection {
            return Err(DomainError::Protocol(
                "Pi did not confirm the context revision; update the matching adapter".into(),
            ));
        }
        Ok(response)
    }

    pub(super) async fn manage_external(
        &self,
        session: &SessionId,
        action: &ManagementAction,
    ) -> Result<CommandReceipt, DomainError> {
        let view = self
            .database
            .view(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if view.active_turn.is_some() || view.configuration_intent.is_some() {
            return Err(DomainError::Busy);
        }
        if view.harness != crate::domain::Harness::Pi {
            return Err(DomainError::UnsupportedFeature(
                "only Pi provides profile context settings".into(),
            ));
        }
        let stage = (!matches!(action, ManagementAction::RefreshModels)).then_some(action);
        let refreshed = self.sync_model_context(session, stage, true).await?;
        if matches!(action, ManagementAction::RefreshModels) && !refreshed {
            let response = self.provider_models(session, action.clone(), None).await?;
            self.database
                .model_defaults(session.clone(), response)
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
        }
        Ok(CommandReceipt::Accepted {
            session: session.clone(),
            revision: view.revision,
        })
    }

    pub(super) async fn ensure_model_context(
        &self,
        session: &SessionId,
    ) -> Result<(), DomainError> {
        let view: SessionView = self
            .database
            .view(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if view.harness != crate::domain::Harness::Pi {
            return Ok(());
        }
        self.sync_model_context(session, None, false)
            .await
            .map(|_| ())
    }

    pub(super) async fn discover_model_context(
        &self,
        session: &SessionId,
    ) -> Result<(), DomainError> {
        let view = self
            .database
            .view(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if view.harness != crate::domain::Harness::Pi {
            return Ok(());
        }
        self.sync_model_context(session, None, true)
            .await
            .map(|_| ())
    }

    /// Returns true if a worker refresh was performed. Only file projections
    /// need global serialization; different workers may refresh concurrently.
    async fn sync_model_context(
        &self,
        session: &SessionId,
        stage: Option<&ManagementAction>,
        initialize_defaults: bool,
    ) -> Result<bool, DomainError> {
        let mut snapshot = self
            .database
            .context_snapshot()
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if stage.is_some() || !snapshot.pending.is_empty() {
            let _settings =
                tokio::time::timeout(PROFILE_LOCK_TIMEOUT, self.coordinator.model_settings.lock())
                    .await
                    .map_err(|_| DomainError::Busy)?;
            if let Some(action) = stage {
                self.database
                    .context_stage(session.clone(), action.clone())
                    .await
                    .map_err(|e| DomainError::Persistence(e.to_string()))?;
            }
            // Another session may have settled or replaced intents while we
            // waited. Never project a snapshot obtained before the lock.
            snapshot = self
                .database
                .context_snapshot()
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
            self.project_pending_context(session, &snapshot).await?;
        }
        // Initial metadata discovery belongs to explicit discovery/settings, not
        // prompt admission: a read-only refresh must not interfere with replay
        // recovery or turn startup on peers without the Pi metadata extension.
        if snapshot.revision == 0 && !initialize_defaults {
            return Ok(false);
        }
        let observed = self
            .coordinator
            .adapters
            .lock()
            .await
            .get(session)
            .and_then(|h| h.context_revision);
        if observed == Some(snapshot.revision) {
            return Ok(false);
        }
        // No profile lock is held across this read-only RPC. A slow worker
        // cannot prevent another workspace from using an up-to-date worker.
        let response = match self
            .provider_models(session, ManagementAction::RefreshModels, None)
            .await
        {
            Ok(response) => response,
            // Plain ACP peers may offer a selector without Pi's metadata extension.
            // Do not block initial discovery, but never ignore projection failures.
            Err(DomainError::UnsupportedFeature(_)) if snapshot.revision == 0 => return Ok(false),
            Err(error) => return Err(error),
        };
        let latest = self
            .database
            .context_snapshot()
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if latest.revision != snapshot.revision || !latest.pending.is_empty() {
            // A profile save already durably settled its own projection. A
            // subsequent save must not turn that successful mutation into an
            // error just because its optional catalogue refresh was overtaken.
            // Ordinary reads/prompts must retry rather than use the old view.
            return if stage.is_some() {
                Ok(true)
            } else {
                Err(DomainError::Busy)
            };
        }
        self.database
            .model_defaults(session.clone(), response)
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if let Some(handle) = self.coordinator.adapters.lock().await.get_mut(session) {
            handle.context_revision = Some(snapshot.revision);
        }
        Ok(true)
    }

    async fn project_pending_context(
        &self,
        session: &SessionId,
        snapshot: &ContextSnapshot,
    ) -> Result<(), DomainError> {
        let deadline = Instant::now() + PROJECTION_BATCH_TIMEOUT;
        for intent in snapshot.pending.iter().take(MAX_PROJECTION_BATCH) {
            let action = ManagementAction::Context {
                model: intent.model.clone(),
                context_window: intent.context_window,
            };
            let projection = ContextProjection {
                owner: self.context_owner.clone(),
                revision: intent.revision,
            };
            let applied = self
                .provider_models_before(session, action, Some(projection), deadline)
                .await;
            match applied {
                Ok(response) => {
                    self.database
                        .model_defaults(session.clone(), response)
                        .await
                        .map_err(|e| DomainError::Persistence(e.to_string()))?;
                    self.database
                        .context_settle(intent.revision, None)
                        .await
                        .map_err(|e| DomainError::Persistence(e.to_string()))?;
                }
                Err(error) => {
                    self.database
                        .context_settle(intent.revision, Some(error.to_string()))
                        .await
                        .map_err(|e| DomainError::Persistence(e.to_string()))?;
                    return Err(error);
                }
            }
        }
        if snapshot.pending.len() > MAX_PROJECTION_BATCH {
            return Err(DomainError::OperationInterrupted);
        }
        Ok(())
    }
}
