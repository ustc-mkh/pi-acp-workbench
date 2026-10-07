//! Session service socket client (docs/service-protocol.md). Client side of the
//! daemon socket: `{id,method,params}` requests, `{id,value|error}` replies,
//! `{fragment,last}` chunked responses and `{event}` pushes. Matches
//! SessionClient in src/session-wire.ts (single connection, no replay on drop).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, oneshot, Mutex};
use uuid::Uuid;

/// Per-line inbound bound; the server never sends a single frame this large.
const LINE_LIMIT: usize = 16 * 1024 * 1024;
/// WIRE_LIMITS.responseBytes — cumulative reassembled fragment cap.
const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;
/// Fragment stream cap: at most 2048 chunks (spec §4).
const FRAGMENT_PARTS: usize = 2048;
/// 10 s to continue a fragment sequence or the connection dies (spec §5).
const FRAGMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// WIRE_LIMITS.pending — the server destroys sockets that exceed 128 in-flight.
const PENDING_LIMIT: usize = 128;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum WireError {
    Io(io::Error),
    Closed,
    PendingFull,
    Timeout,
    /// `{id,error}` from the service.
    Service(String),
    Protocol(&'static str),
}
impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Io(e) => write!(f, "{e}"),
            WireError::Closed => write!(
                f,
                "Pi 会话服务连接已断开。请检查 pi-sessions.service；任务不会自动重发。"
            ),
            WireError::PendingFull => write!(f, "待处理服务请求过多"),
            WireError::Timeout => write!(f, "会话服务响应超时"),
            WireError::Service(m) => write!(f, "{m}"),
            WireError::Protocol(m) => write!(f, "会话协议无效：{m}"),
        }
    }
}
impl std::error::Error for WireError {}
impl From<io::Error> for WireError {
    fn from(e: io::Error) -> Self {
        WireError::Io(e)
    }
}

type PendingResult = Result<Value, WireError>;

struct Inner {
    writer: Mutex<OwnedWriteHalf>,
    pending: Mutex<HashMap<String, oneshot::Sender<PendingResult>>>,
    /// Fragmented response in progress as raw UTF-16 code units (spec §4 may
    /// sever surrogate pairs at chunk boundaries — serde_json can't represent
    /// lone surrogates, so fragments bypass JSON decoding until reassembled).
    /// `None` means interleaving is legal.
    /// (chunk count, code units) — 2048 parts / 64 MiB caps enforced.
    fragments: Mutex<Option<(usize, Vec<u16>)>>,
    events: broadcast::Sender<Value>,
    closed: AtomicBool,
}

pub struct WireClient {
    inner: Arc<Inner>,
}

impl WireClient {
    pub async fn connect(path: &Path) -> Result<Self, WireError> {
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| {
                WireError::Io(io::Error::new(io::ErrorKind::TimedOut, "connect timeout"))
            })??;
        let (read, write) = stream.into_split();
        let (events, _) = broadcast::channel(256);
        let inner = Arc::new(Inner {
            writer: Mutex::new(write),
            pending: Mutex::new(HashMap::new()),
            fragments: Mutex::new(None),
            events,
            closed: AtomicBool::new(false),
        });
        let task_inner = inner.clone();
        tokio::spawn(async move { task_inner.read_loop(read).await });
        Ok(WireClient { inner })
    }

    /// Broadcast of raw `{event}` payloads; closes when the connection drops.
    pub fn events(&self) -> broadcast::Receiver<Value> {
        self.inner.events.subscribe()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, WireError> {
        self.call_timeout(method, params, Some(DEFAULT_TIMEOUT))
            .await
    }

    /// `timeout: None` mirrors the TypeScript `timeout: 0` (prompt/create await the turn).
    pub async fn call_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, WireError> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(WireError::Closed);
        }
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<PendingResult>();
        {
            let mut pending = self.inner.pending.lock().await;
            if pending.len() >= PENDING_LIMIT {
                return Err(WireError::PendingFull);
            }
            pending.insert(id.clone(), tx);
        }
        let mut frame =
            serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
                .map_err(|_| WireError::Protocol("serialize request"))?;
        frame.push(b'\n');
        let wrote = self.inner.writer.lock().await.write_all(&frame).await;
        if let Err(e) = wrote {
            self.inner.pending.lock().await.remove(&id);
            return Err(WireError::Io(e));
        }
        let replied = match timeout {
            Some(t) => match tokio::time::timeout(t, rx).await {
                Ok(v) => Ok(v),
                Err(_) => Err(WireError::Timeout),
            },
            None => Ok(rx.await),
        };
        match replied {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(WireError::Closed), // sender dropped: connection died
            Err(e) => {
                self.inner.pending.lock().await.remove(&id);
                Err(e)
            }
        }
    }

    pub async fn watch(&self, session_id: &str, enabled: bool) -> Result<Value, WireError> {
        self.call(
            "_watch",
            json!({ "sessionId": session_id, "enabled": enabled }),
        )
        .await
    }

    pub async fn dispose(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        let _ = self.inner.writer.lock().await.shutdown().await;
        self.inner.fail_pending().await;
    }
}

