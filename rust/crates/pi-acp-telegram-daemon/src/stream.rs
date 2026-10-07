//! Telegram stream: one coalesced preview message
//! per turn, throttled edits, chunked finish + completion notification.
use crate::api::{chunks, ApiError, TelegramApi};
use pi_acp_core::utf16::utf16_tail;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Mutex};

type BoxReport = Arc<dyn Fn(&ApiError) + Send + Sync>;

enum Command {
    Preview(String),
    Finish {
        text: String,
        notification: String,
        ack: oneshot::Sender<Result<(), ApiError>>,
    },
}

pub struct TelegramStream {
    tx: Mutex<Option<mpsc::Sender<Command>>>,
}

fn bounded_preview(mut text: String) -> String {
    if text.encode_utf16().count() > 3800 {
        format!("…（完整回复将在结束后补齐）\n{}", utf16_tail(&text, 3800))
    } else {
        text.shrink_to_fit();
        text
    }
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    #[tokio::test]
    async fn coalesces_one_hundred_updates_then_preserves_unicode_and_audible_completion() {
        let bot = crate::test_support::Bot::success().await;
        let enabled = Arc::new(AtomicBool::new(true));
        let silent = Arc::new(AtomicBool::new(false));
        let stream = TelegramStream::new(
            bot.api.clone(),
            -100,
            101,
            Duration::from_millis(500),
            enabled,
            silent,
            Arc::new(|error| panic!("unexpected error: {error}")),
        );
        for i in 0..100 {
            stream.update(format!("partial {i}")).await;
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while bot.calls.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        {
            let calls = bot.calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].1["text"], "partial 99");
        }
        let text = format!("{}last", "😀".repeat(5000));
        stream
            .finish(text.clone(), "✅ 任务完成".into())
            .await
            .unwrap();
        let calls = bot.calls.lock().unwrap();
        let output = calls[1..calls.len() - 1]
            .iter()
            .map(|(_, p)| p["text"].as_str().unwrap())
            .collect::<String>();
        assert_eq!(output, text);
        assert_eq!(calls.last().unwrap().1["disable_notification"], false);
        assert_eq!(calls.last().unwrap().1["message_thread_id"], 101);
        assert!(calls[1..calls.len() - 1].iter().all(|(_, p)| p["text"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count()
            <= 3900));
    }
    #[test]
    fn previews_own_small_buffers_instead_of_retaining_large_sources() {
        let previews: Vec<_> = (0..32)
            .map(|_| bounded_preview("x".repeat(4 * 1024 * 1024)))
            .collect();
        assert!(previews
            .iter()
            .all(|text| text.encode_utf16().count() < 3900));
        assert!(previews.iter().map(String::capacity).sum::<usize>() < 512 * 1024);
        let unicode = bounded_preview("😀".repeat(2 * 1024 * 1024));
        assert!(unicode.encode_utf16().count() < 3900);
        assert!(!unicode.contains('�'));
        assert!(unicode.capacity() < 32 * 1024);
        let mut overallocated = String::with_capacity(8 * 1024 * 1024);
        overallocated.push_str("short");
        assert!(bounded_preview(overallocated).capacity() < 128);
    }
}

impl TelegramStream {
    pub fn new(
        api: Arc<TelegramApi>,
        chat_id: i64,
        thread_id: i64,
        interval: Duration,
        enabled: Arc<AtomicBool>,
        silent: Arc<AtomicBool>,
        report: BoxReport,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<Command>(64);
        tokio::spawn(flush_loop(
            api, chat_id, thread_id, interval, enabled, silent, report, rx,
        ));
        TelegramStream {
            tx: Mutex::new(Some(tx)),
        }
    }

    /// Update the coalesced preview; oversized text keeps the last 3800 UTF-16
    /// units prefixed with an ellipsis, matching the reference implementation.
    pub async fn update(&self, text: String) {
        let preview = bounded_preview(text);
        let tx = self.tx.lock().await;
        if let Some(tx) = &*tx {
            let _ = tx.send(Command::Preview(preview)).await;
        }
    }

