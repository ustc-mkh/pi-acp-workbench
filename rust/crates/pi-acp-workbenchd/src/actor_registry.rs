//! Registry owns routing/lifecycle metadata, never historical session contents.
//! Store futures are bounded owned jobs, not awaits inside the routing loop.
use super::*;
use std::{collections::VecDeque, sync::Arc};
use tokio::{
    sync::{watch, Mutex},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
type Outcome = Result<(), DomainError>;
const MAX_IO: usize = 16;
const IDLE_OWNER_BUDGET: usize = 64;
pub(super) type Shared = Arc<Mutex<RegistryState>>;
pub(super) struct RegistryState {
    sessions: BTreeMap<SessionId, mpsc::Sender<OwnerEnvelope>>,
    activities: BTreeMap<SessionId, Arc<OwnerActivity>>,
    actors: JoinSet<()>,
    stopping: JoinSet<Outcome>,
    io: JoinSet<Completion>,
    lanes: BTreeMap<SessionId, VecDeque<Pending>>,
    events: broadcast::Sender<CommitBatch>,
}
enum Pending {
    Command(
        Box<DomainCommand>,
        Option<crate::domain::operation::OperationTicket>,
        Reply,
        bool,
    ),
    StartWorker(u64, Reply),
}
impl Pending {
    fn reject(self) {
        let reply = match self {
            Self::Command(_, _, reply, _) | Self::StartWorker(_, reply) => reply,
        };
        let _ = reply.send(Err(stopping()));
    }
}
struct Completion {
    lane: Option<SessionId>,
    effect: Effect,
}
enum Effect {
    StartWorker {
        state: Box<SessionView>,
        epoch: u64,
        reply: Reply,
    },
    Activate {
        state: Box<SessionView>,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply,
    },
    Ready {
        state: Box<SessionView>,
        result: OwnerReply,
        reply: Reply,
    },
    Reply {
        result: Result<OwnerReply, DomainError>,
        reply: Reply,
    },
}
fn stopping() -> DomainError {
    DomainError::Worker("registry shutting down".into())
}
fn panic_error() -> DomainError {
    DomainError::Worker("registry storage task panicked".into())
}
impl RegistryState {
    pub(super) fn new(events: broadcast::Sender<CommitBatch>) -> Self {
        Self {
            sessions: BTreeMap::new(),
            activities: BTreeMap::new(),
            actors: JoinSet::new(),
            stopping: JoinSet::new(),
            io: JoinSet::new(),
            lanes: BTreeMap::new(),
            events,
        }
    }
    fn reply(
        &mut self,
        completion: Completion,
        store: &impl SessionPersistence,
        mailbox: usize,
        closing: bool,
    ) {
        let lane = completion.lane;
        let queue = lane
            .as_ref()
            .and_then(|id| self.lanes.remove(id))
            .unwrap_or_default();
        match completion.effect {
            Effect::StartWorker {
                state,
                epoch,
                reply,
            } => {
                if closing {
                    let _ = reply.send(Err(stopping()));
                } else {
                    let id = state.id.clone();
                    self.spawn(*state, store, mailbox);
                    self.start_worker(id, epoch, reply, store, mailbox);
                }
            }
            Effect::Activate {
                state,
                command,
                operation,
                reply,
            } => {
                if closing {
                    let _ = reply.send(Err(stopping()));
                } else {
                    self.spawn(*state, store, mailbox);
                    self.route(command, operation, reply, store, mailbox, true);
                }
            }
            Effect::Ready {
                state,
                result,
                reply,
            } => {
                if !closing {
                    self.spawn(*state, store, mailbox);
                }
                let _ = reply.send(Ok(result));
            }
            Effect::Reply { result, reply } => {
                let _ = reply.send(result);
            }
        }
        for pending in queue {
            if closing {
                pending.reject();
            } else {
                match pending {
                    Pending::Command(command, operation, reply, admitted) => {
                        self.route(*command, operation, reply, store, mailbox, admitted)
                    }
                    Pending::StartWorker(epoch, reply) => self.start_worker(
                        lane.clone().expect("reserved worker lane"),
                        epoch,
                        reply,
                        store,
                        mailbox,
                    ),
                }
            }
        }
    }
    fn start_worker(
        &mut self,
        session: SessionId,
        epoch: u64,
        reply: Reply,
        store: &impl SessionPersistence,
        mailbox: usize,
    ) {
        if self.lanes.contains_key(&session) {
            if self.lanes.values().map(VecDeque::len).sum::<usize>() >= mailbox {
                let _ = reply.send(Err(DomainError::Backpressure));
            } else {
                self.lanes
                    .get_mut(&session)
                    .expect("reserved lane")
                    .push_back(Pending::StartWorker(epoch, reply));
            }
        } else if self.sessions.get(&session).is_some_and(|s| !s.is_closed()) {
            enqueue(
                SessionCommand::Worker {
                    queued: crate::diagnostics::Stamp::now(),
                    epoch,
                    event: None,
                    reply,
                },
                &session,
                &self.sessions,
                &self.activities,
            );
        } else if self.io.len() >= MAX_IO {
            let _ = reply.send(Err(DomainError::Backpressure));
        } else {
            let store = store.clone();
            let events = self.events.clone();
            self.lanes.insert(session.clone(), VecDeque::new());
            self.io.spawn(async move {
                let effect = match load(&store, &session, &events).await {
                    Ok(state) => Effect::StartWorker {
                        state: Box::new(state),
                        epoch,
                        reply,
                    },
                    Err(error) => Effect::Reply {
                        result: Err(error),
                        reply,
                    },
                };
                Completion {
                    lane: Some(session),
                    effect,
                }
            });
        }
    }

    fn spawn(&mut self, state: SessionView, store: &impl SessionPersistence, mailbox: usize) {
        // Only the registry enqueues owner messages. Pending is incremented
        // before send and released after an owner publishes its idle snapshot.
        // Closing an eligible sender cannot race an accepted mutation.
        while self.sessions.len() >= IDLE_OWNER_BUDGET {
            let victim = self
                .activities
                .iter()
                .filter(|(id, a)| {
                    !self.lanes.contains_key(*id)
                        && a.pending.load(Ordering::Acquire) == 0
                        && a.idle.load(Ordering::Acquire)
                })
                .min_by_key(|(_, a)| a.touched.load(Ordering::Relaxed))
                .map(|(id, _)| id.clone());
            let Some(id) = victim else {
                break;
            }; // Busy/pinned owners are never evicted to satisfy the cache target.
            self.activities.remove(&id);
            self.sessions.remove(&id); // recv drains and exits; JoinSet still owns the physical join.
        }
        let (tx, rx) = mpsc::channel(mailbox);
        let activity = Arc::new(OwnerActivity::default());
        activity.touch();
        activity
            .idle
            .store(cacheable(&state, None), Ordering::Release);
        self.activities.insert(state.id.clone(), activity);
        self.sessions.insert(state.id.clone(), tx);
        self.actors
            .spawn(session_loop(state, rx, store.clone(), self.events.clone()));
    }
    fn route(
        &mut self,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply,
        store: &impl SessionPersistence,
        mailbox: usize,
        admitted: bool,
    ) {
        let lane = match &command {
            DomainCommand::LoadSession(id) | DomainCommand::RemoveSession(id) => Some(id),
            DomainCommand::Prompt { session, .. }
            | DomainCommand::Cancel { session }
            | DomainCommand::RequestCancel { session }
            | DomainCommand::AnswerInteraction { session, .. }
            | DomainCommand::Fork { session, .. }
            | DomainCommand::PrepareFork { session, .. }
            | DomainCommand::SetModel { session, .. }
            | DomainCommand::SetMode { session, .. }
            | DomainCommand::SetOption { session, .. }
            | DomainCommand::PrepareConfiguration { session, .. }
            | DomainCommand::CommitConfiguration { session }
            | DomainCommand::Agent { session, .. } => Some(session),
            _ => None,
        };
        if lane.is_some_and(|id| self.lanes.contains_key(id)) {
            let queued: usize = self.lanes.values().map(VecDeque::len).sum();
            if queued >= mailbox {
                let _ = reply.send(Err(DomainError::Backpressure));
            } else {
                self.lanes
                    .get_mut(lane.unwrap())
                    .expect("reserved lane")
                    .push_back(Pending::Command(
                        Box::new(command),
                        operation,
                        reply,
                        admitted,
                    ));
            }
            return;
        }
        match command {
            #[cfg(test)]
            DomainCommand::CreateSession { harness, cwd } => {
                if self.io.len() >= MAX_IO {
                    let _ = reply.send(Err(DomainError::Backpressure));
                    return;
                }
                let store = store.clone();
                let state = SessionView::new(harness, cwd);
                let id = state.id.clone();
                self.lanes.insert(id.clone(), VecDeque::new());
                self.io.spawn(async move {
                    let effect = match store.create(&state).await {
                        Ok(summary) => Effect::Ready {
                            result: OwnerReply::Receipt(CommandReceipt::Created { summary }),
                            state: Box::new(state),
                            reply,
                        },
                        Err(error) => Effect::Reply {
                            result: Err(DomainError::Persistence(error)),
                            reply,
                        },
                    };
                    Completion {
                        lane: Some(id),
                        effect,
                    }
                });
            }
            #[cfg(test)]
            DomainCommand::ListSessions => {
                if self.io.len() >= MAX_IO {
                    let _ = reply.send(Err(DomainError::Backpressure));
                    return;
                }
                let store = store.clone();
                self.io.spawn(async move {
                    let result = store
                        .list(None, None)
                        .await
                        .map(OwnerReply::Listed)
                        .map_err(DomainError::Persistence);
                    Completion {
                        lane: None,
                        effect: Effect::Reply { result, reply },
                    }
                });
            }
            DomainCommand::Inspect(id) | DomainCommand::LoadSession(id)
                if self
                    .sessions
                    .get(&id)
                    .is_some_and(|sender| !sender.is_closed()) =>
            {
                forward(
                    DomainCommand::Inspect(id.clone()),
                    operation,
                    &id,
                    reply,
                    &self.sessions,
                    &self.activities,
                );
            }
            command @ (DomainCommand::AdoptFork { .. }
            | DomainCommand::LoadSession(_)
            | DomainCommand::RemoveSession(_)
            | DomainCommand::Inspect(_)) => {
                if self.io.len() >= MAX_IO {
                    let _ = reply.send(Err(DomainError::Backpressure));
                    return;
                }
                let store = store.clone();
                let events = self.events.clone();
                match command {
                    DomainCommand::AdoptFork { projection, native } => {
                        let id = projection.new_session_id.clone();
                        if self.sessions.contains_key(&id) || self.lanes.contains_key(&id) {
                            let _ = reply.send(Err(DomainError::OperationConflict));
                            return;
                        }
                        self.lanes.insert(id.clone(), VecDeque::new());
                        self.io.spawn(async move {
                            let effect = match store.adopt_fork(*projection, native).await {
                                Ok((view, summary)) => Effect::Ready {
                                    state: Box::new(view),
                                    result: OwnerReply::Receipt(CommandReceipt::Forked { summary }),
                                    reply,
                                },
                                Err(error) => Effect::Reply {
                                    result: Err(DomainError::Persistence(error)),
                                    reply,
                                },
                            };
                            Completion {
                                lane: Some(id),
                                effect,
                            }
                        });
                    }
                    DomainCommand::LoadSession(id) => {
                        self.lanes.insert(id.clone(), VecDeque::new());
                        self.io.spawn(async move {
                            let effect = match load(&store, &id, &events).await {
                                Ok(state) => Effect::Ready {
                                    result: OwnerReply::Receipt(CommandReceipt::Loaded {
                                        view: Box::new(state.clone()),
                                    }),
                                    state: Box::new(state),
                                    reply,
                                },
                                Err(error) => Effect::Reply {
                                    result: Err(error),
                                    reply,
                                },
                            };
                            Completion {
                                lane: Some(id),
                                effect,
                            }
                        });
                    }
                    DomainCommand::RemoveSession(id) => {
                        self.lanes.insert(id.clone(), VecDeque::new());
                        let sender = self.sessions.remove(&id);
                        self.activities.remove(&id);
                        self.io.spawn(async move {
                            let result = async {
                                // Accepted writes and cancellation drain before unlinking.
                                if let Some(sender) = sender {
                                    stop_actor(sender).await?;
                                }
                                let terminal = store
                                    .remove(&id, operation)
                                    .await
                                    .map_err(DomainError::Persistence)?;
                                let _ = events.send(terminal);
                                Ok(OwnerReply::Receipt(CommandReceipt::Removed {
                                    session: id.clone(),
                                }))
                            }
                            .await;
                            Completion {
                                lane: Some(id),
                                effect: Effect::Reply { result, reply },
                            }
                        });
                    }
                    DomainCommand::Inspect(id) => {
                        self.io.spawn(async move {
                            let result = match store.load(&id).await {
                                Ok(Some(state)) => {
                                    Ok(OwnerReply::Receipt(CommandReceipt::Loaded {
                                        view: Box::new(state),
                                    }))
                                }
                                Ok(None) => Err(DomainError::NotFound(id)),
                                Err(error) => Err(DomainError::Persistence(error)),
                            };
                            Completion {
                                lane: None,
                                effect: Effect::Reply { result, reply },
                            }
                        });
                    }
                    _ => unreachable!(),
                }
            }
            other => {
                let id = match &other {
                    DomainCommand::Prompt { session, .. }
                    | DomainCommand::Cancel { session }
                    | DomainCommand::RequestCancel { session }
                    | DomainCommand::AnswerInteraction { session, .. }
                    | DomainCommand::Fork { session, .. }
                    | DomainCommand::PrepareFork { session, .. }
                    | DomainCommand::SetModel { session, .. }
                    | DomainCommand::SetMode { session, .. }
                    | DomainCommand::SetOption { session, .. }
                    | DomainCommand::PrepareConfiguration { session, .. }
                    | DomainCommand::CommitConfiguration { session }
                    | DomainCommand::Agent { session, .. } => session.clone(),
                    _ => {
                        let _ = reply.send(Err(DomainError::Protocol(
                            "command must pass host admission".into(),
                        )));
                        return;
                    }
                };
                if self
                    .sessions
                    .get(&id)
                    .is_none_or(|sender| sender.is_closed())
                {
                    if !admitted {
                        let _ = reply.send(Err(DomainError::NotFound(id)));
                        return;
                    }
                    if self.io.len() >= MAX_IO {
                        let _ = reply.send(Err(DomainError::Backpressure));
                        return;
                    }
                    let store = store.clone();
                    let events = self.events.clone();
                    self.lanes.insert(id.clone(), VecDeque::new());
                    self.io.spawn(async move {
                        let effect = match load(&store, &id, &events).await {
                            Ok(state) => Effect::Activate {
                                state: Box::new(state),
                                command: other,
                                operation,
                                reply,
                            },
                            Err(error) => Effect::Reply {
                                result: Err(error),
                                reply,
                            },
                        };
                        Completion {
                            lane: Some(id),
                            effect,
                        }
                    });
                } else {
                    forward(
                        other,
                        operation,
                        &id,
                        reply,
                        &self.sessions,
                        &self.activities,
                    );
                }
            }
        }
    }
    async fn drain(
        &mut self,
        store: &impl SessionPersistence,
        mailbox: usize,
        workers_stopped: Option<&CancellationToken>,
    ) -> Outcome {
        let mut outcome = Ok(());
        // Never abort an accepted transaction, even when its observer/root dies.
        while let Some(result) = self.io.join_next().await {
            match result {
                Ok(completion) => self.reply(completion, store, mailbox, true),
                Err(_) => outcome = Err(panic_error()),
            }
        }
        for (_, queue) in std::mem::take(&mut self.lanes) {
            for pending in queue {
                pending.reject();
            }
        }
        // Physical providers must be joined before publishing terminal intentions.
        if let Some(permit) = workers_stopped {
            permit.cancelled().await;
        }
        for (_, sender) in std::mem::take(&mut self.sessions) {
            self.stopping.spawn(stop_actor(sender));
        }
        crate::diagnostics::gauge("registry_stopping_tasks", self.stopping.len());
        while let Some(result) = self.stopping.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => outcome = Err(error),
                Err(_) => outcome = Err(DomainError::Worker("actor shutdown task failed".into())),
            }
        }
        while self.actors.join_next().await.is_some() {}
        self.activities.clear();
        outcome
    }
}
async fn stop_actor(sender: mpsc::Sender<OwnerEnvelope>) -> Outcome {
    let (reply, wait) = oneshot::channel();
    if sender
        .send(OwnerEnvelope::untracked(SessionCommand::Shutdown(reply)))
        .await
        .is_err()
    {
        return Ok(());
    }
    wait.await
        .map_err(|_| DomainError::Worker("session shutdown interrupted".into()))?
}
async fn load(
    store: &impl SessionPersistence,
    id: &SessionId,
    events: &broadcast::Sender<CommitBatch>,
) -> Result<SessionView, DomainError> {
    let mut state = store
        .load(id)
        .await
        .map_err(DomainError::Persistence)?
        .ok_or_else(|| DomainError::NotFound(id.clone()))?;
    if state.active_turn.is_some() {
        let command = if matches!(state.status, SessionStatus::Cancelling) {
            DomainCommand::Cancel {
                session: id.clone(),
            }
        } else {
            DomainCommand::Agent {
                session: id.clone(),
                event: AgentEvent::Crashed {
                    reason: "daemon restarted during active turn".into(),
                },
            }
        };
        commit_command(&mut state, command, None, store, events).await?;
    }
    Ok(state)
}
pub(super) async fn run(
    mut rx: mpsc::Receiver<RegistryCommand>,
    store: impl SessionPersistence,
    mailbox: usize,
    shared: Shared,
    completion: watch::Sender<Option<Outcome>>,
    workers_stopped: CancellationToken,
) -> Outcome {
    let mut owned = shared.lock().await;
    let state = &mut *owned;
    let mut shutdown_reply = None;
    let mut failure = None;
    loop {
        // Drain finished handles on every iteration: a continuously ready IO
        // lane must not retain an unbounded tail of already retired tasks.
        while state.actors.try_join_next().is_some() {}
        state.sessions.retain(|_, sender| !sender.is_closed());
        state
            .activities
            .retain(|id, _| state.sessions.contains_key(id));
        if crate::diagnostics::enabled() {
            crate::diagnostics::gauge("owners", state.sessions.len());
            crate::diagnostics::gauge("owner_tasks", state.actors.len());
            crate::diagnostics::gauge("registry_io_tasks", state.io.len());
            crate::diagnostics::gauge("registry_stopping_tasks", state.stopping.len());
            crate::diagnostics::gauge("registry_queue", rx.len());
            crate::diagnostics::gauge(
                "owner_queue_total",
                state
                    .sessions
                    .values()
                    .map(|s| s.max_capacity() - s.capacity())
                    .sum(),
            );
            crate::diagnostics::gauge(
                "registry_lane_queue",
                state.lanes.values().map(VecDeque::len).sum(),
            );
        }
        tokio::select! {
            biased;
            result = state.io.join_next(), if !state.io.is_empty() => match result {
                Some(Ok(result)) => state.reply(result, &store, mailbox, false),
                Some(Err(_)) => { failure = Some(panic_error()); break; }, None => {},
            },
            _ = state.actors.join_next(), if !state.actors.is_empty() => { state.sessions.retain(|_, sender| !sender.is_closed()); state.activities.retain(|id,_| state.sessions.contains_key(id)); },
            message = rx.recv() => match message {
                #[cfg(test)]
                Some(RegistryCommand::CacheStats(reply)) => {let _=reply.send((state.sessions.len(),state.actors.len(),state.activities.values().map(|a|a.pending.load(Ordering::Acquire)).sum::<usize>() + state.lanes.values().map(VecDeque::len).sum::<usize>()));},
                Some(RegistryCommand::Command { admitted, queued, command, operation, reply }) => { queued.finish("registry_queue"); state.route(command, operation, reply, &store, mailbox, admitted) },
                Some(RegistryCommand::Worker { queued, session, epoch, event, reply }) => {
                    queued.finish("registry_queue");
                    if event.is_none() { state.start_worker(session,epoch,reply,&store,mailbox); }
                    else { enqueue(SessionCommand::Worker {queued:crate::diagnostics::Stamp::now(),epoch,event,reply}, &session,&state.sessions,&state.activities); }
                },
                Some(RegistryCommand::WorkerStopped {session,epoch,reply}) => enqueue(SessionCommand::WorkerStopped {epoch,reply}, &session, &state.sessions, &state.activities),
                Some(RegistryCommand::Shutdown(reply)) => { shutdown_reply = Some(reply); break; }, None => break,
            },
        }
    }
    rx.close();
    while let Some(message) = rx.recv().await {
        match message {
            #[cfg(test)]
            RegistryCommand::CacheStats(reply) => {
                let _ = reply.send((state.sessions.len(), state.actors.len(), 0));
            }
            RegistryCommand::Command { reply, .. }
            | RegistryCommand::Worker { reply, .. }
            | RegistryCommand::WorkerStopped { reply, .. } => {
                let _ = reply.send(Err(stopping()));
            }
            RegistryCommand::Shutdown(reply) => {
                let _ = reply.send(Err(stopping()));
            }
        }
    }
    if let Some(error) = &failure {
        completion.send_replace(Some(Err(error.clone())));
    }
    let drained = state
        .drain(&store, mailbox, failure.as_ref().map(|_| &workers_stopped))
        .await;
    crate::diagnostics::gauge("owners", state.sessions.len());
    crate::diagnostics::gauge("owner_tasks", state.actors.len());
    for label in [
        "owner_queue_total",
        "registry_io_tasks",
        "registry_stopping_tasks",
        "registry_lane_queue",
        "registry_queue",
    ] {
        crate::diagnostics::gauge(label, 0);
    }
    let result = failure.map_or(drained, Err);
    if let Some(reply) = shutdown_reply {
        let _ = reply.send(result.clone());
    }
    completion.send_replace(Some(result.clone()));
    result
}
pub(super) async fn recover(
    shared: Shared,
    store: impl SessionPersistence,
    mailbox: usize,
) -> Outcome {
    shared.lock().await.drain(&store, mailbox, None).await
}
