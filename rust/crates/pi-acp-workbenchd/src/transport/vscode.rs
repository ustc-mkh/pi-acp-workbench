//! External v3 IPC. Only bounded queries, typed original receipts and committed
//! revision batches cross the wire. No internal Agent command is decodable.
pub use crate::domain::query::PROTOCOL_VERSION;
use crate::{
    app::WorkbenchApp,
    domain::{
        command::DomainCommand,
        error::DomainError,
        interaction::InteractionAnswer,
        query::{self, CommandReceipt, CommitBatch, QueryCommand, QueryResult, SafeInteger},
        Harness, ModeId, ModelId, Prompt, SessionId, WorkspacePath,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
#[cfg(test)]
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{broadcast, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 64;
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_IN_FLIGHT: usize = 24;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IpcRequest {
    pub version: query::ProtocolVersion,
    pub id: SafeInteger,
    pub command: ClientCommand,
    #[serde(default)]
    pub operation: Option<crate::domain::OperationId>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientCommand {
    Operation {
        operation: crate::domain::OperationId,
    },
    Create {
        harness: Harness,
        cwd: WorkspacePath,
    },
    Load {
        session: SessionId,
    },
    List {
        cursor: Option<query::ListCursor>,
        limit: Option<usize>,
    },
    Inspect {
        session: SessionId,
    },
    History {
        session: SessionId,
        cursor: Option<query::HistoryCursor>,
        limit: Option<usize>,
    },
    Tools {
        session: SessionId,
        turn: crate::domain::TurnId,
        cursor: Option<query::ToolCursor>,
        limit: Option<usize>,
    },
    Content {
        r#ref: query::ContentRef,
        offset: SafeInteger,
        length: Option<usize>,
    },
    Image {
        image: crate::domain::image::ImageRef,
    },
    Management {
        query: crate::domain::management::ManagementQuery,
    },
    Manage {
        session: SessionId,
        action: crate::domain::management::ManagementAction,
    },
    ValidateUndo {
        session: SessionId,
        turn: crate::domain::TurnId,
    },
    TurnDiff {
        session: SessionId,
        turn: crate::domain::TurnId,
        offset: Option<SafeInteger>,
    },
    TurnDiffContent {
        session: SessionId,
        turn: crate::domain::TurnId,
        file: u32,
        after: bool,
        offset: SafeInteger,
    },
    UndoTurn {
        session: SessionId,
        turn: crate::domain::TurnId,
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
    Discover {
        session: SessionId,
    },
    SetOption {
        session: SessionId,
        id: String,
        value: String,
    },
    SetMode {
        session: SessionId,
        mode: ModeId,
    },
    Remove {
        session: SessionId,
    },
    Attach {
        session: SessionId,
    },
    Detach {
        session: SessionId,
    },
}
impl ClientCommand {
    fn pool(&self) -> usize {
        match self {
            Self::Operation { .. }
            | Self::List { .. }
            | Self::Inspect { .. }
            | Self::History { .. }
            | Self::Tools { .. }
            | Self::Content { .. }
            | Self::Image { .. }
            | Self::Management { .. }
            | Self::ValidateUndo { .. }
            | Self::TurnDiff { .. }
            | Self::TurnDiffContent { .. }
            | Self::Attach { .. }
            | Self::Detach { .. } => 2,
            Self::Cancel { .. }
            | Self::UndoTurn { .. }
            | Self::CancelFork { .. }
            | Self::Answer { .. }
            | Self::Remove { .. } => 1,
            _ => 0,
        }
    }
    fn query(&self) -> Option<QueryCommand> {
        Some(match self {
            Self::Operation { operation } => QueryCommand::Operation {
                operation: operation.clone(),
            },
            Self::List { cursor, limit } => QueryCommand::List {
                cursor: cursor.clone(),
                limit: *limit,
            },
            Self::Inspect { session } => QueryCommand::Inspect {
                session: session.clone(),
            },
            Self::History {
                session,
                cursor,
                limit,
            } => QueryCommand::History {
                session: session.clone(),
                cursor: cursor.clone(),
                limit: *limit,
            },
            Self::Tools {
                session,
                turn,
                cursor,
                limit,
            } => QueryCommand::Tools {
                session: session.clone(),
                turn: turn.clone(),
                cursor: cursor.clone(),
                limit: *limit,
            },
            Self::Content {
                r#ref,
                offset,
                length,
            } => QueryCommand::Content {
                r#ref: r#ref.clone(),
                offset: *offset,
                length: *length,
            },
            Self::Management { query } => QueryCommand::Management {
                query: query.clone(),
            },
            Self::ValidateUndo { session, turn } => QueryCommand::ValidateUndo {
                session: session.clone(),
                turn: turn.clone(),
            },
            Self::TurnDiff {
                session,
                turn,
                offset,
            } => QueryCommand::TurnDiff {
                session: session.clone(),
                turn: turn.clone(),
                offset: offset.unwrap_or_default().get() as usize,
            },
            Self::TurnDiffContent {
                session,
                turn,
                file,
                after,
                offset,
            } => QueryCommand::TurnDiffContent {
                session: session.clone(),
                turn: turn.clone(),
                file: *file as usize,
                after: *after,
                offset: *offset,
            },
            _ => return None,
        })
    }
    fn into_domain(self) -> Option<DomainCommand> {
        Some(match self {
            Self::Manage { session, action } => DomainCommand::Manage { session, action },
            Self::UndoTurn { session, turn } => DomainCommand::UndoTurn { session, turn },
            Self::Create { harness, cwd } => DomainCommand::CreateSession { harness, cwd },
            Self::Load { session } => DomainCommand::LoadSession(session),
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
            Self::Discover { session } => DomainCommand::Discover { session },
            Self::SetOption { session, id, value } => {
                DomainCommand::SetOption { session, id, value }
            }
            Self::SetMode { session, mode } => DomainCommand::SetMode { session, mode },
            Self::Remove { session } => DomainCommand::RemoveSession(session),
            _ => return None,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum IpcMessage {
    Reply {
        id: SafeInteger,
        receipt: CommandReceipt,
    },
    Query {
        id: SafeInteger,
        result: QueryResult,
    },
    Detached {
        id: SafeInteger,
        session: SessionId,
    },
    Image {
        id: SafeInteger,
        asset: crate::domain::image::ImageAsset,
    },
    Error {
        id: SafeInteger,
        code: String,
        message: String,
    },
    Batch {
        batch: Box<CommitBatch>,
    },
    ResyncRequired,
}
fn error(id: SafeInteger, error: DomainError) -> IpcMessage {
    let code = match error {
        DomainError::Backpressure => "backpressure",
        DomainError::WorkerCapacity => "worker_capacity",
        DomainError::MailboxClosed => "mailbox_closed",
        DomainError::FrameTooLarge => "frame_too_large",
        DomainError::Busy => "busy",
        DomainError::NotFound(_) => "not_found",
        DomainError::Query(query::QueryError::InvalidInput) => "invalid_input",
        DomainError::Query(query::QueryError::TooLarge) => "too_large",
        DomainError::Query(query::QueryError::UnsupportedVersion) => "unsupported_version",
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
        // Occupied/stale paths fail. Never unlink another host's socket.
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
                    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } { continue; }
                    let Ok(permit) = capacity.clone().try_acquire_owned() else { continue; };
                    let app = app.clone(); let stop = stop.clone();
                    connections.spawn(async move { let _permit = permit; connection(stream, app, stop).await });
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
    let budget = if matches!(message, IpcMessage::Image { .. }) {
        MAX_FRAME
    } else {
        query::MAX_QUERY_BYTES
    };
    let mut bytes = query::json_bytes(message, budget).map_err(io::Error::other)?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), writer.write_all(&bytes))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "slow IPC reader"))?
}
async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    stop: &CancellationToken,
) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    let mut byte = [0u8; 1];
    let mut deadline = None;
    loop {
        let read = if let Some(deadline) = deadline {
            tokio::time::timeout_at(deadline, async {
                tokio::select! { _ = stop.cancelled() => Ok(0), result = reader.read(&mut byte) => result }
            }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "incomplete IPC frame"))??
        } else {
            tokio::select! { _ = stop.cancelled() => return Ok(None), result = reader.read(&mut byte) => result? }
        };
        if read == 0 {
            return Ok(if frame.is_empty() { None } else { Some(frame) });
        }
        if deadline.is_none() {
            deadline = Some(tokio::time::Instant::now() + Duration::from_secs(10));
        }
        if byte[0] == b'\n' {
            return Ok(Some(frame));
        }
        frame.push(byte[0]);
        if frame.len() > MAX_FRAME {
            return Err(io::Error::other("IPC request exceeds frame limit"));
        }
    }
}
async fn connection(
    stream: UnixStream,
    app: WorkbenchApp,
    stop: CancellationToken,
) -> io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = read;
    // Register before any snapshot read. The broadcast itself is the bounded
    // attach buffer; lag is fatal/resync, never silently dropped.
    let mut events = app.subscribe();
    let mut subscriptions: BTreeMap<SessionId, SafeInteger> = BTreeMap::new();
    let mut replies = JoinSet::new();
    let mut pending_ids = BTreeSet::new();
    let pools = [16, 4, 4].map(|size| Arc::new(Semaphore::new(size)));
    loop {
        let message = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            completed = replies.join_next(), if !replies.is_empty() => {
                let (id, message) = completed.expect("nonempty observers").map_err(|_| io::Error::other("IPC reply observer failed"))?;
                pending_ids.remove(&id); message
            },
            result = read_frame(&mut reader, &stop) => {
                let Some(frame) = result? else { return Ok(()); };
                let request: IpcRequest = serde_json::from_slice(&frame).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                let id = request.id;
                if pending_ids.contains(&id) { return Err(io::Error::other("duplicate in-flight IPC request id")); }
                let command = request.command;
                let permit = pools[command.pool()].clone().try_acquire_owned();
                let Ok(permit) = permit else { write_message(&mut write, &error(id, DomainError::Backpressure)).await?; continue; };
                if replies.len() >= MAX_IN_FLIGHT { error(id, DomainError::Backpressure) }
                else if command.pool() == 2 && request.operation.is_some() { error(id, DomainError::InvalidAnswer("queries cannot carry an operation id".into())) }
                else { match command {
                    ClientCommand::Attach { session } => {
                        if subscriptions.len() >= MAX_SUBSCRIPTIONS && !subscriptions.contains_key(&session) { error(id, DomainError::Backpressure) }
                        else {
                            let result = tokio::select! { _ = stop.cancelled() => return Ok(()), result = app.query(QueryCommand::Attach { session: session.clone() }) => result };
                            match result {
                                Ok(QueryResult::Attached(attached)) => {
                                    subscriptions.insert(session, attached.view.revision);
                                    IpcMessage::Query { id, result: QueryResult::Attached(attached) }
                                }
                                Ok(_) => return Err(io::Error::other("invalid attach query result")),
                                Err(failure) => error(id, failure),
                            }
                        }
                    }
                    ClientCommand::Detach { session } => { subscriptions.remove(&session); IpcMessage::Detached { id, session } }
                    ClientCommand::Image { image } => {
                        pending_ids.insert(id); let app = app.clone();
                        replies.spawn(async move {
                            let _permit = permit;
                            let message = match app.image(&image).await { Ok(asset) => IpcMessage::Image { id, asset }, Err(failure) => error(id, failure) };
                            (id, message)
                        }); continue;
                    }
                    command => {
                        if let Some(query) = command.query() {
                            pending_ids.insert(id); let app = app.clone();
                            replies.spawn(async move {
                                let _permit = permit;
                                let message = match app.query(query).await { Ok(result) => IpcMessage::Query { id, result }, Err(failure) => error(id, failure) };
                                (id, message)
                            }); continue;
                        }
                        let command = command.into_domain().expect("all queries handled");
                        match app.enqueue_command(request.operation, command) {
                            Err(failure) => error(id, failure),
                            Ok(ticket) => {
                                pending_ids.insert(id);
                                replies.spawn(async move {
                                    let _permit = permit;
                                    let message = match ticket.wait().await { Ok(receipt) => IpcMessage::Reply { id, receipt }, Err(failure) => error(id, failure) };
                                    (id, message)
                                }); continue;
                            }
                        }
                    }
                }}
            },
            event = events.recv() => match event {
                Ok(batch) => {
                    let Some(last) = subscriptions.get_mut(&batch.session) else { continue; };
                    if batch.revision <= *last { continue; }
                    if last.next().ok() != Some(batch.revision) {
                        write_message(&mut write, &IpcMessage::ResyncRequired).await?; return Ok(());
                    }
                    *last = batch.revision;
                    IpcMessage::Batch { batch: Box::new(batch) }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => { write_message(&mut write, &IpcMessage::ResyncRequired).await?; return Ok(()); }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            }
        };
        tokio::select! { _ = stop.cancelled() => return Ok(()), result = write_message(&mut write, &message) => result? }
    }
}
#[cfg(test)]
#[path = "vscode_tests.rs"]
mod tests;
