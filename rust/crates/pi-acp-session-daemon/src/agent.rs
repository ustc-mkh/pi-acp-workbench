//! ACP JSON-RPC client over a child process stdin/stdout.
//! Requests, permissions and writes are independently tracked; prompts have no timeout.
//! Shutdown signals the process group, escalating after 1.5s only if the child has not exited.
use crate::harness::Harness;
use pi_acp_core::sync::MutexExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::os::unix::process::ExitStatusExt;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

pub type UpdateCb = Arc<dyn Fn(Value) + Send + Sync>;
/// Async permission bridge: the reader task spawns `cb(params)` per inbound
/// `session/request_permission` and writes `{id, result: <resolved>}` back.
pub type PermissionCb =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;
pub type LogCb = Arc<dyn Fn(&str) + Send + Sync>;
pub type ClosedCb = Arc<dyn Fn(String) + Send + Sync>;

pub struct AgentOptions {
    pub harness: Harness,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub update: UpdateCb,
    pub permission: PermissionCb,
    pub log: LogCb,
    pub closed: ClosedCb,
    pub request_timeout: Duration,
}

/// ndJsonStream({maxMessageBytes: 16 * 1024 * 1024}).
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const SIGKILL_DELAY: Duration = Duration::from_millis(1500);
/// Grace window after stdout EOF so the exit monitor's
/// 'ACP 进程退出 (…)。' beats 'ACP 连接已关闭。' — Node delivers the child
/// 'exit' event before the stream closes the connection.
const EOF_GRACE: Duration = Duration::from_millis(50);

struct Inner {
    harness: Harness,
    update: UpdateCb,
    permission: PermissionCb,
    log: LogCb,
    closed: ClosedCb,
    request_timeout: Duration,
    /// createSession params.cwd.
    cwd: String,
    pid: u32,
    closed_flag: AtomicBool,
    exited_flag: AtomicBool,
    next_id: AtomicU64,
    /// connection.pendingResponses — short critical sections, std Mutex so the
    /// sync dispose() path can drain without a runtime.
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    write_tx: StdMutex<Option<mpsc::UnboundedSender<Value>>>,
    exit_tx: watch::Sender<bool>,
    exit_rx: watch::Receiver<bool>,
}

fn send_wire(inner: &Inner, message: Value) -> bool {
    inner
        .write_tx
        .lock_unpoisoned()
        .as_ref()
        .is_some_and(|tx| tx.send(message).is_ok())
}

fn terminate(inner: &Arc<Inner>, pending_reason: &str) {
    inner.write_tx.lock_unpoisoned().take();
    for (_, waiter) in inner.pending.lock_unpoisoned().drain() {
        let _ = waiter.send(Err(pending_reason.to_string()));
    }
    if inner.pid == 0 || inner.exited_flag.load(Ordering::SeqCst) {
        return;
    }
    // process.kill(-pid, 'SIGTERM') — ESRCH on an already-dead group ignored.
    unsafe { libc::kill(-(inner.pid as i32), libc::SIGTERM) };
    let pid = inner.pid;
    // Stop escalation as soon as the exit monitor confirms this child exited.
    let mut exited = inner.exit_rx.clone();
    let child = inner.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = async { let _ = exited.wait_for(|done| *done).await; } => {}
            _ = tokio::time::sleep(SIGKILL_DELAY) => {
                if !child.exited_flag.load(Ordering::SeqCst) {
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                }
            }
        }
    });
}

fn fail_reason(inner: &Arc<Inner>, message: String, pending_reason: &str) {
    if inner.closed_flag.swap(true, Ordering::SeqCst) {
        return;
    }
    terminate(inner, pending_reason);
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (inner.closed)(message))).is_err() {
        (inner.log)("ACP closed callback failed; worker has been terminated");
    }
}

/// Common case: connection.close() with the SDK default reason.
fn fail(inner: &Arc<Inner>, message: String) {
    fail_reason(inner, message, "ACP connection closed");
}

