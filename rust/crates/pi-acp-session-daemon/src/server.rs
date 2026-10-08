//! Bounded newline-delimited service transport with fragmented responses.
//! Per-socket writers serialize output; malformed input closes only its connection.
//! Allocation limits and frame deadlines are specified in docs/service-protocol.md.
use crate::state_stream::{StateStreams, Subscription};
use pi_acp_core::sync::MutexExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::future::Future;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const LINE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_PENDING: usize = 128;
const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTGOING_BYTES: usize = 128 * 1024 * 1024;
/// WIRE_LIMITS.partialMs — incomplete inbound frame / stalled write timeout.
const PARTIAL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_SESSION_ID: usize = 1000;
const MAX_REQUEST_ID: usize = 200;
const FRAGMENT_MIN: usize = 512 * 1024;
const FRAGMENT_UNITS: usize = 128 * 1024;

pub type Handler =
    Arc<dyn Fn(String, Value, String, mpsc::UnboundedSender<Value>) -> HandlerFuture + Send + Sync>;
pub type HandlerFuture =
    std::pin::Pin<Box<dyn Future<Output = Result<Value, crate::error::ServiceError>> + Send>>;

struct Conn {
    id: u64,
    queued_bytes: AtomicUsize,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    outbox: mpsc::UnboundedSender<String>,
    /// handler `emit` endpoint → emit_loop wraps each item as {event} → send().
    emit: mpsc::UnboundedSender<Value>,
    /// cancels reader/writer/emit tasks — Rust `socket.destroy()` equivalent.
    cancel: CancellationToken,
}

struct Shared {
    handle: Handler,
    states: Mutex<StateStreams>,
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next_conn: AtomicU64,
    pending: AtomicUsize,
    pending_bytes: AtomicUsize,
    buffered_bytes: AtomicUsize,
    outgoing_bytes: AtomicUsize,
    shutdown: CancellationToken,
    accept_task: Mutex<Option<JoinHandle<()>>>,
    #[cfg(test)]
    response_limit_override: Option<usize>,
}

impl Shared {
    fn response_limit(&self) -> usize {
        #[cfg(test)]
        if let Some(limit) = self.response_limit_override {
            return limit;
        }
        MAX_RESPONSE_BYTES
    }

    fn adjust_buffered(&self, delta: isize) -> bool {
        if delta >= 0 {
            self.buffered_bytes
                .fetch_add(delta as usize, Ordering::SeqCst)
                + delta as usize
                <= MAX_PENDING_BYTES
        } else {
            self.buffered_bytes
                .fetch_sub((-delta) as usize, Ordering::SeqCst);
            true
        }
    }

    fn close_conn(&self, conn: &Arc<Conn>) {
        conn.cancel.cancel();
        self.conns.lock_unpoisoned().remove(&conn.id);
    }

    fn enqueue(&self, conn: &Arc<Conn>, body: String) {
        if conn.cancel.is_cancelled() {
            return;
        }
        let bytes = body.len();
        let per = conn.queued_bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
        let global = self.outgoing_bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
        if per > self.response_limit() || global > MAX_OUTGOING_BYTES {
            conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
            self.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
            self.close_conn(conn);
            return;
        }
        if conn.outbox.send(body).is_err() {
            conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
            self.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
        }
    }

    fn send(&self, conn: &Arc<Conn>, frame: Value) {
        match encode(&frame, self.response_limit()) {
            Some(body) => self.enqueue(conn, body),
            None => {
                if let Some(id) = frame.get("id").and_then(Value::as_str) {
                    let fallback = json!({ "id": id, "error": "会话响应超过 64 MiB，请缩小查询范围或创建新会话。" });
                    if let Some(body) = encode(&fallback, LINE_LIMIT) {
                        self.enqueue(conn, body);
                    }
                }
            }
        }
    }

