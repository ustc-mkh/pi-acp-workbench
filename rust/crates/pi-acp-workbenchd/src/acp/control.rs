//! Drain protocol traffic while a short control RPC is pending. In particular,
//! session/load replay is not a new domain turn and must never append old text.
use super::{client::AcpClient, dto::*, settings::SessionDetails};
use crate::{
    domain::{
        catalogue::{AvailableCommand, CataloguePatch},
        error::DomainError,
        interaction::InteractionResponse,
        ModeId,
    },
    worker::WorkerEvent,
};
use std::future::Future;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub(super) enum ControlPhase {
    Startup { resuming: bool },
    Configure { preferences_applied: bool },
}

#[derive(Default)]
pub(super) struct ControlUpdates {
    session: Option<NativeSessionId>,
    config_options: Option<Vec<super::settings::ConfigOption>>,
    commands: Option<Vec<AvailableCommand>>,
    mode: Option<ModeId>,
}
impl ControlUpdates {
    fn observe_session(
        &mut self,
        session: &NativeSessionId,
        expected: Option<&NativeSessionId>,
    ) -> Result<(), DomainError> {
        if expected.is_some_and(|id| id != session)
            || self.session.as_ref().is_some_and(|id| id != session)
        {
            return Err(DomainError::Protocol(
                "notification belongs to another native session".into(),
            ));
        }
        self.session = Some(session.clone());
        Ok(())
    }
    pub(super) fn finish(
        self,
        details: &mut SessionDetails,
        native: &NativeSessionId,
        phase: ControlPhase,
    ) -> Result<CataloguePatch, DomainError> {
        let (resuming, reply_authoritative, include_details) = match phase {
            ControlPhase::Startup { resuming } => (resuming, true, true),
            ControlPhase::Configure {
                preferences_applied,
            } => (false, false, preferences_applied),
        };
        if self.session.as_ref().is_some_and(|id| id != native) {
            return Err(DomainError::Protocol(
                "startup notification session does not match reply".into(),
            ));
        }
        let has_options_update = self.config_options.is_some();
        if let Some(options) = self.config_options {
            if !reply_authoritative || details.config_options.is_none() {
                details.config_options = Some(options);
            }
        }
        let reply_has_mode = details.select("mode").is_some() || details.modes.is_some();
        if let Some(mode) = &self.mode {
            if !reply_authoritative || !reply_has_mode {
                details.observe_mode(mode);
            }
        }
        let mut patch = if include_details || has_options_update {
            details.catalogue_patch()?
        } else {
            CataloguePatch::default()
        };
        if let Some(mode) = self.mode {
            if !reply_authoritative || !reply_has_mode {
                patch.current_mode = Some(mode);
            }
        }
        patch.commands = self.commands;
        // Empty catalogues replayed by load are not evidence that the provider
        // withdrew a previously offered setting. Live empty updates still clear.
        if resuming {
            if patch.models.as_ref().is_some_and(Vec::is_empty) {
                patch.models = None;
            }
            if patch.modes.as_ref().is_some_and(Vec::is_empty) {
                patch.modes = None;
            }
            if patch.commands.as_ref().is_some_and(Vec::is_empty) {
                patch.commands = None;
            }
        }
        Ok(patch)
    }
}

pub(super) fn commands(commands: Vec<super::dto::AvailableCommand>) -> Vec<AvailableCommand> {
    commands
        .into_iter()
        .map(|command| AvailableCommand {
            name: command.name,
            description: command.description,
            input_hint: command.input.map(|input| input.hint),
        })
        .collect()
}

pub(super) async fn pump<T>(
    client: &AcpClient,
    updates: &mut mpsc::Receiver<WorkerEvent>,
    stop: &CancellationToken,
    expected: Option<&NativeSessionId>,
    request: impl Future<Output = Result<T, DomainError>>,
) -> Result<(T, ControlUpdates), DomainError> {
    tokio::pin!(request);
    let mut captured = ControlUpdates::default();
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(DomainError::Worker("adapter stopping".into())),
            event = updates.recv() => match event {
                Some(WorkerEvent::Update(notification)) => {
                    captured.observe_session(&notification.session_id, expected)?;
                    match notification.update {
                        SessionUpdate::ConfigOptions { config_options } => {
                            SessionDetails { config_options: Some(config_options.clone()), ..Default::default() }.catalogue_patch()?;
                            captured.config_options = Some(config_options);
                        }
                        SessionUpdate::AvailableCommands { available_commands } => { captured.commands = Some(commands(available_commands)); }
                        SessionUpdate::CurrentMode { current_mode_id } => { captured.mode = Some(ModeId::new(current_mode_id)?); }
                        _ => {} // persisted domain history, not a newly prompted turn
                    }
                }
                Some(WorkerEvent::Request(request)) => {
                    captured.observe_session(request.session(), expected)?;
                    client.answer(&request, InteractionResponse::Cancel).await?;
                }
                Some(WorkerEvent::Closed(reason)) => return Err(DomainError::Worker(reason)),
                None => return Err(DomainError::Worker("worker event stream closed".into())),
            },
            result = &mut request => return result.map(|result| (result, captured)),
        }
    }
}
