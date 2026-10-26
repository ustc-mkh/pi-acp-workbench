use crate::{
    domain::{
        command::{AgentEvent, DomainCommand},
        error::DomainError,
        ids::*,
        query::{CommandReceipt, CommitBatch, SessionView},
        reducer::{transition, TransitionContext},
        session::SessionStatus,
    },
    persistence::interface::SessionPersistence,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::{broadcast, mpsc, oneshot};

/// Internal owner result. Only CommandReceipt crosses the mutation wire or
/// journal boundary; batches are published synchronously by the state owner.
#[derive(Clone, Debug)]
pub enum OwnerReply {
    Receipt(CommandReceipt),
    Committed(CommitBatch),
    Answered {
        batch: CommitBatch,
        answer: crate::domain::interaction::InteractionAnswer,
    },
    #[cfg(test)]
    Listed(crate::domain::query::ListPage),
    ForkPrepared(Box<crate::domain::fork::ForkPlan>),
}
impl OwnerReply {
    pub fn view(&self) -> Option<&SessionView> {
        match self {
            Self::Receipt(CommandReceipt::Loaded { view }) => Some(view),
            Self::Committed(batch) | Self::Answered { batch, .. } => batch.view.as_ref(),
            _ => None,
        }
    }
    pub fn receipt(self) -> Result<CommandReceipt, DomainError> {
        match self {
            Self::Receipt(receipt) => Ok(receipt),
            Self::Committed(batch) | Self::Answered { batch, .. } => Ok(CommandReceipt::Accepted {
                session: batch.session,
                revision: batch.revision,
            }),
            _ => Err(DomainError::Protocol(
                "internal query is not a mutation receipt".into(),
            )),
        }
    }
}
type Reply = oneshot::Sender<Result<OwnerReply, DomainError>>;
#[cfg(test)]
#[path = "actor_mailbox_tests.rs"]
mod mailbox_tests;
#[cfg(test)]
#[path = "actor_registry_tests.rs"]
mod registry_tests;
#[derive(Clone)]
pub struct RegistryHandle {
    tx: mpsc::Sender<RegistryCommand>,
}
impl RegistryHandle {
    pub async fn command(&self, command: DomainCommand) -> Result<OwnerReply, DomainError> {
        self.submit(command, None, false).await
    }
    pub(crate) async fn command_with_operation(
        &self,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
    ) -> Result<OwnerReply, DomainError> {
        self.submit(command, operation, true).await
    }
    /// Only the application admission layer may reload an evicted owner.
    pub(crate) async fn command_admitted(
        &self,
        command: DomainCommand,
    ) -> Result<OwnerReply, DomainError> {
        self.command_with_operation(command, None).await
    }
    async fn submit(
        &self,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
        admitted: bool,
    ) -> Result<OwnerReply, DomainError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(RegistryCommand::Command {
                admitted,
                queued: crate::diagnostics::Stamp::now(),
                command,
                operation,
                reply,
            })
            .map_err(registry_send_error)?;
        rx.await
            .map_err(|_| DomainError::Worker("registry request interrupted".into()))?
    }
    pub async fn worker_started(
        &self,
        session: SessionId,
        epoch: u64,
    ) -> Result<OwnerReply, DomainError> {
        self.worker_message(session, epoch, None).await
    }
    pub async fn worker_event(
        &self,
        session: SessionId,
        epoch: u64,
        event: AgentEvent,
    ) -> Result<OwnerReply, DomainError> {
        self.worker_message(session, epoch, Some(event)).await
    }
    async fn worker_message(
        &self,
        session: SessionId,
        epoch: u64,
        event: Option<AgentEvent>,
    ) -> Result<OwnerReply, DomainError> {
        let (reply, wait) = oneshot::channel();
        self.tx
            .try_send(RegistryCommand::Worker {
                queued: crate::diagnostics::Stamp::now(),
                session,
                epoch,
                event,
                reply,
            })
            .map_err(registry_send_error)?;
        wait.await
            .map_err(|_| DomainError::Worker("session actor closed".into()))?
    }
    #[cfg(test)]
    async fn cache_stats(&self) -> (usize, usize, usize) {
        let (reply, wait) = oneshot::channel();
        self.tx
            .send(RegistryCommand::CacheStats(reply))
            .await
            .unwrap_or_else(|_| panic!("registry closed"));
        wait.await.unwrap()
    }
    // Serialized with user commands and worker events by the session owner.
    // Fence events now, but retain physical attachment until the caller joins.
    pub(crate) async fn retire_idle_worker(
        &self,
        session: SessionId,
        epoch: u64,
    ) -> Result<(), DomainError> {
        let (reply, wait) = oneshot::channel();
        self.tx
            .send(RegistryCommand::WorkerStopped {
                session,
                epoch,
                idle_only: true,
                reply,
            })
            .await
            .map_err(|_| DomainError::MailboxClosed)?;
        wait.await.map_err(|_| DomainError::MailboxClosed)??;
        Ok(())
    }
    pub(crate) async fn worker_stopped(&self, session: SessionId, epoch: u64) {
        let (reply, wait) = oneshot::channel();
        if self
            .tx
            .send(RegistryCommand::WorkerStopped {
                session,
                epoch,
                idle_only: false,
                reply,
            })
            .await
            .is_ok()
        {
            let _ = wait.await;
        }
    }
    #[cfg(test)]
    pub async fn shutdown(&self) {
        self.shutdown_checked()
            .await
            .expect("session shutdown persistence failed");
    }
    #[cfg(test)]
    pub async fn shutdown_checked(&self) -> Result<(), DomainError> {
        self.request_shutdown().await
    }
    async fn request_shutdown(&self) -> Result<(), DomainError> {
        let (reply, wait) = oneshot::channel();
        if self
            .tx
            .send(RegistryCommand::Shutdown(reply))
            .await
            .is_err()
        {
            return Ok(());
        }
        wait.await
            .map_err(|_| DomainError::Worker("registry shutdown interrupted".into()))?
    }
}
fn registry_send_error<T>(error: mpsc::error::TrySendError<T>) -> DomainError {
    match error {
        mpsc::error::TrySendError::Full(_) => DomainError::Backpressure,
        mpsc::error::TrySendError::Closed(_) => DomainError::MailboxClosed,
    }
}
enum RegistryCommand {
    #[cfg(test)]
    CacheStats(oneshot::Sender<(usize, usize, usize)>),
    WorkerStopped {
        session: SessionId,
        epoch: u64,
        idle_only: bool,
        reply: Reply,
    },
    Command {
        admitted: bool,
        queued: crate::diagnostics::Stamp,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply,
    },
    Worker {
        queued: crate::diagnostics::Stamp,
        session: SessionId,
        epoch: u64,
        event: Option<AgentEvent>,
        reply: Reply,
    },
    Shutdown(oneshot::Sender<Result<(), DomainError>>),
}
#[path = "actor_registry.rs"]
mod registry;
#[path = "actor_runtime.rs"]
mod runtime;
pub use runtime::Runtime;
fn forward(
    command: DomainCommand,
    operation: Option<crate::domain::operation::OperationTicket>,
    id: &SessionId,
    reply: Reply,
    sessions: &BTreeMap<SessionId, mpsc::Sender<OwnerEnvelope>>,
    activities: &BTreeMap<SessionId, Arc<OwnerActivity>>,
) {
    enqueue(
        SessionCommand::Command {
            queued: crate::diagnostics::Stamp::now(),
            command,
            operation,
            reply,
        },
        id,
        sessions,
        activities,
    );
}
fn enqueue(
    message: SessionCommand,
    id: &SessionId,
    sessions: &BTreeMap<SessionId, mpsc::Sender<OwnerEnvelope>>,
    activities: &BTreeMap<SessionId, Arc<OwnerActivity>>,
) {
    let Some(sender) = sessions.get(id) else {
        message.reject(DomainError::NotFound(id.clone()));
        return;
    };
    let in_flight = activities.get(id).map(|activity| {
        activity.pending.fetch_add(1, Ordering::AcqRel);
        activity.touch();
        InFlight(activity.clone())
    });
    if let Err(error) = sender.try_send(OwnerEnvelope {
        request: message,
        in_flight,
    }) {
        let failure = if matches!(error, mpsc::error::TrySendError::Full(_)) {
            DomainError::Backpressure
        } else {
            DomainError::MailboxClosed
        };
        error.into_inner().reject(failure);
    }
}
#[derive(Default)]
struct OwnerActivity {
    pending: AtomicUsize,
    idle: AtomicBool,
    touched: AtomicU64,
}
impl OwnerActivity {
    fn touch(&self) {
        static CLOCK: AtomicU64 = AtomicU64::new(1);
        self.touched
            .store(CLOCK.fetch_add(1, Ordering::Relaxed), Ordering::Relaxed);
    }
}
struct InFlight(Arc<OwnerActivity>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::AcqRel);
    }
}
struct OwnerEnvelope {
    request: SessionCommand,
    in_flight: Option<InFlight>,
}
impl OwnerEnvelope {
    fn untracked(request: SessionCommand) -> Self {
        Self {
            request,
            in_flight: None,
        }
    }
    fn reject(self, error: DomainError) {
        self.request.reject(error);
    }
}
fn cacheable(state: &SessionView, epoch: Option<u64>) -> bool {
    epoch.is_none()
        && matches!(state.status, SessionStatus::Idle | SessionStatus::Failed(_))
        && state.active_turn.is_none()
        && state.pending_interactions.is_empty()
        && state.configuration_intent.is_none()
}
enum SessionCommand {
    WorkerStopped {
        epoch: u64,
        idle_only: bool,
        reply: Reply,
    },
    Command {
        queued: crate::diagnostics::Stamp,
        command: DomainCommand,
        operation: Option<crate::domain::operation::OperationTicket>,
        reply: Reply,
    },
    Worker {
        queued: crate::diagnostics::Stamp,
        epoch: u64,
        event: Option<AgentEvent>,
        reply: Reply,
    },
    Shutdown(oneshot::Sender<Result<(), DomainError>>),
}
impl SessionCommand {
    fn reject(self, error: DomainError) {
        if let Self::Command { reply, .. }
        | Self::Worker { reply, .. }
        | Self::WorkerStopped { reply, .. } = self
        {
            let _ = reply.send(Err(error));
        }
    }
}
fn accepted(view: &SessionView) -> OwnerReply {
    OwnerReply::Receipt(CommandReceipt::Accepted {
        session: view.id.clone(),
        revision: view.revision,
    })
}
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
async fn commit_command(
    state: &mut SessionView,
    command: DomainCommand,
    operation: Option<crate::domain::operation::OperationTicket>,
    store: &impl SessionPersistence,
    events: &broadcast::Sender<CommitBatch>,
) -> Result<OwnerReply, DomainError> {
    // Read only the requested tool header, and only after scope/turn fencing.
    // No old body is materialized by either this read or a status-only patch.
    let _local_fence = match &command {
        DomainCommand::Prompt { .. } => {
            Some(crate::diagnostics::Span::new("owner_prompt_durable_fence"))
        }
        DomainCommand::RequestCancel { .. } => {
            Some(crate::diagnostics::Span::new("owner_cancel_durable_fence"))
        }
        _ => None,
    };
    let old_tool = match &command {
        DomainCommand::Agent {
            session,
            event: AgentEvent::ToolCall(update),
        } if session == &state.id
            && state.active_turn.as_ref() == Some(&update.turn)
            && !matches!(state.status, SessionStatus::Cancelling) =>
        {
            store
                .tool(&state.id, &update.turn, &update.id)
                .await
                .map_err(DomainError::Persistence)?
        }
        _ => None,
    };
    let context = TransitionContext {
        tool: old_tool.as_ref(),
    };
    let now = unix_now();
    let answer = match &command {
        DomainCommand::AnswerInteraction { answer, .. } => Some(
            state
                .pending_interactions
                .get(&answer.interaction)
                .ok_or(DomainError::InteractionNotFound)?
                .validate_answer(answer.clone(), now)?,
        ),
        _ => None,
    };
    let Some(mut change) = transition(state, command, &context, now)? else {
        let receipt = CommandReceipt::Accepted {
            session: state.id.clone(),
            revision: state.revision,
        };
        if let Some(ticket) = operation {
            store
                .receipt_only(ticket, receipt.clone())
                .await
                .map_err(DomainError::Persistence)?;
        }
        return Ok(OwnerReply::Receipt(receipt));
    };
    for intent in &mut change.deliveries {
        if let crate::domain::transition::DeliveryPayload::Input { origin, .. } =
            &mut intent.payload
        {
            *origin = operation.as_ref().map(|ticket| ticket.operation.clone());
        }
    }
    change.operation = operation;
    let next = change.next.clone();
    let _commit_span = crate::diagnostics::Span::new("owner_store_commit");
    let batch = store
        .commit(change)
        .await
        .map_err(DomainError::Persistence)?;
    *state = next;
    // No await or next mailbox message can interleave between commit and send.
    let _ = events.send(batch.clone());
    Ok(match answer {
        Some(answer) => OwnerReply::Answered { batch, answer },
        None => OwnerReply::Committed(batch),
    })
}
async fn session_loop(
    mut state: SessionView,
    mut rx: mpsc::Receiver<OwnerEnvelope>,
    store: impl SessionPersistence,
    events: broadcast::Sender<CommitBatch>,
) {
    let mut worker_epoch = None;
    // Cancellation fences events immediately; physical attachment stays pinned until join.
    let mut attached_epoch = None;
    while let Some(envelope) = rx.recv().await {
        let OwnerEnvelope {
            request: message,
            in_flight,
        } = envelope;
        // Pending includes this execution until the final idle snapshot is published.
        macro_rules! snapshot {
            () => {
                if let Some(guard) = &in_flight {
                    guard
                        .0
                        .idle
                        .store(cacheable(&state, attached_epoch), Ordering::Release);
                }
            };
        }

        let (command, reply, operation) = match message {
            SessionCommand::WorkerStopped {
                epoch,
                idle_only,
                reply,
            } => {
                if idle_only
                    && (worker_epoch != Some(epoch)
                        || state.active_turn.is_some()
                        || !state.pending_interactions.is_empty()
                        || state.configuration_intent.is_some())
                {
                    snapshot!();
                    let _ = reply.send(Err(DomainError::Busy));
                    continue;
                }
                if worker_epoch == Some(epoch) {
                    worker_epoch = None;
                }
                if !idle_only && attached_epoch == Some(epoch) {
                    attached_epoch = None;
                }
                snapshot!();
                let _ = reply.send(Ok(accepted(&state)));
                continue;
            }
            SessionCommand::Command {
                queued,
                command,
                operation,
                reply,
            } => {
                queued.finish("owner_queue");
                (command, reply, operation)
            }
            SessionCommand::Worker {
                queued,
                epoch,
                event: None,
                reply,
            } => {
                queued.finish("owner_queue");
                let result = if matches!(state.status, SessionStatus::Cancelling)
                    || epoch == 0
                    || attached_epoch.is_some_and(|current| epoch < current)
                {
                    Err(DomainError::Worker("obsolete worker attachment".into()))
                } else {
                    worker_epoch = Some(epoch);
                    attached_epoch = Some(epoch);
                    Ok(accepted(&state))
                };
                let _ = reply.send(result);
                snapshot!();
                continue;
            }
            SessionCommand::Worker {
                queued,
                epoch,
                event: Some(event),
                reply,
            } => {
                queued.finish("owner_queue");
                if worker_epoch != Some(epoch) {
                    let _ = reply.send(Ok(accepted(&state)));
                    snapshot!();
                    continue;
                }
                (
                    DomainCommand::Agent {
                        session: state.id.clone(),
                        event,
                    },
                    reply,
                    None,
                )
            }
            SessionCommand::Shutdown(reply) => {
                let result = if state.active_turn.is_some() {
                    let command = DomainCommand::Cancel {
                        session: state.id.clone(),
                    };
                    commit_command(&mut state, command, None, &store, &events)
                        .await
                        .map(|_| ())
                } else {
                    Ok(())
                };
                let _ = reply.send(result);
                break;
            }
        };
        if let DomainCommand::PrepareFork {
            request,
            candidates,
            ..
        } = command
        {
            let result = store
                .prepare_fork(&state, request, candidates)
                .await
                .map(|plan| OwnerReply::ForkPrepared(Box::new(plan)))
                .map_err(DomainError::Persistence);
            let _ = reply.send(result);
            snapshot!();
            continue;
        }
        if matches!(command, DomainCommand::Inspect(_)) {
            let _ = reply.send(Ok(OwnerReply::Receipt(CommandReceipt::Loaded {
                view: Box::new(state.clone()),
            })));
            snapshot!();
            continue;
        }
        let invalidate_worker = matches!(
            &command,
            DomainCommand::Cancel { .. }
                | DomainCommand::RequestCancel { .. }
                | DomainCommand::Agent {
                    event: AgentEvent::Crashed { .. },
                    ..
                }
        );
        let result = commit_command(&mut state, command, operation, &store, &events).await;
        if result.is_ok() && invalidate_worker {
            worker_epoch = None;
        }
        snapshot!();
        let _ = reply.send(result);
    }
}