    fn receive(self: &Arc<Self>, conn: &Arc<Conn>, line: &[u8], size: usize) -> Result<(), ()> {
        let item: Value = serde_json::from_slice(line).map_err(|_| ())?;
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return Err(());
        };
        if id.encode_utf16().count() > MAX_REQUEST_ID {
            return Err(());
        }
        let Some(method) = item.get("method").and_then(Value::as_str) else {
            return Err(());
        };
        if !matches!(item.get("params"), Some(Value::Object(_) | Value::Array(_))) {
            return Err(());
        }
        let params = item.get("params").cloned().unwrap_or(Value::Null);

        if method == "_watch" {
            let session_id = params.get("sessionId").and_then(Value::as_str);
            let enabled = params.get("enabled").and_then(Value::as_bool);
            let session_id = match (session_id, enabled) {
                (Some(s), Some(_)) if s.encode_utf16().count() <= MAX_SESSION_ID => s,
                _ => {
                    self.send(conn, json!({ "id": id, "error": "无效订阅" }));
                    return Ok(());
                }
            };
            let enabled = enabled.unwrap();
            let mut subs = conn.subscriptions.lock_unpoisoned();
            if enabled && subs.len() >= MAX_SUBSCRIPTIONS && !subs.contains_key(session_id) {
                drop(subs);
                self.send(conn, json!({ "id": id, "error": "订阅已满" }));
                return Ok(());
            }
            if enabled {
                // Re-subscribing explicitly resets the baseline, including resync after a gap.
                subs.insert(
                    session_id.to_string(),
                    Subscription {
                        permissions_only: params.get("permissionsOnly").and_then(Value::as_bool)
                            == Some(true),
                        revision: None,
                    },
                );
            } else {
                subs.remove(session_id);
            }
            drop(subs);
            self.send(conn, json!({ "id": id, "value": true }));
            return Ok(());
        }

        if self.pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            self.send(
                conn,
                json!({ "id": id, "error": "会话服务请求队列已满，请稍后重试。" }),
            );
            return Ok(());
        }
        if self.pending_bytes.fetch_add(size, Ordering::SeqCst) + size > MAX_PENDING_BYTES {
            self.pending_bytes.fetch_sub(size, Ordering::SeqCst);
            self.pending.fetch_sub(1, Ordering::SeqCst);
            self.send(
                conn,
                json!({ "id": id, "error": "会话服务请求队列已满，请稍后重试。" }),
            );
            return Ok(());
        }

        let shared = self.clone();
        let conn = conn.clone();
        let emit = conn.emit.clone();
        let id = id.to_string();
        let method = method.to_string();
        tokio::spawn(async move {
            let result = (shared.handle)(method.clone(), params, id.clone(), emit).await;
            let frame = match result {
                Ok(Value::Null) if method == "remove" || method == "historyRemove" => {
                    json!({ "id": id })
                }
                Ok(value) => json!({ "id": id, "value": value }),
                Err(error) => {
                    let frame =
                        json!({ "id": id, "error": error.to_string(), "code": error.code() });
                    frame
                }
            };
            shared.send(&conn, frame);
            shared.pending.fetch_sub(1, Ordering::SeqCst);
            shared.pending_bytes.fetch_sub(size, Ordering::SeqCst);
        });
        Ok(())
    }

    async fn accept_loop(self: &Arc<Self>, listener: UnixListener) {
        loop {
            let Some((mut stream, _)) =
                accept_with_retry(|| listener.accept(), &self.shutdown).await
            else {
                break;
            };
            if self.conns.lock_unpoisoned().len() >= MAX_CONNECTIONS {
                eprintln!("[sessions] connection limit reached ({MAX_CONNECTIONS})");
                // Read just the first bounded request to return a correlated error.
                // Keep rejection on this loop so overload cannot spawn unbounded tasks.
                tokio::select! {
                    _ = self.shutdown.cancelled() => break,
                    _ = tokio::time::timeout(ACCEPT_RETRY_DELAY, reject_connection(&mut stream)) => {}
                }
                if !accept_retry_delay(&self.shutdown).await {
                    break;
                }
                continue;
            }
            let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<String>();
            let (emit_tx, emit_rx) = mpsc::unbounded_channel::<Value>();
            let conn = Arc::new(Conn {
                id: self.next_conn.fetch_add(1, Ordering::SeqCst),
                queued_bytes: AtomicUsize::new(0),
                subscriptions: Mutex::new(HashMap::new()),
                outbox: outbox_tx,
                emit: emit_tx,
                cancel: CancellationToken::new(),
            });
            {
                let mut conns = self.conns.lock_unpoisoned();
                conns.insert(conn.id, conn.clone());
            }
            let (read, write) = stream.into_split();
            tokio::spawn(writer_loop(self.clone(), conn.clone(), write, outbox_rx));
            tokio::spawn(emit_loop(self.clone(), conn.clone(), emit_rx));
            tokio::spawn(reader_loop(self.clone(), conn, read));
        }
    }
}

