//! Unit-only local HTTP transport; no environment mutation or external API.
use crate::api::TelegramApi;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub struct Bot {
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
    pub api: Arc<TelegramApi>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl Bot {
    pub async fn new(handler: impl Fn(&str, &Value) -> Value + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let shutdown = stop.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {_ = shutdown.cancelled()=>break,accepted=listener.accept()=>accepted};
                let Ok((mut socket, _)) = accepted else {
                    break;
                };
                let seen = seen.clone();
                let handler = handler.clone();
                let stop = shutdown.clone();
                tokio::spawn(async move {
                    let request = async {
                        let mut bytes = Vec::new();
                        let mut buffer = [0u8; 4096];
                        let end = loop {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&buffer[..count]);
                            assert!(bytes.len() < 1024 * 1024);
                            if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                                break end + 4;
                            }
                        };
                        let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                        let method = headers
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap()
                            .trim_start_matches('/')
                            .to_string();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        assert!(length < 1024 * 1024);
                        while bytes.len() < end + length {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&buffer[..count]);
                        }
                        let params: Value =
                            serde_json::from_slice(&bytes[end..end + length]).unwrap();
                        seen.lock().unwrap().push((method.clone(), params.clone()));
                        let body = serde_json::to_vec(&handler(&method, &params)).unwrap();
                        let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                        socket.write_all(headers.as_bytes()).await.unwrap();
                        socket.write_all(&body).await.unwrap();
                    };
                    tokio::select! {_ = request=>{},_ = stop.cancelled()=>{}}
                });
            }
        });
        let api = Arc::new(TelegramApi::for_test(
            &format!("http://{address}"),
            stop.clone(),
        ));
        Self {
            calls,
            api,
            stop,
            task,
        }
    }
    pub async fn success() -> Self {
        Self::new(|_, _| json!({"ok":true,"result":{"message_id":100,"message_thread_id":201}}))
            .await
    }
}
impl Drop for Bot {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}
