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
#[path = "app_model_context.rs"]
mod model_context;
#[path = "app_residency.rs"]
mod residency;
#[path = "app_worker_lifecycle.rs"]
mod worker_lifecycle;
#[path = "app_worker_retention.rs"]
mod worker_retention;
#[path = "app_workspace.rs"]
mod workspace;

#[path = "app_fork.rs"]
mod forks;
#[path = "app_ingress.rs"]
mod ingress;
#[path = "app_prompt.rs"]
mod prompt;
use ingress::{IngressHandle, Request};

struct AdapterHandle {
    registry: crate::actor::RegistryHandle,
    session: SessionId,
    epoch: u64,
    _workspace_lease: Option<WorkspaceLease>,
    tx: mpsc::Sender<AdapterCommand>,
    stop: CancellationToken,
    task: OwnedTask,
    worker_completion: OwnedTask,
    resumable: Arc<std::sync::atomic::AtomicBool>,
    background_safe: Arc<std::sync::atomic::AtomicBool>,
    pins: Arc<std::sync::atomic::AtomicUsize>,
    last_used: Arc<std::sync::atomic::AtomicU64>,
    last_user_input_at: u64,
    resident_since: u64,
    context_revision: Option<u64>,
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
        self.registry.worker_stopped(self.session, self.epoch).await;
    }
}
#[derive(Clone)]
pub struct WorkbenchApp {
    pub runtime: Runtime,
    core: Arc<CommandCore>,
    ingress: IngressHandle,
}