fn js_display(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| js_display(Some(v)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS truthiness for `agentCapabilities?.loadSession` (false/0/''/null → falsy).
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// jsonrpc.js isJsonRpcId: null | string | finite number.
fn is_json_rpc_id(value: &Value) -> bool {
    match value {
        Value::Null | Value::String(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(|f| f.is_finite()),
        _ => false,
    }
}

/// jsonrpc.js isErrorResponse: {code: integer, message: string}.
fn is_error_response(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.get("code")
            .and_then(Value::as_f64)
            .is_some_and(|c| c.fract() == 0.0)
            && o.get("message").is_some_and(Value::is_string)
    })
}

/// Node reports the signal name ('SIGTERM') for `signal || code`; mirror the
/// printable form for the exit message.
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGPWR => "SIGPWR",
        libc::SIGSYS => "SIGSYS",
        _ => return signal.to_string(),
    }
    .to_string()
}

fn describe_exit(status: std::io::Result<ExitStatus>) -> String {
    match status {
        Ok(status) => status
            .signal()
            .map(signal_name)
            .or_else(|| status.code().map(|c| c.to_string()))
            .unwrap_or_else(|| "null".to_string()),
        Err(_) => "null".to_string(),
    }
}

/// Resolve a pending outbound request (jsonrpc.js handleResponse). Unknown or
/// non-numeric ids are ignored (SDK logs "Got response to unknown request").
fn resolve_response(inner: &Arc<Inner>, obj: &serde_json::Map<String, Value>) {
    // JS Map keys compare numerically — `1` and `1.0` both match our u64 ids.
    let key = obj["id"]
        .as_f64()
        .and_then(|f| (f.fract() == 0.0 && f >= 0.0).then_some(f as u64));
    let waiter = key.and_then(|k| inner.pending.lock_unpoisoned().remove(&k));
    let Some(waiter) = waiter else { return };
    // isResponseMessage: jsonrpc=='2.0' envelope, no method, valid id, exactly
    // one of result|error (error shaped {code:int, message:string}).
    let valid = obj.get("jsonrpc") == Some(&json!("2.0"))
        && !obj.contains_key("method")
        && is_json_rpc_id(&obj["id"])
        && obj.contains_key("result") != obj.contains_key("error")
        && (!obj.contains_key("error") || is_error_response(&obj["error"]));
    if !valid {
        // pendingResponse.reject(RequestError.invalidRequest(response))
        let _ = waiter.send(Err("Invalid request".to_string()));
    } else if let Some(result) = obj.get("result") {
        let _ = waiter.send(Ok(result.clone()));
    } else {
        // pendingResponse.reject(new RequestError(code, message, data)) —
        // callers observe error.message.
        let message = obj["error"]
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let _ = waiter.send(Err(message));
    }
}