async fn accept_retry_delay(shutdown: &CancellationToken) -> bool {
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => false,
        _ = tokio::time::sleep(ACCEPT_RETRY_DELAY) => true,
    }
}

async fn accept_with_retry<T, F, A>(mut accept: F, shutdown: &CancellationToken) -> Option<T>
where
    F: FnMut() -> A,
    A: Future<Output = std::io::Result<T>>,
{
    loop {
        let result = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return None,
            result = accept() => result,
        };
        match result {
            Ok(stream) => return Some(stream),
            Err(error) => {
                eprintln!("[sessions] accept failed: {error}; retrying in 100 ms");
                if !accept_retry_delay(shutdown).await {
                    return None;
                }
            }
        }
    }
}

async fn reject_connection(stream: &mut tokio::net::UnixStream) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut line = Vec::new();
    let mut reader = BufReader::new((&mut *stream).take(64 * 1024));
    if reader.read_until(b'\n', &mut line).await.is_err() || line.last() != Some(&b'\n') {
        return;
    }
    drop(reader);
    if let Ok(item) = serde_json::from_slice::<Value>(&line) {
        if let Some(id) = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| id.encode_utf16().count() <= MAX_REQUEST_ID)
        {
            let frame =
                json!({"id": id, "error": "会话服务连接已满，请稍后重试。", "code": "busy"});
            let _ = stream.write_all(format!("{frame}\n").as_bytes()).await;
        }
    }
}

async fn reader_loop(shared: Arc<Shared>, conn: Arc<Conn>, mut read: OwnedReadHalf) {
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 64 * 1024];
    let mut bytes = 0usize;
    let mut deadline: Option<tokio::time::Instant> = None;
    'read: loop {
        let n = match deadline {
            Some(dl) => tokio::select! {
                _ = conn.cancel.cancelled() => break 'read,
                _ = tokio::time::sleep_until(dl) => break 'read,
                r = read.read(&mut chunk) => match r {
                    Ok(0) | Err(_) => break 'read,
                    Ok(n) => n,
                },
            },
            None => tokio::select! {
                _ = conn.cancel.cancelled() => break 'read,
                r = read.read(&mut chunk) => match r {
                    Ok(0) | Err(_) => break 'read,
                    Ok(n) => n,
                },
            },
        };
        bytes += n;
        if !shared.adjust_buffered(n as isize) || bytes > LINE_LIMIT {
            break 'read;
        }
        buffer.extend_from_slice(&chunk[..n]);
        while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
            let size = end + 1;
            let line: Vec<u8> = buffer.drain(..size).collect();
            bytes -= size;
            shared.adjust_buffered(-(size as isize));
            if shared.receive(&conn, &line[..end], size).is_err() {
                break 'read;
            }
            if conn.cancel.is_cancelled() {
                break 'read;
            }
        }
        deadline = if buffer.is_empty() {
            None
        } else {
            deadline.or_else(|| Some(tokio::time::Instant::now() + PARTIAL_TIMEOUT))
        };
    }
    if bytes > 0 {
        shared.adjust_buffered(-(bytes as isize));
    }
    shared.close_conn(&conn);
}

