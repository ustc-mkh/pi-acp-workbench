//! Session service transport — docs/service-protocol.md.
//! Unix listener + bounded per-connection reader/writer.
//! TS parity notes below describe the retired implementation, not a dependency.
//!
//! Limits (MUST match): connections 32; inbound line 16 MiB; incomplete inbound
//! frame 10s destroys socket; global pending 128 ops / 32 MiB buffered request
//! bytes; per-socket outgoing 64 MiB queue, global 128 MiB; subscriptions ≤32;
//! sessionId ≤1000 chars; request id ≤200 chars.
//!
//! Frames (single-line JSON):
//!   request   {id, method, params}          params must be a JSON object (arrays
//!                                           pass typeof check but fail serviceCommand)
//!   response  {id, value} | {id, error}     value key OMITTED when result is undefined
//!   event     {event: {…}}                  only to sockets subscribed via _watch
//!   fragment  {id?, fragment, last}         responses >512 KiB are split at 128 KiB
//!
//! KEY SUBTLETY (spec §4): fragments are cut at 128 *KIB* of UTF-16 code units on
//! the JS string and may split a surrogate pair (escaped as \uXXXX in the frame).
//! In Rust: serialize the response with serde_json (UTF-8), then… NO — the JS
//! server slices the *string* in UTF-16 units. Equivalent: encode the serialized
//! JSON to UTF-16 (Vec<u16>), slice at 128*1024 u16 units, then emit each slice
//! as a JSON string — escaping lone surrogates manually since serde_json refuses
//! them. Implemented by `encode_fragment()` below; a slice that ends on a high
//! surrogate / starts on a low one is legal and REQUIRED for parity.
//!
//! Behavior (TS → Rust mapping):
//! - accept → if sockets>=32 destroy; else spawn reader+writer+emit tasks.
//! - per conn: Conn{outbox queue,queued_bytes,subscriptions}; reader loop:
//!   `{id,method,params}` validation (id string ≤200 UTF-16 units, method
//!   string, params object — JS `typeof [] === 'object'` passes the wire check)
//!   else destroy; `_watch` → validate sessionId str ≤1000 units + enabled bool;
//!   enabled && size>=32 && !has → {id,error:'订阅已满'} else add/remove +
//!   {id,value:true}; other methods → pending guard → spawn
//!   handle(method,params,id,emit) → {id,value} or {id,error: msg} — the emit
//!   channel sends {event} to THIS socket only.
//! - send(): serialize `{id,value}` — encode size >64MiB → fallback
//!   {id,error:'会话响应超过 64 MiB，请缩小查询范围或创建新会话。'}.
//! - writer loop = TS flush(): sequential per socket; >512*1024-byte bodies
//!   become fragment frames (sliced in UTF-16 units). Frame write timeout 10s →
//!   destroy. Queue caps → destroy socket on overflow.
//! - broadcast(event): sessionId = event.snapshot?.id || event.notification?.sessionId;
//!   only subscribed sockets. Oversized encode → fallback
//!   {event:{type:'serviceError',sessionId,error:'会话状态超过 64 MiB，请创建新会话。'}}.
//! - listen(): bind inside a private 0700 directory, chmod 0600, then publish by rename.
//! - dispose(): destroy all sockets, close listener, rm socket file.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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

/// WIRE_LIMITS / LIMIT from src/session-wire.ts — docs/service-protocol.md §3.
/// `LIMIT` doubles as the inbound line cap and the default encode() cap.
const LINE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 32;
const MAX_PENDING: usize = 128;
const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTGOING_BYTES: usize = 128 * 1024 * 1024;
/// WIRE_LIMITS.partialMs — incomplete inbound frame / stalled write timeout.
const PARTIAL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_SESSION_ID: usize = 1000;
const MAX_REQUEST_ID: usize = 200;
/// TS flush(): bodies whose UTF-8 byte length exceeds 512 KiB are fragmented.
const FRAGMENT_MIN: usize = 512 * 1024;
/// TS body.slice() step — 128 Ki UTF-16 code units; may split surrogate pairs.
const FRAGMENT_UNITS: usize = 128 * 1024;

pub type Handler =
    Arc<dyn Fn(String, Value, String, mpsc::UnboundedSender<Value>) -> HandlerFuture + Send + Sync>;
pub type HandlerFuture = std::pin::Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

