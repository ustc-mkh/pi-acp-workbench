//! Worker discovery, observation, admission and physical shutdown.
use super::*;

impl CommandCore {
    pub(super) async fn stop_session_adapter(
        &self,
        session: &SessionId,
    ) -> Result<(), DomainError> {
        let _worker_admission = self.coordinator.admission.lock().await;
        let adapter = self.coordinator.adapters.lock().await.remove(session);
        if let Some(adapter) = adapter {
            // Native cancel errors do not undo a successful physical stop.
            // cancel_and_stop always joins the process before returning.
            let _ = adapter.cancel_and_stop().await;
        } else if self.closed.load(Ordering::Acquire) {
            // Root shutdown may temporarily own this adapter outside the map.
            self.coordinator.supervisor.shutdown().await?;
        }
        Ok(())
    }
    /// v1 Pi stops cancel the active autonomous run first. Only unresponsive
    /// providers fall back to the existing durable fence/physical join path.
    pub(super) async fn interrupt_background(
        &self,
        session: &SessionId,
    ) -> Result<Option<crate::domain::TurnId>, DomainError> {
        let view = self
            .database
            .view(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        if view.harness != crate::domain::Harness::Pi {
            return Ok(None);
        }
        let Some(turn) = view.active_turn else {
            return Ok(None);
        };
        let sender = self
            .coordinator
            .adapters
            .lock()
            .await
            .get(session)
            .map(|h| h.tx.clone());
        let Some(sender) = sender else {
            return Ok(None);
        };
        let (reply, wait) = tokio::sync::oneshot::channel();
        if sender
            .try_send(AdapterCommand::CanInterrupt {
                turn: turn.clone(),
                reply,
            })
            .is_err()
            || !matches!(
                tokio::time::timeout(std::time::Duration::from_millis(200), wait).await,
                Ok(Ok(true))
            )
        {
            return Ok(None);
        }
        self.commit(DomainCommand::Interrupt {
            session: session.clone(),
            turn: turn.clone(),
            completed: false,
        })
        .await?;
        let mut events = self.events.subscribe();
        let graceful = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (reply, wait) = tokio::sync::oneshot::channel();
            sender
                .try_send(AdapterCommand::Interrupt {
                    turn: turn.clone(),
                    reply,
                })
                .map_err(DomainError::mailbox)?;
            let supported = wait
                .await
                .map_err(|_| DomainError::Worker("interruption observer closed".into()))??;
            loop {
                let current = self
                    .database
                    .view(session.clone())
                    .await
                    .map_err(|e| DomainError::Persistence(e.to_string()))?;
                if matches!(current.status, crate::domain::SessionStatus::Failed(_)) {
                    return Ok(false);
                }
                if current.active_turn.as_ref() != Some(&turn) {
                    return Ok(true);
                }
                if !supported {
                    return Ok(false);
                }
                match events.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => {
                        return Err(DomainError::Worker(
                            "interruption event stream closed".into(),
                        ))
                    }
                }
            }
        })
        .await;
        if matches!(graceful, Ok(Ok(true))) {
            return Ok(Some(turn));
        }
        Ok(None)
    }
    pub(super) async fn fail_adapter(
        &self,
        session: &SessionId,
        error: &DomainError,
    ) -> Result<(), DomainError> {
        let adapter = self.coordinator.adapters.lock().await.remove(session);
        if let Some(adapter) = &adapter {
            adapter.stop.cancel();
        }
        // Attempt durable fencing first, but reclaim the faulty process even
        // when storage is unavailable. The terminal projection follows the join.
        let _ = self
            .runtime
            .registry
            .command_admitted(DomainCommand::RequestCancel {
                session: session.clone(),
            })
            .await;
        if let Some(adapter) = adapter {
            adapter.stop().await;
        } else if self.closed.load(Ordering::Acquire) {
            self.coordinator.supervisor.shutdown().await?;
        }
        let terminal = if self.closed.load(Ordering::Acquire) {
            DomainCommand::Cancel {
                session: session.clone(),
            }
        } else {
            DomainCommand::Agent {
                session: session.clone(),
                event: AgentEvent::Crashed {
                    reason: error.to_string(),
                },
            }
        };
        self.coordinator.reviews.finish(session, None).await?;
        self.runtime.registry.command_admitted(terminal).await?;
        Ok(())
    }
    pub(super) async fn observe_provider(
        &self,
        session: SessionId,
    ) -> Result<
        (
            mpsc::Sender<AdapterCommand>,
            crate::domain::session::SessionConfig,
        ),
        DomainError,
    > {
        self.runtime
            .registry
            .command_admitted(DomainCommand::LoadSession(session.clone()))
            .await?;
        let view = self
            .runtime
            .registry
            .command_admitted(DomainCommand::Inspect(session.clone()))
            .await?;
        if view.view().is_some_and(|view| view.active_turn.is_some()) {
            return Err(DomainError::Busy);
        }
        let (sender, config) = self.adapter_sender(session.clone()).await?;
        let (reply, wait) = tokio::sync::oneshot::channel();
        sender
            .try_send(AdapterCommand::Ready { reply })
            .map_err(DomainError::mailbox)?;
        let ready = tokio::time::timeout(std::time::Duration::from_secs(10), wait).await;
        if !matches!(ready, Ok(Ok(Ok(())))) {
            self.stop_session_adapter(&session).await?;
            return Err(DomainError::Worker(
                "provider discovery did not become ready".into(),
            ));
        }
        self.ensure_model_context(&session).await?;
        Ok((sender, config))
    }
    pub(super) async fn discover(&self, session: SessionId) -> Result<CommandReceipt, DomainError> {
        let (sender, config) = self.observe_provider(session.clone()).await?;
        // Discovery must show the same inherited choices that the next prompt
        // will use, rather than the provider's fresh native defaults.
        let observed = self
            .runtime
            .registry
            .command_admitted(DomainCommand::Inspect(session.clone()))
            .await?;
        let snapshot = observed
            .view()
            .ok_or_else(|| DomainError::NotFound(session.clone()))?;
        let differs = config
            .model
            .as_ref()
            .is_some_and(|v| snapshot.catalogue.current_model.as_ref() != Some(v))
            || config
                .mode
                .as_ref()
                .is_some_and(|v| snapshot.catalogue.current_mode.as_ref() != Some(v))
            || config.options.iter().any(|(id, value)| {
                !snapshot
                    .catalogue
                    .selects
                    .iter()
                    .any(|s| &s.id == id && &s.current_value == value)
            });
        if differs {
            let restore = crate::domain::session::SessionConfig {
                model: snapshot.catalogue.current_model.clone(),
                mode: snapshot.catalogue.current_mode.clone(),
                options: snapshot
                    .catalogue
                    .selects
                    .iter()
                    .filter(|s| config.options.contains_key(&s.id))
                    .map(|s| (s.id.clone(), s.current_value.clone()))
                    .collect(),
            };
            self.commit(DomainCommand::PrepareConfiguration {
                session: session.clone(),
                intent: crate::domain::session::ConfigurationIntent {
                    requested: config.clone(),
                    restore,
                },
            })
            .await?;
            let applied = async {
                let (reply, wait) = tokio::sync::oneshot::channel();
                sender
                    .try_send(AdapterCommand::Configure { config, reply })
                    .map_err(DomainError::mailbox)?;
                wait.await.map_err(|_| {
                    DomainError::Worker("adapter stopped while applying saved preferences".into())
                })??;
                self.commit(DomainCommand::CommitConfiguration {
                    session: session.clone(),
                })
                .await
            }
            .await;
            if let Err(error) = applied {
                self.stop_session_adapter(&session).await?;
                return Err(error);
            }
        }
        self.runtime
            .registry
            .command_admitted(DomainCommand::Inspect(session))
            .await?
            .receipt()
    }
    pub(super) async fn adapter_sender(
        &self,
        session: SessionId,
    ) -> Result<
        (
            mpsc::Sender<AdapterCommand>,
            crate::domain::session::SessionConfig,
        ),
        DomainError,
    > {
        let _worker_admission = self.coordinator.admission.lock().await;
        let obsolete = {
            let mut adapters = self.coordinator.adapters.lock().await;
            if self.closed.load(Ordering::Acquire) {
                return Err(ingress::stopping());
            }
            if adapters.get(&session).is_some_and(|adapter| {
                adapter.stop.is_cancelled() || adapter.task.is_finished() || adapter.tx.is_closed()
            }) {
                adapters.remove(&session)
            } else {
                None
            }
        };
        // Per-session ingress owns ordering; no global map lock spans process I/O.
        if let Some(adapter) = obsolete {
            adapter.stop().await;
        }
        let snapshot = self
            .runtime
            .registry
            .command_admitted(DomainCommand::Inspect(session.clone()))
            .await?;
        let (harness, cwd, provider_session, config, recovery) = match snapshot.view() {
            Some(snapshot) => (
                snapshot.harness.clone(),
                snapshot.cwd.clone(),
                snapshot.provider_session.clone(),
                snapshot.config.clone(),
                snapshot
                    .configuration_intent
                    .as_ref()
                    .map(|intent| intent.restore.clone()),
            ),
            _ => return Err(DomainError::NotFound(session)),
        };
        {
            let adapters = self.coordinator.adapters.lock().await;
            if let Some(adapter) = adapters.get(&session) {
                return Ok((adapter.tx.clone(), config));
            }
        }
        let activity = self
            .database
            .worker_activity(session.clone())
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        let root = crate::workspace_review::canonical(std::path::Path::new(cwd.as_str()))
            .map_err(DomainError::Persistence)?;
        let workspace_lease = self.workspace_gate.enter(root, false)?;
        let (mut events, mut updates) = mpsc::channel(32);
        let mut worker = self
            .coordinator
            .supervisor
            .spawn_for(session.clone(), &harness, events)
            .await;
        if matches!(worker, Err(DomainError::WorkerCapacity)) {
            self.reclaim_workers(Some(&session), false).await?;
            (events, updates) = mpsc::channel(32);
            worker = self
                .coordinator
                .supervisor
                .spawn_for(session.clone(), &harness, events)
                .await;
        }
        let worker = worker?;
        let epoch = worker.epoch;
        if let Err(error) = self
            .runtime
            .registry
            .worker_started(session.clone(), epoch)
            .await
        {
            worker.stop().await;
            return Err(error);
        }
        let (tx, commands) = mpsc::channel(8);
        let stop = self.coordinator.stop.child_token();
        let mut adapters = self.coordinator.adapters.lock().await;
        if self.closed.load(Ordering::Acquire) {
            drop(adapters);
            worker.stop().await;
            return Err(ingress::stopping());
        }
        let resumable = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let background_safe = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_completion = worker.completion();
        let task = self.coordinator.tasks.spawn(adapter::run(
            worker,
            AdapterContext {
                session: session.clone(),
                epoch,
                cwd,
                provider_session,
                registry: self.runtime.registry.clone(),
                lifecycle: stop.clone(),
                pending_interactions: self.pending_interactions,
                reviews: Some(self.coordinator.reviews.clone()),
                database: Some(self.database.clone()),
                recovery,
                worker_capabilities: Some((resumable.clone(), background_safe.clone())),
                pins: Some(pins.clone()),
                session_harness: match harness {
                    crate::domain::Harness::Pi => "Pi",
                    crate::domain::Harness::Codex => "Codex",
                    crate::domain::Harness::Claude => "Claude",
                }
                .into(),
            },
            commands,
            updates,
            stop.clone(),
        ))?;
        adapters.insert(
            session.clone(),
            AdapterHandle {
                registry: self.runtime.registry.clone(),
                session: session.clone(),
                epoch,
                _workspace_lease: Some(workspace_lease),
                tx: tx.clone(),
                stop,
                task,
                worker_completion,
                resumable,
                background_safe,
                pins,
                last_used: Arc::new(std::sync::atomic::AtomicU64::new(activity.1)),
                last_user_input_at: activity.0,
                context_revision: None,
                resident_since: worker_retention::now(),
            },
        );
        Ok((tx, config))
    }
    pub(super) async fn stop_adapters(&self) {
        self.closed.store(true, Ordering::Release);
        let _worker_admission = self.coordinator.admission.lock().await;
        let adapters = std::mem::take(&mut *self.coordinator.adapters.lock().await);
        // Graceful ACP cancellation is bounded and concurrent, never N timeouts.
        let mut stopping = tokio::task::JoinSet::new();
        for (_, adapter) in adapters {
            stopping.spawn(async move {
                let _ = adapter.cancel_and_stop().await;
            });
        }
        while stopping.join_next().await.is_some() {}
    }
}
