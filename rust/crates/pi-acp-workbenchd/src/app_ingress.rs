//! Bounded host ingress. Owns execution tasks and FIFO lane metadata, never
//! session state. Dropping a caller's oneshot does not drop an accepted operation.
use super::*;
use crate::domain::OperationId;
#[cfg(test)]
use crate::persistence::outbox::DeliveryRecord;
use std::collections::VecDeque;
use tokio::sync::{oneshot, watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

type Events = Result<CommandReceipt, DomainError>;
type Lookup = Result<Option<Events>, DomainError>;
type Outcome = Result<(), DomainError>;
pub(super) type IngressTasks = Arc<Mutex<JoinSet<Option<SessionId>>>>;
pub(super) enum Request {
    #[cfg(test)]
    Test {
        lane: Option<SessionId>,
        pool: usize,
        job: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    },
    Discover {
        session: SessionId,
        reply: oneshot::Sender<Events>,
    },
    Command {
        operation: Option<OperationId>,
        command: DomainCommand,
        reply: oneshot::Sender<Events>,
    },
    Lookup {
        operation: OperationId,
        command: DomainCommand,
        reply: oneshot::Sender<Lookup>,
    },
    Image {
        image: crate::domain::image::ImageRef,
        reply: oneshot::Sender<Result<crate::domain::image::ImageAsset, DomainError>>,
    },
    Query {
        command: crate::domain::query::QueryCommand,
        reply: oneshot::Sender<Result<crate::domain::query::QueryResult, DomainError>>,
    },
    Dispatch {
        bot: i64,
        limit: usize,
        reply: oneshot::Sender<Result<crate::persistence::delivery::DispatchSnapshot, DomainError>>,
    },
    #[cfg(test)]
    Deliveries {
        now: u64,
        limit: usize,
        reply: oneshot::Sender<Result<Vec<DeliveryRecord>, DomainError>>,
    },
}
impl Request {
    fn pool(&self) -> usize {
        match self {
            #[cfg(test)]
            Self::Test { pool, .. } => *pool,
            Self::Command {
                command:
                    DomainCommand::Cancel { .. }
                    | DomainCommand::CancelFork { .. }
                    | DomainCommand::AnswerInteraction { .. }
                    | DomainCommand::UndoTurn { .. }
                    | DomainCommand::RemoveSession(_),
                ..
            } => 1,
            Self::Command { command, .. } if command.is_query() => 2,
            Self::Lookup { .. }
            | Self::Query { .. }
            | Self::Dispatch { .. }
            | Self::Image { .. } => 2,
            #[cfg(test)]
            Self::Deliveries { .. } => 2,
            _ => 0,
        }
    }
    fn lane(&self) -> Option<SessionId> {
        match self {
            Self::Discover { session, .. } => Some(session.clone()),
            #[cfg(test)]
            Self::Test { lane, .. } => lane.clone(),
            Self::Command {
                command:
                    DomainCommand::LoadSession(session)
                    | DomainCommand::UndoTurn { session, .. }
                    | DomainCommand::RemoveSession(session)
                    | DomainCommand::Prompt { session, .. }
                    | DomainCommand::Cancel { session }
                    | DomainCommand::RequestCancel { session }
                    | DomainCommand::AnswerInteraction { session, .. }
                    | DomainCommand::Fork { session, .. }
                    | DomainCommand::PrepareFork { session, .. }
                    | DomainCommand::Manage { session, .. }
                    | DomainCommand::SetModel { session, .. }
                    | DomainCommand::SetMode { session, .. }
                    | DomainCommand::PrepareConfiguration { session, .. }
                    | DomainCommand::CommitConfiguration { session }
                    | DomainCommand::Agent { session, .. },
                ..
            } => Some(session.clone()),
            _ => None,
        }
    }
    fn reject(self) {
        match self {
            #[cfg(test)]
            Self::Test { .. } => {}
            Self::Discover { reply, .. } | Self::Command { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            Self::Lookup { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            Self::Query { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            Self::Dispatch { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            #[cfg(test)]
            Self::Deliveries { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            Self::Image { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
        }
    }
}
struct Envelope {
    request: Request,
    permit: OwnedSemaphorePermit,
    fork_lease: Option<super::fork_control::ForkLease>,
}
struct CloseOnExit(Arc<AtomicBool>);
impl Drop for CloseOnExit {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct Lifecycle {
    task: Option<JoinHandle<Outcome>>,
    result: Option<Outcome>,
    recovering: bool,
}
#[derive(Clone)]
pub(super) struct IngressHandle {
    tx: mpsc::Sender<Envelope>,
    pools: [Arc<Semaphore>; 3],
    stop: CancellationToken,
    closed: Arc<AtomicBool>,
    completion: watch::Receiver<Option<Outcome>>,
    lifecycle: Arc<Mutex<Lifecycle>>,
    executions: IngressTasks,
    fork_controls: Arc<super::fork_control::ForkControls>,
    #[cfg(test)]
    root_abort: tokio::task::AbortHandle,
}
pub(super) fn stopping() -> DomainError {
    DomainError::Worker("runtime shutting down".into())
}
pub(super) fn interrupted() -> DomainError {
    DomainError::Worker("owned ingress execution stopped".into())
}
impl IngressHandle {
    pub(super) fn start(core: Arc<CommandCore>) -> Self {
        // Separate control/query reserves remain available when ordinary callers
        // fill all 64 regular slots. Permits bound active plus queued operations.
        let pools = [
            Arc::new(Semaphore::new(64)),
            Arc::new(Semaphore::new(16)),
            Arc::new(Semaphore::new(16)),
        ];
        let (tx, rx) = mpsc::channel(96);
        let stop = CancellationToken::new();
        let run_stop = stop.clone();
        let closed = core.closed.clone();
        let (completion, receiver) = watch::channel(None);
        let executions = Arc::new(Mutex::new(JoinSet::new()));
        let owned = executions.clone();
        let close_on_exit = CloseOnExit(closed.clone());
        let fork_controls = core.fork_controls.clone();
        let task = tokio::spawn(async move {
            let _closed = close_on_exit;
            let result = run(core, rx, run_stop, owned).await;
            completion.send_replace(Some(result.clone()));
            result
        });
        #[cfg(test)]
        let root_abort = task.abort_handle();
        Self {
            tx,
            pools,
            stop,
            closed,
            completion: receiver,
            executions,
            fork_controls,
            #[cfg(test)]
            root_abort,
            lifecycle: Arc::new(Mutex::new(Lifecycle {
                task: Some(task),
                result: None,
                recovering: false,
            })),
        }
    }
    #[cfg(test)]
    pub(super) async fn abort_root(&self) {
        self.root_abort.abort();
    }
    pub(super) fn submit(&self, request: Request) -> Outcome {
        if self.closed.load(Ordering::Acquire) {
            return Err(stopping());
        }
        let permit = self.pools[request.pool()]
            .clone()
            .try_acquire_owned()
            .map_err(|_| DomainError::Backpressure)?;
        let fork_lease = match &request {
            Request::Command {
                operation: Some(operation),
                command: DomainCommand::Fork { session, request },
                ..
            } => Some(self.fork_controls.register(session, operation, request)),
            _ => None,
        };
        self.tx
            .try_send(Envelope {
                request,
                permit,
                fork_lease,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => DomainError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => stopping(),
            })
    }
    pub(super) async fn wait_closed(&self) -> Outcome {
        let mut completion = self.completion.clone();
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            completion.changed().await.map_err(|_| {
                DomainError::Worker("ingress supervisor exited unexpectedly".into())
            })?;
        }
    }
    pub(super) fn close_admission(&self) {
        self.closed.store(true, Ordering::Release);
        self.stop.cancel();
    }
    pub(super) async fn shutdown(&self, core: &Arc<CommandCore>) -> Outcome {
        self.close_admission();
        let mut lifecycle = self.lifecycle.lock().await;
        if let Some(result) = &lifecycle.result {
            return result.clone();
        }
        // Await through the stored handle: cancelling a shutdown caller must not
        // detach the root task or let a later caller release the lease early.
        let result = loop {
            let joined = match lifecycle.task.as_mut() {
                Some(task) => task.await,
                None => break Err(interrupted()),
            };
            lifecycle.task.take();
            match joined {
                Ok(result) => break result,
                Err(_) if !lifecycle.recovering => {
                    // Recovery is itself owned across shutdown caller cancellation.
                    lifecycle.recovering = true;
                    let core = core.clone();
                    let executions = self.executions.clone();
                    lifecycle.task = Some(tokio::spawn(async move {
                        core.emergency_shutdown(&executions).await;
                        Err(DomainError::Worker("ingress supervisor task failed".into()))
                    }));
                }
                Err(_) => {
                    break Err(DomainError::Worker(
                        "ingress emergency cleanup task failed".into(),
                    ))
                }
            }
        };
        lifecycle.result = Some(result.clone());
        result
    }
}

async fn execute(core: Arc<CommandCore>, envelope: Envelope) -> Option<SessionId> {
    let Envelope {
        request,
        permit,
        fork_lease,
    } = envelope;
    let lane = request.lane();
    match request {
        #[cfg(test)]
        Request::Test { job, .. } => job.await,
        Request::Discover { session, reply } => {
            let _ = reply.send(core.discover(session).await);
        }
        Request::Command {
            operation,
            command,
            reply,
        } => {
            let result = match operation {
                Some(operation) => core.execute_journaled(operation, command).await,
                None => core.execute(command).await,
            };
            let _ = reply.send(result);
        }
        Request::Lookup {
            operation,
            command,
            reply,
        } => {
            let result = if core.closed.load(Ordering::Acquire) {
                Err(stopping())
            } else {
                core.journal.lookup(&operation, &command).await
            };
            let _ = reply.send(result);
        }
        Request::Image { image, reply } => {
            let result = if core.closed.load(Ordering::Acquire) {
                Err(stopping())
            } else {
                core.history.payloads.image(&image).await
            };
            let _ = reply.send(result);
        }
        Request::Query { command, reply } => {
            let result = async {
                if core.closed.load(Ordering::Acquire) {
                    return Err(stopping());
                }
                use crate::domain::query::{QueryCommand as Q, QueryResult as R};
                command.validate()?;
                let result = match command {
                    Q::Operation { operation } => {
                        return core.journal.status(operation).await.map(R::Operation);
                    }
                    Q::List { cursor, limit } => {
                        core.database.list(cursor, limit).await.map(R::List)
                    }
                    Q::Inspect { session } => core
                        .database
                        .view(session)
                        .await
                        .map(|view| R::View(Box::new(view))),
                    Q::History {
                        session,
                        cursor,
                        limit,
                    } => core
                        .database
                        .history(session, cursor, limit)
                        .await
                        .map(R::History),
                    Q::Tools {
                        session,
                        turn,
                        cursor,
                        limit,
                    } => core
                        .database
                        .tools(session, turn, cursor, limit)
                        .await
                        .map(R::Tools),
                    Q::Content {
                        r#ref,
                        offset,
                        length,
                    } => core
                        .database
                        .content_slice(r#ref, offset, length)
                        .await
                        .map(R::Content),
                    Q::Attach { session } => core
                        .database
                        .attached(session)
                        .await
                        .map(|attached| R::Attached(Box::new(attached))),
                    Q::Management { query } => {
                        return core
                            .database
                            .management(query)
                            .await
                            .map(R::Management)
                            .map_err(|e| DomainError::Persistence(e.to_string()));
                    }
                    Q::ValidateUndo { session, turn } => {
                        let view = core
                            .database
                            .view(session.clone())
                            .await
                            .map_err(|e| DomainError::Persistence(e.to_string()))?;
                        if view.active_turn.is_some() {
                            return Err(DomainError::Busy);
                        }
                        let diff = core
                            .database
                            .turn_diff(session, turn)
                            .await
                            .map_err(|e| DomainError::Persistence(e.to_string()))?
                            .ok_or_else(|| DomainError::Persistence("No captured diff".into()))?;
                        return tokio::task::spawn_blocking(move || {
                            crate::workspace_undo::undo(
                                std::path::Path::new(view.cwd.as_str()),
                                &diff,
                                true,
                            )
                        })
                        .await
                        .map_err(|_| DomainError::Persistence("Undo preflight interrupted".into()))?
                        .map(R::ValidateUndo)
                        .map_err(DomainError::Persistence);
                    }
                    Q::TurnDiff {
                        session,
                        turn,
                        offset,
                    } => {
                        return core
                            .database
                            .turn_diff_page(session, turn, offset)
                            .await
                            .map(R::TurnDiff)
                            .map_err(|e| DomainError::Persistence(e.to_string()));
                    }
                    Q::TurnDiffContent {
                        session,
                        turn,
                        file,
                        after,
                        offset,
                    } => {
                        return core
                            .database
                            .turn_diff_content(session, turn, file, after, offset)
                            .await
                            .map(R::TurnDiffContent)
                            .map_err(|e| DomainError::Persistence(e.to_string()));
                    }
                    Q::Image { .. } => {
                        return Err(DomainError::Protocol(
                            "image query uses the image response".into(),
                        ))
                    }
                };
                result.map_err(|error| match error {
                    crate::persistence::database::StoreError::NotFound => {
                        DomainError::Protocol("query target not found".into())
                    }
                    crate::persistence::database::StoreError::Query(error) => {
                        DomainError::Query(error)
                    }
                    other => DomainError::Persistence(other.to_string()),
                })
            }
            .await;
            let _ = reply.send(result);
        }
        Request::Dispatch { bot, limit, reply } => {
            let result = if core.closed.load(Ordering::Acquire) {
                Err(stopping())
            } else {
                core.database
                    .dispatch_snapshot(bot, limit)
                    .await
                    .map_err(|error| DomainError::Persistence(error.to_string()))
            };
            let _ = reply.send(result);
        }
        #[cfg(test)]
        Request::Deliveries { now, limit, reply } => {
            let result = async {
                if core.closed.load(Ordering::Acquire) {
                    return Err(stopping());
                }
                // Session state, immutable archives and delivery intent commit atomically.
                core.history.outbox.pending(now, limit).await
            }
            .await;
            let _ = reply.send(result);
        }
    }
    drop(fork_lease);
    drop(permit);
    lane
}
async fn run(
    core: Arc<CommandCore>,
    mut rx: mpsc::Receiver<Envelope>,
    stop: CancellationToken,
    executions: IngressTasks,
) -> Outcome {
    // The set outlives the root task, so root abort/panic does not abort an
    // operation halfway through a journal filesystem commit. Emergency cleanup
    // cancels protocol waits and joins this same set before releasing storage.
    let mut tasks = executions.lock().await;
    let mut lanes: HashMap<SessionId, VecDeque<Envelope>> = HashMap::new();
    let mut failure = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => break,
            result = core.runtime.wait_closed() => { failure = Some(result.err().unwrap_or_else(|| DomainError::Worker("registry exited unexpectedly".into()))); break; },
            completed = tasks.join_next(), if !tasks.is_empty() => match completed {
                Some(Ok(Some(lane))) => {
                    let next = lanes.get_mut(&lane).and_then(VecDeque::pop_front);
                    if let Some(envelope) = next { tasks.spawn(execute(core.clone(), envelope)); }
                    else { lanes.remove(&lane); }
                }
                Some(Err(_)) => { failure = Some(DomainError::Worker("owned ingress task panicked".into())); break; }
                _ => {}
            },
            _ = core.fork_controls.changed.notified() => {
                // Cancellation targets a workflow, not a session state mutation.
                // Cancelled queued forks only seal journal failures; they may
                // bypass a slow earlier mutation without releasing its lane.
                for queue in lanes.values_mut() {
                    let mut retained = VecDeque::new();
                    while let Some(envelope) = queue.pop_front() {
                        if envelope.fork_lease.as_ref().is_some_and(|lease| lease.is_cancelled()) {
                            let core = core.clone();
                            tasks.spawn(async move { execute(core, envelope).await; None });
                        } else { retained.push_back(envelope); }
                    }
                    *queue = retained;
                }
            },
            envelope = rx.recv() => {
                let Some(envelope) = envelope else { break; };
                if envelope.fork_lease.as_ref().is_some_and(|lease| lease.is_cancelled()) {
                    let core = core.clone();
                    tasks.spawn(async move { execute(core, envelope).await; None });
                    continue;
                }
                if let Some(lane) = envelope.request.lane() {
                    if let Some(queue) = lanes.get_mut(&lane) { queue.push_back(envelope); }
                    else { lanes.insert(lane, VecDeque::new()); tasks.spawn(execute(core.clone(), envelope)); }
                } else { tasks.spawn(execute(core.clone(), envelope)); }
            }
        }
    }
    core.closed.store(true, Ordering::Release);
    rx.close();
    while let Some(envelope) = rx.recv().await {
        envelope.request.reject();
    }
    for (_, queue) in lanes {
        for envelope in queue {
            envelope.request.reject();
        }
    }
    // Accepted running tasks retain their receipts. Closing protocol adapters
    // releases pending configure/answer waits; they settle before actors stop.
    core.stop_adapters().await;
    let workers = core.supervisor.shutdown().await;
    core.adapters_stop.cancel();
    core.adapter_tasks.close_and_join().await;
    core.runtime.workers_stopped();
    let actors = drain_commands(&core, &mut tasks).await;
    if let Some(error) = failure {
        return Err(error);
    }
    workers.and(actors)
}

async fn drain_remaining(tasks: &mut JoinSet<Option<SessionId>>) -> Outcome {
    let mut result = Ok(());
    while let Some(completed) = tasks.join_next().await {
        if completed.is_err() {
            result = Err(DomainError::Worker("owned ingress task panicked".into()));
        }
    }
    result
}
pub(super) async fn drain_commands(
    core: &CommandCore,
    tasks: &mut JoinSet<Option<SessionId>>,
) -> Outcome {
    let mut result = Ok(());
    while !tasks.is_empty() {
        tokio::select! {
            completed = tasks.join_next() => { if completed.is_some_and(|completed| completed.is_err()) { result = Err(DomainError::Worker("owned ingress task panicked".into())); } },
            _ = core.runtime.wait_closed() => {
                // A failed Registry needs recovery to deliver IO receipts to
                // these host tasks. Join both; do not create a circular wait.
                let (commands, registry) = tokio::join!(drain_remaining(tasks), core.finish_shutdown());
                return result.and(commands).and(registry);
            }
        }
    }
    result.and(core.finish_shutdown().await)
}
