//! Production Telegram relay (no alternate Node daemon):
//!   PI_TELEGRAM_BOT_TOKEN=... pi-acp-telegram-daemon --config /path/telegram.json
//!     [--data-dir /path/pi-acp-workbench] [--discover] [--help]
//! Isolated contract-test builds support mock Bot API environment hooks.
mod api;
mod bridge;
mod config;
mod events;
mod markdown;
mod sessions;
mod stream;
#[cfg(test)]
mod test_support;

use api::TelegramApi;
use bridge::{Bridge, BridgeState};
use pi_acp_core::mkdir_lock::MkdirLock;
use serde_json::Value;
use sessions::Sessions;
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn data_root(args: &[String]) -> Result<PathBuf, String> {
    let index = args.iter().position(|a| a == "--data-dir");
    match index {
        Some(i) => {
            let value = args.get(i + 1).filter(|v| !v.starts_with("--"));
            value
                .map(|v| std::fs::canonicalize(v).unwrap_or_else(|_| PathBuf::from(v)))
                .ok_or("--data-dir 需要目录路径。".into())
        }
        None => Ok(dirs_home().join(".pi/pi-acp-workbench")),
    }
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn validate_state(value: &Value, bot_id: i64, chat_id: i64) -> Result<BridgeState, String> {
    let invalid = || "Telegram 绑定文件无效，请从备份恢复；不会自动重新执行旧任务。".to_string();
    let v = value.as_object().ok_or_else(invalid)?;
    if v.get("version").and_then(Value::as_u64) != Some(1)
        || v.get("botId").and_then(Value::as_i64) != Some(bot_id)
        || v.get("chatId").and_then(Value::as_i64) != Some(chat_id)
        || !v.get("topics").and_then(Value::as_array).is_some_and(|a| {
            a.iter().all(|t| {
                t.get("sessionId").and_then(Value::as_str).is_some()
                    && t.get("threadId")
                        .and_then(Value::as_i64)
                        .is_some_and(|id| id > 0)
            })
        })
        || !v
            .get("delivered")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().all(|d| d.is_string()))
        || !v
            .get("offset")
            .map(|o| o.as_i64().is_some_and(|i| i >= 0))
            .unwrap_or(true)
        || !v.get("silent").map(|s| s.is_boolean()).unwrap_or(true)
        || !v
            .get("notifications")
            .map(|s| s.is_boolean())
            .unwrap_or(true)
        || !v
            .get("historySent")
            .map(|h| {
                h.as_object().is_some_and(|m| {
                    m.values().all(|v| {
                        v.as_array()
                            .is_some_and(|a| a.iter().all(|k| k.is_string()))
                    })
                })
            })
            .unwrap_or(true)
    {
        return Err(invalid());
    }
    serde_json::from_value(value.clone()).map_err(|_| invalid())
}

