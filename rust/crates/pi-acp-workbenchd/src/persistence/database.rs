//! Single SQLite writer and two fixed readonly executors. Business code submits typed requests, never SQL or closures.
use super::{database_dispatch::execute_request, format::StorageLease, schema};
use crate::domain::{
    query::{
        CommitBatch, ContentRef, HistoryCursor, HistoryPage, ListCursor, ListPage, QueryError,
        SafeInteger, SessionSummary, SessionView,
    },
    transition::Transition,
    SessionId,
};
use serde::Serialize;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

pub const STORE_QUEUE_CAPACITY: usize = 256;
// SQLite uses signed i64; this adapter validates the narrower public range on
// every read and only binds values already validated by SafeInteger.
impl rusqlite::types::ToSql for SafeInteger {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.get() as i64))
    }
}
impl rusqlite::types::FromSql for SafeInteger {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let number = value.as_i64()?;
        let unsigned =
            u64::try_from(number).map_err(|_| rusqlite::types::FromSqlError::OutOfRange(number))?;
        SafeInteger::new(unsigned).map_err(|e| rusqlite::types::FromSqlError::Other(Box::new(e)))
    }
}
#[derive(Clone, Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database is closed")]
    Closed,
    #[error("database revision or immutable identity conflict")]
    Conflict,
    #[error("session not found")]
    NotFound,
    #[error("invalid database state: {0}")]
    Invalid(&'static str),
    #[error("database I/O: {0}")]
    Io(String),
    #[error("SQLite: {0}")]
    Sqlite(String),
    #[error(transparent)]
    Query(#[from] QueryError),
}
impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e.to_string())
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(_: serde_json::Error) -> Self {
        Self::Invalid("typed JSON decode/encode failed")
    }
}
pub(super) fn encode<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}

