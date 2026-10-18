use crate::{
    domain::{command::DomainCommand, error::DomainError, event::DomainEvent, ids::*, session::*},
    persistence::interface::SessionPersistence,
};
use std::collections::BTreeMap;
use tokio::sync::{mpsc, oneshot};

type Reply = oneshot::Sender<Result<Vec<DomainEvent>, DomainError>>;

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
    pub async fn command(&self, command: DomainCommand) -> Result<Vec<DomainEvent>, DomainError> {
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
    ) -> Result<Vec<DomainEvent>, DomainError> {
        self.worker_message(session, epoch, None).await
    }
    pub async fn worker_event(
        &self,
        session: SessionId,
        epoch: u64,
        event: crate::domain::command::AgentEvent,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        self.worker_message(session, epoch, Some(event)).await
    }
    async fn worker_message(
        &self,
        session: SessionId,
        epoch: u64,
        event: Option<crate::domain::command::AgentEvent>,
    ) -> Result<Vec<DomainEvent>, DomainError> {
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
    // Test-only protocol helpers. Production shutdown is owned and joined by
    // Runtime, not exposed to protocol adapters through RegistryHandle clones.
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
        event: Option<crate::domain::command::AgentEvent>,
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
        event: Option<crate::domain::command::AgentEvent>,
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
async fn session_loop(
    mut state: SessionState,
    mut rx: mpsc::Receiver<SessionCommand>,
    store: impl SessionPersistence,
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
                if matches!(state.status, SessionStatus::Cancelling)
                    || epoch == 0
                    || worker_epoch.is_some_and(|current| epoch < current)
                {
                    let _ = reply.send(Err(DomainError::Worker(
                        "obsolete worker attachment".into(),
                    )));
                } else {
                    worker_epoch = Some(epoch);
                    let _ = reply.send(Ok(vec![]));
                }
                continue;
            }
            SessionCommand::Worker {
                epoch,
                event: Some(event),
                reply,
            } => {
                if worker_epoch != Some(epoch) {
                    let _ = reply.send(Ok(vec![]));
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
                    let id = state.id.clone();
                    match crate::domain::reducer::apply(
                        &mut state,
                        DomainCommand::Cancel { session: id },
                    ) {
                        Ok(events) => {
                            state.revision += 1;
                            store
                                .commit(&state, &events)
                                .await
                                .map_err(DomainError::Persistence)
                        }
                        Err(error) => Err(error),
                    }
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
        } = &command
        {
            let result = crate::domain::fork::prepare(&state, request, candidates)
                .map(|projection| vec![DomainEvent::ForkPrepared(Box::new(projection))]);
            let _ = reply.send(result);
            continue;
        }
        if matches!(command, DomainCommand::Inspect(_)) {
            let _ = reply.send(Ok(vec![DomainEvent::SessionLoaded(state.snapshot())]));
            continue;
        }
        // Archive image bytes before committing/publishing any metadata reference.
        // The actor owns this I/O across caller/adapter disconnect and shutdown.
        let image = match &command {
            DomainCommand::Agent {
                event: crate::domain::command::AgentEvent::Image { asset, .. },
                ..
            } => Some(asset.clone()),
            _ => None,
        };
        // Publish and replace committed state only after the store succeeds.
        let mut candidate = state.clone();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let result = match crate::domain::reducer::apply_at(&mut candidate, command, now) {
            Ok(events) if !events.is_empty() => {
                candidate.revision += 1;
                let commit = async {
                    if let Some(asset) = image {
                        store.save_image(&asset).await?;
                    }
                    store.commit(&candidate, &events).await
                }
                .await;
                match commit {
                    Ok(()) => {
                        if matches!(candidate.status, SessionStatus::Cancelling)
                            || events.iter().any(|event| {
                                matches!(
                                    event,
                                    DomainEvent::TurnCancelled { .. }
                                        | DomainEvent::SessionError { .. }
                                )
                            })
                        {
                            worker_epoch = None;
                        }
                        state = candidate;
                        Ok(events)
                    }
                    Err(error) => Err(DomainError::Persistence(error)),
                }
            }
            result => result,
        };
        let _ = reply.send(result);
    }
}