/// TS `Outgoing` — per-socket writer state plus _watch subscriptions.
struct Conn {
    id: u64,
    /// TS state.bytes — bytes currently queued for this socket.
    queued_bytes: AtomicUsize,
    subscriptions: Mutex<HashSet<String>>,
    /// TS state.queue — serialized frames; the writer task is the only consumer,
    /// which makes every transfer sequential like the TS flush() loop.
    outbox: mpsc::UnboundedSender<String>,
    /// handler `emit` endpoint → emit_loop wraps each item as {event} → send().
    emit: mpsc::UnboundedSender<Value>,
    /// cancels reader/writer/emit tasks — Rust `socket.destroy()` equivalent.
    cancel: CancellationToken,
}

/// TS `this` (SessionServer privates): sockets, pending, pendingBytes,
/// bufferedBytes, outgoingBytes.
struct Shared {
    handle: Handler,
    /// TS this.sockets (id → live connection).
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next_conn: AtomicU64,
    /// TS this.pending — in-flight handler calls.
    pending: AtomicUsize,
    /// TS this.pendingBytes — bytes of in-flight requests.
    pending_bytes: AtomicUsize,
    /// TS this.bufferedBytes — global inbound buffered bytes (reader `adjust`).
    buffered_bytes: AtomicUsize,
    /// TS this.outgoingBytes — global queued outbound bytes.
    outgoing_bytes: AtomicUsize,
    /// server lifetime — stops the accept loop (TS server.close()).
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

    /// TS reader's `adjust(delta)` — global inbound buffered-byte accounting.
    /// Returns false when the added bytes push the total past 32 MiB.
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

    /// TS 'close' handler — drop the socket from the set and stop its tasks.
    /// Queued bytes are reclaimed by the writer task draining its channel.
    fn close_conn(&self, conn: &Arc<Conn>) {
        conn.cancel.cancel();
        self.conns.lock().unwrap().remove(&conn.id);
    }