pub(super) use super::database_request::StoreRequest;
#[derive(Clone)]
struct Senders {
    writer: mpsc::Sender<QueuedRequest>,
    readers: [mpsc::Sender<QueuedRequest>; 2],
}
struct ReaderWorker {
    sender: Option<mpsc::Sender<QueuedRequest>>,
    thread: Option<JoinHandle<Result<(), StoreError>>>,
}
impl ReaderWorker {
    fn start(
        root: &Path,
        index: usize,
        metrics: Arc<super::metrics::Metrics>,
    ) -> Result<Self, StoreError> {
        let root = root.to_path_buf();
        let (sender, mut requests) = mpsc::channel::<QueuedRequest>(STORE_QUEUE_CAPACITY / 2);
        let (started, ready) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name(format!("workbench-read-{index}"))
            .spawn(move || {
                let mut connection = match schema::open_reader(&root) {
                    Ok(connection) => {
                        let _ = started.send(Ok(()));
                        connection
                    }
                    Err(error) => {
                        let _ = started.send(Err(error.clone()));
                        return Err(error);
                    }
                };
                while let Some(queued) = requests.blocking_recv() {
                    let began = Instant::now();
                    let wait = queued.enqueued.elapsed();
                    let kind = queued.request.kind();
                    execute_request(&mut connection, queued.request);
                    metrics.record(
                        kind,
                        queued.enqueue_wait,
                        wait,
                        began.elapsed(),
                        queued.depth,
                    );
                }
                connection
                    .close()
                    .map_err(|(_, error)| StoreError::from(error))
            })?;
        let worker = Self {
            sender: Some(sender),
            thread: Some(thread),
        };
        ready.recv().unwrap_or(Err(StoreError::Closed))?;
        Ok(worker)
    }
    fn join(&mut self) -> Result<(), StoreError> {
        self.sender.take();
        self.thread.take().map_or(Ok(()), |thread| {
            thread
                .join()
                .unwrap_or(Err(StoreError::Invalid("reader thread panicked")))
        })
    }
}
impl Drop for ReaderWorker {
    fn drop(&mut self) {
        let _ = self.join();
    }
}
struct Inner {
    metrics: Arc<super::metrics::Metrics>,
    sender: Mutex<Option<Senders>>,
    next_reader: std::sync::atomic::AtomicUsize,
    thread: Mutex<Option<JoinHandle<()>>>,
    finished: Mutex<Option<oneshot::Receiver<Result<(), StoreError>>>>,
    shutdown: tokio::sync::Mutex<()>,
    shutdown_started: Mutex<bool>,
    shutdown_result: Arc<Mutex<Option<Result<(), StoreError>>>>,
    shutdown_notify: Arc<tokio::sync::Notify>,
}
struct QueuedRequest {
    request: StoreRequest,
    enqueued: Instant,
    enqueue_wait: Duration,
    depth: usize,
}
#[derive(Clone)]
pub struct Database {
    inner: Arc<Inner>,
}
impl Database {
    /// The retained lease prevents a host/maintenance race even if the caller
    /// drops its lease before all Database handles have drained.
    pub async fn open(root: impl AsRef<Path>, lease: &StorageLease) -> Result<Self, StoreError> {
        let root = root.as_ref().to_path_buf();
        let lease = lease.clone();
        tokio::task::spawn_blocking(move || Self::open_sync(root, &lease))
            .await
            .map_err(|_| StoreError::Invalid("database startup task panicked"))?
    }
    /// Synchronous host construction waits only for the dedicated thread's
    /// startup result. All SQLite work, including open/validation, stays there.
    pub fn open_sync(root: impl AsRef<Path>, lease: &StorageLease) -> Result<Self, StoreError> {
        let root = root.as_ref().to_path_buf();
        if !lease.owns(&root) {
            return Err(StoreError::Invalid(
                "database open requires this root's host lease",
            ));
        }
        let held_lease = lease.claim_database()?;
        let (sender, mut requests) = mpsc::channel::<QueuedRequest>(STORE_QUEUE_CAPACITY);
        let metrics = Arc::new(super::metrics::Metrics::default());
        let worker_metrics = metrics.clone();
        let (started, ready) = std::sync::mpsc::sync_channel(1);
        let (finished, done) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("workbench-sqlite".into())
            .spawn(move || {
                let mut connection = match schema::open(&root) {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = started.send(Err(error.clone()));
                        let _ = finished.send(Err(error));
                        return;
                    }
                };
                let readers = (0..2)
                    .map(|index| ReaderWorker::start(&root, index, worker_metrics.clone()))
                    .collect::<Result<Vec<_>, _>>();
                let mut readers = match readers {
                    Ok(readers) => readers,
                    Err(error) => {
                        let _ = started.send(Err(error.clone()));
                        let _ = finished.send(Err(error));
                        return;
                    }
                };
                let reader_senders = [
                    readers[0].sender.take().unwrap(),
                    readers[1].sender.take().unwrap(),
                ];
                let _ = started.send(Ok(reader_senders));
                let mut checkpoint = super::checkpoint::Checkpoint::new(&root);
                // A reply is an observer, not ownership of an accepted transaction.
                while let Some(queued) = requests.blocking_recv() {
                    let execution = Instant::now();
                    let queue_wait = queued.enqueued.elapsed();
                    let kind = queued.request.kind();
                    execute_request(&mut connection, queued.request);
                    worker_metrics.record(
                        kind,
                        queued.enqueue_wait,
                        queue_wait,
                        execution.elapsed(),
                        queued.depth,
                    );
                    match checkpoint.poll(&connection, Instant::now()) {
                        Ok(Some(outcome)) => eprintln!(
                            "WAL reuse checkpoint: busy={} log_frames={} checkpointed_frames={} elapsed_us={} busy_wait_budget_ms=20",
                            outcome.busy, outcome.log_frames, outcome.checkpointed_frames, outcome.elapsed.as_micros()
                        ),
                        Ok(None) => {},
                        // A committed request keeps its receipt. Maintenance
                        // failure is visible and retried at the next interval.
                        Err(error) => eprintln!("WAL reuse checkpoint failed: {error}"),
                    }
                }
                let mut reader_result = Ok(());
                for reader in &mut readers {
                    if let Err(error) = reader.join() {
                        reader_result = Err(error);
                    }
                }
                let result = connection
                    .close()
                    .map_err(|(_, error)| StoreError::from(error))
                    .and(reader_result);
                drop(held_lease);
                let _ = finished.send(result);
            })?;
        match ready.recv().unwrap_or(Err(StoreError::Closed)) {
            Ok(readers) => Ok(Self {
                inner: Arc::new(Inner {
                    metrics,
                    sender: Mutex::new(Some(Senders {
                        writer: sender,
                        readers,
                    })),
                    next_reader: std::sync::atomic::AtomicUsize::new(0),
                    thread: Mutex::new(Some(thread)),
                    finished: Mutex::new(Some(done)),
                    shutdown: tokio::sync::Mutex::new(()),
                    shutdown_started: Mutex::new(false),
                    shutdown_result: Arc::new(Mutex::new(None)),
                    shutdown_notify: Arc::new(tokio::sync::Notify::new()),
                }),
            }),
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }
    pub(super) async fn enqueue(&self, request: StoreRequest) -> Result<(), StoreError> {
        let sender = self
            .inner
            .sender
            .lock()
            .expect("sender lock poisoned")
            .clone()
            .ok_or(StoreError::Closed)?;
        let (sender, capacity) = if request.read_only() {
            let index = self
                .inner
                .next_reader
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                % 2;
            (sender.readers[index].clone(), STORE_QUEUE_CAPACITY / 2)
        } else {
            (sender.writer.clone(), STORE_QUEUE_CAPACITY)
        };
        let began = Instant::now();
        let permit = sender.reserve().await.map_err(|_| StoreError::Closed)?;
        let depth = capacity - sender.capacity();
        self.inner.metrics.accepted(request.kind(), depth);
        permit.send(QueuedRequest {
            request,
            enqueued: Instant::now(),
            enqueue_wait: began.elapsed(),
            depth,
        });
        Ok(())
    }
    pub fn metrics(&self) -> std::collections::BTreeMap<&'static str, super::RequestMetrics> {
        self.inner.metrics.snapshot()
    }
    pub async fn content_slice(
        &self,
        content: ContentRef,
        offset: SafeInteger,
        length: Option<usize>,
    ) -> Result<crate::domain::query::ContentSlice, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ContentSlice {
            content,
            offset,
            length,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn management(
        &self,
        query: crate::domain::management::ManagementQuery,
    ) -> Result<crate::domain::management::ManagementData, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ManagementRead { query, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn manage(
        &self,
        session: SessionId,
        action: crate::domain::management::ManagementAction,
        ticket: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<crate::domain::query::CommandReceipt, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ManagementUpdate {
            session,
            action,
            ticket,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn context_stage(
        &self,
        session: SessionId,
        action: crate::domain::management::ManagementAction,
    ) -> Result<crate::domain::management::ContextIntent, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ContextStage {
            session,
            action,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn context_snapshot(
        &self,
    ) -> Result<crate::domain::management::ContextSnapshot, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ContextSnapshot { reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn context_settle(
        &self,
        revision: u64,
        error: Option<String>,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ContextSettle {
            revision,
            error,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn model_defaults(
        &self,
        session: SessionId,
        models: crate::domain::management::ProviderModels,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ModelDefaults {
            session: Some(session),
            models,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn profile_model_defaults(
        &self,
        models: crate::domain::management::ProviderModels,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ModelDefaults {
            session: None,
            models,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn title_job(&self, session: SessionId) -> Result<Option<String>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::TitleJob { session, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn title_result(
        &self,
        session: SessionId,
        result: crate::domain::management::TitleResponse,
    ) -> Result<(), StoreError> {
        let (reply, wait) = oneshot::channel();
        self.enqueue(StoreRequest::TitleResult {
            session,
            result,
            reply,
        })
        .await?;
        wait.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn save_turn_diff(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        diff: crate::workspace_review::TurnDiff,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::TurnDiffSave {
            session,
            turn,
            diff: Box::new(diff),
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn turn_diff_page(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        offset: usize,
    ) -> Result<crate::workspace_review::TurnDiff, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::TurnDiffPage {
            session,
            turn,
            offset,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn turn_diff_content(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        file: usize,
        after: bool,
        offset: SafeInteger,
    ) -> Result<crate::workspace_review::DiffContent, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::TurnDiffContent {
            session,
            turn,
            file,
            after,
            offset,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn turn_diff(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
    ) -> Result<Option<crate::workspace_review::TurnDiff>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::TurnDiffGet {
            session,
            turn,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn attached(
        &self,
        session: SessionId,
    ) -> Result<crate::domain::query::Attached, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Attached { session, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn tools(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        cursor: Option<crate::domain::query::ToolCursor>,
        limit: Option<usize>,
    ) -> Result<crate::domain::query::ToolPage, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Tools {
            session,
            turn,
            cursor,
            limit,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn remove(
        &self,
        session: SessionId,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<CommitBatch, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Remove {
            session,
            operation,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn tool(
        &self,
        session: SessionId,
        turn: crate::domain::TurnId,
        tool: crate::domain::ToolCallId,
    ) -> Result<Option<crate::domain::query::ToolHeader>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Tool {
            session,
            turn,
            tool,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn prepare_fork(
        &self,
        view: SessionView,
        request: crate::domain::fork::ForkRequest,
        candidates: Vec<crate::domain::fork::ForkCandidate>,
    ) -> Result<crate::domain::fork::ForkPlan, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::PrepareFork {
            view: Box::new(view),
            request,
            candidates,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn adopt_fork(
        &self,
        plan: crate::domain::fork::ForkPlan,
        native: crate::domain::ProviderSessionId,
    ) -> Result<(SessionView, SessionSummary), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::AdoptFork {
            plan: Box::new(plan),
            native,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub(crate) async fn create(&self, view: SessionView) -> Result<SessionSummary, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Create {
            view: Box::new(view),
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn commit(&self, commit: Transition) -> Result<CommitBatch, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Commit {
            commit: Box::new(commit),
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub(crate) async fn summary(&self, session: SessionId) -> Result<SessionSummary, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Summary { session, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub(crate) async fn worker_activity(
        &self,
        session: SessionId,
    ) -> Result<(u64, u64), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::WorkerActivity { session, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn view(&self, session: SessionId) -> Result<SessionView, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::View { session, reply }).await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub(crate) async fn history_clear(
        &self,
        request: super::history_clear::Request,
    ) -> Result<super::history_clear::Output, StoreError> {
        let (reply, wait) = oneshot::channel();
        self.enqueue(StoreRequest::HistoryClear { request, reply })
            .await?;
        wait.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn search(
        &self,
        filter: crate::domain::query::SessionFilter,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> Result<ListPage, StoreError> {
        let (reply, wait) = oneshot::channel();
        self.enqueue(StoreRequest::Search {
            filter,
            cursor,
            limit,
            reply,
        })
        .await?;
        wait.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn list(
        &self,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> Result<ListPage, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::List {
            cursor,
            limit,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn activity_list(
        &self,
        cursor: Option<ListCursor>,
        limit: Option<usize>,
    ) -> Result<ListPage, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ActivityList {
            cursor,
            limit,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn history(
        &self,
        session: SessionId,
        cursor: Option<HistoryCursor>,
        limit: Option<usize>,
    ) -> Result<HistoryPage, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::History {
            session,
            cursor,
            limit,
            reply,
        })
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn content(&self, content: ContentRef) -> Result<String, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Content { content, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub(crate) async fn reject_journal_admission(
        &self,
        operation: crate::domain::OperationId,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Test(
            super::sqlite_tests::TestRequest::RejectJournalAdmission { operation, reply },
        ))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub(crate) async fn pause_executor(
        &self,
    ) -> Result<super::sqlite_tests::ExecutorPause, StoreError> {
        let (entered, ready) = oneshot::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        self.enqueue(StoreRequest::Test(
            super::sqlite_tests::TestRequest::Pause {
                entered,
                resume: wait,
            },
        ))
        .await?;
        ready.await.map_err(|_| StoreError::Closed)?;
        Ok(super::sqlite_tests::ExecutorPause::new(resume))
    }
    #[cfg(test)]
    pub(crate) async fn set_session_commit_failure(
        &self,
        session: SessionId,
        fail: bool,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Test(
            super::sqlite_tests::TestRequest::SessionCommitFailure {
                session,
                fail,
                reply,
            },
        ))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub(crate) async fn corrupt_image(&self, id: crate::domain::ImageId) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Test(
            super::sqlite_tests::TestRequest::CorruptImage { id, reply },
        ))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub(crate) async fn archive_image(
        &self,
        asset: crate::domain::image::ImageAsset,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ArchiveImage { asset, reply })
            .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn image_by_id(
        &self,
        id: crate::domain::ImageId,
    ) -> Result<crate::domain::image::ImageAsset, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Image { id, reply }).await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn image(
        &self,
        expected: crate::domain::image::ImageRef,
    ) -> Result<crate::domain::image::ImageAsset, StoreError> {
        let asset = self.image_by_id(expected.id().clone()).await?;
        if asset.image() != &expected {
            return Err(StoreError::Invalid("image reference identity mismatch"));
        }
        Ok(asset)
    }
    pub async fn enqueue_delivery(
        &self,
        intent: crate::domain::transition::DeliveryIntent,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::Enqueue { intent, reply },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    /// Heads for immutable persisted targets, including deferred heads when
    /// now=MAX_SAFE_INTEGER. Dynamic Telegram binding resolution stays with
    /// the adapter until its own store migration; this is not a topic resolver.
    #[cfg(test)]
    pub async fn delivery_target_heads(
        &self,
        now: SafeInteger,
        limit: usize,
    ) -> Result<Vec<super::delivery::PendingDelivery>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::Heads { now, limit, reply },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub async fn pending_delivery_records(
        &self,
        now: SafeInteger,
        limit: usize,
    ) -> Result<Vec<super::delivery::PendingDelivery>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::All { now, limit, reply },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn dispatch_snapshot(
        &self,
        bot: i64,
        limit: usize,
    ) -> Result<super::delivery::DispatchSnapshot, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::DispatchSnapshot { bot, limit, reply },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    #[cfg(test)]
    pub async fn delivery_topic_heads(
        &self,
        now: SafeInteger,
        limit: usize,
        bindings: Vec<(SessionId, i64, i64)>,
        bot_id: i64,
    ) -> Result<Vec<super::delivery::PendingDelivery>, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::TopicHeads {
                now,
                limit,
                bindings,
                bot_id,
                reply,
            },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn ack_delivery(&self, id: crate::domain::DeliveryId) -> Result<(), StoreError> {
        self.ack_sent_delivery(id, None).await
    }
    pub(crate) async fn ack_sent_delivery(
        &self,
        id: crate::domain::DeliveryId,
        destination: Option<(i64, crate::telegram::types::TopicKey)>,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::Ack {
                id,
                destination,
                reply,
            },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn fail_delivery(
        &self,
        id: crate::domain::DeliveryId,
        failure: super::delivery::Failure,
        retry_at: SafeInteger,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::Fail {
                id,
                failure,
                retry_at,
                reply,
            },
        )))
        .await?;
        result.await.map_err(|_| StoreError::Closed)?
    }
    pub async fn shutdown(&self) -> Result<(), StoreError> {
        let _shutdown = self.inner.shutdown.lock().await;
        let should_start = {
            let mut started = self
                .inner
                .shutdown_started
                .lock()
                .expect("shutdown lock poisoned");
            if *started {
                false
            } else {
                *started = true;
                true
            }
        };
        if should_start {
            self.inner
                .sender
                .lock()
                .expect("sender lock poisoned")
                .take();
            let done = self
                .inner
                .finished
                .lock()
                .expect("finish lock poisoned")
                .take();
            let thread = self
                .inner
                .thread
                .lock()
                .expect("thread lock poisoned")
                .take();
            let result_cell = Arc::clone(&self.inner.shutdown_notify);
            let result_store = self.inner.shutdown_result.clone();
            tokio::spawn(async move {
                let result = match done {
                    Some(done) => done.await.unwrap_or(Err(StoreError::Closed)),
                    None => Ok(()),
                };
                let result = if let Some(thread) = thread {
                    match tokio::task::spawn_blocking(move || thread.join()).await {
                        Ok(Ok(())) => result,
                        Ok(Err(_)) | Err(_) => Err(StoreError::Invalid("database thread panicked")),
                    }
                } else {
                    result
                };
                *result_store.lock().expect("shutdown result lock poisoned") = Some(result);
                result_cell.notify_waiters();
            });
        }
        loop {
            let notified = self.inner.shutdown_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self
                .inner
                .shutdown_result
                .lock()
                .expect("shutdown result lock poisoned")
                .clone()
            {
                return result;
            }
            notified.await;
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.sender.get_mut().expect("sender lock poisoned").take();
        // Implicit teardown must not block a Tokio executor. The writer retains
        // the lease while draining and joining both readers; a dedicated reaper
        // owns its physical join when explicit async shutdown was not used.
        if let Some(thread) = self.thread.get_mut().expect("thread lock poisoned").take() {
            if tokio::runtime::Handle::try_current().is_err() {
                let _ = thread.join();
                return;
            }
            let _ = std::thread::Builder::new()
                .name("workbench-storage-reaper".into())
                .spawn(move || {
                    let _ = thread.join();
                });
        }
    }
}
