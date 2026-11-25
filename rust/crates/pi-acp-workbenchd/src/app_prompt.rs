//! Prompt preflight and dispatch, without changing durable admission.
use super::*;

impl CommandCore {
    pub(super) async fn prepare_input(
        &self,
        mut command: DomainCommand,
    ) -> Result<DomainCommand, DomainError> {
        let mut sanitized_prompt = None;
        match &command {
            DomainCommand::CreateSession { harness, .. }
                if !self.coordinator.supervisor.is_configured(harness) =>
            {
                return Err(DomainError::ProviderNotConfigured)
            }
            DomainCommand::Prompt { session, .. } => {
                let events = self
                    .runtime
                    .registry
                    .command_admitted(DomainCommand::Inspect(session.clone()))
                    .await?;
                let Some(snapshot) = events.view() else {
                    return Err(DomainError::NotFound(session.clone()));
                };
                if !self.coordinator.supervisor.is_configured(&snapshot.harness) {
                    return Err(DomainError::ProviderNotConfigured);
                }
                if let DomainCommand::Prompt { prompt, .. } = &command {
                    if prompt
                        .parts()
                        .iter()
                        .any(|p| matches!(p, crate::domain::ids::PromptPart::Image { .. }))
                    {
                        let input = prompt.clone();
                        static IMAGE_INPUT_JOBS: tokio::sync::Semaphore =
                            tokio::sync::Semaphore::const_new(2);
                        let permit = IMAGE_INPUT_JOBS
                            .try_acquire()
                            .map_err(|_| DomainError::Busy)?;
                        sanitized_prompt = Some(
                            tokio::task::spawn_blocking(move || {
                                let _permit = permit;
                                let parts = input
                                    .parts()
                                    .iter()
                                    .map(|part| match part {
                                        crate::domain::ids::PromptPart::Image { asset } => {
                                            Ok(crate::domain::ids::PromptPart::Image {
                                                asset: asset.sanitize_input()?,
                                            })
                                        }
                                        part => Ok(part.clone()),
                                    })
                                    .collect::<Result<Vec<_>, DomainError>>()?;
                                crate::domain::Prompt::from_parts(parts)
                                    .map_err(|e| DomainError::Protocol(e.to_string()))
                            })
                            .await
                            .map_err(|_| {
                                DomainError::Protocol("image validation interrupted".into())
                            })??,
                        );
                        self.discover(session.clone()).await?;
                        let observed = self
                            .database
                            .view(session.clone())
                            .await
                            .map_err(|e| DomainError::Persistence(e.to_string()))?;
                        if !observed.catalogue.image_input {
                            return Err(DomainError::Protocol(
                                "provider does not support image input".into(),
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
        if let (Some(sanitized), DomainCommand::Prompt { prompt, .. }) =
            (sanitized_prompt, &mut command)
        {
            *prompt = sanitized;
        }
        Ok(command)
    }
    pub(super) async fn dispatch_prompt(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        text: crate::domain::Prompt,
    ) -> Result<(), DomainError> {
        let activity = self
            .database
            .worker_activity(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        let (sender, config) = self.adapter_sender(session.clone()).await?;
        if let Some(handle) = self.coordinator.adapters.lock().await.get_mut(&session) {
            handle.last_user_input_at = activity.0;
            handle.last_used = activity.1;
        }
        sender
            .try_send(AdapterCommand::Prompt { turn, text, config })
            .map_err(DomainError::mailbox)
    }
}
