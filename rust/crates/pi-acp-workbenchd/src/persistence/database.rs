//! Single SQLite writer and two fixed readonly executors. Business code submits typed requests, never SQL or closures.
use super::{format::StorageLease, query, schema};
use crate::domain::{
    query::{
        CommitBatch, ContentRef, HistoryCursor, HistoryPage, ListCursor, ListPage, QueryError,
        SafeInteger, SessionSummary, SessionView,
    },
    transition::Transition,
    SessionId,
};
use rusqlite::OptionalExtension;
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

type Reply<T> = oneshot::Sender<Result<T, StoreError>>;
pub(super) enum StoreRequest {
    ManagementRead {
        query: crate::domain::management::ManagementQuery,
        reply: Reply<crate::domain::management::ManagementData>,
    },
    ManagementUpdate {
        session: SessionId,
        action: crate::domain::management::ManagementAction,
        ticket: Option<crate::domain::operation::OperationTicket>,
        reply: Reply<crate::domain::query::CommandReceipt>,
    },
    ModelDefaults {
        session: SessionId,
        models: crate::domain::management::ProviderModels,
        reply: Reply<()>,
    },
    TitleJob {
        session: SessionId,
        reply: Reply<Option<String>>,
    },
    TitleResult {
        session: SessionId,
        result: crate::domain::management::TitleResponse,
        reply: Reply<()>,
    },
    TurnDiffSave {
        session: SessionId,
        turn: crate::domain::TurnId,
        diff: Box<crate::workspace_review::TurnDiff>,
        reply: Reply<()>,
    },
    TurnDiffGet {
        session: SessionId,
        turn: crate::domain::TurnId,
        reply: Reply<Option<crate::workspace_review::TurnDiff>>,
    },
    TurnDiffPage {
        session: SessionId,
        turn: crate::domain::TurnId,
        offset: usize,
        reply: Reply<crate::workspace_review::TurnDiff>,
    },
    TurnDiffContent {
        session: SessionId,
        turn: crate::domain::TurnId,
        file: usize,
        after: bool,
        offset: SafeInteger,
        reply: Reply<crate::workspace_review::DiffContent>,
    },
    Attached {
        session: SessionId,
        reply: Reply<crate::domain::query::Attached>,
    },
    Tools {
        session: SessionId,
        turn: crate::domain::TurnId,
        cursor: Option<crate::domain::query::ToolCursor>,
        limit: Option<usize>,
        reply: Reply<crate::domain::query::ToolPage>,
    },
    Remove {
        session: SessionId,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply<CommitBatch>,
    },
    Tool {
        session: SessionId,
        turn: crate::domain::TurnId,
        tool: crate::domain::ToolCallId,
        reply: Reply<Option<crate::domain::query::ToolHeader>>,
    },
    PrepareFork {
        view: Box<SessionView>,
        request: crate::domain::fork::ForkRequest,
        candidates: Vec<crate::domain::fork::ForkCandidate>,
        reply: Reply<crate::domain::fork::ForkPlan>,
    },
    AdoptFork {
        plan: Box<crate::domain::fork::ForkPlan>,
        native: crate::domain::ProviderSessionId,
        reply: Reply<(SessionView, SessionSummary)>,
    },
    Create {
        view: Box<SessionView>,
        reply: Reply<SessionSummary>,
    },
    Commit {
        commit: Box<Transition>,
        reply: Reply<CommitBatch>,
    },
    View {
        session: SessionId,
        reply: Reply<SessionView>,
    },
    List {
        cursor: Option<ListCursor>,
        limit: Option<usize>,
        reply: Reply<ListPage>,
    },
    ActivityList {
        cursor: Option<ListCursor>,
        limit: Option<usize>,
        reply: Reply<ListPage>,
    },
    History {
        session: SessionId,
        cursor: Option<HistoryCursor>,
        limit: Option<usize>,
        reply: Reply<HistoryPage>,
    },
    ContentSlice {
        content: ContentRef,
        offset: SafeInteger,
        length: Option<usize>,
        reply: Reply<crate::domain::query::ContentSlice>,
    },
    Content {
        content: ContentRef,
        reply: Reply<String>,
    },
    Delivery(Box<super::delivery::Request>),
    Payload(Box<super::payload::Request>),
    TelegramInbox(Box<super::inbox::Request>),
    TelegramEffect(Box<super::telegram_effect::Request>),
    Journal(Box<super::journal::Request>),
    ArchiveImage {
        asset: crate::domain::image::ImageAsset,
        reply: Reply<()>,
    },
    Image {
        id: crate::domain::ImageId,
        reply: Reply<crate::domain::image::ImageAsset>,
    },
    #[cfg(test)]
    Test(super::sqlite_tests::TestRequest),
}
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
fn execute_request(connection: &mut rusqlite::Connection, request: StoreRequest) {
    match request {
        StoreRequest::ManagementRead { query, reply } => {
            let _ = reply.send(super::management::read(connection, &query));
        }
        StoreRequest::ManagementUpdate {
            session,
            action,
            ticket,
            reply,
        } => {
            let _ = reply.send(super::management::update(
                connection,
                &session,
                &action,
                ticket.as_ref(),
            ));
        }
        StoreRequest::ModelDefaults {
            session,
            models,
            reply,
        } => {
            let _ = reply.send(super::management::models(connection, &session, &models));
        }
        StoreRequest::TitleJob { session, reply } => {
            let _ = reply.send(super::management::title_job(connection, &session));
        }
        StoreRequest::TitleResult {
            session,
            result,
            reply,
        } => {
            let _ = reply.send(super::management::title_result(
                connection, &session, &result,
            ));
        }
        StoreRequest::TurnDiffSave {
            session,
            turn,
            diff,
            reply,
        } => {
            let result = (|| {
                let encoded = serde_json::to_string(&diff)
                    .map_err(|_| StoreError::Invalid("turn diff encode failed"))?;
                if encoded.len() > 32 * 1024 * 1024 {
                    return Err(StoreError::Invalid("turn diff exceeds archive budget"));
                }
                connection.execute("INSERT INTO turn_diffs(session,turn,diff_json) VALUES (?1,?2,?3) ON CONFLICT(session,turn) DO NOTHING", rusqlite::params![session.as_str(),turn.as_str(),encoded])?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffPage {
            session,
            turn,
            offset,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|v| {
                    v.map(|j| {
                        serde_json::from_str::<crate::workspace_review::TurnDiff>(&j)
                            .map_err(|_| StoreError::Invalid("turn diff corrupt"))
                    })
                    .transpose()
                })
                .and_then(|d| {
                    crate::workspace_review::summary(d, offset).map_err(StoreError::Query)
                });
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffContent {
            session,
            turn,
            file,
            after,
            offset,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|v| v.ok_or(StoreError::NotFound))
                .and_then(|j| {
                    serde_json::from_str::<crate::workspace_review::TurnDiff>(&j)
                        .map_err(|_| StoreError::Invalid("turn diff corrupt"))
                })
                .and_then(|d| {
                    crate::workspace_review::content(&d, file, after, offset.get() as usize)
                        .map_err(StoreError::Query)
                });
            let _ = reply.send(result);
        }
        StoreRequest::TurnDiffGet {
            session,
            turn,
            reply,
        } => {
            let result = connection
                .query_row(
                    "SELECT diff_json FROM turn_diffs WHERE session=?1 AND turn=?2",
                    rusqlite::params![session.as_str(), turn.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(StoreError::from)
                .and_then(|value| {
                    value
                        .map(|json| {
                            serde_json::from_str(&json)
                                .map_err(|_| StoreError::Invalid("turn diff archive is corrupt"))
                        })
                        .transpose()
                });
            let _ = reply.send(result);
        }
        StoreRequest::Attached { session, reply } => {
            let result = (|| {
                let tx = connection.transaction()?;
                let mut attached = crate::domain::query::Attached {
                    view: query::view(&tx, &session)?,
                    recent_page: query::history(&tx, &session, None, None)?,
                };
                while attached.validate().is_err() {
                    if attached.recent_page.entries.len() <= 1 {
                        return Err(crate::domain::query::QueryError::TooLarge.into());
                    }
                    attached.recent_page.entries.remove(0);
                    attached.recent_page.next_cursor = Some(crate::domain::query::HistoryCursor {
                        version: crate::domain::query::ProtocolVersion,
                        session: session.clone(),
                        max_entry_seq: attached.view.last_entry_seq,
                        before_seq: attached.recent_page.entries[0].seq,
                    });
                }
                tx.commit()?;
                Ok(attached)
            })();
            let _ = reply.send(result);
        }
        StoreRequest::Tools {
            session,
            turn,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::tools(connection, &session, &turn, cursor, limit));
        }
        StoreRequest::Remove {
            session,
            operation,
            reply,
        } => {
            let _ = reply.send(query::remove(connection, &session, operation.as_ref()));
        }
        StoreRequest::Tool {
            session,
            turn,
            tool,
            reply,
        } => {
            let _ = reply.send(query::tool(connection, &session, &turn, &tool));
        }
        StoreRequest::PrepareFork {
            view,
            request,
            candidates,
            reply,
        } => {
            let result = (|| {
                let tx = connection.transaction()?;
                let plan = super::fork::prepare(&tx, &view, &request, &candidates)?;
                tx.commit()?;
                Ok(plan)
            })();
            let _ = reply.send(result);
        }
        StoreRequest::AdoptFork {
            plan,
            native,
            reply,
        } => {
            let _ = reply.send(super::fork::adopt(connection, *plan, native));
        }
        StoreRequest::Create { view, reply } => {
            let _ = reply.send(query::create(connection, &view));
        }
        StoreRequest::Commit { commit, reply } => {
            let _ = reply.send(query::commit(connection, *commit));
        }
        StoreRequest::View { session, reply } => {
            let _ = reply.send(query::view(connection, &session));
        }
        StoreRequest::List {
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::list(connection, cursor, limit));
        }
        StoreRequest::ActivityList {
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::activity_list(connection, cursor, limit));
        }
        StoreRequest::History {
            session,
            cursor,
            limit,
            reply,
        } => {
            let _ = reply.send(query::history(connection, &session, cursor, limit));
        }
        StoreRequest::ContentSlice {
            content,
            offset,
            length,
            reply,
        } => {
            let _ = reply.send(super::content::slice(connection, &content, offset, length));
        }
        StoreRequest::Content { content, reply } => {
            let _ = reply.send(super::content::read_text(connection, &content));
        }
        StoreRequest::ArchiveImage { asset, reply } => {
            let result = (|| -> Result<(), StoreError> {
                let tx = connection.transaction()?;
                super::content::put_image(&tx, &asset)?;
                tx.commit()?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        StoreRequest::Image { id, reply } => {
            let _ = reply.send(super::content::image(connection, &id));
        }
        StoreRequest::Delivery(request) => {
            super::delivery::execute(connection, *request);
        }
        StoreRequest::Payload(request) => {
            super::payload::execute(connection, *request);
        }
        StoreRequest::TelegramInbox(request) => {
            super::telegram_sql::execute(connection, *request);
        }
        StoreRequest::TelegramEffect(request) => {
            super::telegram_effect::execute(connection, *request);
        }
        StoreRequest::Journal(request) => {
            super::journal::execute(connection, *request);
        }
        #[cfg(test)]
        StoreRequest::Test(request) => super::sqlite_tests::execute(connection, request),
    }
}

struct QueuedRequest {
    request: StoreRequest,
    enqueued: Instant,
    enqueue_wait: Duration,
    depth: usize,
}
impl StoreRequest {
    fn read_only(&self) -> bool {
        match self {
            Self::ManagementRead { .. }
            | Self::TurnDiffGet { .. }
            | Self::TurnDiffPage { .. }
            | Self::TurnDiffContent { .. }
            | Self::Attached { .. }
            | Self::Tools { .. }
            | Self::Tool { .. }
            | Self::View { .. }
            | Self::List { .. }
            | Self::History { .. }
            | Self::ContentSlice { .. }
            | Self::Content { .. }
            | Self::Image { .. } => true,
            #[cfg(test)]
            Self::Test(super::sqlite_tests::TestRequest::ReaderPause { .. }) => true,
            Self::Delivery(request) => matches!(
                request.as_ref(),
                super::delivery::Request::DispatchSnapshot { .. }
            ),
            Self::Journal(request) => {
                matches!(request.as_ref(), super::journal::Request::Status { .. })
            }
            _ => false,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            Self::ManagementRead { .. } => "management_read",
            Self::ManagementUpdate { .. } => "management_update",
            Self::ModelDefaults { .. } => "model_defaults",
            Self::TitleJob { .. } => "title_job",
            Self::TitleResult { .. } => "title_result",
            Self::TurnDiffGet { .. } => "turn_diff",
            Self::TurnDiffPage { .. } => "turn_diff_page",
            Self::TurnDiffContent { .. } => "turn_diff_content",
            Self::TurnDiffSave { .. } => "turn_diff_save",
            Self::Attached { .. } => "attach",
            Self::Tools { .. } => "tools",
            Self::Remove { .. } => "remove",
            Self::Tool { .. } => "tool",
            Self::PrepareFork { .. } => "fork_prepare",
            Self::AdoptFork { .. } => "fork_adopt",
            Self::Create { .. } => "create",
            Self::Commit { .. } => "commit",
            Self::View { .. } => "view",
            Self::List { .. } | Self::ActivityList { .. } => "list",
            Self::History { .. } => "history",
            Self::ContentSlice { .. } => "content_slice",
            Self::Content { .. } => "content",
            Self::Delivery(_) => "delivery",
            Self::Payload(_) => "payload",
            Self::TelegramInbox(_) => "inbox",
            Self::TelegramEffect(_) => "telegram_effect",
            Self::Journal(_) => "operation",
            Self::ArchiveImage { .. } => "archive_image",
            Self::Image { .. } => "image",
            #[cfg(test)]
            Self::Test(_) => "test",
        }
    }
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
    pub async fn model_defaults(
        &self,
        session: SessionId,
        models: crate::domain::management::ProviderModels,
    ) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::ModelDefaults {
            session,
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
    pub async fn create(&self, view: SessionView) -> Result<SessionSummary, StoreError> {
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
    pub async fn view(&self, session: SessionId) -> Result<SessionView, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::View { session, reply }).await?;
        result.await.map_err(|_| StoreError::Closed)?
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
    pub async fn archive_image(
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
