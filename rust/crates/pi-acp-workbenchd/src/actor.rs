use crate::{
    domain::{
        command::{AgentEvent, DomainCommand},
        error::DomainError,
        ids::*,
        query::{CommandReceipt, CommitBatch, ListPage, SessionView},
        reducer::{transition, TransitionContext},
        session::SessionStatus,
    },
    persistence::interface::SessionPersistence,
};
use std::collections::BTreeMap;
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
    Listed(ListPage),
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
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(RegistryCommand::Command { command, reply })
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
        mpsc::error::TrySendError::Closed(_) => DomainError::Worker("registry stopped".into()),
    }
}
enum RegistryCommand {
    Command {
        command: DomainCommand,
        reply: Reply,
    },
    Worker {
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
    id: &SessionId,
    reply: Reply,
    sessions: &BTreeMap<SessionId, mpsc::Sender<SessionCommand>>,
) {
    enqueue(SessionCommand::Command { command, reply }, id, sessions);
}
fn enqueue(
    message: SessionCommand,
    id: &SessionId,
    sessions: &BTreeMap<SessionId, mpsc::Sender<SessionCommand>>,
) {
    let Some(sender) = sessions.get(id) else {
        message.reject(DomainError::NotFound(id.clone()));
        return;
    };
    if let Err(error) = sender.try_send(message) {
        let failure = if matches!(error, mpsc::error::TrySendError::Full(_)) {
            DomainError::Backpressure
        } else {
            DomainError::NotFound(id.clone())
        };
        error.into_inner().reject(failure);
    }
}
enum SessionCommand {
    Command {
        command: DomainCommand,
        reply: Reply,
    },
    Worker {
        epoch: u64,
        event: Option<AgentEvent>,
        reply: Reply,
    },
    Shutdown(oneshot::Sender<Result<(), DomainError>>),
}
impl SessionCommand {
    fn reject(self, error: DomainError) {
        if let Self::Command { reply, .. } | Self::Worker { reply, .. } = self {
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
    store: &impl SessionPersistence,
    events: &broadcast::Sender<CommitBatch>,
) -> Result<OwnerReply, DomainError> {
    // Read only the requested tool header, and only after scope/turn fencing.
    // No old body is materialized by either this read or a status-only patch.
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
    let Some(change) = transition(state, command, &context, now)? else {
        return Ok(accepted(state));
    };
    let next = change.next.clone();
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
    mut rx: mpsc::Receiver<SessionCommand>,
    store: impl SessionPersistence,
    events: broadcast::Sender<CommitBatch>,
) {
    let mut worker_epoch = None;
    while let Some(message) = rx.recv().await {
        let (command, reply) = match message {
            SessionCommand::Command { command, reply } => (command, reply),
            SessionCommand::Worker {
                epoch,
                event: None,
                reply,
            } => {
                let result = if matches!(state.status, SessionStatus::Cancelling)
                    || epoch == 0
                    || worker_epoch.is_some_and(|current| epoch < current)
                {
                    Err(DomainError::Worker("obsolete worker attachment".into()))
                } else {
                    worker_epoch = Some(epoch);
                    Ok(accepted(&state))
                };
                let _ = reply.send(result);
                continue;
            }
            SessionCommand::Worker {
                epoch,
                event: Some(event),
                reply,
            } => {
                if worker_epoch != Some(epoch) {
                    let _ = reply.send(Ok(accepted(&state)));
                    continue;
                }
                (
                    DomainCommand::Agent {
                        session: state.id.clone(),
                        event,
                    },
                    reply,
                )
            }
            SessionCommand::Shutdown(reply) => {
                let result = if state.active_turn.is_some() {
                    let command = DomainCommand::Cancel {
                        session: state.id.clone(),
                    };
                    commit_command(&mut state, command, &store, &events)
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
            continue;
        }
        if matches!(command, DomainCommand::Inspect(_)) {
            let _ = reply.send(Ok(OwnerReply::Receipt(CommandReceipt::Loaded {
                view: Box::new(state.clone()),
            })));
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
        let result = commit_command(&mut state, command, &store, &events).await;
        if result.is_ok() && invalidate_worker {
            worker_epoch = None;
        }
        let _ = reply.send(result);
    }
}