    /// Final chunks plus the completion notification. Errors from Telegram are
    /// propagated so the caller keeps the durable event for retry.
    pub async fn finish(&self, text: String, notification: String) -> Result<(), ApiError> {
        let Some(tx) = self.tx.lock().await.take() else {
            return Ok(());
        };
        let (ack, result) = oneshot::channel();
        if tx
            .send(Command::Finish {
                text,
                notification,
                ack,
            })
            .await
            .is_err()
        {
            return Ok(());
        }
        result.await.unwrap_or(Ok(()))
    }
}

impl Drop for TelegramStream {
    fn drop(&mut self) {
        // Dropping the sender ends the flush loop without further sends.
    }
}

#[allow(clippy::too_many_arguments)]
async fn flush_loop(
    api: Arc<TelegramApi>,
    chat_id: i64,
    thread_id: i64,
    interval: Duration,
    enabled: Arc<AtomicBool>,
    silent: Arc<AtomicBool>,
    report: BoxReport,
    mut rx: mpsc::Receiver<Command>,
) {
    let mut text = String::new();
    let mut shown = String::new();
    let mut message_id: Option<i64> = None;
    let mut flush_at: Option<Instant> = None;
    loop {
        let timer = async {
            match flush_at {
                Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            command = rx.recv() => match command {
                Some(Command::Preview(next)) => {
                    text = next;
                    if flush_at.is_none() && text != shown && enabled.load(Ordering::SeqCst) {
                        flush_at = Some(Instant::now() + interval);
                    }
                }
                Some(Command::Finish { text, notification, ack }) => {
                    let result = finish(&api, chat_id, thread_id, &enabled, &silent, &mut message_id, &shown, text, notification).await;
                    let _ = ack.send(result);
                    return;
                }
                None => return,
            },
            _ = timer => {
                flush_at = None;
                if text == shown || !enabled.load(Ordering::SeqCst) { continue; }
                let preview = if text.is_empty() { "正在处理…".to_string() } else { text.clone() };
                let result = match message_id {
                    Some(id) => api
                        .call("editMessageText", json!({ "chat_id": chat_id, "message_id": id, "text": preview }))
                        .await
                        .map(|_| ()),
                    None => api
                        .call("sendMessage", json!({
                            "chat_id": chat_id, "message_thread_id": thread_id,
                            "text": preview, "disable_notification": true,
                        }))
                        .await
                        .map(|m| { message_id = m.get("message_id").and_then(|v| v.as_i64()); }),
                };
                if let Err(error) = result { report(&error); } else { shown = text.clone(); }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    api: &TelegramApi,
    chat_id: i64,
    thread_id: i64,
    enabled: &AtomicBool,
    silent: &AtomicBool,
    message_id: &mut Option<i64>,
    shown: &str,
    text: String,
    notification: String,
) -> Result<(), ApiError> {
    if !enabled.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mut parts = chunks(&text);
    if let Some(id) = *message_id {
        let first = if parts.is_empty() {
            "本轮没有文本回复。".to_string()
        } else {
            parts.remove(0)
        };
        if first != shown || shown.encode_utf16().count() > 3800 {
            api.call(
                "editMessageText",
                json!({ "chat_id": chat_id, "message_id": id, "text": first }),
            )
            .await?;
        }
    }
    for part in parts {
        if !enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        api.call("sendMessage", json!({
            "chat_id": chat_id, "message_thread_id": thread_id, "text": part, "disable_notification": true,
        }))
        .await?;
    }
    if enabled.load(Ordering::SeqCst) {
        api.call(
            "sendMessage",
            json!({
                "chat_id": chat_id, "message_thread_id": thread_id,
                "text": notification, "disable_notification": silent.load(Ordering::SeqCst),
            }),
        )
        .await?;
    }
    Ok(())
}
