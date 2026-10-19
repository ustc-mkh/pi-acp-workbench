//! Owns one ACP client's protocol lifecycle, never the domain session state.
use super::interaction::InboundRequest;
use super::{client::AcpClient, ContentBlock, SessionUpdate};
use crate::domain::{
    interaction::{InteractionAnswer, InteractionResponse},
    InteractionId,
};
use crate::{
    actor::RegistryHandle,
    domain::{command::AgentEvent, error::DomainError, SessionId, TurnId, WorkspacePath},
    worker::{WorkerEvent, WorkerHandle},
};
use std::collections::BTreeMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub enum AdapterCommand {
    Ready {
        reply: tokio::sync::oneshot::Sender<Result<(), DomainError>>,
    },
    Prompt {
        turn: TurnId,
        text: String,
        config: crate::domain::session::SessionConfig,
    },
    Configure {
        config: crate::domain::session::SessionConfig,
        reply: tokio::sync::oneshot::Sender<Result<(), DomainError>>,
    },
    ForkPoints {
        cancel: CancellationToken,
        reply: tokio::sync::oneshot::Sender<
            Result<Vec<crate::domain::fork::ForkCandidate>, DomainError>,
        >,
    },
    ForkNative {
        cancel: CancellationToken,
        target: crate::domain::fork::ForkTarget,
        reply: tokio::sync::oneshot::Sender<Result<crate::domain::ProviderSessionId, DomainError>>,
    },
    Answer(InteractionAnswer),
    Cancel {
        reply: tokio::sync::oneshot::Sender<Result<(), DomainError>>,
    },
}

pub async fn run(
    worker: WorkerHandle,
    context: AdapterContext,
    commands: mpsc::Receiver<AdapterCommand>,
    updates: mpsc::Receiver<WorkerEvent>,
    stop: CancellationToken,
) {
    let observer = context.clone();
    let completion = worker.completion();
    if pi_acp_core::panic_guard::run(run_protocol(worker, context, commands, updates, stop))
        .await
        .is_err()
    {
        observer.lifecycle.cancel();
        completion.join().await;
        // A protocol-owner panic is isolated to this session. Fencing happens
        // through the same committed domain crash path as an ordinary EOF.
        let _ = observer
            .publish(AgentEvent::Crashed {
                reason: "ACP adapter task panicked".into(),
            })
            .await;
    }
}

