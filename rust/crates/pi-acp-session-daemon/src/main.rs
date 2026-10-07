//! Rust port of src/session-daemon.ts — CLI-compatible:
//!   pi-acp-session-daemon --config /absolute/path/sessions.json [--data-dir /path]
//!
//! Default worker resolution differs from the TS daemon (which defaults to
//! `node dist/pi-adapter.mjs`): when `command` is absent the binary looks for
//! `pi-adapter.mjs` beside itself, then requires `command`/`args` in the config.
mod agent;
mod diff;
mod history;
mod journal;
mod native;
mod outbox;
mod prefs;
mod protocol;
mod queue;
mod server;
mod service;
mod types;
mod updates;

use pi_acp_core::mkdir_lock::MkdirLock;
use serde_json::Value;
use service::{ServiceConfig, SessionService};
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

fn load_config(path: &str) -> Result<ServiceConfig, String> {
    let raw: Value = serde_json::from_str(
        &std::fs::read_to_string(path).map_err(|e| format!("无法读取会话配置：{e}"))?,
    )
    .map_err(|e| format!("会话配置必须为 JSON 对象：{e}"))?;
    let invalid = || "工作进程参数无效".to_string();
    // TS: Number.isInteger check — an explicitly non-integer value is invalid
    // config, not a silent default (1.5 / "3" / -2 must all be rejected).
    let max_workers = match raw.get("maxWorkers") {
        None => 3usize,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=8).contains(n))
            .map(|n| n as usize)
            .ok_or_else(invalid)?,
    };
    let idle_ms = match raw.get("idleMs") {
        None => 900_000,
        Some(v) => v.as_u64().filter(|n| *n >= 1000).ok_or_else(invalid)?,
    };
    let args: Vec<String> = match raw.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(v)
            if v.as_array()
                .is_some_and(|a| a.iter().all(|x| x.is_string())) =>
        {
            v.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect()
        }
        _ => return Err(invalid()),
    };
    let mut env: HashMap<String, String> = match raw.get("env") {
        None | Some(Value::Null) => HashMap::new(),
        Some(v)
            if v.as_object()
                .is_some_and(|m| m.values().all(|x| x.is_string())) =>
        {
            v.as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect()
        }
        _ => return Err(invalid()),
    };
    // TS defaults: command=process.execPath (node) args=[dist/pi-adapter.mjs].
    // For the Rust binary: explicit command wins; otherwise look for the adapter
    // beside the executable and use `node` from PATH.
    let command = match raw.get("command").and_then(Value::as_str) {
        Some(cmd) => cmd.to_string(),
        None => {
            // TS default was `node <dist>/pi-adapter.mjs`; for the Rust binary
            // look beside the executable (or PI_ADAPTER) else require config.
            let adapter = std::env::var("PI_ADAPTER")
                .ok()
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.join("pi-adapter.mjs")))
                })
                .filter(|p| p.exists());
            let Some(adapter) = adapter else {
                return Err(
                    "会话配置缺少 command；Rust daemon 需要显式 worker 命令或旁边的 pi-adapter.mjs"
                        .into(),
                );
            };
            env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
            let config = ServiceConfig {
                command: "node".to_string(),
                args: vec![adapter.to_string_lossy().into_owned()],
                env,
                max_workers,
                idle_ms,
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

    let stop = CancellationToken::new();
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

    let stop_clone = stop.clone();
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
    service.initialize().await?;

    let svc = service.clone();
    let server = server::SessionServer::new(
        root.join("service").join("sessions.sock"),
        Arc::new(
            move |method: String, params: Value, request_id: String, _emit| {
                let svc = svc.clone();
                Box::pin(async move { svc.handle(&method, params, &request_id).await })
                    as std::pin::Pin<
                        Box<dyn std::future::Future<Output = Result<Value, String>> + Send>,
                    >
            },
        ),
    );
    server.listen().await?;
    let _ = server_cell.set(server);
    println!(
        "Pi session service ready; maxWorkers={}, idleMs={}",
        config.max_workers, config.idle_ms
    );

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
    stop.cancelled().await;
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
    let _ = stop_clone;
    Ok(())
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    // std::process::exit() would bypass destructors — MkdirLock's Drop removes
    // the lock dir, so errors must return normally (TS used process.exitCode).
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}
