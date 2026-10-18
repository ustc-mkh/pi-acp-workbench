use crate::{
    acp::adapter::{self, AdapterCommand, AdapterContext},
    actor::Runtime,
    config::Config,
    domain::{
        command::{AgentEvent, DomainCommand},
        error::DomainError,
        event::DomainEvent,
        ids::SessionId,
    },
    persistence::{
        database::Database,
        format::StorageLease,
        journal::{Admission, JournalStore},
        HistoryStore,
    },
    task_scope::{OwnedTask, TaskScope},
    worker::WorkerSupervisor,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_util::sync::CancellationToken;

#[path = "app_fork_control.rs"]
mod fork_control;
#[path = "app_fork.rs"]
mod forks;
#[path = "app_ingress.rs"]
mod ingress;
use ingress::{IngressHandle, Request};

struct AdapterHandle {
    tx: mpsc::Sender<AdapterCommand>,
    stop: CancellationToken,
    task: OwnedTask,
    worker_completion: OwnedTask,
}
impl AdapterHandle {
    async fn cancel_and_stop(self) -> Result<(), DomainError> {
        if self.stop.is_cancelled() || self.task.is_finished() || self.tx.is_closed() {
            self.stop().await;
            return Ok(());
        }
        let (reply, wait) = tokio::sync::oneshot::channel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            self.tx
                .send(AdapterCommand::Cancel { reply })
                .await
                .map_err(|_| DomainError::Worker("adapter closed during cancellation".into()))?;
            wait.await
                .map_err(|_| DomainError::Worker("adapter cancellation interrupted".into()))?
        })
        .await
        .unwrap_or_else(|_| {
            Err(DomainError::Worker(
                "adapter cancellation deadline exceeded".into(),
            ))
        });
        self.stop().await;
        result
    }
    async fn stop(self) {
        self.stop.cancel();
        self.task.join().await;
        self.worker_completion.join().await;
    }
}
#[derive(Clone)]
pub struct WorkbenchApp {
    pub runtime: Runtime,
    core: Arc<CommandCore>,
    ingress: IngressHandle,
}

