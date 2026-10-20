use crate::{
    acp::{
        decode_notification, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, RequestId,
        SessionNotification,
    },
    domain::{error::DomainError, ids::SessionId},
    task_scope::{OwnedTask, TaskScope},
};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore},
    time::{Instant, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;

const MAX_FRAME: usize = 2 * 1024 * 1024;
// Only image notifications may use the larger lane. Raw bytes expand to base64;
// the remainder covers the UTF-8 JSON envelope, not arbitrary text/tool output.
const MAX_MEDIA_FRAME: usize = crate::domain::image::MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1024 * 1024;
fn validate_frame(message: &JsonRpcMessage, bytes: usize) -> Result<(), DomainError> {
    if bytes <= MAX_FRAME {
        return Ok(());
    }
    if bytes > MAX_MEDIA_FRAME {
        return Err(DomainError::FrameTooLarge);
    }
    if let JsonRpcMessage::Request(request) = message {
        if request.method == "session/prompt" {
            if let Some(parts) = request.params["prompt"].as_array() {
                let images: Vec<_> = parts.iter().filter(|p| p["type"] == "image").collect();
                if images.len() == 1 {
                    let data = images[0]["data"]
                        .as_str()
                        .ok_or(DomainError::FrameTooLarge)?;
                    let mime = images[0]["mimeType"]
                        .as_str()
                        .ok_or(DomainError::FrameTooLarge)?;
                    if bytes.saturating_sub(data.len()) <= 1024 * 1024 {
                        crate::domain::image::ImageAsset::from_base64(mime, data)?;
                        return Ok(());
                    }
                }
            }
        }
    }
    if let JsonRpcMessage::Notification(notification) = message {
        if notification.method == "session/update" {
            let update = &notification.params["update"];
            if matches!(
                update["sessionUpdate"].as_str(),
                Some("agent_message_chunk" | "agent_thought_chunk")
            ) && update["content"]["type"].as_str() == Some("image")
            {
                let data = update["content"]["data"]
                    .as_str()
                    .ok_or(DomainError::FrameTooLarge)?;
                let mime = update["content"]["mimeType"]
                    .as_str()
                    .ok_or(DomainError::FrameTooLarge)?;
                if bytes.saturating_sub(data.len()) <= 64 * 1024 {
                    crate::domain::image::ImageAsset::from_base64(mime, data)?;
                    return Ok(());
                }
            }
        }
    }
    Err(DomainError::FrameTooLarge)
}
fn validate_outbound(message: &JsonRpcMessage) -> Result<(), DomainError> {
    let bytes = serde_json::to_vec(message).map_err(|e| DomainError::Protocol(e.to_string()))?;
    validate_frame(message, bytes.len())
}
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
fn request_deadline(method: &str, now: Instant) -> Option<Instant> {
    match method {
        "session/prompt" => None,
        "_pi_workbench/fork" => Some(now + Duration::from_secs(180)),
        _ => Some(now + REQUEST_TIMEOUT),
    }
}

#[derive(Debug)]
pub enum WorkerEvent {
    Request(crate::acp::interaction::InboundRequest),
    Update(SessionNotification),
    Closed(String),
}
enum WorkerCommand {
    Send {
        message: JsonRpcMessage,
        written: oneshot::Sender<Result<(), DomainError>>,
    },
    Request {
        request: JsonRpcRequest,
        reply: oneshot::Sender<Result<JsonRpcResponse, DomainError>>,
    },
}
struct PendingRequest {
    reply: oneshot::Sender<Result<JsonRpcResponse, DomainError>>,
    deadline: Option<Instant>,
}
pub struct WorkerHandle {
    pub session: SessionId,
    pub epoch: u64,
    tx: mpsc::Sender<WorkerCommand>,
    stop: CancellationToken,
    task: OwnedTask,
}
impl WorkerHandle {
    pub(crate) fn completion(&self) -> OwnedTask {
        self.task.clone()
    }
    pub async fn prompt(&self, request: JsonRpcRequest) -> Result<(), DomainError> {
        self.send(JsonRpcMessage::Request(request)).await
    }
    pub async fn respond(&self, response: JsonRpcResponse) -> Result<(), DomainError> {
        self.send(JsonRpcMessage::Response(response)).await
    }
    pub async fn notify(
        &self,
        notification: crate::acp::JsonRpcNotification,
    ) -> Result<(), DomainError> {
        self.send(JsonRpcMessage::Notification(notification)).await
    }
    async fn send(&self, message: JsonRpcMessage) -> Result<(), DomainError> {
        validate_outbound(&message)?;
        let (written, wait) = oneshot::channel();
        self.tx
            .try_send(WorkerCommand::Send { message, written })
            .map_err(DomainError::mailbox)?;
        wait.await
            .map_err(|_| DomainError::Worker("worker stopped before writing frame".into()))?
    }
    pub async fn request(&self, request: JsonRpcRequest) -> Result<JsonRpcResponse, DomainError> {
        validate_outbound(&JsonRpcMessage::Request(request.clone()))?;
        let (reply, wait) = oneshot::channel();
        self.tx
            .try_send(WorkerCommand::Request { request, reply })
            .map_err(DomainError::mailbox)?;
        wait.await
            .map_err(|_| DomainError::Worker("worker stopped before response".into()))?
    }
    pub async fn stop(self) {
        self.stop.cancel();
        self.task.join().await;
    }
}
impl Drop for WorkerHandle {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
pub struct WorkerSupervisor {
    launches: crate::config::WorkersConfig,
    private_env: Vec<String>,
    capacity: Arc<Semaphore>,
    total_slots: u32,
    stop: CancellationToken,
    tasks: TaskScope,
    next_epoch: AtomicU64,
}
impl WorkerSupervisor {
    pub fn configured(launches: crate::config::WorkersConfig, max_workers: usize) -> Self {
        Self {
            launches,
            private_env: vec![],
            capacity: Arc::new(Semaphore::new(max_workers)),
            total_slots: max_workers.try_into().expect("validated worker limit"),
            stop: CancellationToken::new(),
            tasks: TaskScope::default(),
            next_epoch: AtomicU64::new(1),
        }
    }
    pub fn without_env(mut self, name: String) -> Self {
        for launch in [
            &mut self.launches.pi,
            &mut self.launches.codex,
            &mut self.launches.claude,
        ]
        .into_iter()
        .flatten()
        {
            launch.env.remove(&name);
        }
        self.private_env.push(name);
        self
    }
    pub async fn shutdown(&self) -> Result<(), DomainError> {
        self.stop.cancel();
        // Includes workers whose handle was dropped or whose adapter has not yet
        // been registered. The permit lives until process-group cleanup finishes.
        let _all = self
            .capacity
            .clone()
            .acquire_many_owned(self.total_slots)
            .await
            .map_err(|_| DomainError::Worker("worker accounting closed".into()))?;
        self.tasks.close_and_join().await;
        Ok(())
    }
    pub fn is_configured(&self, harness: &crate::domain::Harness) -> bool {
        self.launches.get(harness).is_some()
    }
    pub async fn spawn_for(
        &self,
        session: SessionId,
        harness: &crate::domain::Harness,
        events: mpsc::Sender<WorkerEvent>,
    ) -> Result<WorkerHandle, DomainError> {
        if self.stop.is_cancelled() {
            return Err(DomainError::Worker("worker supervisor stopping".into()));
        }
        let launch = self
            .launches
            .get(harness)
            .ok_or(DomainError::ProviderNotConfigured)?;
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|error| match error {
                tokio::sync::TryAcquireError::NoPermits => DomainError::WorkerCapacity,
                tokio::sync::TryAcquireError::Closed => DomainError::MailboxClosed,
            })?;
        // Registration and the final stopping check are atomic against the
        // shutdown task snapshot. No await or protocol I/O holds this guard.
        let mut tasks = self.tasks.entry()?;
        if self.stop.is_cancelled() {
            return Err(DomainError::Worker("worker supervisor stopping".into()));
        }
        let mut command = Command::new(&launch.command);
        for name in &self.private_env {
            command.env_remove(name);
        }
        command
            .args(&launch.args)
            .envs(&launch.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| DomainError::Worker(format!("spawn failed: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| DomainError::Worker("stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DomainError::Worker("stdout unavailable".into()))?;
        let group = ProcessGroup(
            child
                .id()
                .ok_or_else(|| DomainError::Worker("process ID unavailable".into()))?
                as i32,
        );
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(32);
        let stop = self.stop.child_token();
        let task = tasks.spawn(worker_loop(
            child,
            stdin,
            stdout,
            rx,
            events,
            stop.clone(),
            group,
            permit,
        ));
        Ok(WorkerHandle {
            session,
            epoch,
            tx,
            stop,
            task,
        })
    }
}

impl Drop for WorkerSupervisor {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// A drop guard also cleans process groups when the worker task unwinds.
struct ProcessGroup(i32);
impl ProcessGroup {
    fn signal(&self, signal: i32) {
        // SAFETY: the negative PID addresses the process group created for this child.
        unsafe {
            libc::kill(-self.0, signal);
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.signal(libc::SIGKILL);
    }
}

#[allow(clippy::too_many_arguments)]
async fn worker_loop(
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut commands: mpsc::Receiver<WorkerCommand>,
    events: mpsc::Sender<WorkerEvent>,
    stop: CancellationToken,
    group: ProcessGroup,
    _permit: OwnedSemaphorePermit,
) {
    let mut reader = BufReader::new(stdout);
    let mut frame = Vec::new();
    // One staged notification propagates bounded backpressure to stdout without
    // blocking cancellation or writes that resolve an inbound request.
    let mut staged = None;
    let mut pending: HashMap<RequestId, PendingRequest> = HashMap::new();
    let mut exit_reason = None;
    let mut drain_deadline = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let reason = loop {
        let remaining = MAX_MEDIA_FRAME + 2 - frame.len();
        let mut bounded = (&mut reader).take(remaining as u64);
        tokio::select! {
            biased;
            _ = stop.cancelled() => break "stopped".to_owned(),
            _ = tokio::time::sleep_until(drain_deadline), if exit_reason.is_some() => {
                break exit_reason.take().unwrap_or_else(|| "worker exited".into());
            }
            status = child.wait(), if exit_reason.is_none() => {
                exit_reason = Some(format!("worker exit: {status:?}"));
                drain_deadline = Instant::now() + Duration::from_millis(250);
            }
            _ = tick.tick() => {
                let now = Instant::now();
                let expired: Vec<_> = pending.iter().filter(|(_, request)| request.reply.is_closed() || request.deadline.is_some_and(|deadline| deadline <= now))
                    .map(|(id, _)| id.clone()).collect();
                for id in expired {
                    if let Some(request) = pending.remove(&id) {
                        let _ = request.reply.send(Err(DomainError::Worker("request timed out".into())));
                    }
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break "handle closed".into() };
                let (message, written) = match command {
                    WorkerCommand::Send { message, written } => (message, Some(written)),
                    WorkerCommand::Request { request, reply } => {
                        if pending.contains_key(&request.id) || pending.len() >= 64 {
                            let _ = reply.send(Err(DomainError::Backpressure));
                            continue;
                        }
                        // A prompt may wait on the agent or a human indefinitely. Only
                        // short control requests use the protocol response deadline.
                        let deadline = request_deadline(&request.method, Instant::now());
                        pending.insert(request.id.clone(), PendingRequest { reply, deadline });
                        (JsonRpcMessage::Request(request), None)
                    }
                };
                let mut bytes = match serde_json::to_vec(&message) {
                    Ok(bytes) if validate_frame(&message, bytes.len()).is_ok() => bytes,
                    _ => break "outbound frame exceeds limit".into(),
                };
                bytes.push(b'\n');
                let write = async { stdin.write_all(&bytes).await?; stdin.flush().await };
                tokio::select! {
                    _ = stop.cancelled() => break "stopped".into(),
                    result = tokio::time::timeout(REQUEST_TIMEOUT, write) => {
                        if !matches!(result, Ok(Ok(()))) { break "worker input failed or timed out".into(); }
                    }
                }
                if let Some(written) = written { let _ = written.send(Ok(())); }
            }
            permit = events.reserve(), if staged.is_some() => {
                match permit { Ok(permit) => permit.send(staged.take().expect("staged event")), Err(_) => break "worker event receiver closed".into() }
            }
            read = bounded.read_until(b'\n', &mut frame), if staged.is_none() => {
                match read {
                    Ok(0) => break "eof".into(),
                    Ok(_) if frame.len() > MAX_MEDIA_FRAME + 1 => break "inbound frame exceeds limit".into(),
                    Err(error) => break format!("worker output: {error}"),
                    Ok(_) => {}
                }
                let payload = frame.strip_suffix(b"\n").unwrap_or(&frame);
                let decoded = serde_json::from_slice::<JsonRpcMessage>(payload);
                if let Ok(message) = &decoded {
                    if let Err(error) = validate_frame(message, payload.len()) {
                        break error.to_string();
                    }
                }
                match decoded {
                    Ok(JsonRpcMessage::Response(response)) => {
                        if let Some(request) = pending.remove(&response.id) { let _ = request.reply.send(Ok(response)); }
                    }
                    Ok(JsonRpcMessage::Notification(notification)) if notification.method == "session/update" => {
                        match decode_notification(notification.params) {
                            Ok(update) => { staged = Some(WorkerEvent::Update(update)); }
                            Err(error) => break error.to_string(),
                        }
                    }
                    Ok(JsonRpcMessage::Request(request)) => {
                        let id = request.id.clone();
                        let is_form = request.method == "elicitation/create";
                        match crate::acp::decode_request(request) {
                            Ok(request) => { staged = Some(WorkerEvent::Request(request)); }
                            Err(error) => {
                                let response = if is_form {
                                    // Unsupported/nested schemas are explicitly declined,
                                    // not truncated into a different question.
                                    JsonRpcResponse::success(id, crate::acp::interaction::FormResponse::Decline)
                                        .expect("form response serialization")
                                } else {
                                    JsonRpcResponse { jsonrpc: crate::acp::JsonRpcVersion::V2,
                                        id, result: None, error: Some(crate::acp::JsonRpcError { code: -32602, message: error.to_string() }) }
                                };
                                let mut bytes = serde_json::to_vec(&response).expect("response serialization");
                                bytes.push(b'\n');
                                let write = async { stdin.write_all(&bytes).await?; stdin.flush().await };
                                tokio::select! {
                                    _ = stop.cancelled() => break "stopped".into(),
                                    result = tokio::time::timeout(REQUEST_TIMEOUT, write) => {
                                        if !matches!(result, Ok(Ok(()))) { break "worker response write failed".into(); }
                                    }
                                }
                            }
                        }
                    }
                    Ok(_) => {},
                    Err(error) => break format!("invalid JSON-RPC: {error}"),
                }
                frame.clear();
            }
        }
    };
    commands.close();
    // EOF is ordered after flushed protocol replies. Give the peer a bounded
    // chance to consume them and exit before signalling its process group.
    // Immediate SIGTERM can discard a response already accepted by the pipe.
    drop(stdin);
    if tokio::time::timeout(Duration::from_millis(250), child.wait())
        .await
        .is_err()
    {
        group.signal(libc::SIGTERM);
        if tokio::time::timeout(Duration::from_millis(250), child.wait())
            .await
            .is_err()
        {
            group.signal(libc::SIGKILL);
            let _ = child.wait().await;
        }
    }
    // Also kill descendants when the leader has exited normally or ignored TERM.
    group.signal(libc::SIGKILL);
    for (_, request) in pending {
        let _ = request.reply.send(Err(DomainError::Worker(reason.clone())));
    }
    let _ = events.try_send(WorkerEvent::Closed(reason));
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