fn report_fn(token: String) -> impl Fn(&str) + Send + Sync + 'static {
    move |error: &str| eprintln!("[telegram] {}", error.replace(&token, "[redacted]"))
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        println!(
            "Usage: PI_TELEGRAM_BOT_TOKEN=... pi-acp-telegram-daemon --config /path/telegram.json"
        );
        println!("Optional: --data-dir /path/pi-acp-workbench (default ~/.pi/pi-acp-workbench)");
        return Ok(());
    }
    let token = std::env::var("PI_TELEGRAM_BOT_TOKEN").unwrap_or_default();
    let valid_token = {
        let mut parts = token.splitn(2, ':');
        let id_ok = parts
            .next()
            .map(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        let secret_ok = parts
            .next()
            .map(|p| {
                p.len() >= 20
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
            .unwrap_or(false);
        id_ok && secret_ok
    };
    if !valid_token {
        return Err("请通过 PI_TELEGRAM_BOT_TOKEN 环境变量提供 BotFather token，不要放入项目配置或命令参数。".into());
    }

    let stop = CancellationToken::new();
    let api = Arc::new(TelegramApi::new(
        &token,
        Duration::from_millis(3100),
        stop.clone(),
    ));

    if args.iter().any(|a| a == "--discover") {
        let updates = api
            .call(
                "getUpdates",
                serde_json::json!({ "timeout": 20, "allowed_updates": ["message"] }),
            )
            .await
            .map_err(|e| e.message)?;
        for update in updates.as_array().cloned().unwrap_or_default() {
            if let Some(m) = update.get("message") {
                println!(
                    "{}",
                    serde_json::json!({
                        "chatId": m.pointer("/chat/id"),
                        "userId": m.pointer("/from/id"),
                        "threadId": m.get("message_thread_id"),
                    })
                );
            }
        }
        return Ok(());
    }

    let config_file = arg_value(&args, "--config")
        .ok_or("需要 --config /absolute/path/telegram.json；示例见 docs/telegram.md。")?;
    let raw: Value = serde_json::from_str(
        &std::fs::read_to_string(config_file)
            .map_err(|e| format!("无法读取 Telegram 配置：{e}"))?,
    )
    .map_err(|e| format!("Telegram 配置必须为 JSON 对象：{e}"))?;
    let mut cfg = config::parse(&raw)?;
    for (name, path) in cfg.workspaces.clone() {
        if !Path::new(&path).is_absolute() {
            return Err(format!("工作区 {name} 必须使用绝对路径。"));
        }
        let real =
            std::fs::canonicalize(&path).map_err(|e| format!("工作区 {name} 解析失败：{e}"))?;
        if !real.is_dir() {
            return Err(format!("工作区 {name} 不是目录。"));
        }
        cfg.workspaces
            .insert(name, real.to_string_lossy().into_owned());
    }

    let root = data_root(&args)?;
    let directory = root.join("telegram");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|e| format!("无法创建数据目录：{e}"))?;

    let bot = api
        .call("getMe", serde_json::json!({}))
        .await
        .map_err(|e| e.message)?;
    let bot_id = bot
        .get("id")
        .and_then(Value::as_i64)
        .ok_or("getMe 响应无效")?;
    let username = bot
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let stop_for_compromise = stop.clone();
    let lock = MkdirLock::acquire(
        &directory.join(format!("bot-{bot_id}")),
        Duration::from_secs(10),
        Duration::from_secs(30),
        move || {
            eprintln!("[telegram] Telegram 锁已失效，已停止避免并发运行。");
            stop_for_compromise.cancel();
        },
    )
    .await
    .map_err(|e| format!("Telegram relay 已在运行：{e}"))?;

    let state_file = directory.join(format!("bot-{bot_id}-chat-{}.json", cfg.chat_id));
    let mut data = BridgeState {
        version: 1,
        bot_id,
        chat_id: cfg.chat_id,
        offset: None,
        topics: vec![],
        delivered: vec![],
        notifications: None,
        silent: None,
        history_sent: None,
    };
    match std::fs::read_to_string(&state_file) {
        Ok(body) => {
            let value: Value = serde_json::from_str(&body).map_err(|_| {
                "Telegram 绑定文件无效，请从备份恢复；不会自动重新执行旧任务。".to_string()
            })?;
            data = validate_state(&value, bot_id, cfg.chat_id)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("无法读取 Telegram 绑定：{e}")),
    }

    let host = Sessions::connect(
        cfg.workspaces.clone(),
        &root.join("service/sessions.sock"),
        cfg.restrict_to_workspaces,
    )
    .await
    .map_err(|e| format!("无法连接会话服务：{e}"))?;

    let report: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(report_fn(token.clone()));
    let bridge = Bridge::new(
        api.clone(),
        host,
        data,
        bridge::Options {
            chat_id: cfg.chat_id,
            allowed_user_ids: cfg.allowed_user_ids,
            stream_interval: Duration::from_millis(3100),
            state_file: state_file.clone(),
            report: report.clone(),
            stop: stop.clone(),
        },
    );
    bridge.initialize(&username).await?;
    println!(
        "Telegram relay ready: @{username}, {}; send /help in the configured Topics group.",
        cfg.workspaces
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );

    // SIGINT/SIGTERM → graceful shutdown.
    {
        let stop = stop.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("signal");
            let mut int = signal(SignalKind::interrupt()).expect("signal");
            tokio::select! {
                _ = term.recv() => {}
                _ = int.recv() => {}
            }
            stop.cancel();
        });
    }

    let events_dir = directory.join("events");
    let sweep = {
        let bridge = bridge.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            while !stop.is_cancelled() {
                match events::Scanner::open(&events_dir).await {
                    Ok(mut scanner) => {
                        while !stop.is_cancelled() {
                            match scanner.next().await {
                                Ok(Some(event)) => {
                                    if bridge.consume(&event).await {
                                        let _ = events::remove(&events_dir, &event.id).await;
                                    }
                                }
                                Ok(None) => break,
                                Err(error) => {
                                    eprintln!("[telegram] outbox 扫描失败：{error}");
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => eprintln!("[telegram] outbox 扫描失败：{e}"),
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(2500)) => {}
                    _ = stop.cancelled() => {}
                }
            }
        })
    };
    let maintenance = {
        let bridge = bridge.clone();
        tokio::spawn(async move { bridge.maintenance().await })
    };

    let poll_result = bridge.poll().await;
    if let Err(e) = &poll_result {
        eprintln!("[telegram] {}", e.replace(&token, "[redacted]"));
    }
    stop.cancel();
    bridge.dispose().await;
    let _ = tokio::join!(sweep, maintenance);
    lock.release().await;
    poll_result
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        let token = std::env::var("PI_TELEGRAM_BOT_TOKEN").unwrap_or_default();
        eprintln!("{}", error.replace(&token, "[redacted]"));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_history_sync_state_is_not_required_to_restart() {
        let value = json!({"version":1,"botId":123,"chatId":-100,"topics":[],"delivered":[]});
        let state = validate_state(&value, 123, -100).unwrap();
        let saved = serde_json::to_value(state).unwrap();
        assert!(saved.get("historySent").is_none());
        assert!(validate_state(&saved, 123, -100).is_ok());
        let mut invalid = value;
        invalid["historySent"] = Value::Null;
        assert!(validate_state(&invalid, 123, -100).is_err());
        invalid["historySent"] = json!({"session":["hash"]});
        assert!(validate_state(&invalid, 123, -100).is_ok());
        invalid["historySent"] = json!({"session":[42]});
        assert!(validate_state(&invalid, 123, -100).is_err());
    }
}