    /// TS enqueue(): cap-check then queue a serialized frame for this socket.
    /// Reserve-then-check mirrors the single-threaded TS accounting exactly;
    /// overflow destroys the socket (TS socket.destroy()).
    fn enqueue(&self, conn: &Arc<Conn>, body: String) {
        if conn.cancel.is_cancelled() {
            return; // TS: !state || socket.destroyed → drop
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

    /// TS send(): encode under 64 MiB; oversize falls back to a fixed error —
    /// but only for {id,…} frames ({event} frames have no id and are dropped).
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

    /// TS accept-handler `reader(socket, receive, adjust)` receive callback —
    /// per-line request validation, `_watch`, pending guard, handler spawn.
    /// Err(()) destroys the socket (TS socket.destroy() on invalid frames).
    fn receive(self: &Arc<Self>, conn: &Arc<Conn>, line: &[u8], size: usize) -> Result<(), ()> {
        // TS: JSON.parse failure → destroy ('会话协议无效' — error event is a no-op,
        // so nothing reaches the client, matching serde failure → destroy here).
        let item: Value = serde_json::from_slice(line).map_err(|_| ())?;
        // TS: !item || typeof id!=='string' || id.length>200 || typeof method!=='string'
        //     || !params || typeof params!=='object' → destroy (no error frame).
        // `length` counts UTF-16 units; arrays pass the JS typeof-object check.
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
            let mut subs = conn.subscriptions.lock().unwrap();
            if enabled && subs.len() >= MAX_SUBSCRIPTIONS && !subs.contains(session_id) {
                drop(subs);
                self.send(conn, json!({ "id": id, "error": "订阅已满" }));
                return Ok(());
            }
            if enabled {
                subs.insert(session_id.to_string());
            } else {
                subs.remove(session_id);
            }
            drop(subs);
            self.send(conn, json!({ "id": id, "value": true }));
            return Ok(());
        }

        // TS pending/pendingBytes guard → error frame (not a destroy).
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

        // TS: Promise.resolve().then(()=>this.handle(method,params,id,emit))
        //     .then(v=>send({id,value:v}), e=>send({id,error:e.message}))
        //     .finally(()=>{pending--;pendingBytes-=bytes;})
        let shared = self.clone();
        let conn = conn.clone();
        let emit = conn.emit.clone();
        let id = id.to_string();
        let method = method.to_string();
        tokio::spawn(async move {
            let result = (shared.handle)(method.clone(), params, id.clone(), emit).await;
            // `remove`/`historyRemove` resolve `undefined` in TS → the value
            // key is OMITTED; other commands resolve a real JSON value.
            let frame = match result {
                Ok(Value::Null) if method == "remove" || method == "historyRemove" => {
                    json!({ "id": id })
                }
                Ok(value) => json!({ "id": id, "value": value }),
                Err(error) => {
                    let mut frame = json!({ "id": id, "error": error });
                    if !matches!(
                        method.as_str(),
                        "hello"
                            | "list"
                            | "create"
                            | "state"
                            | "cancel"
                            | "remove"
                            | "permission"
                            | "prompt"
                            | "request"
                            | "historyWrite"
                            | "historyRemove"
                    ) {
                        frame["code"] = json!("unknown_method");
                    }
                    frame
                }
            };
            shared.send(&conn, frame);
            shared.pending.fetch_sub(1, Ordering::SeqCst);
            shared.pending_bytes.fetch_sub(size, Ordering::SeqCst);
        });
        Ok(())
    }

    /// TS createServer(connection => {…}) accept loop.
    async fn accept_loop(self: &Arc<Self>, listener: UnixListener) {
        loop {
            let stream = tokio::select! {
                _ = self.shutdown.cancelled() => break,
                result = listener.accept() => match result {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                },
            };
            let (outbox_tx, outbox_rx) = mpsc::unbounded_channel::<String>();
            let (emit_tx, emit_rx) = mpsc::unbounded_channel::<Value>();
            let conn = Arc::new(Conn {
                id: self.next_conn.fetch_add(1, Ordering::SeqCst),
                queued_bytes: AtomicUsize::new(0),
                subscriptions: Mutex::new(HashSet::new()),
                outbox: outbox_tx,
                emit: emit_tx,
                cancel: CancellationToken::new(),
            });
            {
                let mut conns = self.conns.lock().unwrap();
                // TS: sockets.size>=WIRE_LIMITS.connections → socket.destroy().
                if conns.len() >= MAX_CONNECTIONS {
                    continue;
                }
                conns.insert(conn.id, conn.clone());
            }
            let (read, write) = stream.into_split();
            tokio::spawn(writer_loop(self.clone(), conn.clone(), write, outbox_rx));
            tokio::spawn(emit_loop(self.clone(), conn.clone(), emit_rx));
            tokio::spawn(reader_loop(self.clone(), conn, read));
        }
    }
}

/// TS reader(): consume a byte stream into buffered lines, enforce the 16 MiB
/// cap and the single-armed 10 s partial-frame timer, then call receive() per
/// line. Exiting destroys the connection (reader owns teardown).
async fn reader_loop(shared: Arc<Shared>, conn: Arc<Conn>, mut read: OwnedReadHalf) {
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 64 * 1024];
    let mut bytes = 0usize; // TS `bytes` — buffered byte count under `adjust`
                            // TS arms the 10 s timer ONCE when a remainder first appears and clears it
                            // when the buffer empties — it is NOT refreshed by later chunks.
    let mut deadline: Option<tokio::time::Instant> = None;
    'read: loop {
        let n = match deadline {
            Some(dl) => tokio::select! {
                _ = conn.cancel.cancelled() => break 'read,
                // TS: '会话消息未完整发送' → destroy (error object is a no-op event).
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
        // TS: !adjust(added) || bytes > LIMIT → destroy ('会话消息缓冲已满').
        if !shared.adjust_buffered(n as isize) || bytes > LINE_LIMIT {
            break 'read;
        }
        buffer.extend_from_slice(&chunk[..n]);
        while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
            let size = end + 1; // TS Buffer.byteLength(line)+1
            let line: Vec<u8> = buffer.drain(..size).collect();
            bytes -= size;
            shared.adjust_buffered(-(size as isize));
            if shared.receive(&conn, &line[..end], size).is_err() {
                break 'read;
            }
            // TS: if(socket.destroyed) after receive → stop processing lines.
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
    // TS release() on 'close' — return any buffered remainder to the global pool.
    if bytes > 0 {
        shared.adjust_buffered(-(bytes as isize));
    }
    shared.close_conn(&conn);
}

/// TS flush()+frame(): single sequential writer per socket. Bodies >512 KiB go
/// out as fragment frames; a failed/timed-out write destroys the socket.
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
        // TS: try{…}catch{socket.destroy()} — any frame error ends the socket.
        let ok = flush_body(&mut write, &body, &conn.cancel).await.is_ok();
        conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
        shared.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
        if !ok {
            break;
        }
    }
    // TS 'close': state.queue=[] — drain anything queued so the byte accounting
    // returns to zero (senders already failed or will fail on rx.close()).
    rx.close();
    while let Some(body) = rx.recv().await {
        let bytes = body.len();
        conn.queued_bytes.fetch_sub(bytes, Ordering::SeqCst);
        shared.outgoing_bytes.fetch_sub(bytes, Ordering::SeqCst);
    }
    shared.close_conn(&conn);
}