/// Dispatch one inbound ndjson frame (jsonrpc.js receiveWireMessage /
/// receiveMessage). Returns false when the connection must close.
fn handle_line(inner: &Arc<Inner>, line: &[u8]) -> bool {
    // stream.js enqueueLine: decode, trim, skip blank.
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let message: Value = match serde_json::from_str(trimmed) {
        Ok(message) => message,
        Err(_) => {
            // SDK replies protocolErrorResponse(RequestError.parseError()) and
            // keeps the connection open — it does NOT close on bad JSON.
            send_wire(
                inner,
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}}),
            );
            return true;
        }
    };
    if message.is_array() {
        // ACP connects with allowBatches:false → close(TypeError(...)); the
        // TypeError message becomes the pending-requests rejection reason.
        fail_reason(
            inner,
            "ACP 连接已关闭。".to_string(),
            "JSON-RPC batches are not supported on this connection",
        );
        return false;
    }
    let Some(obj) = message.as_object() else {
        // stream.js: protocolErrorResponse(RequestError.invalidRequest(message))
        send_wire(
            inner,
            json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Invalid request", "data": message}}),
        );
        return true;
    };
    let envelope = obj.get("jsonrpc") == Some(&json!("2.0"));
    let method = obj.get("method").and_then(Value::as_str);
    if let (true, Some(method)) = (
        envelope && obj.contains_key("id") && is_json_rpc_id(&obj["id"]),
        method,
    ) {
        // Inbound request: only session/request_permission has a handler.
        // The SDK processes it on a promise — spawn a task and reply with
        // {id, result: <permission cb response>} when it resolves.
        let id = obj["id"].clone();
        let params = match inner
            .harness
            .inbound(obj.get("params").cloned().unwrap_or(Value::Null))
        {
            Ok(params) => params,
            Err(error) => {
                fail(inner, error);
                return false;
            }
        };
        if method == "session/request_permission" {
            let inner = inner.clone();
            tokio::spawn(async move {
                let result =
                    pi_acp_core::panic_guard::run(async { (inner.permission)(params).await }).await;
                let result = match result {
                    Ok(value) => value,
                    Err(_) => {
                        fail(&inner, "ACP 授权处理异常，工作进程已关闭。".into());
                        return;
                    }
                };
                send_wire(
                    &inner,
                    json!({"jsonrpc": "2.0", "id": id, "result": result}),
                );
            });
        } else {
            // responder.respondWithError(RequestError.methodNotFound(method))
            send_wire(
                inner,
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("\"Method not found\": {}", method), "data": {"method": method}}}),
            );
        }
        return true;
    }
    if envelope && !obj.contains_key("id") && method.is_some() {
        // Inbound notification ($/cancelRequest is ignored like an
        // unimplemented protocol hook).
        if method == Some("session/update") {
            match inner
                .harness
                .inbound(obj.get("params").cloned().unwrap_or(Value::Null))
            {
                Ok(params) => {
                    if let Err(error) = crate::acp_validation::notification(&params) {
                        fail(inner, error);
                        return false;
                    }
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (inner.update)(params)
                    }))
                    .is_err()
                    {
                        fail(inner, "ACP 通知处理异常，工作进程已关闭。".into());
                        return false;
                    }
                }
                Err(error) => {
                    fail(inner, error);
                    return false;
                }
            }
        }
        return true;
    }
    if !obj.contains_key("method")
        && (obj.contains_key("id") || obj.contains_key("result") || obj.contains_key("error"))
    {
        // isResponseShapedMessage → handleResponse when an id is present,
        // else the SDK just console.errors "Invalid message".
        if obj.contains_key("id") {
            resolve_response(inner, obj);
        }
        return true;
    }
    // Record that is none of request/notification/response-shaped.
    send_wire(
        inner,
        json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Invalid request", "data": message}}),
    );
    true
}

/// stdout reader — the SDK's readable half of ndJsonStream. Line accumulation
/// via fill_buf keeps the 16 MiB cap without an intermediate full-line buffer.
async fn reader_task(inner: Arc<Inner>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line: Vec<u8> = Vec::new();
    enum End {
        Line,
        Eof,
        TooLong,
        Io,
    }
    loop {
        line.clear();
        let end = loop {
            let (found, consumed) = {
                match reader.fill_buf().await {
                    Err(_) => break End::Io,
                    Ok([]) => {
                        // EOF: flush() — a trailing partial line is still
                        // parsed (SDK lines.flush() → enqueueLine).
                        break if line.is_empty() { End::Eof } else { End::Line };
                    }
                    Ok(buf) => match buf.iter().position(|b| *b == b'\n') {
                        Some(pos) => {
                            line.extend_from_slice(&buf[..pos]);
                            (true, pos + 1)
                        }
                        None => {
                            line.extend_from_slice(buf);
                            (false, buf.len())
                        }
                    },
                }
            };
            reader.consume(consumed);
            // Check the cap for complete lines too — a >16 MiB line ending in
            // this same chunk must not reach handle_line (SDK throws and
            // closes on the byte limit regardless of framing).
            if line.len() > MAX_LINE_BYTES {
                break End::TooLong;
            }
            if found {
                break End::Line;
            }
        };
        match end {
            End::Line => {
                if !handle_line(&inner, &line) {
                    return;
                }
            }
            End::Eof => {
                // Node fires 'exit' before the connection observes stream end —
                // yield briefly so 'ACP 进程退出 (…)。' wins over the
                // connection-closed message.
                if !*inner.exit_tx.borrow() {
                    let mut rx = inner.exit_rx.clone();
                    let _ = tokio::time::timeout(EOF_GRACE, rx.wait_for(|v| *v)).await;
                }
                fail(&inner, "ACP 连接已关闭。".to_string());
                return;
            }
            End::TooLong => {
                // MessageTooLargeError verbatim — it is also the reason
                // pending requests reject with.
                fail_reason(
                    &inner,
                    "ACP 连接已关闭。".to_string(),
                    &format!(
                        "Incoming ACP data exceeds the configured {MAX_LINE_BYTES} byte limit"
                    ),
                );
                return;
            }
            End::Io => {
                fail(&inner, "ACP 连接已关闭。".to_string());
                return;
            }
        }
    }
}

