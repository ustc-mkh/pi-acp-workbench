//! External IPC adapter. No internal Agent command is deserializable from this API.
use crate::{
    app::WorkbenchApp,
    domain::{
        command::DomainCommand, error::DomainError, event::DomainEvent,
        interaction::InteractionAnswer, Harness, ModeId, ModelId, Prompt, SessionId, WorkspacePath,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{broadcast, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

pub const PROTOCOL_VERSION: u32 = 2;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_IN_FLIGHT: usize = 24;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IpcRequest {
    pub version: u32,
    pub id: u64,
    pub command: ClientCommand,
    #[serde(default)]
    pub operation: Option<crate::domain::OperationId>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientCommand {
    Create {
        harness: Harness,
        cwd: WorkspacePath,
    },
    Load {
        session: SessionId,
    },
    List,
    Inspect {
        session: SessionId,
    },
    Image {
        image: crate::domain::image::ImageRef,
    },
    Prompt {
        session: SessionId,
        prompt: Prompt,
    },
    Cancel {
        session: SessionId,
    },
    Answer {
        session: SessionId,
        answer: InteractionAnswer,
    },
    Fork {
        session: SessionId,
        request: crate::domain::fork::ForkRequest,
    },
    CancelFork {
        session: SessionId,
        operation: crate::domain::OperationId,
    },
    SetModel {
        session: SessionId,
        model: ModelId,
    },
    SetMode {
        session: SessionId,
        mode: ModeId,
    },
    Remove {
        session: SessionId,
    },
    Subscribe {
        session: SessionId,
    },
    Unsubscribe {
        session: SessionId,
    },
}
impl ClientCommand {
    fn pool(&self) -> usize {
        match self {
            Self::List | Self::Inspect { .. } | Self::Image { .. } => 2,
            Self::Cancel { .. }
            | Self::CancelFork { .. }
            | Self::Answer { .. }
            | Self::Remove { .. } => 1,
            _ => 0,
        }
    }
    fn into_domain(self) -> Option<DomainCommand> {
        Some(match self {
            Self::Create { harness, cwd } => DomainCommand::CreateSession { harness, cwd },
            Self::Load { session } => DomainCommand::LoadSession(session),
            Self::List => DomainCommand::ListSessions,
            Self::Inspect { session } => DomainCommand::Inspect(session),
            Self::Prompt { session, prompt } => DomainCommand::Prompt { session, prompt },
            Self::Cancel { session } => DomainCommand::Cancel { session },
            Self::Answer { session, answer } => {
                DomainCommand::AnswerInteraction { session, answer }
            }
            Self::Fork { session, request } => DomainCommand::Fork { session, request },
            Self::CancelFork { session, operation } => {
                DomainCommand::CancelFork { session, operation }
            }
            Self::SetModel { session, model } => DomainCommand::SetModel { session, model },
            Self::SetMode { session, mode } => DomainCommand::SetMode { session, mode },
            Self::Remove { session } => DomainCommand::RemoveSession(session),
            Self::Subscribe { .. } | Self::Unsubscribe { .. } | Self::Image { .. } => return None,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcMessage {
    Reply {
        id: u64,
        events: Vec<DomainEvent>,
    },
    Image {
        id: u64,
        asset: crate::domain::image::ImageAsset,
    },
    Error {
        id: u64,
        code: String,
        message: String,
    },
    Event {
        event: Box<DomainEvent>,
    },
    ResyncRequired,
}
fn error(id: u64, error: DomainError) -> IpcMessage {
    let code = match error {
        DomainError::Backpressure => "backpressure",
        DomainError::Busy => "busy",
        DomainError::NotFound(_) => "not_found",
        DomainError::Persistence(_) => "persistence",
        DomainError::InvalidId(_) | DomainError::InvalidAnswer(_) => "invalid_input",
        DomainError::OperationConflict => "operation_conflict",
        DomainError::OperationInterrupted => "operation_interrupted",
        DomainError::OperationExpired => "operation_expired",
        DomainError::UnsupportedFeature(_) => "unsupported_feature",
        DomainError::NativeForkUncertain => "native_fork_uncertain",
        DomainError::ForkCancelled => "fork_cancelled",
        DomainError::NoActiveFork => "fork_not_running",
        DomainError::NativeForkUnadopted { .. } => "native_fork_unadopted",
        _ => "operation_failed",
    };
    IpcMessage::Error {
        id,
        code: code.into(),
        message: error.to_string(),
    }
}

pub struct ExternalTransport {
    stop: CancellationToken,
    task: Option<JoinHandle<io::Result<()>>>,
}
impl ExternalTransport {
    pub async fn bind(path: impl AsRef<Path>, app: WorkbenchApp) -> io::Result<Self> {
        let path = path.as_ref().to_owned();
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("IPC socket parent missing"))?;
        tokio::fs::create_dir_all(parent).await?;
        // Bind fails on an occupied or stale path; never unlink another host's socket.
        let listener = UnixListener::bind(&path)?;
        let metadata = std::fs::symlink_metadata(&path)?;
        let guard = SocketGuard {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        };
        std::fs::set_permissions(&guard.path, std::fs::Permissions::from_mode(0o600))?;
        let stop = CancellationToken::new();
        let task = tokio::spawn(serve(listener, app, stop.clone(), guard));
        Ok(Self {
            stop,
            task: Some(task),
        })
    }
    pub async fn wait(&mut self) -> io::Result<()> {
        let Some(task) = self.task.as_mut() else {
            return Ok(());
        };
        let result = task.await.map_err(io::Error::other)?;
        self.task.take();
        result
    }
    pub async fn shutdown(mut self) -> io::Result<()> {
        self.stop.cancel();
        self.wait().await
    }
}
impl Drop for ExternalTransport {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| metadata.dev() == self.device && metadata.ino() == self.inode)
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
async fn serve(
    listener: UnixListener,
    app: WorkbenchApp,
    stop: CancellationToken,
    _guard: SocketGuard,
) -> io::Result<()> {
    let capacity = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = JoinSet::new();
    let outcome = loop {
        tokio::select! {
            _ = stop.cancelled() => break Ok(()),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    // Filesystem mode plus peer credentials restrict access to this UID.
                    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } { continue; }
                    let Ok(permit) = capacity.clone().try_acquire_owned() else { continue; };
                    let app = app.clone();
                    let stop = stop.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        connection(stream, app, stop).await
                    });
                }
                Err(error) => break Err(error),
            },
            _ = connections.join_next(), if !connections.is_empty() => {},
        }
    };
    stop.cancel();
    while connections.join_next().await.is_some() {}
    outcome
}
async fn write_message(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    message: &IpcMessage,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
    if bytes.len() > MAX_FRAME {
        return Err(io::Error::other("IPC response exceeds frame limit"));
    }
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), writer.write_all(&bytes))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "slow IPC reader"))?
}
async fn connection(
    stream: UnixStream,
    app: WorkbenchApp,
    stop: CancellationToken,
) -> io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut events = app.subscribe();
    let mut subscriptions = BTreeSet::new();
    // Session executions are synchronously admitted; these tasks then own only
    // reply observers. Read-only image queries submit when their observer is
    // polled; after host admission their I/O is owned there too. Socket loss
    // cannot abort accepted writes or create a durable image operation.
    let mut replies = JoinSet::new();
    let mut pending_ids = BTreeSet::new();
    let pools = [16, 4, 4].map(|size| Arc::new(Semaphore::new(size)));
    let mut frame = vec![];
    loop {
        let remaining = MAX_FRAME + 1 - frame.len();
        let mut bounded = (&mut reader).take(remaining as u64);
        let message = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            completed = replies.join_next(), if !replies.is_empty() => {
                let (id, message) = completed.expect("nonempty observers").map_err(|_| io::Error::other("IPC reply observer failed"))?;
                pending_ids.remove(&id);
                message
            },
            result = bounded.read_until(b'\n', &mut frame) => {
                if result? == 0 { return Ok(()); }
                if frame.len() > MAX_FRAME { return Err(io::Error::other("IPC request exceeds frame limit")); }
                let request: IpcRequest = serde_json::from_slice(&frame).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                frame.clear();
                if request.version != PROTOCOL_VERSION { return Err(io::Error::other("unsupported IPC version")); }
                let id = request.id;
                if pending_ids.contains(&id) { return Err(io::Error::other("duplicate in-flight IPC request id")); }
                match request.command {
                    ClientCommand::Subscribe { session } => {
                        if subscriptions.len() >= MAX_SUBSCRIPTIONS && !subscriptions.contains(&session) {
                            error(id, DomainError::Backpressure)
                        } else {
                            subscriptions.insert(session);
                            IpcMessage::Reply { id, events: vec![] }
                        }
                    }
                    ClientCommand::Unsubscribe { session } => { subscriptions.remove(&session); IpcMessage::Reply { id, events: vec![] } }
                    ClientCommand::Image { image } => {
                        if request.operation.is_some() { error(id, DomainError::InvalidAnswer("image queries cannot carry an operation id".into())) }
                        else {
                            match pools[2].clone().try_acquire_owned() {
                                Ok(permit) if replies.len() < MAX_IN_FLIGHT => {
                                    pending_ids.insert(id);
                                    let app = app.clone();
                                    replies.spawn(async move {
                                        let _permit = permit;
                                        let message = match app.image(&image).await {
                                            Ok(asset) => IpcMessage::Image { id, asset },
                                            Err(failure) => error(id, failure),
                                        };
                                        (id, message)
                                    });
                                    continue;
                                }
                                _ => error(id, DomainError::Backpressure),
                            }
                        }
                    }
                    command => {
                        let permit = pools[command.pool()].clone().try_acquire_owned();
                        match permit {
                            Ok(permit) if replies.len() < MAX_IN_FLIGHT => {
                            let command = command.into_domain().expect("subscription handled above");
                            match app.enqueue_command(request.operation, command) {
                                Err(failure) => error(id, failure),
                                Ok(ticket) => {
                                    pending_ids.insert(id);
                                    replies.spawn(async move {
                                        let _permit = permit;
                                        let message = match ticket.wait().await {
                                            Ok(events) => IpcMessage::Reply { id, events },
                                            Err(failure) => error(id, failure),
                                        };
                                        (id, message)
                                    });
                                    continue;
                                }
                            }
                            }
                            _ => error(id, DomainError::Backpressure),
                        }
                    }
                }
            }
            event = events.recv() => match event {
                Ok(event) if event_session(&event).is_some_and(|session| subscriptions.contains(session)) => IpcMessage::Event { event: Box::new(event) },
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    write_message(&mut write, &IpcMessage::ResyncRequired).await?;
                    return Ok(());
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            }
        };
        tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            result = write_message(&mut write, &message) => result?,
        }
    }
}
fn event_session(event: &DomainEvent) -> Option<&SessionId> {
    match event {
        DomainEvent::SessionCreated(snapshot) | DomainEvent::SessionLoaded(snapshot) => {
            Some(&snapshot.id)
        }
        DomainEvent::SessionsListed(_) | DomainEvent::ForkPrepared(_) => None,
        DomainEvent::ForkCancelled { session, .. } => Some(session),
        DomainEvent::SessionRemoved(session) => Some(session),
        DomainEvent::ProviderSessionAttached { session, .. }
        | DomainEvent::CatalogueChanged { session, .. }
        | DomainEvent::UserPromptAdded { session, .. }
        | DomainEvent::AgentText { session, .. }
        | DomainEvent::AgentImage { session, .. }
        | DomainEvent::AgentThought { session, .. }
        | DomainEvent::ToolCallChanged { session, .. }
        | DomainEvent::PlanChanged { session, .. }
        | DomainEvent::InteractionRequested { session, .. }
        | DomainEvent::InteractionResolved { session, .. }
        | DomainEvent::UsageChanged { session, .. }
        | DomainEvent::ContextUsageChanged { session, .. }
        | DomainEvent::TurnStarted { session, .. }
        | DomainEvent::TurnFinished { session, .. }
        | DomainEvent::TurnCancelled { session, .. }
        | DomainEvent::SessionError { session, .. } => Some(session),
    }
}

#[cfg(test)]
#[path = "vscode_tests.rs"]
mod tests;