// Runtime handles and protocol/lifecycle metadata only. SessionState remains
// exclusively inside SessionActor; ingress never owns a session projection.
struct CommandCore {
    runtime: Runtime,
    events: broadcast::Sender<DomainEvent>,
    supervisor: Arc<WorkerSupervisor>,
    adapters: Arc<Mutex<HashMap<SessionId, AdapterHandle>>>,
    adapter_tasks: TaskScope,
    adapters_stop: CancellationToken,
    closed: Arc<AtomicBool>,
    storage_lease: Arc<Mutex<Option<StorageLease>>>,
    database: Database,
    journal: JournalStore,
    history: HistoryStore,
    pending_interactions: usize,
    fork_controls: Arc<fork_control::ForkControls>,
}
impl WorkbenchApp {
    pub fn new(config: Config) -> Result<Self, DomainError> {
        Self::start(config, Runtime::start)
    }
    fn start(
        config: Config,
        make_runtime: impl FnOnce(HistoryStore, usize) -> Runtime,
    ) -> Result<Self, DomainError> {
        config.validate()?;
        let lease = StorageLease::lock(&config.storage.root)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        let database = Database::open_sync(&config.storage.root, &lease)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        let (events, _) = broadcast::channel(256);
        let mut supervisor =
            WorkerSupervisor::configured(config.workers, config.sessions.max_workers);
        if let Some(telegram) = &config.telegram {
            supervisor = supervisor.without_env(telegram.bot_token_env.clone());
        }
        let history = HistoryStore::with_delivery(
            config.storage.root.join("history"),
            crate::persistence::outbox::OutboxStore::new(config.storage.root.join("outbox"), 1024),
            crate::persistence::payload::PayloadStore::new(config.storage.root.join("payloads")),
        );
        let core = Arc::new(CommandCore {
            runtime: make_runtime(history.clone(), config.sessions.mailbox),
            events,
            supervisor: Arc::new(supervisor),
            adapters: Arc::new(Mutex::new(HashMap::new())),
            adapter_tasks: TaskScope::default(),
            adapters_stop: CancellationToken::new(),
            closed: Arc::new(AtomicBool::new(false)),
            storage_lease: Arc::new(Mutex::new(Some(lease))),
            journal: JournalStore::new(database.clone()),
            database,
            history,
            pending_interactions: config.limits.pending_interactions,
            fork_controls: Arc::new(fork_control::ForkControls::default()),
        });
        let ingress = IngressHandle::start(core.clone());
        Ok(Self {
            runtime: core.runtime.clone(),
            core,
            ingress,
        })
    }
    pub async fn pending_deliveries(
        &self,
        now: u64,
        limit: usize,
    ) -> Result<Vec<crate::persistence::outbox::DeliveryRecord>, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress
            .submit(Request::Deliveries { now, limit, reply })?;
        wait.await.map_err(|_| ingress::interrupted())?
    }
    /// Read immutable bytes through the bounded query ingress. This never
    /// journals pixels, invokes a provider, or interprets a path/URI.
    pub async fn image(
        &self,
        image: &crate::domain::image::ImageRef,
    ) -> Result<crate::domain::image::ImageAsset, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress.submit(Request::Image {
            image: image.clone(),
            reply,
        })?;
        wait.await.map_err(|_| ingress::interrupted())?
    }
    pub fn delivery_store(&self) -> crate::persistence::outbox::OutboxStore {
        self.core.history.outbox.clone()
    }
    pub fn delivery_payloads(&self) -> crate::persistence::payload::PayloadStore {
        self.core.history.payloads.clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<DomainEvent> {
        self.core.events.subscribe()
    }
    pub async fn command(&self, command: DomainCommand) -> Result<Vec<DomainEvent>, DomainError> {
        self.enqueue_command(None, command)?.wait().await
    }
    #[cfg(test)]
    pub(crate) async fn journal_snapshot(
        &self,
    ) -> Result<Vec<crate::persistence::journal::ArchivedOperation>, DomainError> {
        self.core.journal.snapshot().await
    }
    pub async fn operation_result(
        &self,
        operation: &crate::domain::OperationId,
        command: &DomainCommand,
    ) -> Result<Option<Result<Vec<DomainEvent>, DomainError>>, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress.submit(Request::Lookup {
            operation: operation.clone(),
            command: command.clone(),
            reply,
        })?;
        wait.await.map_err(|_| ingress::interrupted())?
    }
    pub async fn command_durable(
        &self,
        operation: crate::domain::OperationId,
        command: DomainCommand,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        self.enqueue_command(Some(operation), command)?.wait().await
    }
    /// Synchronous admission preserves wire order before reply observers are
    /// scheduled concurrently. Dropping a ticket never drops its host execution.
    pub(crate) fn enqueue_command(
        &self,
        operation: Option<crate::domain::OperationId>,
        command: DomainCommand,
    ) -> Result<CommandTicket, DomainError> {
        let operation = operation.or_else(|| {
            (!matches!(
                command,
                DomainCommand::ListSessions | DomainCommand::Inspect(_)
            ))
            .then(crate::domain::OperationId::generate)
        });
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress.submit(Request::Command {
            operation,
            command,
            reply,
        })?;
        Ok(CommandTicket { wait })
    }
    /// Completes on any ingress-supervisor exit, including unexpected failures.
    pub async fn wait_closed(&self) -> Result<(), DomainError> {
        self.ingress.wait_closed().await
    }
    /// Start shutdown without releasing storage. Join transport adapters before
    /// shutdown_checked, which joins the runtime and finally releases its lease.
    pub fn close_admission(&self) {
        self.ingress.close_admission();
    }
    pub(crate) fn is_closing(&self) -> bool {
        self.core.closed.load(Ordering::Acquire)
    }
    pub async fn shutdown(&self) {
        self.shutdown_checked()
            .await
            .expect("workbench shutdown persistence failed");
    }
    pub async fn shutdown_checked(&self) -> Result<(), DomainError> {
        let result = self.ingress.shutdown(&self.core).await;
        let database = self
            .core
            .database
            .shutdown()
            .await
            .map_err(|error| DomainError::Persistence(error.to_string()));
        // Main stops the transport adapters before this call. Keep the lease
        // across an unexpected ingress exit until the host finishes that cleanup.
        self.core.storage_lease.lock().await.take();
        result.and(database)
    }
}
pub(crate) struct CommandTicket {
    wait: tokio::sync::oneshot::Receiver<Result<Vec<DomainEvent>, DomainError>>,
}
impl CommandTicket {
    pub(crate) async fn wait(self) -> Result<Vec<DomainEvent>, DomainError> {
        self.wait.await.map_err(|_| ingress::interrupted())?
    }
}
impl CommandCore {
    async fn execute_journaled(
        &self,
        operation: crate::domain::OperationId,
        command: DomainCommand,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DomainError::Worker("runtime shutting down".into()));
        }
        let ticket = match self.journal.begin(operation.clone(), &command).await? {
            Admission::Execute(ticket) => ticket,
            Admission::Replay(result) => return result,
        };
        let result = if let DomainCommand::Fork { session, request } = &command {
            match self.fork_controls.get(session, &operation) {
                Ok(control) => self.fork_session(session, request, &control.stop).await,
                Err(error) => Err(error),
            }
        } else {
            self.execute(command).await
        };
        self.journal.finish(ticket, &result).await?;
        result
    }
    async fn execute(&self, command: DomainCommand) -> Result<Vec<DomainEvent>, DomainError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DomainError::Worker("runtime shutting down".into()));
        }
        match &command {
            DomainCommand::CreateSession { harness, .. }
                if !self.supervisor.is_configured(harness) =>
            {
                return Err(DomainError::ProviderNotConfigured)
            }
            DomainCommand::Prompt { session, .. } => {
                let events = self
                    .runtime
                    .registry
                    .command(DomainCommand::Inspect(session.clone()))
                    .await?;
                let Some(DomainEvent::SessionLoaded(snapshot)) = events.first() else {
                    return Err(DomainError::NotFound(session.clone()));
                };
                if !self.supervisor.is_configured(&snapshot.harness) {
                    return Err(DomainError::ProviderNotConfigured);
                }
            }
            _ => {}
        }
        if matches!(command, DomainCommand::Fork { .. }) {
            return Err(DomainError::Protocol(
                "native fork requires durable admission".into(),
            ));
        }
        if let DomainCommand::CancelFork { session, operation } = &command {
            return self.cancel_fork(session, operation).await;
        }
        if let DomainCommand::Cancel { session } = &command {
            self.commit(DomainCommand::RequestCancel {
                session: session.clone(),
            })
            .await?;
            self.stop_session_adapter(session).await?;
            // The final terminal event and delivery intent are committed only
            // after the provider process group has stopped and been joined.
            return self
                .commit(DomainCommand::Cancel {
                    session: session.clone(),
                })
                .await;
        }
        if let DomainCommand::RemoveSession(session) = &command {
            // A cold session has no current process owner. A live active owner
            // is fenced durably before stopping it or removing its history.
            let active = match self
                .commit(DomainCommand::LoadSession(session.clone()))
                .await
            {
                Ok(events) => {
                    matches!(events.first(), Some(DomainEvent::SessionLoaded(snapshot)) if snapshot.active_turn.is_some())
                }
                Err(DomainError::NotFound(_)) => false,
                Err(error) => return Err(error),
            };
            if active {
                self.commit(DomainCommand::RequestCancel {
                    session: session.clone(),
                })
                .await?;
            }
            self.stop_session_adapter(session).await?;
            if active {
                self.commit(DomainCommand::Cancel {
                    session: session.clone(),
                })
                .await?;
            }
        }
        if let DomainCommand::SetModel { session, .. } | DomainCommand::SetMode { session, .. } =
            &command
        {
            let events = self
                .runtime
                .registry
                .command(DomainCommand::Inspect(session.clone()))
                .await?;
            let DomainEvent::SessionLoaded(snapshot) = &events[0] else {
                return Err(DomainError::NotFound(session.clone()));
            };
            if snapshot.active_turn.is_some() || snapshot.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            let mut config = snapshot.config.clone();
            match &command {
                DomainCommand::SetModel { model, .. } => config.model = Some(model.clone()),
                DomainCommand::SetMode { mode, .. } => config.mode = Some(mode.clone()),
                _ => unreachable!(),
            }
            let sender = self
                .adapters
                .lock()
                .await
                .get(session)
                .map(|adapter| adapter.tx.clone());
            if let Some(sender) = sender {
                let intent = crate::domain::session::ConfigurationIntent {
                    requested: config.clone(),
                    restore: crate::domain::session::SessionConfig {
                        model: snapshot
                            .config
                            .model
                            .clone()
                            .or_else(|| snapshot.catalogue.current_model.clone()),
                        mode: snapshot
                            .config
                            .mode
                            .clone()
                            .or_else(|| snapshot.catalogue.current_mode.clone()),
                    },
                };
                // Durable intent precedes the remote side effect. A failed or
                // interrupted final commit leaves a baseline for native-load
                // reconciliation; never continue using a possibly changed peer.
                self.commit(DomainCommand::PrepareConfiguration {
                    session: session.clone(),
                    intent,
                })
                .await?;
                let applied = async {
                    let (reply, wait) = tokio::sync::oneshot::channel();
                    sender
                        .try_send(AdapterCommand::Configure { config, reply })
                        .map_err(|_| DomainError::Backpressure)?;
                    wait.await.map_err(|_| {
                        DomainError::Worker("adapter stopped during configuration".into())
                    })??;
                    self.commit(DomainCommand::CommitConfiguration {
                        session: session.clone(),
                    })
                    .await
                }
                .await;
                if applied.is_err() {
                    let adapter = self.adapters.lock().await.remove(session);
                    if let Some(adapter) = adapter {
                        adapter.stop().await;
                    }
                }
                return applied;
            }
        }
        let read_only = matches!(
            command,
            DomainCommand::ListSessions | DomainCommand::Inspect(_)
        );
        let events = self.runtime.registry.command(command).await?;
        if !read_only {
            for event in &events {
                let _ = self.events.send(event.clone());
            }
        }
        for event in &events {
            match event {
                DomainEvent::UserPromptAdded {
                    session,
                    turn,
                    prompt,
                    ..
                } => {
                    if let Err(error) = self
                        .dispatch_prompt(session.clone(), turn.clone(), prompt.clone())
                        .await
                    {
                        self.fail_adapter(session, &error).await?;
                        return Err(error);
                    }
                }
                DomainEvent::InteractionResolved {
                    session,
                    resolution,
                } => {
                    let crate::domain::interaction::InteractionResolution::Answered(answer) =
                        resolution
                    else {
                        continue;
                    };
                    let sender = self
                        .adapters
                        .lock()
                        .await
                        .get(session)
                        .map(|adapter| adapter.tx.clone());
                    let result = match sender {
                        Some(sender) => sender
                            .try_send(AdapterCommand::Answer(answer.clone()))
                            .map_err(|_| DomainError::Backpressure),
                        None => Err(DomainError::Worker(
                            "answer has no live provider adapter".into(),
                        )),
                    };
                    if let Err(error) = result {
                        // The domain answer is already committed. Never leave it
                        // looking Running after silently losing the remote reply.
                        self.fail_adapter(session, &error).await?;
                        return Err(error);
                    }
                }
                _ => {}
            }
        }
        Ok(events)
    }
    async fn stop_session_adapter(&self, session: &SessionId) -> Result<(), DomainError> {
        let adapter = self.adapters.lock().await.remove(session);
        if let Some(adapter) = adapter {
            // Native cancel errors do not undo a successful physical stop.
            // cancel_and_stop always joins the process before returning.
            let _ = adapter.cancel_and_stop().await;
        } else if self.closed.load(Ordering::Acquire) {
            // Root shutdown may temporarily own this adapter outside the map.
            self.supervisor.shutdown().await?;
        }
        Ok(())
    }
    async fn commit(&self, command: DomainCommand) -> Result<Vec<DomainEvent>, DomainError> {
        let events = self.runtime.registry.command(command).await?;
        for event in &events {
            let _ = self.events.send(event.clone());
        }
        Ok(events)
    }
    async fn fail_adapter(
        &self,
        session: &SessionId,
        error: &DomainError,
    ) -> Result<(), DomainError> {
        let adapter = self.adapters.lock().await.remove(session);
        if let Some(adapter) = &adapter {
            adapter.stop.cancel();
        }
        // Attempt durable fencing first, but reclaim the faulty process even
        // when storage is unavailable. The terminal projection follows the join.
        let _ = self
            .runtime
            .registry
            .command(DomainCommand::RequestCancel {
                session: session.clone(),
            })
            .await;
        if let Some(adapter) = adapter {
            adapter.stop().await;
        } else if self.closed.load(Ordering::Acquire) {
            self.supervisor.shutdown().await?;
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
        let failed = self.runtime.registry.command(terminal).await;
        for event in failed? {
            let _ = self.events.send(event);
        }
        Ok(())
    }
    async fn dispatch_prompt(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        text: String,
    ) -> Result<(), DomainError> {
        let (sender, config) = self.adapter_sender(session).await?;
        sender
            .try_send(AdapterCommand::Prompt { turn, text, config })
            .map_err(|_| DomainError::Backpressure)
    }
    async fn adapter_sender(
        &self,
        session: SessionId,
    ) -> Result<
        (
            mpsc::Sender<AdapterCommand>,
            crate::domain::session::SessionConfig,
        ),
        DomainError,
    > {
        let obsolete = {
            let mut adapters = self.adapters.lock().await;
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
            .command(DomainCommand::Inspect(session.clone()))
            .await?;
        let (harness, cwd, provider_session, config, recovery) = match &snapshot[0] {
            DomainEvent::SessionLoaded(snapshot) => (
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
        let sender = self
            .adapters
            .lock()
            .await
            .get(&session)
            .map(|adapter| adapter.tx.clone());
        if let Some(sender) = sender {
            return Ok((sender, config));
        }
        let (events, updates) = mpsc::channel(32);
        let worker = self
            .supervisor
            .spawn_for(session.clone(), &harness, events)
            .await?;
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
        let stop = self.adapters_stop.child_token();
        let mut adapters = self.adapters.lock().await;
        if self.closed.load(Ordering::Acquire) {
            drop(adapters);
            worker.stop().await;
            return Err(ingress::stopping());
        }
        let worker_completion = worker.completion();
        let task = self.adapter_tasks.spawn(adapter::run(
            worker,
            AdapterContext {
                session: session.clone(),
                epoch,
                cwd,
                provider_session,
                registry: self.runtime.registry.clone(),
                output: self.events.clone(),
                lifecycle: stop.clone(),
                pending_interactions: self.pending_interactions,
                recovery,
            },
            commands,
            updates,
            stop.clone(),
        ))?;
        adapters.insert(
            session,
            AdapterHandle {
                tx: tx.clone(),
                stop,
                task,
                worker_completion,
            },
        );
        Ok((tx, config))
    }
    async fn stop_adapters(&self) {
        self.closed.store(true, Ordering::Release);
        let adapters = std::mem::take(&mut *self.adapters.lock().await);
        // Graceful ACP cancellation is bounded and concurrent, never N timeouts.
        let mut stopping = tokio::task::JoinSet::new();
        for (_, adapter) in adapters {
            stopping.spawn(async move {
                let _ = adapter.cancel_and_stop().await;
            });
        }
        while stopping.join_next().await.is_some() {}
    }
    async fn finish_shutdown(&self) -> Result<(), DomainError> {
        self.runtime.shutdown_checked().await
    }
    async fn emergency_shutdown(&self, executions: &ingress::IngressTasks) {
        self.closed.store(true, Ordering::Release);
        self.adapters_stop.cancel();
        self.stop_adapters().await;
        let _ = self.supervisor.shutdown().await;
        self.adapter_tasks.close_and_join().await;
        self.runtime.workers_stopped();
        let mut tasks = executions.lock().await;
        let _ = ingress::drain_commands(self, &mut tasks).await;
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