/// Minimal `{fragment,last}` frame parser for chunks whose JSON string
/// contains a lone `\uXXXX` surrogate (spec §4). Extracts the raw string
/// literal and decodes escapes into UTF-16 code units without requiring
/// pairing. Returns None if the frame doesn't have the expected shape.
fn parse_fragment_frame(text: &str) -> Option<(Vec<u16>, bool)> {
    let key_pos = text.find("\"fragment\"")?;
    let mut chars = text[key_pos + 10..].char_indices().peekable();
    // skip ':' + whitespace
    while let Some((_, c)) = chars.next() {
        if c == '"' {
            break;
        }
        if !c.is_whitespace() && c != ':' {
            return None;
        }
    }
    let mut units = Vec::new();
    loop {
        let (_, c) = chars.next()?;
        match c {
            '"' => break,
            '\\' => {
                let (_, esc) = chars.next()?;
                match esc {
                    '"' | '\\' | '/' => units.push(esc as u16),
                    'b' => units.push(8),
                    'f' => units.push(12),
                    'n' => units.push(10),
                    'r' => units.push(13),
                    't' => units.push(9),
                    'u' => {
                        let mut value = 0u16;
                        for _ in 0..4 {
                            let (_, h) = chars.next()?;
                            value = value.checked_mul(16)?.checked_add(h.to_digit(16)? as u16)?;
                        }
                        units.push(value); // lone surrogates kept verbatim
                    }
                    _ => return None,
                }
            }
            c => units.extend_from_slice(c.encode_utf16(&mut [0u16; 2])),
        }
    }
    let rest: String = text[chars
        .peek()
        .map(|(i, _)| *i + key_pos + 10)
        .unwrap_or(text.len())..]
        .to_string();
    let last = rest.contains("\"last\":true") || rest.contains("\"last\": true");
    Some((units, last))
}

#[cfg(test)]
mod tests {
    use super::parse_fragment_frame;

    /// spec §4: a 128Ki-code-unit chunk boundary may sever a surrogate pair.
    /// serde_json rejects lone surrogates, so the manual parser must keep the
    /// raw unit; reassembly via from_utf16 must restore the pair.
    #[test]
    fn fragment_frame_keeps_lone_surrogate() {
        let (units, last) =
            parse_fragment_frame("{\"fragment\":\"prefix \\ud835\",\"last\":false}").unwrap();
        assert!(!last);
        assert_eq!(*units.last().unwrap(), 0xD835);
        let (tail, last) =
            parse_fragment_frame("{\"fragment\":\"\\udd4a tail\",\"last\":true}").unwrap();
        assert!(last);
        assert_eq!(tail[0], 0xDD4A);
        let mut all = units;
        all.extend_from_slice(&tail);
        let text = String::from_utf16(&all).unwrap();
        assert_eq!(text, "prefix 𝕊 tail"); // U+1D54A = \ud835\udd4a
    }