async fn writer_loop(
    shared: Arc<Shared>,
    conn: Arc<Conn>,
    mut write: OwnedWriteHalf,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    loop {
        let body = tokio::select! {
            _ = conn.cancel.cancelled() => break,
            item = rx.recv() => match item {
                Some(body) => body,
                None => break,
            },
        };
        let bytes = body.len();
        let ok = flush_body(&mut write, &body, &conn.cancel).await.is_ok();
        conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
        shared.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
        if !ok {
            break;
        }
    }
    rx.close();
    while let Some(body) = rx.recv().await {
        let bytes = body.len();
        conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
        shared.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
    }
    shared.close_conn(&conn);
}

async fn flush_body(
    write: &mut OwnedWriteHalf,
    body: &str,
    cancel: &CancellationToken,
) -> Result<(), ()> {
    if body.len() <= FRAGMENT_MIN {
        return write_frame(write, body.as_bytes(), cancel).await;
    }
    // body.length in JS counts UTF-16 units — encode once, slice on unit edges;
    // cuts may split a surrogate pair (spec §4), which encode_fragment escapes.
    let units: Vec<u16> = body.encode_utf16().collect();
    for (i, slice) in units.chunks(FRAGMENT_UNITS).enumerate() {
        let last = (i + 1) * FRAGMENT_UNITS >= units.len();
        let frame = format!(
            "{{\"fragment\":\"{}\",\"last\":{last}}}\n",
            encode_fragment(slice)
        );
        write_frame(write, frame.as_bytes(), cancel).await?;
    }
    Ok(())
}

async fn write_frame(
    write: &mut OwnedWriteHalf,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), ()> {
    tokio::select! {
        _ = cancel.cancelled() => Err(()),
        result = tokio::time::timeout(PARTIAL_TIMEOUT, write.write_all(bytes)) => match result {
            Ok(Ok(())) => Ok(()),
            _ => Err(()),
        },
    }
}

async fn emit_loop(shared: Arc<Shared>, conn: Arc<Conn>, mut rx: mpsc::UnboundedReceiver<Value>) {
    loop {
        let event = tokio::select! {
            _ = conn.cancel.cancelled() => break,
            item = rx.recv() => match item {
                Some(event) => event,
                None => break,
            },
        };
        shared.send(&conn, json!({ "event": event }));
    }
}

fn encode(value: &Value, limit: usize) -> Option<String> {
    let mut body = serde_json::to_string(value).ok()?;
    body.push('\n');
    (body.len() <= limit).then_some(body)
}

/// spec §4 / skeleton contract: one UTF-16-unit slice → escaped JSON string
/// *content* (no surrounding quotes). serde_json refuses lone surrogates, so
/// the escapes are produced by hand, byte-identical to JSON.stringify: `"` `\\`
/// and the named control escapes; other <0x20 units and lone surrogates become
/// lowercase `\uXXXX`; intact surrogate pairs and everything else emit raw.
fn encode_fragment(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + units.len() / 8);
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5C => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x09 => out.push_str("\\t"),
            0x0A => out.push_str("\\n"),
            0x0C => out.push_str("\\f"),
            0x0D => out.push_str("\\r"),
            0x00..=0x1F => {
                let _ = write!(out, "\\u{u:04x}");
            }
            0xD800..=0xDBFF => {
                let low = units.get(i + 1).copied().unwrap_or(0);
                if (0xDC00..=0xDFFF).contains(&low) {
                    // intact pair — emit the scalar like JSON.stringify does.
                    let scalar = 0x1_0000 + (((u as u32) - 0xD800) << 10) + (low as u32 - 0xDC00);
                    out.push(char::from_u32(scalar).unwrap_or('\u{FFFD}'));
                    i += 1;
                } else {
                    // 切片边界上的孤立高代理 — JSON.stringify outputs \uXXXX too.
                    let _ = write!(out, "\\u{u:04x}");
                }
            }
            // 孤立低代理（切片起点）— same \uXXXX escape.
            0xDC00..=0xDFFF => {
                let _ = write!(out, "\\u{u:04x}");
            }
            _ => {
                if let Some(c) = char::from_u32(u as u32) {
                    out.push(c);
                }
            }
        }
        i += 1;
    }
    out
}

