//! The only SQLite executor. Business code submits typed requests, never SQL or closures.
use super::{format::StorageLease, query, schema};
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
struct Inner {
    sender: Mutex<Option<mpsc::Sender<StoreRequest>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    finished: Mutex<Option<oneshot::Receiver<Result<(), StoreError>>>>,
    shutdown: tokio::sync::Mutex<()>,
    shutdown_started: Mutex<bool>,
    shutdown_result: Arc<Mutex<Option<Result<(), StoreError>>>>,
    shutdown_notify: Arc<tokio::sync::Notify>,
}
#[derive(Clone)]
pub struct Database {
    inner: Arc<Inner>,
}
impl Database {
    /// The retained lease prevents a host/maintenance race even if the caller
    /// drops its lease before all Database handles have drained.
    pub async fn open(root: impl AsRef<Path>, lease: &StorageLease) -> Result<Self, StoreError> {
        Self::open_sync(root, lease)
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
        let (sender, mut requests) = mpsc::channel(STORE_QUEUE_CAPACITY);
        let (started, ready) = std::sync::mpsc::sync_channel(1);
        let (finished, done) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("workbench-sqlite".into())
            .spawn(move || {
                let mut connection = match schema::open(&root) {
                    Ok(connection) => {
                        let _ = started.send(Ok(()));
                        connection
                    }
                    Err(error) => {
                        let _ = started.send(Err(error.clone()));
                        let _ = finished.send(Err(error));
                        return;
                    }
                };
                // A reply is an observer, not ownership of an accepted transaction.
                while let Some(request) = requests.blocking_recv() {
                    match request {
                        StoreRequest::Attached { session, reply } => {
                            let result = (|| {
                                let tx = connection.transaction()?;
                                let mut attached = crate::domain::query::Attached {
                                    view: query::view(&tx, &session)?,
                                    recent_page: query::history(&tx, &session, None, None)?,
                                };
                                while attached.validate().is_err() {
                                    if attached.recent_page.entries.len() <= 1 {
                                        return Err(
                                            crate::domain::query::QueryError::TooLarge.into()
                                        );
                                    }
                                    attached.recent_page.entries.remove(0);
                                    attached.recent_page.next_cursor =
                                        Some(crate::domain::query::HistoryCursor {
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
                            let _ = reply.send(query::tools(
                                &connection,
                                &session,
                                &turn,
                                cursor,
                                limit,
                            ));
                        }
                        StoreRequest::Remove { session, reply } => {
                            let _ = reply.send(query::remove(&mut connection, &session));
                        }
                        StoreRequest::Tool {
                            session,
                            turn,
                            tool,
                            reply,
                        } => {
                            let _ = reply.send(query::tool(&connection, &session, &turn, &tool));
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
                            let _ = reply.send(super::fork::adopt(&mut connection, *plan, native));
                        }
                        StoreRequest::Create { view, reply } => {
                            let _ = reply.send(query::create(&mut connection, &view));
                        }
                        StoreRequest::Commit { commit, reply } => {
                            let _ = reply.send(query::commit(&mut connection, *commit));
                        }
                        StoreRequest::View { session, reply } => {
                            let _ = reply.send(query::view(&connection, &session));
                        }
                        StoreRequest::List {
                            cursor,
                            limit,
                            reply,
                        } => {
                            let _ = reply.send(query::list(&connection, cursor, limit));
                        }
                        StoreRequest::History {
                            session,
                            cursor,
                            limit,
                            reply,
                        } => {
                            let _ =
                                reply.send(query::history(&connection, &session, cursor, limit));
                        }
                        StoreRequest::ContentSlice {
                            content,
                            offset,
                            length,
                            reply,
                        } => {
                            let _ = reply.send(super::content::slice(
                                &connection,
                                &content,
                                offset,
                                length,
                            ));
                        }
                        StoreRequest::Content { content, reply } => {
                            let _ = reply.send(super::content::read_text(&connection, &content));
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
                            let _ = reply.send(super::content::image(&connection, &id));
                        }
                        StoreRequest::Delivery(request) => {
                            super::delivery::execute(&mut connection, *request);
                        }
                        StoreRequest::Payload(request) => {
                            super::payload::execute(&mut connection, *request);
                        }
                        StoreRequest::TelegramInbox(request) => {
                            super::telegram_sql::execute(&mut connection, *request);
                        }
                        StoreRequest::TelegramEffect(request) => {
                            super::telegram_effect::execute(&mut connection, *request);
                        }
                        StoreRequest::Journal(request) => {
                            super::journal::execute(&mut connection, *request);
                        }
                        #[cfg(test)]
                        StoreRequest::Test(request) => {
                            super::sqlite_tests::execute(&mut connection, request)
                        }
                    }
                }
                let result = connection
                    .close()
                    .map_err(|(_, error)| StoreError::from(error));
                drop(held_lease);
                let _ = finished.send(result);
            })?;
        match ready.recv().unwrap_or(Err(StoreError::Closed)) {
            Ok(()) => Ok(Self {
                inner: Arc::new(Inner {
                    sender: Mutex::new(Some(sender)),
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
        sender.send(request).await.map_err(|_| StoreError::Closed)
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
    pub async fn remove(&self, session: SessionId) -> Result<CommitBatch, StoreError> {
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Remove { session, reply })
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
        let (reply, result) = oneshot::channel();
        self.enqueue(StoreRequest::Delivery(Box::new(
            super::delivery::Request::Ack { id, reply },
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
            if let Some(result) = self
                .inner
                .shutdown_result
                .lock()
                .expect("shutdown result lock poisoned")
                .clone()
            {
                return result;
            }
            self.inner.shutdown_notify.notified().await;
        }
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.sender.get_mut().expect("sender lock poisoned").take();
        // Last-handle drop is also drain + physical join, never a write abort.
        if let Some(thread) = self.thread.get_mut().expect("thread lock poisoned").take() {
            let _ = thread.join();
        }
    }
}
