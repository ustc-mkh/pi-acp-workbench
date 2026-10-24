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
    Models {
        action: crate::domain::management::ManagementAction,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::domain::management::ProviderModels, DomainError>,
        >,
    },
    Ready {
        reply: tokio::sync::oneshot::Sender<Result<(), DomainError>>,
    },
    Prompt {
        turn: TurnId,
        text: crate::domain::Prompt,
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
    let mut runs = RunState::default();
    let mut background_interactions = BTreeMap::new();
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
                            initialized.agent_capabilities.load_session,
                            initialized.agent_capabilities.prompt_capabilities,
                        ))
                    }
                    None => {
                        let created = client.new_session(&context.cwd).await?;
                        Ok((
                            created.session_id,
                            created.details,
                            initialized.agent_capabilities.metadata,
                            initialized.agent_capabilities.load_session,
                            initialized.agent_capabilities.prompt_capabilities,
                        ))
                    }
                }
            })
            .await?;
        let ((native, mut details, metadata, resumable, prompt_capabilities), mut captured) =
            initialized;
        runs.enabled = context.session_harness == "Pi"
            && metadata
                .pi_workbench
                .as_ref()
                .is_some_and(|cap| cap.version == 1 && cap.autonomous_runs == Some(true));
        runs.drain(
            &mut captured,
            &context,
            &client,
            &native,
            &mut details,
            &mut background_interactions,
        )
        .await?;
        let mut patch = captured.finish(
            &mut details,
            &native,
            super::control::ControlPhase::Startup {
                resuming: context.provider_session.is_some(),
            },
        )?;
        patch.image_input = Some(prompt_capabilities.image);
        if context.provider_session.is_none() {
            context
                .publish(AgentEvent::ProviderSessionAttached {
                    id: crate::domain::ProviderSessionId::new(native.as_str())?,
                })
                .await?;
        }
        context.publish(AgentEvent::Catalogue(patch)).await?;
        if let Some(restore) = &context.recovery {
            let ((), mut captured) = super::control::pump(
                &client,
                &mut updates,
                &stop,
                Some(&native),
                client.configure(&native, &mut details, restore),
            )
            .await?;
            runs.drain(
                &mut captured,
                &context,
                &client,
                &native,
                &mut details,
                &mut background_interactions,
            )
            .await?;
            let restored = captured.finish(
                &mut details,
                &native,
                super::control::ControlPhase::Configure {
                    preferences_applied: restore.model.is_some()
                        || restore.mode.is_some()
                        || !restore.options.is_empty(),
                },
            )?;
            // Clear the durable marker only with the observed restored settings.
            // Failure here stops the peer and leaves recovery required next load.
            context
                .publish(AgentEvent::ConfigurationRestored(restored))
                .await?;
        }
        Ok::<_, DomainError>((native, details, metadata, resumable, prompt_capabilities))
    };
    let (native, mut details, metadata, resumable, prompt_capabilities) = match startup.await {
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
    if let Some((resumable_state, background_state)) = &context.worker_capabilities {
        resumable_state.store(resumable, std::sync::atomic::Ordering::Release);
        background_state.store(
            if matches!(context.session_harness.as_str(), "Pi") {
                metadata
                    .pi_workbench
                    .as_ref()
                    .and_then(|cap| cap.autonomous_runs)
                    == Some(false)
            } else {
                true
            },
            std::sync::atomic::Ordering::Release,
        );
    }
    let client = std::sync::Arc::new(client);
    let mut title_tasks = tokio::task::JoinSet::new();
    'adapter: loop {
        let command = tokio::select! {
            Some(_) = title_tasks.join_next(), if !title_tasks.is_empty() => continue,
            _ = stop.cancelled() => break,
            event = updates.recv() => {
                let result = match event {
                    Some(WorkerEvent::Update(notification)) => runs.notification(&context, &native, &mut details, None, notification).await,
                    Some(WorkerEvent::Request(request)) if request.session() == &native => {
                        if runs.autonomous.is_some() {
                            context.interaction(&client, &native, request, &mut background_interactions).await
                        } else { client.answer(&request, InteractionResponse::Cancel).await }
                    },
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
        if runs.autonomous.is_some() {
            match command {
                AdapterCommand::Answer(answer) => {
                    if let Some(request) = background_interactions.remove(&answer.interaction) {
                        if client.answer(&request, answer.response).await.is_err() {
                            break;
                        }
                    }
                }
                AdapterCommand::Cancel { reply } => {
                    let result = client.cancel(native.clone()).await;
                    for request in background_interactions.values() {
                        let _ = client.answer(request, InteractionResponse::Cancel).await;
                    }
                    let _ = reply.send(result);
                    break;
                }
                AdapterCommand::Models { reply, .. } => {
                    let _ = reply.send(Err(DomainError::Busy));
                }
                AdapterCommand::Ready { reply } | AdapterCommand::Configure { reply, .. } => {
                    let _ = reply.send(Err(DomainError::Busy));
                }
                AdapterCommand::ForkPoints { reply, .. } => {
                    let _ = reply.send(Err(DomainError::Busy));
                }
                AdapterCommand::ForkNative { reply, .. } => {
                    let _ = reply.send(Err(DomainError::Busy));
                }
                AdapterCommand::Prompt { .. } => { /* Already fenced by autonomous admission. */ }
            }
            continue;
        }
        background_interactions.clear();
        let (turn, text, config) = match command {
            AdapterCommand::Models { action, reply } => {
                let result = async {
                    let (response, mut captured) = super::control::pump(
                        &client,
                        &mut updates,
                        &stop,
                        Some(&native),
                        client.models(&native, &metadata, &action),
                    )
                    .await?;
                    runs.drain(
                        &mut captured,
                        &context,
                        &client,
                        &native,
                        &mut details,
                        &mut background_interactions,
                    )
                    .await?;
                    let patch = captured.finish(
                        &mut details,
                        &native,
                        super::control::ControlPhase::Startup { resuming: true },
                    )?;
                    context.publish(AgentEvent::Catalogue(patch)).await?;
                    Ok(response)
                }
                .await;
                let _ = reply.send(result);
                continue;
            }
            AdapterCommand::Ready { reply } => {
                let _ = reply.send(Ok(()));
                continue;
            }
            AdapterCommand::Prompt { turn, text, config } => (turn, text, config),
            AdapterCommand::ForkPoints { reply, cancel } => {
                let result = async {
                    if cancel.is_cancelled() { return Err(DomainError::ForkCancelled); }
                    let (points, mut captured) = tokio::select! {
                        biased;
                        result = super::control::pump(&client, &mut updates, &stop, Some(&native), client.fork_points(&native, &metadata)) => result?,
                        _ = cancel.cancelled() => return Err(DomainError::ForkCancelled),
                    };
                    runs.drain(&mut captured, &context, &client, &native, &mut details, &mut background_interactions).await?;
                    let patch = captured.finish(
                        &mut details, &native,
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
                    let (forked, mut captured) = response.map_err(|error| match error {
                        DomainError::UnsupportedFeature(_) => error,
                        _ => DomainError::NativeForkUncertain,
                    })?;
                    let publication = async {
                        runs.drain(&mut captured, &context, &client, &native, &mut details, &mut background_interactions).await?;
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
                    let ((), mut captured) = super::control::pump(
                        &client,
                        &mut updates,
                        &stop,
                        Some(&native),
                        client.configure(&native, &mut details, &config),
                    )
                    .await?;
                    runs.drain(
                        &mut captured,
                        &context,
                        &client,
                        &native,
                        &mut details,
                        &mut background_interactions,
                    )
                    .await?;
                    let patch = captured.finish(
                        &mut details,
                        &native,
                        super::control::ControlPhase::Configure {
                            preferences_applied: config.model.is_some()
                                || config.mode.is_some()
                                || !config.options.is_empty(),
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
            let ((), mut captured) = super::control::pump(
                &client,
                &mut updates,
                &stop,
                Some(&native),
                client.configure(&native, &mut details, &config),
            )
            .await?;
            runs.drain(
                &mut captured,
                &context,
                &client,
                &native,
                &mut details,
                &mut background_interactions,
            )
            .await?;
            let patch = captured.finish(
                &mut details,
                &native,
                super::control::ControlPhase::Configure {
                    preferences_applied: config.model.is_some()
                        || config.mode.is_some()
                        || !config.options.is_empty(),
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
        if runs.autonomous.is_some() || runs.rejected.as_ref() == Some(&turn) {
            continue; // Explicit wake won while configuration was in flight.
        }
        runs.live = None;
        let title_text: String = text.as_str().chars().take(1000).collect();
        let title_job = if metadata.supports_title() {
            if let Some(db) = &context.database {
                db.title_job(context.session.clone()).await.ok().flatten()
            } else {
                None
            }
        } else {
            None
        };
        let mut interactions: BTreeMap<InteractionId, InboundRequest> = BTreeMap::new();
        let submitted = std::sync::atomic::AtomicBool::new(false);
        let request = async {
            submitted.store(true, std::sync::atomic::Ordering::Release);
            client
                .prompt(native.clone(), prompt_blocks(&text, &prompt_capabilities)?)
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
                    Some(AdapterCommand::Models { reply,.. }) => {let _=reply.send(Err(DomainError::Busy));}
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
                        if let Err(error) = runs.notification(&context, &native, &mut details, Some(turn.clone()), notification).await {
                            let _ = context.publish(AgentEvent::Crashed { reason: error.to_string() }).await;
                            break 'adapter;
                        }
                    }
                    Some(WorkerEvent::Request(request)) => {
                        if let Err(error) = context.interaction(&client, &native, request, &mut interactions).await {
                            let _ = context.publish(AgentEvent::Crashed { reason: error.to_string() }).await;
                            break 'adapter;
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
        if runs.rejected.as_ref() == Some(&turn) {
            background_interactions = interactions;
            continue;
        }
        match result {
            Ok(response) => {
                if let Some(usage) = response.usage {
                    if context
                        .publish(AgentEvent::Usage {
                            input_tokens: usage.input_tokens,
                            output_tokens: usage.output_tokens,
                            cache_read_tokens: usage.cached_read_tokens,
                            cache_write_tokens: usage.cached_write_tokens,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let title_pin = if title_job.is_some() {
                    context.pins.as_ref().map(|pins| {
                        pins.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                        TitlePin(pins.clone())
                    })
                } else {
                    None
                };
                if context
                    .publish(AgentEvent::Finished { turn })
                    .await
                    .is_err()
                {
                    break;
                }
                if let (Some(model), Some(db)) = (title_job, context.database.clone()) {
                    let (client, native, session) =
                        (client.clone(), native.clone(), context.session.clone());
                    title_tasks.spawn(async move {
                        let _pin = title_pin;
                        if let Ok(Ok(response)) = tokio::time::timeout(
                            std::time::Duration::from_secs(15),
                            client.title(&native, &model, &title_text),
                        )
                        .await
                        {
                            let _ = db.title_result(session, response).await;
                        }
                    });
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
    title_tasks.shutdown().await;
    if let Ok(client) = std::sync::Arc::try_unwrap(client) {
        client.stop().await;
    }
    if let Some(reviews) = &context.reviews {
        let _ = reviews.finish(&context.session, None).await;
    }
}

/// Protocol run identities stay here; only explicit starts become domain facts.
#[derive(Default)]
struct RunState {
    enabled: bool,
    finished: bool,
    live: Option<crate::domain::ProviderMessageId>,
    autonomous: Option<TurnId>,
    rejected: Option<TurnId>,
}
impl RunState {
    async fn drain(
        &mut self,
        captured: &mut super::control::ControlUpdates,
        context: &AdapterContext,
        client: &AcpClient,
        native: &super::NativeSessionId,
        details: &mut super::settings::SessionDetails,
        interactions: &mut BTreeMap<InteractionId, InboundRequest>,
    ) -> Result<(), DomainError> {
        for event in std::mem::take(&mut captured.live) {
            match event {
                WorkerEvent::Update(notification) => {
                    self.notification(context, native, details, None, notification)
                        .await?
                }
                WorkerEvent::Request(request) if self.autonomous.is_some() => {
                    context
                        .interaction(client, native, request, interactions)
                        .await?
                }
                WorkerEvent::Request(request) => {
                    client.answer(&request, InteractionResponse::Cancel).await?
                }
                WorkerEvent::Closed(reason) => return Err(DomainError::Worker(reason)),
            }
        }
        Ok(())
    }
    async fn notification(
        &mut self,
        context: &AdapterContext,
        native: &super::NativeSessionId,
        details: &mut super::settings::SessionDetails,
        prompt: Option<TurnId>,
        mut notification: super::SessionNotification,
    ) -> Result<(), DomainError> {
        if &notification.session_id != native {
            return Err(DomainError::Protocol(
                "notification belongs to another native session".into(),
            ));
        }
        if let SessionUpdate::PiRun(run) = notification.update {
            if !self.enabled {
                return Ok(());
            }
            if run.running {
                if self.live.as_ref() == Some(&run.id)
                    && (self.finished || !run.autonomous || self.autonomous.is_some())
                {
                    return Ok(());
                }
                if run.autonomous {
                    let view = context
                        .registry
                        .command(crate::domain::command::DomainCommand::Inspect(
                            context.session.clone(),
                        ))
                        .await?;
                    self.rejected = prompt
                        .clone()
                        .or_else(|| view.view().and_then(|v| v.active_turn.clone()));
                    if let Some(reviews) = &context.reviews {
                        reviews.reject_input(&context.session).await?;
                    }
                    let turn = TurnId::generate();
                    if let Some(database) = &context.database {
                        database.save_turn_diff(context.session.clone(), turn.clone(), crate::workspace_review::TurnDiff {
                            status: crate::workspace_review::DiffStatus::Unavailable, files: vec![],
                            warnings: vec!["Autonomous start is reported after execution began; no whole-run workspace baseline.".into()],
                            added: 0, removed: 0, next_offset: None,
                        }).await.map_err(|e| DomainError::Persistence(e.to_string()))?;
                    }
                    context
                        .publish(AgentEvent::AutonomousStarted { turn: turn.clone() })
                        .await?;
                    self.autonomous = Some(turn);
                }
                self.live = Some(run.id);
                self.finished = false;
            } else if self.live.as_ref() == Some(&run.id) && !self.finished {
                self.finished = true;
                if self.autonomous.is_some() || prompt.is_some() {
                    if let Some(usage) = run.usage {
                        context
                            .publish(AgentEvent::Usage {
                                input_tokens: usage.input_tokens,
                                output_tokens: usage.output_tokens,
                                cache_read_tokens: usage.cached_read_tokens,
                                cache_write_tokens: usage.cached_write_tokens,
                            })
                            .await?;
                    }
                }
                if let Some(turn) = self.autonomous.take() {
                    if run.error.is_some() {
                        context
                            .publish(AgentEvent::Crashed {
                                reason: "Pi autonomous run failed (provider details withheld)"
                                    .into(),
                            })
                            .await?;
                    } else if run.cancelled {
                        // Provider-confirmed cancellation; no host-side stop is necessary.
                        context.publish(AgentEvent::Cancelled { turn }).await?;
                    } else {
                        context.publish(AgentEvent::Finished { turn }).await?;
                    }
                }
            }
            return Ok(());
        }
        if let SessionUpdate::PiLive { id, update } = notification.update {
            if self.live.as_ref() != Some(&id) {
                return Ok(());
            }
            if self.finished {
                // Stats settle asynchronously after the explicit finish. They
                // update occupancy only, never append text or inference usage.
                if let SessionUpdate::Usage { used, size } = *update {
                    context
                        .publish(AgentEvent::ContextUsage { used, size })
                        .await?;
                }
                return Ok(());
            }
            notification.update = *update;
        } else if self.autonomous.is_some() {
            // No run identity means no evidence this belongs to the autonomous run.
            return Ok(());
        }
        context
            .notification(
                native,
                details,
                self.autonomous.clone().or(prompt),
                notification,
            )
            .await
    }
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
    pub(crate) reviews: Option<std::sync::Arc<crate::workspace_reviews::Reviews>>,
    pub(crate) database: Option<crate::persistence::database::Database>,
    pub(crate) worker_capabilities: Option<(
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    )>,
    pub(crate) pins: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
    pub(crate) session_harness: String,
    pub recovery: Option<crate::domain::session::SessionConfig>,
}
struct TitlePin(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl Drop for TitlePin {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl AdapterContext {
    async fn interaction(
        &self,
        client: &AcpClient,
        native: &super::NativeSessionId,
        request: InboundRequest,
        interactions: &mut BTreeMap<InteractionId, InboundRequest>,
    ) -> Result<(), DomainError> {
        if request.session() != native || interactions.len() >= self.pending_interactions {
            return Err(DomainError::Protocol(
                "invalid or excessive inbound interaction".into(),
            ));
        }
        if interactions
            .values()
            .any(|existing| existing.id() == request.id())
        {
            return Ok(());
        }
        let id = InteractionId::generate();
        match request.to_domain(id.clone()) {
            Ok(interaction) => {
                self.publish(AgentEvent::Interaction(interaction)).await?;
                interactions.insert(id, request);
            }
            Err(_) => {
                client
                    .answer(&request, InteractionResponse::Decline)
                    .await?
            }
        }
        Ok(())
    }
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
        if matches!(
            event,
            AgentEvent::Finished { .. } | AgentEvent::Cancelled { .. } | AgentEvent::Crashed { .. }
        ) {
            if let Some(reviews) = &self.reviews {
                let expected = match &event {
                    AgentEvent::Finished { turn } | AgentEvent::Cancelled { turn } => Some(turn),
                    _ => None,
                };
                reviews.finish(&self.session, expected).await?;
            }
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

fn prompt_blocks(
    prompt: &crate::domain::Prompt,
    capabilities: &super::dto::PromptCapabilities,
) -> Result<Vec<ContentBlock>, DomainError> {
    use super::content::{EmbeddedResource, KnownContent};
    use crate::domain::ids::PromptPart;
    use base64::{engine::general_purpose::STANDARD, Engine};
    prompt
        .parts()
        .iter()
        .map(|part| {
            Ok(match part {
                PromptPart::Text { text } => ContentBlock::text(text),
                PromptPart::Context { id, name, text } => {
                    if capabilities.embedded_context {
                        ContentBlock::Known(KnownContent::Resource {
                            resource: EmbeddedResource::Text {
                                uri: format!("workbench-context:{id}"),
                                text: format!(
                                    "Explicit context: {name}

{text}"
                                ),
                                mime_type: Some("text/plain".into()),
                            },
                        })
                    } else {
                        ContentBlock::text(format!(
                            "Explicit context [{id}]: {name}

{text}"
                        ))
                    }
                }
                PromptPart::Image { asset } => {
                    if !capabilities.image {
                        return Err(DomainError::Protocol(
                            "provider does not support image input".into(),
                        ));
                    }
                    ContentBlock::Known(KnownContent::Image {
                        data: STANDARD.encode(asset.bytes()),
                        mime_type: asset.image().mime().as_str().into(),
                        uri: None,
                    })
                }
            })
        })
        .collect()
}