/// JS `||` truthiness for `snapshot?.id || notification?.sessionId`
/// (null/false/0/'' are falsy; objects are always truthy).
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Keep the socket private throughout bind/chmod and clean failed publication.
struct PrivateSocket {
    directory: PathBuf,
    path: PathBuf,
    listener: Option<UnixListener>,
}

impl PrivateSocket {
    fn bind(target: &std::path::Path) -> Result<Self, String> {
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let directory = parent.join(format!(".s-{}", &suffix[..8]));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|e| format!("无法创建 socket 私有目录：{e}"))?;
        let mut staged = Self {
            path: directory.join("s"),
            directory,
            listener: None,
        };
        staged.listener = Some(
            UnixListener::bind(&staged.path).map_err(|e| format!("无法监听会话 socket：{e}"))?,
        );
        std::fs::set_permissions(&staged.path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("无法设置会话 socket 权限：{e}"))?;
        Ok(staged)
    }

    fn publish(mut self, target: &std::path::Path) -> Result<UnixListener, String> {
        std::fs::rename(&self.path, target).map_err(|e| format!("无法发布会话 socket：{e}"))?;
        Ok(self.listener.take().expect("bound private socket"))
    }
}

impl Drop for PrivateSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    #[tokio::test]
    async fn publishes_only_a_private_socket_and_remains_connectable() {
        let root = std::env::temp_dir().join(format!("pi-socket-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        let target = root.join("sessions.sock");
        let staged = PrivateSocket::bind(&target).unwrap();
        assert!(!target.exists());
        assert_eq!(
            std::fs::metadata(&staged.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let directory = staged.directory.clone();
        let listener = staged.publish(&target).unwrap();
        assert!(!directory.exists());
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let client = tokio::net::UnixStream::connect(&target).await.unwrap();
        let (peer, _) = listener.accept().await.unwrap();
        drop((peer, client, listener));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_publication_cleans_the_private_directory() {
        let root = std::env::temp_dir().join(format!("pi-socket-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("occupied");
        std::fs::create_dir(&target).unwrap();
        let staged = PrivateSocket::bind(&target).unwrap();
        let directory = staged.directory.clone();
        assert!(staged.publish(&target).is_err());
        assert!(!directory.exists());
        assert!(target.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::sync::Semaphore;
    use tokio::time::timeout;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pi-server-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct Client {
        reader: BufReader<OwnedReadHalf>,
        writer: OwnedWriteHalf,
    }
    impl Client {
        async fn open(path: &std::path::Path) -> Self {
            let (reader, writer) = UnixStream::connect(path).await.unwrap().into_split();
            Self {
                reader: BufReader::new(reader),
                writer,
            }
        }
        async fn send(&mut self, id: &str, method: &str, params: Value) {
            self.writer
                .write_all(
                    format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes(),
                )
                .await
                .unwrap();
        }
        async fn reply(&mut self) -> Value {
            let mut line = String::new();
            timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }
    }
    async fn until(check: impl Fn() -> bool) {
        timeout(Duration::from_secs(5), async {
            while !check() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn oversize_errors_are_isolated_and_broadcasts_only_reach_subscribers() {
        let root = Root::new();
        let path = root.0.join("s");
        let mut server = SessionServer::new(
            path.clone(),
            Arc::new(|method, _, _, _| {
                Box::pin(async move {
                    Ok(if method == "large" {
                        json!("x".repeat(2048))
                    } else {
                        json!("ok")
                    })
                })
            }),
        );
        Arc::get_mut(&mut server.shared)
            .unwrap()
            .response_limit_override = Some(1024);
        server.listen().await.unwrap();
        let mut client = Client::open(&path).await;
        let mut other = Client::open(&path).await;
        client
            .send(
                "watch",
                "_watch",
                json!({"sessionId":"large","enabled":true}),
            )
            .await;
        assert_eq!(client.reply().await["value"], true);
        other
            .send(
                "watch",
                "_watch",
                json!({"sessionId":"other","enabled":true}),
            )
            .await;
        other.reply().await;
        client.send("large", "large", json!({})).await;
        assert!(client.reply().await["error"]
            .as_str()
            .unwrap()
            .contains("响应超过"));
        server.broadcast(json!({"type":"state","snapshot":{"id":"large","text":"x".repeat(2048)}}));
        assert_eq!(client.reply().await["event"]["type"], "serviceError");
        // If the other subscriber got the broadcast, this would read an event instead.
        other.send("hello", "hello", json!({})).await;
        assert_eq!(other.reply().await["value"], "ok");
        client.send("hello", "hello", json!({})).await;
        assert_eq!(client.reply().await["value"], "ok");
        drop((client, other));
        until(|| server.shared.conns.lock_unpoisoned().is_empty()).await;
        until(|| server.shared.outgoing_bytes.load(Ordering::SeqCst) == 0).await;
        server.dispose().await;
    }

    #[tokio::test]
    async fn delta_and_permission_subscriptions_coexist_and_resubscribe_resets() {
        let root = Root::new();
        let path = root.0.join("s");
        let server = SessionServer::new(
            path.clone(),
            Arc::new(|_, _, _, _| Box::pin(async { Ok(json!(true)) })),
        );
        server.listen().await.unwrap();
        let mut delta = Client::open(&path).await;
        let mut permissions = Client::open(&path).await;
        for (client, permissions_only) in [(&mut delta, false), (&mut permissions, true)] {
            let params =
                json!({"sessionId":"one","enabled":true,"permissionsOnly":permissions_only});
            client.send("watch", "_watch", params).await;
            assert_eq!(client.reply().await["value"], true);
        }
        let old = json!({"id":"old","text":"x".repeat(10000)});
        let state = |text: &str| json!({"type":"state","snapshot":{"id":"one","entries":[old,{"id":"live","text":text}]},"permissions":[],"busy":true});
        server.broadcast(state("中"));
        let first = delta.reply().await;
        assert_eq!(first["event"]["type"], "state");
        assert!(permissions.reply().await["event"]["snapshot"]
            .get("entries")
            .is_none());
        server.broadcast(state("中文😀"));
        let patch = delta.reply().await;
        assert_eq!(patch["event"]["baseRevision"], first["event"]["revision"]);
        assert_eq!(
            patch["event"]["entries"],
            json!([{"id":"live","text":"中文😀"}])
        );
        assert!(serde_json::to_vec(&patch).unwrap().len() < 500);
        permissions.reply().await;
        delta
            .send("watch", "_watch", json!({"sessionId":"one","enabled":true}))
            .await;
        delta.reply().await;
        server.broadcast(state("again"));
        assert_eq!(delta.reply().await["event"]["type"], "state");
        server.dispose().await;
    }

    #[tokio::test]
    async fn bounds_requests_and_connections_and_releases_all_accounting() {
        let root = Root::new();
        let path = root.0.join("s");
        let gate = Arc::new(Semaphore::new(0));
        let wait = gate.clone();
        let server = SessionServer::new(
            path.clone(),
            Arc::new(move |_, _, _, _| {
                let gate = wait.clone();
                Box::pin(async move {
                    gate.acquire().await.unwrap().forget();
                    Ok(json!("ok"))
                })
            }),
        );
        server.listen().await.unwrap();
        let mut client = Client::open(&path).await;
        for id in 0..=MAX_PENDING {
            client.send(&id.to_string(), "hold", json!({})).await;
        }
        assert!(client.reply().await["error"]
            .as_str()
            .unwrap()
            .contains("请求队列已满"));
        assert_eq!(server.shared.pending.load(Ordering::SeqCst), MAX_PENDING);
        gate.add_permits(MAX_PENDING);
        for _ in 0..MAX_PENDING {
            assert_eq!(client.reply().await["value"], "ok");
        }
        drop(client);
        until(|| server.shared.conns.lock_unpoisoned().is_empty()).await;
        until(|| {
            server.shared.pending.load(Ordering::SeqCst) == 0
                && server.shared.outgoing_bytes.load(Ordering::SeqCst) == 0
        })
        .await;
        assert_eq!(server.shared.pending_bytes.load(Ordering::SeqCst), 0);
        assert_eq!(server.shared.buffered_bytes.load(Ordering::SeqCst), 0);
        let mut clients = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            clients.push(Client::open(&path).await);
        }
        until(|| server.shared.conns.lock_unpoisoned().len() == MAX_CONNECTIONS).await;
        let mut extra = Client::open(&path).await;
        extra.send("overflow", "hello", json!({})).await;
        let rejected = extra.reply().await;
        assert_eq!(rejected["id"], "overflow");
        assert_eq!(rejected["code"], "busy");
        assert!(rejected["error"].as_str().unwrap().contains("连接已满"));
        assert!(timeout(Duration::from_secs(5), extra.reader.read_u8())
            .await
            .unwrap()
            .is_err());
        drop(clients);
        until(|| server.shared.conns.lock_unpoisoned().is_empty()).await;
        let mut partial = UnixStream::connect(&path).await.unwrap();
        partial.write_all(b"{\"id\":").await.unwrap();
        until(|| server.shared.buffered_bytes.load(Ordering::SeqCst) == 6).await;
        drop(partial);
        until(|| {
            server.shared.buffered_bytes.load(Ordering::SeqCst) == 0
                && server.shared.conns.lock_unpoisoned().is_empty()
        })
        .await;
        server.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn accept_errors_back_off_and_shutdown_interrupts_retry() {
        let shutdown = CancellationToken::new();
        let mut attempts = Vec::new();
        let start = tokio::time::Instant::now();
        let result = accept_with_retry(
            || {
                attempts.push(tokio::time::Instant::now() - start);
                std::future::ready(if attempts.len() < 3 {
                    Err(std::io::Error::from_raw_os_error(libc::EMFILE))
                } else {
                    Ok(42)
                })
            },
            &shutdown,
        )
        .await;
        assert_eq!(result, Some(42));
        assert_eq!(
            attempts,
            vec![Duration::ZERO, ACCEPT_RETRY_DELAY, ACCEPT_RETRY_DELAY * 2]
        );
        let cancel = shutdown.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel.cancel();
        });
        let start = tokio::time::Instant::now();
        let result = accept_with_retry(
            || {
                std::future::ready(Err::<(), _>(std::io::Error::from_raw_os_error(
                    libc::ENFILE,
                )))
            },
            &shutdown,
        )
        .await;
        assert_eq!(result, None);
        assert_eq!(
            tokio::time::Instant::now() - start,
            Duration::from_millis(10)
        );
    }

    #[tokio::test]
    async fn poisoned_global_connections_lock_does_not_stop_accepting() {
        let root = Root::new();
        let path = root.0.join("s");
        let server = SessionServer::new(
            path.clone(),
            Arc::new(|_, _, _, _| Box::pin(async { Ok(json!(true)) })),
        );
        assert!(pi_acp_core::panic_guard::run(async {
            let _guard = server.shared.conns.lock_unpoisoned();
            panic!("connection task bug");
        })
        .await
        .is_err());
        server.listen().await.unwrap();
        let mut client = Client::open(&path).await;
        client.send("hello", "hello", json!({})).await;
        assert_eq!(client.reply().await["value"], true);
        drop(client);
        until(|| server.shared.conns.lock_unpoisoned().is_empty()).await;
        server.dispose().await;
    }
}

pub struct SessionServer {
    path: PathBuf,
    shared: Arc<Shared>,
}

impl SessionServer {
    /// `handle(method, params, request_id, emit)` — `emit` pushes `{event}` frames
    /// to the requesting socket only (broadcast goes through `broadcast()`).
    pub fn new(path: PathBuf, handle: Handler) -> Self {
        SessionServer {
            path,
            shared: Arc::new(Shared {
                handle,
                states: Mutex::new(StateStreams::default()),
                conns: Mutex::new(HashMap::new()),
                next_conn: AtomicU64::new(1),
                pending: AtomicUsize::new(0),
                pending_bytes: AtomicUsize::new(0),
                buffered_bytes: AtomicUsize::new(0),
                outgoing_bytes: AtomicUsize::new(0),
                shutdown: CancellationToken::new(),
                accept_task: Mutex::new(None),
                #[cfg(test)]
                response_limit_override: None,
            }),
        }
    }

    /// Bind privately, set 0600, atomically publish, then serve until dispose().
    pub async fn listen(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| format!("无法创建会话服务目录：{e}"))?;
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("无法清理旧会话 socket：{e}")),
        }
        let listener = PrivateSocket::bind(&self.path)?.publish(&self.path)?;
        let shared = self.shared.clone();
        let task = self
            .shared
            .accept_task
            .lock_unpoisoned()
            .replace(tokio::spawn(
                async move { shared.accept_loop(listener).await },
            ));
        if let Some(task) = task {
            task.abort(); // double-listen: the older loop loses the path anyway
        }
        Ok(())
    }

    pub fn broadcast(&self, event: Value) {
        let session_id = match event.get("snapshot").and_then(|s| s.get("id")) {
            Some(v) if js_truthy(v) => Some(v),
            _ => event.get("notification").and_then(|n| n.get("sessionId")),
        };
        let Some(session_id) = session_id.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return;
        };
        // Serialize state revisions and writes so concurrent emitters cannot reorder patches.
        let mut states = self.shared.states.lock_unpoisoned();
        let targets: Vec<Arc<Conn>> = self
            .shared
            .conns
            .lock_unpoisoned()
            .values()
            .filter(|conn| {
                conn.subscriptions
                    .lock_unpoisoned()
                    .contains_key(session_id)
            })
            .cloned()
            .collect();
        if targets.is_empty() {
            return;
        }
        let state = (event.get("type").and_then(Value::as_str) == Some("state"))
            .then(|| states.next(session_id, event.clone()));
        for conn in targets {
            let frame = {
                let mut subscriptions = conn.subscriptions.lock_unpoisoned();
                let Some(subscription) = subscriptions.get_mut(session_id) else {
                    continue;
                };
                if let Some(state) = &state {
                    let frame = if subscription.permissions_only {
                        &state.permissions
                    } else if subscription.revision.is_some()
                        && subscription.revision == state.previous
                    {
                        state.patch.as_ref().unwrap_or(&state.full)
                    } else {
                        &state.full
                    };
                    subscription.revision = Some(state.revision);
                    frame
                } else {
                    if subscription.permissions_only {
                        continue;
                    }
                    &event
                }
                .clone()
            };
            let body =
                encode(&json!({"event":frame}), self.shared.response_limit()).or_else(|| {
                    encode(
                        &json!({"event":{"type":"serviceError","sessionId":session_id,
                    "error":"会话状态超过 64 MiB，请创建新会话。"}}),
                        LINE_LIMIT,
                    )
                });
            if let Some(body) = body {
                self.shared.enqueue(&conn, body);
            }
        }
    }

    pub async fn dispose(&self) {
        self.shared.shutdown.cancel();
        let task = self.shared.accept_task.lock_unpoisoned().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        for (_, conn) in self.shared.conns.lock_unpoisoned().drain() {
            conn.cancel.cancel(); // writer drains queued bytes on the way out
        }
        let _ = tokio::fs::remove_file(&self.path).await;
    }
}