async fn run_protocol(
    worker: WorkerHandle,
    context: AdapterContext,
    mut commands: mpsc::Receiver<AdapterCommand>,
    mut updates: mpsc::Receiver<WorkerEvent>,
    stop: CancellationToken,
) {
    let client = AcpClient::new(worker);
    let expected = context
        .provider_session
        .as_ref()
        .map(|id| super::NativeSessionId::try_from(id.as_str().to_owned()))
        .transpose();
    let startup = async {
        let expected = expected.map_err(|error| DomainError::Protocol(error.into()))?;
        let initialized =
            super::control::pump(&client, &mut updates, &stop, expected.as_ref(), async {
                let initialized = client.initialize().await?;
                match &expected {
                    Some(native) => {
                        if !initialized.agent_capabilities.load_session {
                            return Err(DomainError::Protocol(
                                "provider cannot resume saved session".into(),
                            ));
                        }
                        let loaded = client.load_session(&context.cwd, native.clone()).await?;
                        Ok((
                            native.clone(),
                            loaded.details,
                            initialized.agent_capabilities.metadata,
                        ))
                    }
                    None => {
                        let created = client.new_session(&context.cwd).await?;
                        Ok((
                            created.session_id,
                            created.details,
                            initialized.agent_capabilities.metadata,
                        ))
                    }
                }
            })
            .await?;
        let ((native, mut details, metadata), captured) = initialized;
        let patch = captured.finish(
            &mut details,
            &native,
            super::control::ControlPhase::Startup {
                resuming: context.provider_session.is_some(),
            },
        )?;
        if context.provider_session.is_none() {
            context
                .publish(AgentEvent::ProviderSessionAttached {
                    id: crate::domain::ProviderSessionId::new(native.as_str())?,
                })
                .await?;
        }
        context.publish(AgentEvent::Catalogue(patch)).await?;
        if let Some(restore) = &context.recovery {
            let ((), captured) = super::control::pump(
                &client,
                &mut updates,
                &stop,
                Some(&native),
                client.configure(&native, &mut details, restore),
            )
            .await?;
            let restored = captured.finish(
                &mut details,
                &native,
                super::control::ControlPhase::Configure {
                    preferences_applied: restore.model.is_some() || restore.mode.is_some(),
                },
            )?;
            // Clear the durable marker only with the observed restored settings.
            // Failure here stops the peer and leaves recovery required next load.
            context
                .publish(AgentEvent::ConfigurationRestored(restored))
                .await?;
        }
        Ok::<_, DomainError>((native, details, metadata))
    };
    let (native, mut details, metadata) = match startup.await {
        Ok(result) => result,
        Err(error) => {
            if !stop.is_cancelled() {
                let _ = context
                    .publish(AgentEvent::Crashed {
                        reason: error.to_string(),
                    })
                    .await;
            }
            client.stop().await;
            return;
        }
    };
    'adapter: loop {
        let command = tokio::select! {
            _ = stop.cancelled() => break,
            event = updates.recv() => {
                let result = match event {
                    Some(WorkerEvent::Update(notification)) => context.notification(&native, &mut details, None, notification).await,
                    Some(WorkerEvent::Request(request)) if request.session() == &native => client.answer(&request, InteractionResponse::Cancel).await,
                    Some(WorkerEvent::Request(_)) => Err(DomainError::Protocol("request belongs to another native session".into())),
                    Some(WorkerEvent::Closed(reason)) => Err(DomainError::Worker(reason)),
                    None => Err(DomainError::Worker("worker event stream closed".into())),
                };
                if let Err(error) = result {
                    let _ = context.publish(AgentEvent::Crashed { reason: error.to_string() }).await;
                    break;
                }
                continue;
            }
            command = commands.recv() => command,
        };
        let Some(command) = command else {
            break;
        };
        let (turn, text, config) = match command {
            AdapterCommand::Ready { reply } => {
                let _ = reply.send(Ok(()));
                continue;
            }
            AdapterCommand::Prompt { turn, text, config } => (turn, text, config),
            AdapterCommand::ForkPoints { reply, cancel } => {
                let result = async {
                    if cancel.is_cancelled() { return Err(DomainError::ForkCancelled); }
                    let (points, captured) = tokio::select! {
                        biased;
                        result = super::control::pump(&client, &mut updates, &stop, Some(&native), client.fork_points(&native, &metadata)) => result?,
                        _ = cancel.cancelled() => return Err(DomainError::ForkCancelled),
                    };
                    let patch = captured.finish(
                        &mut details,
                        &native,
                        super::control::ControlPhase::Startup { resuming: true },
                    )?;
                    context.publish(AgentEvent::Catalogue(patch)).await?;
                    Ok(points)
                }
                .await;
                let _ = reply.send(result);
                continue;
            }
            AdapterCommand::ForkNative {
                target,
                reply,
                cancel,
            } => {
                let result = async {
                    // Do not poll/write a remote effect already cancelled while
                    // queued. Once polled, cancellation is conservatively uncertain.
                    if cancel.is_cancelled() { return Err(DomainError::ForkCancelled); }
                    let response = tokio::select! {
                        biased;
                        result = super::control::pump(&client, &mut updates, &stop, Some(&native), client.fork_native(&native, &target, &metadata)) => result,
                        _ = cancel.cancelled() => Err(DomainError::NativeForkUncertain),
                    };
                    let (forked, captured) = response.map_err(|error| match error {
                        DomainError::UnsupportedFeature(_) => error,
                        _ => DomainError::NativeForkUncertain,
                    })?;
                    let publication = async {
                        let patch = captured.finish(
                            &mut details,
                            &native,
                            super::control::ControlPhase::Startup { resuming: true },
                        )?;
                        context.publish(AgentEvent::Catalogue(patch)).await
                    }
                    .await;
                    publication.map_err(|error| DomainError::NativeForkUnadopted {
                        native: forked.clone(),
                        reason: error.to_string(),
                    })?;
                    Ok(forked)
                }
                .await;
                if stop.is_cancelled() || cancel.is_cancelled() {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        client.cancel_native_fork(&native, &metadata),
                    )
                    .await;
                }
                let _ = reply.send(result);
                if stop.is_cancelled() {
                    break;
                }
                continue;
            }
            AdapterCommand::Cancel { reply } => {
                let result = client.cancel(native.clone()).await;
                let _ = reply.send(result);
                break;
            }
            AdapterCommand::Configure { config, reply } => {
                let result = async {
                    let ((), captured) = super::control::pump(
                        &client,
                        &mut updates,
                        &stop,
                        Some(&native),
                        client.configure(&native, &mut details, &config),
                    )
                    .await?;
                    let patch = captured.finish(
                        &mut details,
                        &native,
                        super::control::ControlPhase::Configure {
                            preferences_applied: config.model.is_some() || config.mode.is_some(),
                        },
                    )?;
                    context.publish(AgentEvent::Catalogue(patch)).await
                }
                .await;
                let _ = reply.send(result);
                continue;
            }
            _ => continue,
        };
        let configured = async {
            let ((), captured) = super::control::pump(
                &client,
                &mut updates,
                &stop,
                Some(&native),
                client.configure(&native, &mut details, &config),
            )
            .await?;
            let patch = captured.finish(
                &mut details,
                &native,
                super::control::ControlPhase::Configure {
                    preferences_applied: config.model.is_some() || config.mode.is_some(),
                },
            )?;
            context.publish(AgentEvent::Catalogue(patch)).await
        }
        .await;
        if stop.is_cancelled() {
            break;
        }
        if let Err(error) = configured {
            let _ = context
                .publish(AgentEvent::Crashed {
                    reason: error.to_string(),
                })
                .await;
            break;
        }
        let mut interactions: BTreeMap<InteractionId, InboundRequest> = BTreeMap::new();
        let submitted = std::sync::atomic::AtomicBool::new(false);
        let request = async {
            submitted.store(true, std::sync::atomic::Ordering::Release);
            client
                .prompt(native.clone(), vec![ContentBlock::text(text)])
                .await
        };
        tokio::pin!(request);
        let result = loop {
            tokio::select! {
                biased;
                _ = stop.cancelled() => break 'adapter,
                // Control ingress takes priority over an unbounded notification
                // stream; notification order still precedes the prompt response.
                command = commands.recv() => match command {
                    Some(AdapterCommand::Answer(answer)) => {
                        if let Some(request) = interactions.remove(&answer.interaction) {
                            if let Err(error) = client.answer(&request, answer.response).await {
                                let _ = context.publish(AgentEvent::Crashed { reason: error.to_string() }).await;
                                break 'adapter;
                            }
                        }
                    }
                    Some(AdapterCommand::Cancel { reply }) => {
                        let result = client.cancel(native.clone()).await;
                        for interaction in interactions.values() { let _ = client.answer(interaction, InteractionResponse::Cancel).await; }
                        if submitted.load(std::sync::atomic::Ordering::Acquire) {
                            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), &mut request).await;
                        }
                        let _ = reply.send(result);
                        break 'adapter;
                    }
                    Some(AdapterCommand::Ready { reply }) => { let _ = reply.send(Err(DomainError::Busy)); }
                    Some(AdapterCommand::Configure { reply, .. }) => { let _ = reply.send(Err(DomainError::Busy)); }
                    Some(AdapterCommand::ForkPoints { reply, .. }) => { let _ = reply.send(Err(DomainError::Busy)); }
                    Some(AdapterCommand::ForkNative { reply, .. }) => { let _ = reply.send(Err(DomainError::Busy)); }
                    Some(AdapterCommand::Prompt { .. }) => {
                        let _ = context.publish(AgentEvent::Crashed { reason: "overlapping worker turn".into() }).await;
                        break 'adapter;
                    }
                    None => break 'adapter,
                },
                event = updates.recv() => match event {
                    Some(WorkerEvent::Update(notification)) => {
                        if let Err(error) = context.notification(&native, &mut details, Some(turn.clone()), notification).await {
                            let _ = context.publish(AgentEvent::Crashed { reason: error.to_string() }).await;
                            break 'adapter;
                        }
                    }
                    Some(WorkerEvent::Request(request)) => {
                        if request.session() != &native || interactions.len() >= context.pending_interactions {
                            let _ = context.publish(AgentEvent::Crashed { reason: "invalid or excessive inbound interaction".into() }).await;
                            break 'adapter;
                        }
                        if interactions.values().any(|existing| existing.id() == request.id()) { continue; }
                        let id = InteractionId::generate();
                        match request.to_domain(id.clone()) {
                            Ok(interaction) => {
                                if context.publish(AgentEvent::Interaction(interaction)).await.is_err() { break 'adapter; }
                                interactions.insert(id, request);
                            }
                            Err(_) => {
                                // Explicitly decline unsupported forms; never silently truncate schemas.
                                if client.answer(&request, InteractionResponse::Decline).await.is_err() { break 'adapter; }
                            }
                        }
                    }
                    Some(WorkerEvent::Closed(reason)) => {
                        let _ = context.publish(AgentEvent::Crashed { reason }).await;
                        break 'adapter;
                    }
                    None => {
                        let _ = context.publish(AgentEvent::Crashed { reason: "worker event stream closed".into() }).await;
                        break 'adapter;
                    }
                },
                result = &mut request => break result,
            }
        };
        match result {
            Ok(response) => {
                if let Some(usage) = response.usage {
                    if context
                        .publish(AgentEvent::Usage {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                if context
                    .publish(AgentEvent::Finished { turn })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(error) => {
                let _ = context
                    .publish(AgentEvent::Crashed {
                        reason: error.to_string(),
                    })
                    .await;
                break;
            }
        }
    }
    client.stop().await;
}

#[derive(Clone)]
pub struct AdapterContext {
    pub session: SessionId,
    pub epoch: u64,
    pub cwd: WorkspacePath,
    pub provider_session: Option<crate::domain::ProviderSessionId>,
    pub registry: RegistryHandle,
    pub lifecycle: CancellationToken,
    pub pending_interactions: usize,
    pub recovery: Option<crate::domain::session::SessionConfig>,
}
impl AdapterContext {
    async fn notification(
        &self,
        native: &super::NativeSessionId,
        details: &mut super::settings::SessionDetails,
        turn: Option<TurnId>,
        notification: super::SessionNotification,
    ) -> Result<(), DomainError> {
        if &notification.session_id != native {
            return Err(DomainError::Protocol(
                "notification belongs to another native session".into(),
            ));
        }
        let event = match notification.update {
            SessionUpdate::ConfigOptions { config_options } => {
                details.config_options = Some(config_options);
                Some(AgentEvent::Catalogue(details.catalogue_patch()?))
            }
            SessionUpdate::CurrentMode { current_mode_id } => {
                let mode = crate::domain::ModeId::new(current_mode_id)?;
                details.observe_mode(&mode);
                Some(AgentEvent::Catalogue(
                    crate::domain::catalogue::CataloguePatch {
                        current_mode: Some(mode),
                        ..Default::default()
                    },
                ))
            }
            SessionUpdate::AvailableCommands { available_commands } => Some(
                AgentEvent::AvailableCommands(super::control::commands(available_commands)),
            ),
            update => match turn {
                Some(turn) => update_to_agent(turn, update)?,
                None => None,
            },
        };
        if let Some(event) = event {
            self.publish(event).await?;
        }
        Ok(())
    }
    async fn publish(&self, event: AgentEvent) -> Result<(), DomainError> {
        // Mark protocol ownership terminal before exposing the committed crash.
        // A next prompt must join/replace us, not queue into a dying receiver.
        if matches!(event, AgentEvent::Crashed { .. }) {
            self.lifecycle.cancel();
        }
        self.registry
            .worker_event(self.session.clone(), self.epoch, event)
            .await?;
        Ok(())
    }
}

fn tool_update(
    turn: TurnId,
    id: String,
    title: Option<String>,
    status: Option<super::ToolStatus>,
    details: super::tool::ToolDetailsPatch,
) -> Option<AgentEvent> {
    let id = crate::domain::ToolCallId::new(id).ok()?;
    let status = status.and_then(|status| match status {
        super::ToolStatus::Pending => Some(crate::domain::tool::ToolStatus::Pending),
        super::ToolStatus::InProgress => Some(crate::domain::tool::ToolStatus::InProgress),
        super::ToolStatus::Completed => Some(crate::domain::tool::ToolStatus::Completed),
        super::ToolStatus::Failed => Some(crate::domain::tool::ToolStatus::Failed),
        super::ToolStatus::Unknown => None,
    });
    Some(AgentEvent::ToolCall(crate::domain::tool::ToolCallUpdate {
        id,
        turn,
        title,
        status,
        details: details.into_domain(),
    }))
}

pub fn update_to_agent(
    turn: TurnId,
    update: SessionUpdate,
) -> Result<Option<AgentEvent>, DomainError> {
    Ok(match update {
        SessionUpdate::AgentMessage {
            content,
            message_id,
        } => match content {
            ContentBlock::Known(super::content::KnownContent::Image {
                data, mime_type, ..
            }) => Some(AgentEvent::Image {
                turn,
                asset: crate::domain::image::ImageAsset::from_base64(&mime_type, &data)?,
                message: message_id,
            }),
            content => content.display_text().map(|text| AgentEvent::Text {
                turn,
                text: text.to_owned(),
                message: message_id,
            }),
        },
        SessionUpdate::AgentThought {
            content,
            message_id,
        } => content.display_text().map(|text| AgentEvent::Thought {
            turn,
            text: text.to_owned(),
            message: message_id,
        }),
        SessionUpdate::ToolCall {
            tool_call_id,
            title,
            status,
            details,
        } => tool_update(turn, tool_call_id, Some(title), status, details),
        SessionUpdate::ToolCallUpdate {
            tool_call_id,
            title,
            status,
            details,
        } => tool_update(turn, tool_call_id, title, status, details),
        SessionUpdate::AvailableCommands { available_commands } => Some(
            AgentEvent::AvailableCommands(super::control::commands(available_commands)),
        ),
        SessionUpdate::Usage { used, size } => Some(AgentEvent::ContextUsage { used, size }),
        SessionUpdate::Plan { entries } => Some(AgentEvent::Plan(crate::domain::plan::Plan {
            items: entries
                .into_iter()
                .map(|entry| crate::domain::plan::PlanItem {
                    description: entry.content,
                    status: match entry.status {
                        super::PlanStatus::Pending | super::PlanStatus::Unknown => {
                            crate::domain::plan::PlanStatus::Pending
                        }
                        super::PlanStatus::InProgress => {
                            crate::domain::plan::PlanStatus::InProgress
                        }
                        super::PlanStatus::Completed => crate::domain::plan::PlanStatus::Completed,
                    },
                })
                .collect(),
        })),
        _ => None,
    })
}
