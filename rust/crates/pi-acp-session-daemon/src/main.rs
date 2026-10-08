//! Production session service:
//!   pi-acp-session-daemon --config /absolute/path/sessions.json [--data-dir /path]
//!
//! When command is absent, resolve PI_ADAPTER or pi-adapter.mjs beside this
//! binary and launch it with Node from PATH. build:services ships the complete
//! runtime directory; custom workers require explicit command/args.
mod acp_validation;
mod agent;
mod diff;
mod error;
mod harness;
mod history;
mod journal;
mod native;
mod outbox;
mod outbox_reader;
mod phase;
mod prefs;
mod protocol;
mod queue;
mod server;
mod service;
mod state_stream;
mod types;
mod updates;
mod usage;

use pi_acp_core::mkdir_lock::MkdirLock;
use serde::Deserialize;
use serde_json::Value;
use service::{ServiceConfig, SessionService, WorkerLaunch};
use std::collections::HashMap;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn home() -> PathBuf {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerConfig {
    command: Option<String>,
    #[serde(default)]
    harnesses: HashMap<String, WorkerLaunch>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    #[serde(default = "default_max_workers")]
    max_workers: usize,
    #[serde(default = "default_idle_ms")]
    idle_ms: u64,
}
fn default_max_workers() -> usize {
    3
}
fn default_idle_ms() -> u64 {
    900_000
}

fn load_config(path: &str) -> Result<ServiceConfig, String> {
    let raw: WorkerConfig = serde_json::from_str(
        &std::fs::read_to_string(path).map_err(|e| format!("无法读取会话配置：{e}"))?,
    )
    .map_err(|e| format!("会话配置无效：{e}"))?;
    let invalid = || "工作进程参数无效".to_string();
    let max_workers = raw.max_workers;
    let idle_ms = raw.idle_ms;
    if !(1..=8).contains(&max_workers) || idle_ms < 1000 {
        return Err(invalid());
    }
    for name in raw.harnesses.keys() {
        harness::Harness::parse(name)?;
    }
    for worker in raw.harnesses.values() {
        if worker.command.trim().is_empty() {
            return Err(invalid());
        }
    }
    let harnesses = raw.harnesses;
    let args = raw.args.unwrap_or_default();
    let mut env = raw.env.unwrap_or_default();
    let command = match raw
        .command
        .or_else(|| harnesses.get("pi").map(|w| w.command.clone()))
    {
        Some(cmd) => cmd,
        None => {
            let adapter = std::env::var("PI_ADAPTER")
                .ok()
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("pi-adapter.mjs")))
                })
                .filter(|p| p.exists());
            let adapter = adapter.unwrap_or_else(|| PathBuf::from("pi-acp"));
            // A Codex/Claude-only installation need not ship the Pi adapter.
            if adapter == std::path::Path::new("pi-acp") {
                return Ok(ServiceConfig {
                    command: "pi-acp".into(),
                    args,
                    env,
                    max_workers,
                    idle_ms,
                    harnesses,
                });
            }
            env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
            let config = ServiceConfig {
                command: "node".to_string(),
                args: vec![adapter.to_string_lossy().into_owned()],
                env,
                max_workers,
                idle_ms,
                harnesses,
            };
            return Ok(config);
        }
    };
    if command.is_empty() {
        return Err(invalid());
    }
    env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    Ok(ServiceConfig {
        command,
        args,
        env,
        max_workers,
        idle_ms,
        harnesses,
    })
}

async fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        println!("pi-acp-session-daemon --config /absolute/path/sessions.json [--data-dir /path]");
        return Ok(());
    }
    let config_file = arg_value(&args, "--config").ok_or("需要 --config sessions.json")?;
    let config = load_config(config_file)?;
    let root = match arg_value(&args, "--data-dir") {
        Some(v) if !v.starts_with("--") => PathBuf::from(v),
        Some(_) => return Err("--data-dir 缺少路径".into()),
        None => home().join(".pi/pi-acp-workbench"),
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root.join("service"))
        .map_err(|e| format!("无法创建数据目录：{e}"))?;

    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
    let mut int = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
    let stop = CancellationToken::new();
    let signal_stop = stop.clone();
    let signal_task = tokio::spawn(async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        signal_stop.cancel();
    });
    let stop_for_lock = stop.clone();
    let lock = MkdirLock::acquire(
        &root.join("service"),
        Duration::from_secs(10),
        Duration::from_secs(30),
        move || {
            eprintln!("会话服务锁已失效，已停止避免并发运行。");
            stop_for_lock.cancel();
        },
    )
    .await
    .map_err(|e| format!("会话服务已在运行：{e}"))?;

    let server_cell: Arc<tokio::sync::OnceCell<server::SessionServer>> =
        Arc::new(tokio::sync::OnceCell::new());
    let server_for_broadcast = server_cell.clone();
    let service = SessionService::new(
        &root,
        config.clone(),
        Arc::new(move |event| {
            if let Some(server) = server_for_broadcast.get() {
                server.broadcast(event);
            }
        }),
        Arc::new(|e| eprintln!("[sessions] {e}")),
    );

    let svc = service.clone();
    let server = server::SessionServer::new(
        root.join("service").join("sessions.sock"),
        Arc::new(
            move |method: String, params: Value, request_id: String, _emit| {
                let svc = svc.clone();
                Box::pin(async move { svc.handle(&method, params, &request_id).await })
                    as std::pin::Pin<
                        Box<
                            dyn std::future::Future<Output = Result<Value, error::ServiceError>>
                                + Send,
                        >,
                    >
            },
        ),
    );
    let startup = async {
        service.initialize().await?;
        server.listen().await?;
        Ok::<(), String>(())
    };
    let result = tokio::select! {
        biased;
        _ = stop.cancelled() => Ok(()),
        result = startup => result,
    };
    let _ = server_cell.set(server);
    if result.is_ok() && !stop.is_cancelled() {
        println!(
            "Pi session service ready; maxWorkers={}, idleMs={}",
            config.max_workers, config.idle_ms
        );
        stop.cancelled().await;
    }
    {
        let server = server_cell.get();
        if let Some(server) = server {
            server.dispose().await;
        }
    }
    service.dispose().await;
    if !lock.compromised() {
        lock.release().await;
    }
    signal_task.abort();
    result
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    if std::env::args().any(|arg| arg == "--print-types") {
        print!("{}", protocol::typescript());
        return std::process::ExitCode::SUCCESS;
    }
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn typed_config_rejects_unknown_fields_and_invalid_value_types() {
        for body in [
            r#"{"command":"node","maxWorker":1}"#,
            r#"{"command":"node","args":[1]}"#,
            r#"{"command":"node","env":{"KEY":1}}"#,
            r#"{"command":42}"#,
            "[]",
        ] {
            assert!(serde_json::from_str::<WorkerConfig>(body).is_err());
        }
        let config: WorkerConfig =
            serde_json::from_str(r#"{"command":"node","args":null,"env":null}"#).unwrap();
        assert_eq!(config.max_workers, 3);
        assert_eq!(config.idle_ms, 900_000);
    }
}