    #[test]
    fn fragment_frame_ignores_non_fragment() {
        assert!(parse_fragment_frame("{\"id\":\"x\"}").is_none());
    }
}

impl Inner {
    async fn read_loop(&self, read: tokio::net::unix::OwnedReadHalf) {
        let mut reader = BufReader::new(read);
        let mut line: Vec<u8> = Vec::new();
        loop {
            line.clear();
            // Mid-fragment streams must continue within 10 s (spec §5).
            let incoming = if self.fragments.lock().await.is_some() {
                match tokio::time::timeout(FRAGMENT_TIMEOUT, reader.read_until(b'\n', &mut line))
                    .await
                {
                    Ok(r) => r,
                    Err(_) => break,
                }
            } else {
                reader.read_until(b'\n', &mut line).await
            };
            let frame = match incoming {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.len() > LINE_LIMIT {
                        break;
                    }
                    let Ok(text) = std::str::from_utf8(&line) else {
                        break;
                    };
                    let text = text.trim_end();
                    match serde_json::from_str::<Value>(text) {
                        Ok(item) => item,
                        Err(_) => match parse_fragment_frame(text) {
                            // Lone-surrogate fragment chunk (spec §4).
                            Some((units, last)) => {
                                if self.dispatch_fragment(units, last).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                            None => break,
                        },
                    }
                }
            };
            if self.dispatch(frame).await.is_err() {
                break;
            }
        }
        self.closed.store(true, Ordering::SeqCst);
        self.fail_pending().await;
    }

    async fn dispatch(&self, item: Value) -> Result<(), ()> {
        if item.get("fragment").is_some() {
            // Shape gate: fragment must be a non-empty string and last a bool
            // (TS destroys the socket on any other shape).
            let last = match (item.get("fragment"), item.get("last")) {
                (Some(Value::String(s)), Some(Value::Bool(b))) if !s.is_empty() => (s.clone(), *b),
                _ => return Err(()),
            };
            let units: Vec<u16> = last.0.encode_utf16().collect();
            return self.dispatch_fragment(units, last.1).await;
        }
        if self.fragments.lock().await.is_some() {
            return Err(()); // interleaved frames inside a fragment stream
        }
        // TS: `if (item.event)` — falsy (null/false/0/"") falls through.
        if item.get("event").is_some_and(|v| {
            !matches!(v, Value::Null | Value::Bool(false))
                && !matches!(v, Value::Number(n) if n.as_f64() == Some(0.0))
                && !matches!(v, Value::String(s) if s.is_empty())
        }) {
            let _ = self.events.send(item["event"].clone());
            return Ok(());
        }
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if let Some(pending) = self.pending.lock().await.remove(id) {
                // TS: truthy error → reject, otherwise resolve value (a falsy
                // `error:null` resolves with item.value).
                let error = item.get("error");
                let result = match error {
                    Some(Value::String(m)) => Err(WireError::Service(m.clone())),
                    Some(v) if !matches!(v, Value::Null | Value::Bool(false)) => {
                        Err(WireError::Service(v.to_string()))
                    }
                    _ => Ok(item.get("value").cloned().unwrap_or(Value::Null)),
                };
                let _ = pending.send(result);
            }
        }
        Ok(())
    }

    async fn dispatch_fragment(&self, units: Vec<u16>, last: bool) -> Result<(), ()> {
        let mut frags = self.fragments.lock().await;
        let (parts, buffer) = frags.get_or_insert_with(|| (0, Vec::new()));
        *parts += 1;
        if *parts > FRAGMENT_PARTS || (buffer.len() + units.len()) * 2 > RESPONSE_LIMIT {
            return Err(());
        }
        buffer.extend_from_slice(&units);
        if last {
            let body = String::from_utf16(buffer).map_err(|_| ())?;
            *frags = None;
            drop(frags);
            let joined: Value = serde_json::from_str(&body).map_err(|_| ())?;
            return Box::pin(self.dispatch(joined)).await;
        }
        Ok(())
    }

    async fn fail_pending(&self) {
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(WireError::Closed));
        }
    }
}
