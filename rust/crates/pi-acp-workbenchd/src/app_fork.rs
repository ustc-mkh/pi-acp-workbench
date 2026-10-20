//! Native branch transaction. The outer host journal admits it once; an
//! uncertain remote result is never retried or replaced with a text summary.
use super::*;
use crate::domain::fork::ForkRequest;
impl CommandCore {
    pub(super) async fn fork_session(
        &self,
        session: &SessionId,
        request: &ForkRequest,
        cancel: &CancellationToken,
    ) -> Result<CommandReceipt, DomainError> {
        if cancel.is_cancelled() {
            return Err(DomainError::ForkCancelled);
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(ingress::stopping());
        }
        let inspected = self
            .runtime
            .registry
            .command(DomainCommand::Inspect(session.clone()))
            .await?;
        let Some(snapshot) = inspected.view() else {
            return Err(DomainError::NotFound(session.clone()));
        };
        if !self.coordinator.supervisor.is_configured(&snapshot.harness) {
            return Err(DomainError::ProviderNotConfigured);
        }
        if !matches!(snapshot.harness, crate::domain::Harness::Pi) {
            return Err(DomainError::UnsupportedFeature(
                "native branching is not implemented for this harness".into(),
            ));
        }
        if snapshot.active_turn.is_some() || snapshot.configuration_intent.is_some() {
            return Err(DomainError::Busy);
        }
        if snapshot.provider_session.is_none() {
            return Err(DomainError::Protocol(
                "native branch has no committed source entry".into(),
            ));
        }
        if cancel.is_cancelled() {
            return Err(DomainError::ForkCancelled);
        }
        self.commit(DomainCommand::LoadSession(session.clone()))
            .await?;
        if cancel.is_cancelled() {
            return Err(DomainError::ForkCancelled);
        }
        let result = async {
            let (sender, _) = self.adapter_sender(session.clone()).await?;
            let (reply, wait) = tokio::sync::oneshot::channel();
            sender
                .try_send(AdapterCommand::ForkPoints { reply, cancel: cancel.clone() })
                .map_err(|_| DomainError::Backpressure)?;
            let candidates = tokio::select! {
                biased;
                result = wait => result.map_err(|_| DomainError::Worker("adapter stopped during native inspection".into()))??,
                _ = cancel.cancelled() => return Err(DomainError::ForkCancelled),
            };
            // Only the SessionActor inspects the authoritative state and
            // constructs the immutable prefix projection.
            let prepared = self
                .runtime
                .registry
                .command(DomainCommand::PrepareFork {
                    session: session.clone(),
                    request: request.clone(),
                    candidates,
                })
                .await?;
            let crate::actor::OwnerReply::ForkPrepared(projection) = prepared else {
                return Err(DomainError::Protocol(
                    "native branch projection missing".into(),
                ));
            };
            if cancel.is_cancelled() { return Err(DomainError::ForkCancelled); }
            let (reply, wait) = tokio::sync::oneshot::channel();
            sender
                .try_send(AdapterCommand::ForkNative {
                    target: projection.target.clone(),
                    reply,
                    cancel: cancel.clone(),
                })
                .map_err(|_| DomainError::Backpressure)?;
            let native = wait.await.map_err(|_| DomainError::NativeForkUncertain)??;
            Ok((projection, native))
        }
        .await;
        // Release the source process/capacity, never delete its native context.
        // The new branch's first prompt must load its own historical settings.
        let stopped = self.stop_session_adapter(session).await;
        let (projection, native) = match result {
            Err(DomainError::ForkCancelled) => {
                stopped?;
                return Err(DomainError::ForkCancelled);
            }
            other => other?,
        };
        stopped.map_err(|error| DomainError::NativeForkUnadopted {
            native: native.clone(),
            reason: error.to_string(),
        })?;
        self.commit(DomainCommand::AdoptFork {
            projection,
            native: native.clone(),
        })
        .await
        .map_err(|error| DomainError::NativeForkUnadopted {
            native,
            reason: error.to_string(),
        })
    }
}
