use crate::workspace_gate::{WorkspaceGate, WorkspaceLease};
use crate::{
    acp::adapter::{self, AdapterCommand, AdapterContext},
    actor::Runtime,
    config::Config,
    domain::{
        command::{AgentEvent, DomainCommand},
        error::DomainError,
        ids::SessionId,
        query::{CommandReceipt, CommitBatch},
    },
    persistence::{
        database::Database,
        format::StorageLease,
        journal::{Admission, JournalStore},
        SessionStore,
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
    _workspace_lease: Option<WorkspaceLease>,
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

// Runtime handles and protocol/lifecycle metadata only. SessionView remains
// exclusively inside SessionActor; ingress never owns a session projection.
struct CommandCore {
    runtime: Runtime,
    events: broadcast::Sender<CommitBatch>,
    supervisor: Arc<WorkerSupervisor>,
    adapters: Arc<Mutex<HashMap<SessionId, AdapterHandle>>>,
    adapter_tasks: TaskScope,
    adapters_stop: CancellationToken,
    closed: Arc<AtomicBool>,
    storage_lease: Arc<Mutex<Option<StorageLease>>>,
    database: Database,
    journal: JournalStore,
    history: SessionStore,
    pending_interactions: usize,
    fork_controls: Arc<fork_control::ForkControls>,
    reviews: Arc<crate::workspace_reviews::Reviews>,
    workspace_gate: Arc<WorkspaceGate>,
}
impl WorkbenchApp {
    pub fn new(config: Config) -> Result<Self, DomainError> {
        Self::start(config, Runtime::start)
    }
    fn start(
        config: Config,
        make_runtime: impl FnOnce(SessionStore, usize) -> Runtime,
    ) -> Result<Self, DomainError> {
        config.validate()?;
        let lease = StorageLease::lock(&config.storage.root)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        let database = Database::open_sync(&config.storage.root, &lease)
            .map_err(|error| DomainError::Persistence(error.to_string()))?;
        let mut supervisor =
            WorkerSupervisor::configured(config.workers, config.sessions.max_workers);
        if let Some(telegram) = &config.telegram {
            supervisor = supervisor.without_env(telegram.bot_token_env.clone());
        }
        let history = SessionStore::new(database.clone());
        let runtime = make_runtime(history.clone(), config.sessions.mailbox);
        let core = Arc::new(CommandCore {
            events: runtime.events.clone(),
            runtime,
            supervisor: Arc::new(supervisor),
            adapters: Arc::new(Mutex::new(HashMap::new())),
            adapter_tasks: TaskScope::default(),
            adapters_stop: CancellationToken::new(),
            closed: Arc::new(AtomicBool::new(false)),
            storage_lease: Arc::new(Mutex::new(Some(lease))),
            journal: JournalStore::new(database.clone()),
            reviews: crate::workspace_reviews::Reviews::new(database.clone()),
            database,
            history,
            pending_interactions: config.limits.pending_interactions,
            fork_controls: Arc::new(fork_control::ForkControls::default()),
            workspace_gate: Arc::new(WorkspaceGate::default()),
        });
        let ingress = IngressHandle::start(core.clone());
        Ok(Self {
            runtime: core.runtime.clone(),
            core,
            ingress,
        })
    }
    pub async fn query(
        &self,
        command: crate::domain::query::QueryCommand,
    ) -> Result<crate::domain::query::QueryResult, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress.submit(Request::Query { command, reply })?;
        wait.await.map_err(|_| ingress::interrupted())?
    }
    pub(crate) fn harness_configured(&self, harness: &crate::domain::Harness) -> bool {
        self.core.supervisor.is_configured(harness)
    }
    pub async fn list(
        &self,
        cursor: Option<crate::domain::query::ListCursor>,
        limit: Option<usize>,
    ) -> Result<crate::domain::query::ListPage, DomainError> {
        match self
            .query(crate::domain::query::QueryCommand::List { cursor, limit })
            .await?
        {
            crate::domain::query::QueryResult::List(page) => Ok(page),
            _ => Err(DomainError::Protocol("invalid list query result".into())),
        }
    }
    pub(crate) async fn list_activity(
        &self,
        cursor: Option<crate::domain::query::ListCursor>,
        limit: Option<usize>,
    ) -> Result<crate::domain::query::ListPage, DomainError> {
        self.core
            .database
            .activity_list(cursor, limit)
            .await
            .map_err(|error| DomainError::Persistence(error.to_string()))
    }
    pub(crate) async fn dispatch_snapshot(
        &self,
        bot: i64,
        limit: usize,
    ) -> Result<crate::persistence::delivery::DispatchSnapshot, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress
            .submit(Request::Dispatch { bot, limit, reply })?;
        wait.await.map_err(|_| ingress::interrupted())?
    }
    #[cfg(test)]
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
    pub async fn turn_diff_page(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        offset: usize,
    ) -> Result<crate::workspace_review::TurnDiff, DomainError> {
        self.core
            .database
            .turn_diff_page(session, turn, offset)
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))
    }
    pub async fn turn_diff_content(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        file: usize,
        after: bool,
        offset: crate::domain::query::SafeInteger,
    ) -> Result<crate::workspace_review::DiffContent, DomainError> {
        self.core
            .database
            .turn_diff_content(session, turn, file, after, offset)
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))
    }
    pub(crate) fn database(&self) -> Database {
        self.core.database.clone()
    }
    pub fn delivery_store(&self) -> crate::persistence::outbox::OutboxStore {
        self.core.history.outbox.clone()
    }
    pub fn delivery_payloads(&self) -> crate::persistence::payload::PayloadStore {
        self.core.history.payloads.clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<CommitBatch> {
        self.core.events.subscribe()
    }
    pub(crate) async fn discover_session(
        &self,
        session: SessionId,
    ) -> Result<CommandReceipt, DomainError> {
        let (reply, wait) = tokio::sync::oneshot::channel();
        self.ingress.submit(Request::Discover { session, reply })?;
        wait.await.map_err(|_| ingress::stopping())?
    }
    pub async fn command(&self, command: DomainCommand) -> Result<CommandReceipt, DomainError> {
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
    ) -> Result<Option<Result<CommandReceipt, DomainError>>, DomainError> {
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
    ) -> Result<CommandReceipt, DomainError> {
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
    wait: tokio::sync::oneshot::Receiver<Result<CommandReceipt, DomainError>>,
}
impl CommandTicket {
    pub(crate) async fn wait(self) -> Result<CommandReceipt, DomainError> {
        self.wait.await.map_err(|_| ingress::interrupted())?
    }
}
impl CommandCore {
    async fn execute_journaled(
        &self,
        operation: crate::domain::OperationId,
        command: DomainCommand,
    ) -> Result<CommandReceipt, DomainError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DomainError::Worker("runtime shutting down".into()));
        }
        if let DomainCommand::CreateSession { harness, cwd } = &command {
            // Query replay before preflight: a later configuration change must
            // not invalidate an already committed creation receipt.
            if let Some(result) = self.journal.lookup(&operation, &command).await? {
                return result;
            }
            if !self.supervisor.is_configured(harness) {
                return Err(DomainError::ProviderNotConfigured);
            }
            let receipt = self
                .journal
                .create_local(operation, harness.clone(), cwd.clone())
                .await?;
            if let CommandReceipt::Created { summary } = &receipt {
                // Warming an owner is advisory, not the creation commit point.
                // A failed/closed registry cannot turn committed acceptance into
                // a failed receipt or cause creation to run again on reload.
                let _ = self
                    .runtime
                    .registry
                    .command(DomainCommand::LoadSession(summary.id.clone()))
                    .await;
            }
            return Ok(receipt);
        }
        let ticket = match self.journal.begin(operation.clone(), &command).await? {
            Admission::Execute(ticket) => ticket,
            Admission::Replay(result) => return result,
        };
        if let DomainCommand::Manage { action, .. } = &command {
            let external = action.external();
            let result = self
                .execute_with_operation(command, Some(ticket.clone()))
                .await;
            if external || result.is_err() {
                self.journal.finish(ticket, &result).await?;
            }
            return result;
        }
        if matches!(command, DomainCommand::UndoTurn { .. }) {
            let result = self
                .execute_with_operation(command, Some(ticket.clone()))
                .await;
            self.journal.finish(ticket, &result).await?;
            return result;
        }
        if matches!(
            command,
            DomainCommand::Prompt { .. }
                | DomainCommand::SetModel { .. }
                | DomainCommand::SetMode { .. }
                | DomainCommand::Cancel { .. }
                | DomainCommand::AnswerInteraction { .. }
                | DomainCommand::RemoveSession(_)
        ) {
            let result = self
                .execute_with_operation(command, Some(ticket.clone()))
                .await;
            // Successful terminal receipts are sealed with their local state.
            // Only rejected, uncommitted commands need a failed receipt.
            if result.is_err() {
                self.journal.finish(ticket, &result).await?;
            }
            return result;
        }
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
    async fn execute(&self, command: DomainCommand) -> Result<CommandReceipt, DomainError> {
        self.execute_with_operation(command, None).await
    }
    async fn execute_with_operation(
        &self,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<CommandReceipt, DomainError> {
        let accepts_input = operation.is_some();
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
                let Some(snapshot) = events.view() else {
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
            self.reviews.finish(session, None).await?;
            // The final terminal event and delivery intent are committed only
            // after the provider process group has stopped and been joined.
            return self
                .runtime
                .registry
                .command_with_operation(
                    DomainCommand::Cancel {
                        session: session.clone(),
                    },
                    operation,
                )
                .await?
                .receipt();
        }
        if let DomainCommand::Manage { session, action } = &command {
            if !action.validate() {
                return Err(DomainError::Protocol("Invalid management settings".into()));
            }
            if !action.external() {
                return self
                    .database
                    .manage(session.clone(), action.clone(), operation)
                    .await
                    .map_err(|e| DomainError::Persistence(e.to_string()));
            }
            let view = self
                .database
                .view(session.clone())
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
            if view.active_turn.is_some() || view.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            let (sender, _) = self.adapter_sender(session.clone()).await?;
            let (reply, wait) = tokio::sync::oneshot::channel();
            sender
                .try_send(AdapterCommand::Models {
                    action: action.clone(),
                    reply,
                })
                .map_err(|_| DomainError::Backpressure)?;
            let response = tokio::time::timeout(std::time::Duration::from_secs(20), wait)
                .await
                .map_err(|_| DomainError::OperationInterrupted)?
                .map_err(|_| DomainError::OperationInterrupted)??;
            self.database
                .model_defaults(session.clone(), response)
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
            return Ok(CommandReceipt::Accepted {
                session: session.clone(),
                revision: view.revision,
            });
        }
        if let DomainCommand::UndoTurn { session, turn } = &command {
            let view = self
                .database
                .view(session.clone())
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
            let diff = self
                .database
                .turn_diff(session.clone(), turn.clone())
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?
                .ok_or_else(|| DomainError::NotFound(session.clone()))?;
            let root = crate::workspace_review::canonical(std::path::Path::new(view.cwd.as_str()))
                .map_err(DomainError::Persistence)?;
            if view.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            // Idle providers may still produce background writes. Join this
            // session's provider before acquiring the exclusive workspace permit;
            // other overlapping providers keep their permits and cause Busy.
            self.stop_session_adapter(session).await?;
            let _undo_lease = self.workspace_gate.enter(root.clone(), true)?;
            let report = tokio::task::spawn_blocking(move || {
                crate::workspace_undo::undo(&root, &diff, false)
            })
            .await
            .map_err(|_| DomainError::Persistence("undo task interrupted".into()))?
            .map_err(DomainError::Persistence)?;
            return Ok(CommandReceipt::UndoCompleted {
                session: session.clone(),
                report,
            });
        }
        if let DomainCommand::RemoveSession(session) = &command {
            // A cold session has no current process owner. A live active owner
            // is fenced durably before stopping it or removing its history.
            let active = match self
                .commit(DomainCommand::LoadSession(session.clone()))
                .await
            {
                Ok(events) => events.view().is_some_and(|view| view.active_turn.is_some()),
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
            let Some(snapshot) = events.view() else {
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
                    self.runtime
                        .registry
                        .command_with_operation(
                            DomainCommand::CommitConfiguration {
                                session: session.clone(),
                            },
                            operation,
                        )
                        .await?
                        .receipt()
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
        let before_snapshot = if let DomainCommand::Prompt { session, .. } = &command {
            let events = self
                .runtime
                .registry
                .command(DomainCommand::Inspect(session.clone()))
                .await?;
            let view = events
                .view()
                .ok_or_else(|| DomainError::NotFound(session.clone()))?;
            let cwd = view.cwd.clone();
            let root = crate::workspace_review::canonical(std::path::Path::new(cwd.as_str()))
                .map_err(DomainError::Persistence)?;
            let lease = self.workspace_gate.enter(root.clone(), false)?;
            let snapshot = tokio::task::spawn_blocking(move || {
                crate::workspace_review::Snapshot::capture(&root)
                    .unwrap_or_else(|e| crate::workspace_review::Snapshot::unavailable(root, e))
            })
            .await
            .map_err(|_| DomainError::Persistence("workspace snapshot task failed".into()))?;
            Some((session.clone(), snapshot, lease))
        } else {
            None
        };
        let terminal = match &command {
            DomainCommand::Agent {
                session,
                event: AgentEvent::Finished { turn },
            } => Some((session.clone(), Some(turn.clone()))),
            DomainCommand::Agent {
                session,
                event: AgentEvent::Crashed { .. },
            } => Some((session.clone(), None)),
            _ => None,
        };
        // Side effects use the accepted command and its committed view, not a
        // second event/reducer projection. The owner already published its batch.
        let prompt = match &command {
            DomainCommand::Prompt { session, prompt } => {
                Some((session.clone(), prompt.as_str().to_owned()))
            }
            _ => None,
        };
        let answer_session = match &command {
            DomainCommand::AnswerInteraction { session, .. } => Some(session.clone()),
            _ => None,
        };
        let result = self
            .runtime
            .registry
            .command_with_operation(command, operation)
            .await?;
        if let (Some((session, before, lease)), Some(turn)) = (
            before_snapshot,
            result.view().and_then(|view| view.active_turn.clone()),
        ) {
            self.reviews.start(session, turn, before, lease).await;
        }
        if let Some((session, text)) = prompt {
            if let Some(turn) = result.view().and_then(|view| view.active_turn.clone()) {
                if let Err(error) = self.dispatch_prompt(session.clone(), turn, text).await {
                    let failure = self.fail_adapter(&session, &error).await;
                    if accepts_input {
                        // Dispatch is after durable acceptance. Its failure is
                        // task state, never a rollback or failed input receipt.
                        return result.receipt();
                    }
                    failure?;
                    return Err(error);
                }
            }
        }
        if let Some((session, turn)) = terminal {
            self.reviews.finish(&session, turn.as_ref()).await?;
        }
        if let Some(session) = answer_session {
            // Forward only the canonical validated response, and only after the
            // owner has committed it. Raw text answers are not ACP wire values.
            if let crate::actor::OwnerReply::Answered { answer, .. } = &result {
                let sender = self
                    .adapters
                    .lock()
                    .await
                    .get(&session)
                    .map(|adapter| adapter.tx.clone());
                let sent = match sender {
                    Some(sender) => sender
                        .try_send(AdapterCommand::Answer(answer.clone()))
                        .map_err(|_| DomainError::Backpressure),
                    None => Err(DomainError::Worker(
                        "answer has no live provider adapter".into(),
                    )),
                };
                if let Err(error) = sent {
                    let failure = self.fail_adapter(&session, &error).await;
                    if accepts_input {
                        // The answer was durably accepted. Provider dispatch
                        // failure is task state, not a second failed receipt.
                        return result.receipt();
                    }
                    failure?;
                    return Err(error);
                }
            }
        }
        result.receipt()
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
    async fn commit(&self, command: DomainCommand) -> Result<CommandReceipt, DomainError> {
        self.runtime.registry.command(command).await?.receipt()
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
        self.reviews.finish(session, None).await?;
        self.runtime.registry.command(terminal).await?;
        Ok(())
    }
    async fn discover(&self, session: SessionId) -> Result<CommandReceipt, DomainError> {
        self.runtime
            .registry
            .command(DomainCommand::LoadSession(session.clone()))
            .await?;
        let view = self
            .runtime
            .registry
            .command(DomainCommand::Inspect(session.clone()))
            .await?;
        if view
            .view()
            .is_some_and(|view| view.active_turn.is_some() || view.configuration_intent.is_some())
        {
            return Err(DomainError::Busy);
        }
        let (sender, _) = self.adapter_sender(session.clone()).await?;
        let (reply, wait) = tokio::sync::oneshot::channel();
        sender
            .try_send(AdapterCommand::Ready { reply })
            .map_err(|_| DomainError::Backpressure)?;
        let ready = tokio::time::timeout(std::time::Duration::from_secs(10), wait).await;
        if !matches!(ready, Ok(Ok(Ok(())))) {
            self.stop_session_adapter(&session).await?;
            return Err(DomainError::Worker(
                "provider discovery did not become ready".into(),
            ));
        }
        self.runtime
            .registry
            .command(DomainCommand::Inspect(session))
            .await?
            .receipt()
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
        let sender = self
            .adapters
            .lock()
            .await
            .get(&session)
            .map(|adapter| adapter.tx.clone());
        if let Some(sender) = sender {
            return Ok((sender, config));
        }
        let root = crate::workspace_review::canonical(std::path::Path::new(cwd.as_str()))
            .map_err(DomainError::Persistence)?;
        let workspace_lease = self.workspace_gate.enter(root, false)?;
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
                lifecycle: stop.clone(),
                pending_interactions: self.pending_interactions,
                reviews: Some(self.reviews.clone()),
                database: Some(self.database.clone()),
                recovery,
            },
            commands,
            updates,
            stop.clone(),
        ))?;
        adapters.insert(
            session,
            AdapterHandle {
                _workspace_lease: Some(workspace_lease),
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
