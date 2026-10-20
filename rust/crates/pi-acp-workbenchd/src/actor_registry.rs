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
pub(super) type Shared = Arc<Mutex<RegistryState>>;
pub(super) struct RegistryState {
    sessions: BTreeMap<SessionId, mpsc::Sender<SessionCommand>>,
    actors: JoinSet<()>,
    stopping: JoinSet<Outcome>,
    io: JoinSet<Completion>,
    lanes: BTreeMap<
        SessionId,
        VecDeque<(
            DomainCommand,
            Option<crate::domain::operation::OperationTicket>,
            Reply,
        )>,
    >,
    events: broadcast::Sender<CommitBatch>,
}
struct Completion {
    lane: Option<SessionId>,
    effect: Effect,
}
enum Effect {
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
        let queue = completion
            .lane
            .and_then(|id| self.lanes.remove(&id))
            .unwrap_or_default();
        match completion.effect {
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
        for (command, operation, reply) in queue {
            if closing {
                let _ = reply.send(Err(stopping()));
            } else {
                self.route(command, operation, reply, store, mailbox);
            }
        }
    }
    fn spawn(&mut self, state: SessionView, store: &impl SessionPersistence, mailbox: usize) {
        let (tx, rx) = mpsc::channel(mailbox);
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
                    .push_back((command, operation, reply));
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
                forward(other, operation, &id, reply, &self.sessions);
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
            for (_, _, reply) in queue {
                let _ = reply.send(Err(stopping()));
            }
        }
        // Physical providers must be joined before publishing terminal intentions.
        if let Some(permit) = workers_stopped {
            permit.cancelled().await;
        }
        for (_, sender) in std::mem::take(&mut self.sessions) {
            self.stopping.spawn(stop_actor(sender));
        }
        while let Some(result) = self.stopping.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => outcome = Err(error),
                Err(_) => outcome = Err(DomainError::Worker("actor shutdown task failed".into())),
            }
        }
        while self.actors.join_next().await.is_some() {}
        outcome
    }
}
async fn stop_actor(sender: mpsc::Sender<SessionCommand>) -> Outcome {
    let (reply, wait) = oneshot::channel();
    if sender.send(SessionCommand::Shutdown(reply)).await.is_err() {
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
        tokio::select! {
            biased;
            result = state.io.join_next(), if !state.io.is_empty() => match result {
                Some(Ok(result)) => state.reply(result, &store, mailbox, false),
                Some(Err(_)) => { failure = Some(panic_error()); break; }, None => {},
            },
            _ = state.actors.join_next(), if !state.actors.is_empty() => { state.sessions.retain(|_, sender| !sender.is_closed()); },
            message = rx.recv() => match message {
                Some(RegistryCommand::Command { command, operation, reply }) => state.route(command, operation, reply, &store, mailbox),
                Some(RegistryCommand::Worker { session, epoch, event, reply }) => enqueue(SessionCommand::Worker { epoch, event, reply }, &session, &state.sessions),
                Some(RegistryCommand::Shutdown(reply)) => { shutdown_reply = Some(reply); break; }, None => break,
            },
        }
    }
    rx.close();
    while let Some(message) = rx.recv().await {
        match message {
            RegistryCommand::Command { reply, .. } | RegistryCommand::Worker { reply, .. } => {
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
