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
#[path = "app_worker_retention.rs"]
mod worker_retention;

#[path = "app_fork.rs"]
mod forks;
#[path = "app_ingress.rs"]
mod ingress;
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
            | DomainCommand::RequestCancel { session }
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
        let mut sanitized_prompt = None;
        if self.closed.load(Ordering::Acquire) {
            return Err(DomainError::Worker("runtime shutting down".into()));
        }
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
        if let DomainCommand::Cancel { session } = &command {
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
                .map_err(DomainError::mailbox)?;
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
        if let DomainCommand::UndoTurn {
            session,
            turn,
            files,
        } = &command
        {
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
            let files = files.clone();
            // Validate selection before stopping a provider.
            crate::workspace_undo::select_files(diff.clone(), files.as_deref())
                .map_err(DomainError::Persistence)?;
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
                crate::workspace_undo::undo_selected(&root, diff, files.as_deref(), false)
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
        if let DomainCommand::SetModel { session, .. }
        | DomainCommand::SetMode { session, .. }
        | DomainCommand::SetOption { session, .. } = &command
        {
            if matches!(&command, DomainCommand::SetOption { .. }) {
                self.discover(session.clone()).await?;
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
    async fn annotate_residency(&self, page: &mut crate::domain::query::ListPage) {
        let adapters = self.coordinator.adapters.lock().await;
        let mut recent: Vec<_> = adapters
            .iter()
            .filter(|(_, h)| {
                h.last_used.load(Ordering::Relaxed) != 0
                    && !h.stop.is_cancelled()
                    && !h.task.is_finished()
                    && !h.tx.is_closed()
            })
            .map(|(id, h)| (id, h.last_used.load(Ordering::Relaxed)))
            .collect();
        recent.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
        let recent: std::collections::HashSet<_> =
            recent.into_iter().take(8).map(|(id, _)| id).collect();
        for row in &mut page.sessions {
            row.retention_days = adapters
                .get(&row.id)
                .filter(|h| !h.stop.is_cancelled() && !h.task.is_finished() && !h.tx.is_closed())
                .map(|_| if recent.contains(&row.id) { 4 } else { 1 })
                .or(Some(0));
        }
    }
    // Caller owns admission. Capacity reclaims one oldest idle resident; expiry
    // reclaims all expired idle residents. Reads/discovery never refresh the clock.
    async fn reclaim_workers(
        &self,
        exclude: Option<&SessionId>,
        expired_only: bool,
    ) -> Result<(), DomainError> {
        let mut adapters = self.coordinator.adapters.lock().await;
        let mut recent: Vec<_> = adapters
            .iter()
            .filter(|(_, h)| {
                h.last_used.load(Ordering::Relaxed) != 0
                    && !h.stop.is_cancelled()
                    && !h.task.is_finished()
                    && !h.tx.is_closed()
            })
            .map(|(id, h)| (id.clone(), h.last_used.load(Ordering::Relaxed)))
            .collect();
        recent.sort_by_key(|(_, order)| std::cmp::Reverse(*order));
        let recent: std::collections::HashSet<_> =
            recent.into_iter().take(8).map(|(id, _)| id).collect();
        let now = worker_retention::now();
        let mut candidates: Vec<_> = adapters
            .keys()
            .filter(|id| exclude != Some(*id))
            .cloned()
            .collect();
        candidates.sort_by_key(|id| {
            adapters
                .get(id)
                .map(|handle| (handle.last_used.load(Ordering::Relaxed), handle.epoch))
                .unwrap_or((u64::MAX, u64::MAX))
        });
        for id in candidates {
            let Some(handle) = adapters.get(&id) else {
                continue;
            };
            if handle.pins.load(Ordering::Acquire) != 0
                || !handle.resumable.load(Ordering::Acquire)
                || handle.stop.is_cancelled()
                || handle.task.is_finished()
                || handle.tx.is_closed()
            {
                continue;
            }
            if expired_only
                && !worker_retention::expired(
                    now,
                    handle.resident_since,
                    handle.last_user_input_at,
                    recent.contains(&id),
                )
            {
                continue;
            }
            let view = match self.database.view(id.clone()).await {
                Ok(view) => view,
                Err(_) => continue,
            };
            if view.active_turn.is_some()
                || !view.pending_interactions.is_empty()
                || view.configuration_intent.is_some()
            {
                continue;
            }
            // Fork work does not mark the source as an active turn. Its
            // admission lease protects inspection, remote mutation and adopt
            // even while the stored session still looks idle. Recheck after
            // the database await; admission/map locks serialize worker starts.
            if self.coordinator.forks.owns_session(&id) {
                continue;
            }
            // The owner atomically rejects retirement if a user/background turn
            // or permission arrived after the snapshot. Its epoch fence rejects
            // later peer events; the physical pin is released only after join.
            if self
                .runtime
                .registry
                .retire_idle_worker(id.clone(), handle.epoch)
                .await
                .is_err()
            {
                continue;
            }
            let handle = adapters.remove(&id).expect("candidate is still registered");
            crate::diagnostics::gauge(
                "last_reclaimed_background_capable",
                usize::from(!handle.background_safe.load(Ordering::Acquire)),
            );
            // Fence map ownership before requesting physical termination. The
            // admission lock prevents a concurrent session start from replacing it.
            handle.stop.cancel();
            // Queries can observe the logical release while physical join is
            // still pending. Admission and the owner's attachment pin continue
            // to prevent slot reuse or owner eviction until that join finishes.
            drop(adapters);
            handle.stop().await;
            if !expired_only {
                return Ok(());
            }
            adapters = self.coordinator.adapters.lock().await;
        }
        if expired_only {
            Ok(())
        } else {
            Err(DomainError::WorkerCapacity)
        }
    }
    async fn stop_session_adapter(&self, session: &SessionId) -> Result<(), DomainError> {
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
    async fn commit(&self, command: DomainCommand) -> Result<CommandReceipt, DomainError> {
        self.runtime
            .registry
            .command_admitted(command)
            .await?
            .receipt()
    }
    async fn fail_adapter(
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
    async fn discover(&self, session: SessionId) -> Result<CommandReceipt, DomainError> {
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
    async fn dispatch_prompt(
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
            handle.last_used.store(activity.1, Ordering::Relaxed);
        }
        sender
            .try_send(AdapterCommand::Prompt { turn, text, config })
            .map_err(DomainError::mailbox)
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
                resident_since: worker_retention::now(),
            },
        );
        Ok((tx, config))
    }
    async fn stop_adapters(&self) {
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