async fn writer_task(
    inner: Arc<Inner>,
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<Value>,
) {
    while let Some(message) = rx.recv().await {
        let mut line = serde_json::to_vec(&message).unwrap_or_default();
        line.push(b'\n');
        if let Err(error) = stdin.write_all(&line).await {
            fail(&inner, error.to_string());
            return;
        }
        if let Err(error) = stdin.flush().await {
            fail(&inner, error.to_string());
            return;
        }
    }
    // Channel closed (dispose) → stdin drops here → child sees EOF.
}

async fn stderr_task(inner: Arc<Inner>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => (inner.log)(&String::from_utf8_lossy(&line)),
        }
    }
}

pub struct AgentProcess {
    inner: Arc<Inner>,
    info: Mutex<Option<Value>>,
}

impl AgentProcess {
    pub fn spawn(options: AgentOptions) -> Result<Self, String> {
        let mut command = Command::new(&options.command);
        command
            .args(&options.args)
            .current_dir(&options.cwd)
            // Inherit the OS environment without decoding it; apply worker overrides.
            .envs(&options.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // detached:true → own process group so killpg(-pid) works later.
        // SAFETY: pre_exec runs post-fork pre-exec in the child; setsid() is
        // async-signal-safe and takes no locks. Failure aborts the spawn.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!(
                    "无法启动 Pi Agent ACP 进程：{error}。请检查 sessions.json 的 command/env 和远端 PATH。安装：npm install -g @earendil-works/pi-coding-agent"
                );
                (options.closed)(message.clone());
                return Err(message);
            }
        };
        let pid = child.id().unwrap_or(0);
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err("ACP 工作进程 stdio 管道不可用".to_string());
        };
        let (exit_tx, exit_rx) = watch::channel(false);
        let (write_tx, write_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            harness: options.harness,
            update: options.update,
            permission: options.permission,
            log: options.log,
            closed: options.closed,
            request_timeout: options.request_timeout,
            cwd: options.cwd,
            pid,
            closed_flag: AtomicBool::new(false),
            exited_flag: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            pending: StdMutex::new(HashMap::new()),
            write_tx: StdMutex::new(Some(write_tx)),
            exit_tx,
            exit_rx,
        });
        // stderr → log cb; writer owns stdin; reader owns stdout.
        tokio::spawn(stderr_task(inner.clone(), stderr));
        tokio::spawn(writer_task(inner.clone(), stdin, write_rx));
        tokio::spawn(reader_task(inner.clone(), stdout));
        // 'exit' monitor — owns Child::wait. fail() runs BEFORE the watch
        // send so the exit message wins over the reader's EOF handling
        // (Node delivers 'exit' before connection.closed).
        let monitor = inner.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            monitor.exited_flag.store(true, Ordering::SeqCst);
            fail(
                &monitor,
                format!(
                    "ACP 进程退出 ({})。请查看 Pi Agent 日志。",
                    describe_exit(status)
                ),
            );
            monitor.exit_tx.send_replace(true);
        });
        Ok(Self {
            inner,
            info: Mutex::new(None),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed_flag.load(Ordering::SeqCst)
    }

    /// initialize() response — for capability checks (image support).
    pub async fn info(&self) -> Option<Value> {
        self.info.lock().await.clone()
    }

    pub async fn request(&self, method: &str, mut params: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("ACP connection closed".to_string());
        }
        if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
            params["sessionId"] = self.inner.harness.native_id(id)?.into();
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        // Register before writing — a fast reply may beat the send.
        self.inner.pending.lock_unpoisoned().insert(id, tx);
        let mut frame = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if !params.is_null() {
            frame["params"] = params;
        }
        if !send_wire(&self.inner, frame) {
            self.inner.pending.lock_unpoisoned().remove(&id);
            return Err("ACP connection closed".to_string());
        }
        let result = rx
            .await
            .unwrap_or_else(|_| Err("ACP connection closed".to_string()))?;
        crate::acp_validation::response(method, &result)?;
        Ok(result)
    }

    pub async fn with_timeout(
        &self,
        future: impl std::future::Future<Output = Result<Value, String>>,
        ms: u64,
    ) -> Result<Value, String> {
        tokio::select! {
            result = future => result,
            _ = tokio::time::sleep(Duration::from_millis(ms)) => {
                fail(&self.inner, "ACP 请求超时，连接已关闭。".to_string());
                // `${ms / 1000}` — f64 Display matches JS number formatting for
                // the used values (20/30/180 seconds, fractional ms).
                Err(format!("ACP 请求超过 {} 秒，连接已关闭。", ms as f64 / 1000.0))
            }
        }
    }

    pub async fn initialize(&self) -> Result<Value, String> {
        let result = self
            .with_timeout(
                self.request(
                    "initialize",
                    json!({
                        "protocolVersion": 1,
                        "clientInfo": {"name": "pi-acp-workbench", "title": "Pi ACP Workbench", "version": "0.11.2"},
                        "clientCapabilities": {},
                    }),
                ),
                20_000,
            )
            .await;
        let info = match result {
            Err(error) => {
                self.dispose();
                return Err(error);
            }
            Ok(info) => info,
        };
        // JS `!== 1` — compare as f64 so `1.0` also counts as version 1.
        if info.get("protocolVersion").and_then(Value::as_f64) != Some(1.0) {
            self.dispose();
            return Err(format!(
                "不支持 ACP 协议版本 {}",
                js_display(info.get("protocolVersion"))
            ));
        }
        *self.info.lock().await = Some(info.clone());
        Ok(info)
    }

    /// id=None → session/new; Some → session/load (requires loadSession capability).
    /// Both wrapped in withTimeout default (requestTimeoutMs ?? 30000 →
    /// options.request_timeout). session/load result gains `sessionId: id`.
    pub async fn create_session(&self, id: Option<&str>) -> Result<Value, String> {
        let default_ms = self.inner.request_timeout.as_millis() as u64;
        let mut params = json!({"cwd": self.inner.cwd, "mcpServers": []});
        let Some(id) = id else {
            let result = self
                .with_timeout(self.request("session/new", params), default_ms)
                .await?;
            return self.inner.harness.inbound(result);
        };
        let capable = {
            let info = self.info.lock().await;
            info.as_ref()
                .and_then(|info| info.pointer("/agentCapabilities/loadSession"))
                .is_some_and(js_truthy)
        };
        if !capable {
            return Err("此 Agent 未声明 session/load 能力，无法恢复远端会话。".to_string());
        }
        params["sessionId"] = json!(id);
        let result = self
            .with_timeout(self.request("session/load", params), default_ms)
            .await?;
        let mut obj = result.as_object().cloned().unwrap_or_default();
        obj.insert("sessionId".to_string(), json!(id));
        Ok(Value::Object(obj))
    }

    /// Adapter policy is kept beside ACP negotiation, not duplicated in clients.
    pub async fn configure_session(&self, session: &mut Value) -> Result<(), String> {
        if self.inner.harness != Harness::Codex {
            return Ok(());
        }
        let needs_default = session
            .get("configOptions")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                options
                    .iter()
                    .any(|o| o["id"] == "collaboration_mode" && o["currentValue"] != "default")
            });
        if needs_default {
            let result = self.with_timeout(self.request("session/set_config_option", json!({ "sessionId": session["sessionId"], "configId": "collaboration_mode", "value": "default" })), 30_000).await?;
            session["configOptions"] = result["configOptions"].clone();
        }
        Ok(())
    }

    pub async fn prompt(&self, session_id: &str, prompt: Vec<Value>) -> Result<Value, String> {
        self.request(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": prompt}),
        )
        .await
    }

    pub async fn cancel(&self, session_id: &str) {
        let _ = send_wire(
            &self.inner,
            json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}}),
        );
    }

    pub async fn stop(&self) {
        self.dispose();
        let mut rx = self.inner.exit_rx.clone();
        let _ = rx.wait_for(|v| *v).await;
    }

    pub fn dispose(&self) {
        if self.inner.closed_flag.swap(true, Ordering::SeqCst) {
            return;
        }
        terminate(&self.inner, "ACP connection closed");
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc as tmpsc;

    /// test/contract-agent.mjs lives at the repo root, three levels up from
    /// this crate's manifest dir.
    fn agent_path() -> String {
        format!(
            "{}/../../../test/contract-agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    struct Cbs {
        updates: tmpsc::UnboundedReceiver<Value>,
        permissions: tmpsc::UnboundedReceiver<Value>,
        closed: tmpsc::UnboundedReceiver<String>,
    }

    fn test_options() -> (AgentOptions, Cbs) {
        let (update_tx, updates) = tmpsc::unbounded_channel();
        let (perm_tx, permissions) = tmpsc::unbounded_channel();
        let (closed_tx, closed) = tmpsc::unbounded_channel();
        (
            AgentOptions {
                harness: Harness::Pi,
                cwd: "/".to_string(),
                command: "node".to_string(),
                args: vec![agent_path()],
                env: HashMap::new(),
                update: Arc::new(move |notification| {
                    let _ = update_tx.send(notification);
                }),
                permission: Arc::new(move |request| {
                    let perm_tx = perm_tx.clone();
                    Box::pin(async move {
                        let _ = perm_tx.send(request);
                        // Same shape the service resolves ({outcome:…}).
                        json!({"outcome": {"outcome": "selected", "optionId": "yes"}})
                    })
                }),
                log: Arc::new(|_| {}),
                closed: Arc::new(move |error| {
                    let _ = closed_tx.send(error);
                }),
                request_timeout: Duration::from_secs(30),
            },
            Cbs {
                updates,
                permissions,
                closed,
            },
        )
    }

    #[tokio::test]
    async fn a_panicking_worker_callback_closes_only_that_worker() {
        let (mut options, _) = test_options();
        options.update = Arc::new(|_| panic!("unexpected notification callback bug"));
        let broken = AgentProcess::spawn(options).unwrap();
        broken.initialize().await.unwrap();
        let session = broken.create_session(None).await.unwrap();
        assert!(broken
            .prompt(
                session["sessionId"].as_str().unwrap(),
                vec![json!({"type":"text","text":"hello"})]
            )
            .await
            .is_err());
        assert!(broken.is_closed());
        broken.stop().await;
        let (options, _) = test_options();
        let healthy = AgentProcess::spawn(options).unwrap();
        healthy.initialize().await.unwrap();
        let session = healthy.create_session(None).await.unwrap();
        assert!(healthy
            .prompt(
                session["sessionId"].as_str().unwrap(),
                vec![json!({"type":"text","text":"hello"})]
            )
            .await
            .is_ok());
        healthy.stop().await;
    }

    #[tokio::test]
    async fn initialize_new_prompt_permission_cancel_stop() {
        let (options, mut cbs) = test_options();
        // Arc: in-flight prompts are spawned so a concurrent permission
        // request can arrive while the prompt future is pending (JS promises
        // are eager; Rust futures need a task to drive them).
        let agent = Arc::new(AgentProcess::spawn(options).expect("spawn contract-agent"));

        let info = agent.initialize().await.expect("initialize");
        assert_eq!(info["protocolVersion"], json!(1));
        assert_eq!(agent.info().await.unwrap()["protocolVersion"], json!(1));

        let session = agent.create_session(None).await.expect("session/new");
        let session_id = session["sessionId"].as_str().unwrap().to_string();
        assert!(!session_id.is_empty());

        // echo prompt → agent_message_chunk + tool_call updates + end_turn
        let result = agent
            .prompt(&session_id, vec![json!({"type": "text", "text": "hello"})])
            .await
            .expect("prompt");
        assert_eq!(result["stopReason"], json!("end_turn"));
        let mut updates = Vec::new();
        while let Ok(notification) = cbs.updates.try_recv() {
            updates.push(notification);
        }
        assert!(updates.iter().all(|n| n["sessionId"] == session_id));
        assert!(updates.iter().any(|n| {
            n["update"]["sessionUpdate"] == "agent_message_chunk"
                && n["update"]["content"]["text"] == "echo: hello"
        }));
        assert!(updates
            .iter()
            .any(|n| n["update"]["sessionUpdate"] == "tool_call"));

        // permission → cb fires → respond selected → end_turn
        let pending = {
            let agent = agent.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                agent
                    .prompt(
                        &session_id,
                        vec![json!({"type": "text", "text": "permission"})],
                    )
                    .await
            })
        };
        let request = tokio::time::timeout(Duration::from_secs(5), cbs.permissions.recv())
            .await
            .expect("permission request timed out")
            .expect("permission channel closed");
        assert_eq!(request["toolCall"]["toolCallId"], json!("write-1"));
        assert_eq!(
            pending.await.expect("join").expect("permission prompt")["stopReason"],
            json!("end_turn")
        );

        // wait + cancel → pending prompt resolves cancelled
        let pending = {
            let agent = agent.clone();
            let session_id = session_id.clone();
            tokio::spawn(async move {
                agent
                    .prompt(&session_id, vec![json!({"type": "text", "text": "wait"})])
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        agent.cancel(&session_id).await;
        assert_eq!(
            pending.await.expect("join").expect("wait prompt")["stopReason"],
            json!("cancelled")
        );

        agent.stop().await;
        assert!(agent.is_closed());
        assert!(
            cbs.closed.try_recv().is_err(),
            "clean stop must not call closed cb"
        );
    }

    #[tokio::test]
    async fn load_session_and_crash() {
        let (options, mut cbs) = test_options();
        let agent = AgentProcess::spawn(options).expect("spawn contract-agent");
        agent.initialize().await.expect("initialize");

        // contract-agent declares loadSession → session/load merges the id in.
        let session = agent
            .create_session(Some("native-123"))
            .await
            .expect("session/load");
        assert_eq!(session["sessionId"], json!("native-123"));

        // 'crash' → process.exit(7): pending rejects with the close reason and
        // the closed cb observes 'ACP 进程退出 (7)。…'.
        let error = agent
            .prompt("native-123", vec![json!({"type": "text", "text": "crash"})])
            .await
            .expect_err("crash must reject the prompt");
        assert_eq!(error, "ACP connection closed");
        let message = tokio::time::timeout(Duration::from_secs(5), cbs.closed.recv())
            .await
            .expect("closed cb timed out")
            .expect("closed channel closed");
        assert!(
            message.starts_with("ACP 进程退出 ("),
            "unexpected closed message: {message}"
        );
        assert!(agent.is_closed());
    }

    #[tokio::test]
    async fn load_requires_capability_and_timeout_fails() {
        let (options, mut cbs) = test_options();
        let agent = AgentProcess::spawn(options).expect("spawn contract-agent");

        // No initialize → no agentCapabilities → verbatim refusal.
        let error = agent
            .create_session(Some("x"))
            .await
            .expect_err("must refuse load");
        assert_eq!(
            error,
            "此 Agent 未声明 session/load 能力，无法恢复远端会话。"
        );

        // with_timeout: verbatim rejection + fail() → closed cb message.
        let error = agent
            .with_timeout(std::future::pending(), 50)
            .await
            .expect_err("must time out");
        assert_eq!(error, "ACP 请求超过 0.05 秒，连接已关闭。");
        let message = cbs.closed.recv().await.expect("closed cb");
        assert_eq!(message, "ACP 请求超时，连接已关闭。");
        assert!(agent.is_closed());
        agent.stop().await;
    }
}