/// TS flush() body dispatch: ≤512 KiB writes the frame whole; larger bodies are
/// cut into 128 Ki-UTF-16-unit fragments {fragment,last} (TS sends no id).
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

/// TS frame(): one write bounded by the 10 s partialMs drain ceiling; timeout
/// or io error destroys the socket ('客户端读取超时' is a no-op error event).
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

/// TS emit closure: `event => this.send(socket, {event})` — scoped to this one
/// socket; broadcast() is the global path.
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

/// TS encode(value,limit): `JSON.stringify(value)+'\n'` under a UTF-8 byte cap.
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
        until(|| server.shared.conns.lock().unwrap().is_empty()).await;
        until(|| server.shared.outgoing_bytes.load(Ordering::SeqCst) == 0).await;
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
        until(|| server.shared.conns.lock().unwrap().is_empty()).await;
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
        until(|| server.shared.conns.lock().unwrap().len() == MAX_CONNECTIONS).await;
        let mut extra = UnixStream::connect(&path).await.unwrap();
        assert!(timeout(Duration::from_secs(5), extra.read_u8())
            .await
            .unwrap()
            .is_err());
        drop(clients);
        until(|| server.shared.conns.lock().unwrap().is_empty()).await;
        let mut partial = UnixStream::connect(&path).await.unwrap();
        partial.write_all(b"{\"id\":").await.unwrap();
        until(|| server.shared.buffered_bytes.load(Ordering::SeqCst) == 6).await;
        drop(partial);
        until(|| {
            server.shared.buffered_bytes.load(Ordering::SeqCst) == 0
                && server.shared.conns.lock().unwrap().is_empty()
        })
        .await;
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
        // TS rm(path,{force:true}) — missing file is fine, other errors fail.
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
            .lock()
            .unwrap()
            .replace(tokio::spawn(
                async move { shared.accept_loop(listener).await },
            ));
        if let Some(task) = task {
            task.abort(); // double-listen: the older loop loses the path anyway
        }
        Ok(())
    }

    /// Push `{event}` to every socket subscribed to the event's sessionId —
    /// TS broadcast(): snapshot.id || notification.sessionId routing, one shared
    /// encode, 64 MiB cap with serviceError fallback.
    pub fn broadcast(&self, event: Value) {
        let session_id = match event.get("snapshot").and_then(|s| s.get("id")) {
            Some(v) if js_truthy(v) => Some(v),
            _ => event.get("notification").and_then(|n| n.get("sessionId")),
        };
        // TS `sessionId && subscriptions.has(sessionId)` — a non-string value
        // can never match a Set<string>, and a falsy one short-circuits.
        let Some(session_id) = session_id.and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return;
        };
        let targets: Vec<Arc<Conn>> = self
            .shared
            .conns
            .lock()
            .unwrap()
            .values()
            .filter(|conn| conn.subscriptions.lock().unwrap().contains(session_id))
            .cloned()
            .collect();
        if targets.is_empty() {
            return;
        }
        let body = match encode(&json!({ "event": event }), self.shared.response_limit()) {
            Some(body) => body,
            None => match encode(
                &json!({
                    "event": {
                        "type": "serviceError",
                        "sessionId": session_id,
                        "error": "会话状态超过 64 MiB，请创建新会话。",
                    }
                }),
                LINE_LIMIT,
            ) {
                Some(body) => body,
                None => return,
            },
        };
        for conn in targets {
            self.shared.enqueue(&conn, body.clone());
        }
    }

    /// TS dispose(): destroy every socket, close the listener, rm socket file.
    pub async fn dispose(&self) {
        self.shared.shutdown.cancel();
        if let Some(task) = self.shared.accept_task.lock().unwrap().take() {
            task.abort();
            let _ = task.await;
        }
        for (_, conn) in self.shared.conns.lock().unwrap().drain() {
            conn.cancel.cancel(); // writer drains queued bytes on the way out
        }
        let _ = tokio::fs::remove_file(&self.path).await;
    }
}