struct SessionCoordinator {
    adapters: Arc<Mutex<HashMap<SessionId, AdapterHandle>>>,
    admission: Mutex<()>,
    model_settings: Mutex<()>,
    model_metadata: Mutex<()>,
    stop: CancellationToken,
    forks: Arc<fork_control::ForkControls>,
    reviews: Arc<crate::workspace_reviews::Reviews>,
    supervisor: Arc<WorkerSupervisor>,
    tasks: TaskScope,
}
impl SessionCoordinator {
    fn new(database: Database, supervisor: Arc<WorkerSupervisor>) -> Self {
        Self {
            adapters: Arc::new(Mutex::new(HashMap::new())),
            admission: Mutex::new(()),
            model_settings: Mutex::new(()),
            model_metadata: Mutex::new(()),
            stop: CancellationToken::new(),
            forks: Arc::new(fork_control::ForkControls::default()),
            reviews: crate::workspace_reviews::Reviews::new(database),
            supervisor,
            tasks: TaskScope::default(),
        }
    }
}
struct CommandCore {
    runtime: Runtime,
    events: broadcast::Sender<CommitBatch>,
    coordinator: SessionCoordinator,
    closed: Arc<AtomicBool>,
    storage_lease: Arc<Mutex<Option<StorageLease>>>,
    database: Database,
    journal: JournalStore,
    history: SessionStore,
    pending_interactions: usize,
    context_owner: String,
    workspace_gate: Arc<WorkspaceGate>,
    history_clear_admission: Arc<tokio::sync::Semaphore>,
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
        use sha2::Digest;
        let context_root = std::fs::canonicalize(&config.storage.root)
            .map_err(|e| DomainError::Persistence(e.to_string()))?;
        let context_owner = format!(
            "{:x}",
            sha2::Sha256::digest(context_root.as_os_str().as_encoded_bytes())
        );
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
            coordinator: SessionCoordinator::new(database.clone(), Arc::new(supervisor)),
            closed: Arc::new(AtomicBool::new(false)),
            storage_lease: Arc::new(Mutex::new(Some(lease))),
            journal: JournalStore::new(database.clone()),
            database,
            history,
            pending_interactions: config.limits.pending_interactions,
            context_owner,
            workspace_gate: Arc::new(WorkspaceGate::default()),
            history_clear_admission: Arc::new(tokio::sync::Semaphore::new(1)),
        });
        let weak = Arc::downgrade(&core);
        let stop = core.coordinator.stop.clone();
        core.coordinator.tasks.spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    _ = interval.tick() => {
                        let Some(core) = weak.upgrade() else { break };
                        let _admission = core.coordinator.admission.lock().await;
                        let _ = core.reclaim_workers(None, true).await;
                    }
                }
            }
        })?;
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
        self.core.coordinator.supervisor.is_configured(harness)
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
        let operation =
            operation.or_else(|| (!command.is_query()).then(crate::domain::OperationId::generate));
        let (reply, wait) = tokio::sync::oneshot::channel();
        if matches!(
            command,
            DomainCommand::PrepareHistoryClear { .. } | DomainCommand::ClearHistoryBatch { .. }
        ) {
            if self.core.closed.load(Ordering::Acquire) {
                return Err(ingress::stopping());
            }
            let permit = self
                .core
                .history_clear_admission
                .clone()
                .try_acquire_owned()
                .map_err(|_| DomainError::Backpressure)?;
            let app = self.clone();
            self.core.coordinator.tasks.spawn(async move {
                let _permit = permit;
                let result = app
                    .clear_history(operation.expect("mutation identity"), command)
                    .await;
                let _ = reply.send(result);
            })?;
        } else {
            self.ingress.submit(Request::Command {
                operation,
                command,
                reply,
            })?;
        }
        Ok(CommandTicket { wait })
    }
    async fn clear_history(
        &self,
        operation: crate::domain::OperationId,
        command: DomainCommand,
    ) -> Result<CommandReceipt, DomainError> {
        use crate::persistence::history_clear::{Output, Request as C};
        let admission = self.core.journal.admit_local(operation, &command).await?;
        let ticket = match admission {
            Admission::Replay(result) => return result,
            Admission::Execute(ticket) => ticket,
        };
        let request = match command {
            DomainCommand::PrepareHistoryClear { filter } => C::Prepare { filter, ticket },
            DomainCommand::ClearHistoryBatch { job } => {
                let targets = match self
                    .core
                    .database
                    .history_clear(C::Next { job: job.clone() })
                    .await
                    .map_err(|e| DomainError::Persistence(e.to_string()))?
                {
                    Output::Targets(ids) => ids,
                    _ => unreachable!(),
                };
                for session in targets {
                    if self.core.closed.load(Ordering::Acquire) {
                        return Err(ingress::stopping());
                    }
                    // Stable child identity closes the delete/progress crash window.
                    use sha2::{Digest, Sha256};
                    let id = crate::domain::OperationId::new(format!(
                        "clear-{:x}",
                        Sha256::digest(format!("{}:{}", job.as_str(), session.as_str()))
                    ))
                    .map_err(|e| DomainError::Protocol(e.to_string()))?;
                    let result = self
                        .enqueue_command(Some(id), DomainCommand::RemoveSession(session.clone()))?
                        .wait()
                        .await;
                    let error = match result {
                        Ok(_) | Err(DomainError::NotFound(_)) => None,
                        Err(e) => Some(e.to_string()),
                    };
                    self.core
                        .database
                        .history_clear(C::Result {
                            job: job.clone(),
                            session,
                            error,
                        })
                        .await
                        .map_err(|e| DomainError::Persistence(e.to_string()))?;
                }
                C::Settle { job, ticket }
            }
            _ => unreachable!(),
        };
        match self
            .core
            .database
            .history_clear(request)
            .await
            .map_err(|e| DomainError::Persistence(e.to_string()))?
        {
            Output::Receipt(receipt) => Ok(receipt),
            _ => unreachable!(),
        }
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
        crate::diagnostics::emit(self.core.database.metrics());
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
            if !self.coordinator.supervisor.is_configured(harness) {
                return Err(DomainError::ProviderNotConfigured);
            }
            let receipt = self
                .journal
                .create_local(operation, harness.clone(), cwd.clone())
                .await?;
            return Ok(receipt);
        }
        // Only paths with no possible remote effect may omit durable prepare.
        // Warm configure, prompt/answer dispatch, cancel/remove physical stop,
        // fork/context/topic/undo retain their existing prepare boundary.
        let local = match &command {
            DomainCommand::Manage { action, .. } => !action.external(),
            DomainCommand::SetModel { session, .. } | DomainCommand::SetMode { session, .. } => {
                !self.coordinator.adapters.lock().await.contains_key(session)
            }
            _ => false,
        };
        let admission = if local {
            self.journal
                .admit_local(operation.clone(), &command)
                .await?
        } else {
            self.journal.begin(operation.clone(), &command).await?
        };
        let ticket = match admission {
            Admission::Execute(ticket) => ticket,
            Admission::Replay(result) => return result,
        };
        let owner_session = match &command {
            DomainCommand::Prompt { session, .. }
            | DomainCommand::Cancel { session }
            | DomainCommand::ReleaseWorker { session }
            | DomainCommand::RequestCancel { session }
            | DomainCommand::Interrupt { session, .. }
            | DomainCommand::AnswerInteraction { session, .. }
            | DomainCommand::Fork { session, .. }
            | DomainCommand::SetModel { session, .. }
            | DomainCommand::SetMode { session, .. }
            | DomainCommand::SetOption { session, .. }
            | DomainCommand::UndoTurn { session, .. } => Some(session.clone()),
            DomainCommand::Manage { session, action } if action.external() => Some(session.clone()),
            _ => None,
        };
        if let Some(session) = owner_session {
            self.runtime
                .registry
                .command_admitted(DomainCommand::LoadSession(session))
                .await?;
        }
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
                | DomainCommand::SetOption { .. }
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
            match self.coordinator.forks.get(session, &operation) {
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
        mut command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<CommandReceipt, DomainError> {
        let accepts_input = operation.is_some();
        if self.closed.load(Ordering::Acquire) {
            return Err(DomainError::Worker("runtime shutting down".into()));
        }
        command = self.prepare_input(command).await?;
        if matches!(command, DomainCommand::Fork { .. }) {
            return Err(DomainError::Protocol(
                "native fork requires durable admission".into(),
            ));
        }
        if let DomainCommand::Discover { session } = &command {
            return self.discover(session.clone()).await;
        }
        if let DomainCommand::CancelFork { session, operation } = &command {
            return self.cancel_fork(session, operation).await;
        }
        if let DomainCommand::Cancel { session } | DomainCommand::ReleaseWorker { session } =
            &command
        {
            if matches!(&command, DomainCommand::Cancel { .. }) {
                if let Some(turn) = self.interrupt_background(session).await? {
                    return self
                        .runtime
                        .registry
                        .command_with_operation(
                            DomainCommand::Interrupt {
                                session: session.clone(),
                                turn,
                                completed: true,
                            },
                            operation,
                        )
                        .await?
                        .receipt();
                }
            }
            self.commit(DomainCommand::RequestCancel {
                session: session.clone(),
            })
            .await?;
            self.stop_session_adapter(session).await?;
            self.coordinator.reviews.finish(session, None).await?;
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
            return self.manage_external(session, action).await;
        }
        if let DomainCommand::UndoTurn {
            session,
            turn,
            files,
        } = &command
        {
            return self.undo_turn(session, turn, files).await;
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
        if let DomainCommand::SetModel { session, .. }
        | DomainCommand::SetMode { session, .. }
        | DomainCommand::SetOption { session, .. } = &command
        {
            let observe = matches!(&command, DomainCommand::SetOption { .. })
                || self
                    .coordinator
                    .adapters
                    .lock()
                    .await
                    .get(session)
                    .is_some_and(|adapter| {
                        !adapter.stop.is_cancelled()
                            && !adapter.task.is_finished()
                            && !adapter.tx.is_closed()
                    });
            if observe {
                // Observe offerings without reapplying saved preferences: the
                // explicit edit may be correcting a value no longer offered.
                self.observe_provider(session.clone()).await?;
            }
            let events = self
                .runtime
                .registry
                .command_admitted(DomainCommand::Inspect(session.clone()))
                .await?;
            let Some(snapshot) = events.view() else {
                return Err(DomainError::NotFound(session.clone()));
            };
            if snapshot.active_turn.is_some() || snapshot.configuration_intent.is_some() {
                return Err(DomainError::Busy);
            }
            let mut config = snapshot.config.clone();
            if observe {
                // Rebase old overrides on the current offering before applying
                // the explicit edit. A withdrawn, unrelated setting must not
                // lock every control. The edit itself is validated below and
                // cleanup is persisted only with a successful provider commit.
                config.options.retain(|id, value| {
                    let Some(setting) = snapshot.catalogue.selects.iter().find(|s| {
                        &s.id == id
                            && !matches!(s.category.as_deref(), Some("model" | "mode"))
                            && s.id != "model"
                            && s.id != "mode"
                    }) else {
                        return false;
                    };
                    if !setting.choices.iter().any(|choice| &choice.value == value) {
                        *value = setting.current_value.clone();
                    }
                    true
                });
            }
            match &command {
                DomainCommand::SetModel { model, .. } => config.model = Some(model.clone()),
                DomainCommand::SetMode { mode, .. } => config.mode = Some(mode.clone()),
                DomainCommand::SetOption { id, value, .. } => {
                    config.options.insert(id.clone(), value.clone());
                }
                _ => unreachable!(),
            }
            let sender = if matches!(&command, DomainCommand::SetOption { .. }) {
                Some(self.adapter_sender(session.clone()).await?.0)
            } else {
                self.coordinator
                    .adapters
                    .lock()
                    .await
                    .get(session)
                    // Failed workers leave a joined/closed handle until the
                    // next launch. Treat it as cold for local preferences;
                    // sending Configure to it can only return MailboxClosed.
                    .filter(|adapter| {
                        !adapter.stop.is_cancelled()
                            && !adapter.task.is_finished()
                            && !adapter.tx.is_closed()
                    })
                    .map(|adapter| adapter.tx.clone())
            };
            if let Some(sender) = sender {
                let intent = crate::domain::session::ConfigurationIntent {
                    requested: config.clone(),
                    restore: crate::domain::session::SessionConfig {
                        options: snapshot
                            .catalogue
                            .selects
                            .iter()
                            .filter(|s| config.options.contains_key(&s.id))
                            .map(|s| (s.id.clone(), s.current_value.clone()))
                            .collect(),
                        model: snapshot
                            .catalogue
                            .current_model
                            .clone()
                            .or_else(|| snapshot.config.model.clone()),
                        mode: snapshot
                            .catalogue
                            .current_mode
                            .clone()
                            .or_else(|| snapshot.config.mode.clone()),
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
                        .map_err(DomainError::mailbox)?;
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
                    let adapter = self.coordinator.adapters.lock().await.remove(session);
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
                .command_admitted(DomainCommand::Inspect(session.clone()))
                .await?;
            let view = events
                .view()
                .ok_or_else(|| DomainError::NotFound(session.clone()))?;
            if view.active_turn.is_some() {
                return Err(DomainError::Busy);
            }
            if view.harness == crate::domain::Harness::Pi {
                self.ensure_model_context(session).await?;
            }
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
        // Side effects use the accepted command and its committed view, not a
        // second event/reducer projection. The owner already published its batch.
        let prompt = match &command {
            DomainCommand::Prompt { session, prompt } => Some((session.clone(), prompt.clone())),
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
            self.coordinator
                .reviews
                .start(session.clone(), turn.clone(), before, lease)
                .await;
            // An autonomous start can commit between acceptance and capture
            // registration. Never retain that rejected input's tentative baseline.
            let current = self
                .database
                .view(session.clone())
                .await
                .map_err(|e| DomainError::Persistence(e.to_string()))?;
            if current.active_turn.as_ref() != Some(&turn) {
                self.coordinator.reviews.reject_input(&session).await?;
            }
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
        if let Some(session) = answer_session {
            // Forward only the canonical validated response, and only after the
            // owner has committed it. Raw text answers are not ACP wire values.
            if let crate::actor::OwnerReply::Answered { answer, .. } = &result {
                let sender = self
                    .coordinator
                    .adapters
                    .lock()
                    .await
                    .get(&session)
                    .map(|adapter| adapter.tx.clone());
                let sent = match sender {
                    Some(sender) => sender
                        .try_send(AdapterCommand::Answer(answer.clone()))
                        .map_err(DomainError::mailbox),
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
    async fn commit(&self, command: DomainCommand) -> Result<CommandReceipt, DomainError> {
        self.runtime
            .registry
            .command_admitted(command)
            .await?
            .receipt()
    }
    async fn finish_shutdown(&self) -> Result<(), DomainError> {
        self.runtime.shutdown_checked().await
    }
    async fn emergency_shutdown(&self, executions: &ingress::IngressTasks) {
        self.closed.store(true, Ordering::Release);
        self.coordinator.stop.cancel();
        self.stop_adapters().await;
        let _ = self.coordinator.supervisor.shutdown().await;
        self.coordinator.tasks.close_and_join().await;
        self.runtime.workers_stopped();
        let mut tasks = executions.lock().await;
        let _ = ingress::drain_commands(self, &mut tasks).await;
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
