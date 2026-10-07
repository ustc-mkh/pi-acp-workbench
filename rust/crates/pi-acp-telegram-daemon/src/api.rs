//! TelegramApi port (src/telegram-api.ts): paced sends, 429 honor, redacted errors.
//! Production builds always use Telegram's official endpoint and caller pace.
//! The opt-in contract-test feature enables mock transport environment hooks.
use pi_acp_core::utf16::telegram_chunks;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const PACED: &[&str] = &["sendMessage", "editMessageText", "createForumTopic"];
const QUEUE_LIMIT: usize = 64;

#[derive(Debug)]
pub struct ApiError {
    pub code: i64,
    pub message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ApiError {}

type Result<T> = std::result::Result<T, ApiError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(ApiError {
        code: 0,
        message: message.into(),
    })
}

struct Pace {
    next_send: Instant,
}

pub struct TelegramApi {
    http: reqwest::Client,
    base: String,
    token: String,
    interval: Duration,
    pace: Mutex<Pace>,
    queued: AtomicUsize,
    stop: CancellationToken,
}

#[cfg(all(test, not(feature = "contract-test")))]
mod production_tests {
    use super::*;

    #[test]
    fn production_transport_ignores_mock_environment_hooks() {
        let keys = ["PI_TELEGRAM_API_BASE", "PI_TELEGRAM_PACE_MS"];
        let previous: Vec<_> = keys.iter().map(|key| std::env::var_os(key)).collect();
        std::env::set_var(keys[0], "http://attacker.invalid");
        std::env::set_var(keys[1], "1");
        let api = TelegramApi::new(
            "synthetic-token",
            Duration::from_millis(3100),
            CancellationToken::new(),
        );
        for (key, value) in keys.iter().zip(previous) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        assert_eq!(api.base, "https://api.telegram.org/botsynthetic-token");
        assert_eq!(api.interval, Duration::from_millis(3100));
    }
}

impl TelegramApi {
    pub fn new(token: &str, interval: Duration, stop: CancellationToken) -> Self {
        #[cfg(not(feature = "contract-test"))]
        let base = format!("https://api.telegram.org/bot{token}");
        #[cfg(feature = "contract-test")]
        let base = std::env::var("PI_TELEGRAM_API_BASE")
            .unwrap_or_else(|_| format!("https://api.telegram.org/bot{token}"));
        // Test hook: contract suites set PI_TELEGRAM_PACE_MS instead of waiting 3.1s/send.
        #[cfg(feature = "contract-test")]
        let interval = std::env::var("PI_TELEGRAM_PACE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or(interval);
        TelegramApi {
            http: reqwest::Client::new(),
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
            interval,
            pace: Mutex::new(Pace {
                next_send: Instant::now(),
            }),
            queued: AtomicUsize::new(0),
            stop,
        }
    }

    fn redact(&self, text: &str) -> String {
        pi_acp_core::utf16::utf16_head(&text.replace(&self.token, "[redacted]"), 500)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        if !PACED.contains(&method) {
            return self.request(method, params).await;
        }
        if self.queued.fetch_add(1, Ordering::SeqCst) >= QUEUE_LIMIT {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return err("Telegram 发送队列已满，请稍后重试。");
        }
        let result = async {
            let mut pace = self.pace.lock().await;
            let wait = pace.next_send.saturating_duration_since(Instant::now());
            if !wait.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = self.stop.cancelled() => return err("Telegram 已停止。"),
                }
            }
            if self.stop.is_cancelled() {
                return err("Telegram 已停止。");
            }
            let result = self.request(method, params).await;
            pace.next_send = Instant::now() + self.interval;
            result
        }
        .await;
        self.queued.fetch_sub(1, Ordering::SeqCst);
        result
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let url = format!("{}/{}", self.base, method);
        let timeout = if method == "getUpdates" {
            Duration::from_secs(40)
        } else {
            Duration::from_secs(20)
        };
        for attempt in 0.. {
            let body: Value = {
                let pending = async {
                    let response = self
                        .http
                        .post(&url)
                        .timeout(timeout)
                        .json(&params)
                        .send()
                        .await?;
                    response.json::<Value>().await
                };
                tokio::select! {
                    _ = self.stop.cancelled() => return err("Telegram 已停止。"),
                    response = pending => match response {
                        Ok(body) => body,
                        Err(_) => return err("Telegram 网络请求失败或超时，请检查服务器到 api.telegram.org 的连接。"),
                    },
                }
            };
            if body.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(body.get("result").cloned().unwrap_or(Value::Null));
            }
            let code = body.get("error_code").and_then(Value::as_i64).unwrap_or(0);
            let retry_after = body
                .pointer("/parameters/retry_after")
                .and_then(Value::as_i64);
            if code == 429 && attempt < 2 && matches!(retry_after, Some(r) if r > 0 && r <= 120) {
                let delay = Duration::from_secs(retry_after.unwrap() as u64);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => continue,
                    _ = self.stop.cancelled() => return err("Telegram 已停止。"),
                }
            }
            let description = body
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("API 请求失败");
            return Err(ApiError {
                code,
                message: format!("Telegram: {}", self.redact(description)),
            });
        }
        unreachable!()
    }
}

/// Outbound text split identical to telegramChunks(text, 3900).
pub fn chunks(text: &str) -> Vec<String> {
    telegram_chunks(text, 3900)
}
