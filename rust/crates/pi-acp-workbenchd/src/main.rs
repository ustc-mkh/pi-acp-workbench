use pi_acp_workbenchd::{
    app::WorkbenchApp,
    config::{Config, LimitsConfig, SessionsConfig, StorageConfig, WorkerConfig, WorkersConfig},
    telegram::{api::BotClient, TelegramAdapter},
    transport::vscode::ExternalTransport,
};
use std::path::PathBuf;
use tokio::signal;
fn default_config(root: PathBuf) -> Config {
    Config {
        workers: WorkersConfig {
            pi: Some(WorkerConfig {
                command: "pi-acp".into(),
                args: vec![],
                env: Default::default(),
            }),
            ..Default::default()
        },
        sessions: SessionsConfig {
            mailbox: 128,
            max_workers: 16,
        },
        telegram: None,
        storage: StorageConfig { root },
        limits: LimitsConfig {
            pending_interactions: 32,
        },
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "storage") {
        pi_acp_workbenchd::persistence::maintenance::run(&args[2..]).await?;
        return Ok(());
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--help" || arg == "-h")
    {
        println!("pi-acp-workbenchd {}\nUsage: pi-acp-workbenchd [--config PATH]\nSingle-process ACP runtime with external IPC at STORAGE_ROOT/workbench.sock.\nOffline maintenance: pi-acp-workbenchd storage export|reset|gc --root ABSOLUTE [--destination ABSOLUTE] --confirm\nIncompatible storage is rejected; back up and clean old data explicitly offline.", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.get(1).is_some_and(|arg| arg == "--version") {
        println!("pi-acp-workbenchd {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if !(args.len() == 1 || (args.len() == 3 && args[1] == "--config")) {
        return Err("Usage: pi-acp-workbenchd [--config PATH]".into());
    }
    // Install handlers before network startup; startup signals must not leave
    // accepted IPC work or Telegram tasks behind.
    let mut interrupt = signal::unix::signal(signal::unix::SignalKind::interrupt())?;
    let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let config: Config = if args.len() == 3 {
        serde_json::from_slice(&tokio::fs::read(&args[2]).await?)?
    } else {
        default_config(home.join(".pi/pi-acp-workbench"))
    };
    config.validate()?;
    let telegram_config = config.telegram.clone();
    let client = if let Some(telegram) = &telegram_config {
        let token = std::env::var(&telegram.bot_token_env).map_err(|_| {
            std::io::Error::other("Telegram token environment variable is missing or invalid")
        })?;
        Some(BotClient::new(&telegram.api_base, &token)?)
    } else {
        None
    };
    let socket = config.storage.root.join("workbench.sock");
    let telegram_root = config.storage.root.join("telegram");
    let app = WorkbenchApp::new(config)?;
    let mut telegram = if let (Some(client), Some(config)) = (client, telegram_config) {
        let started = tokio::select! {
            biased;
            _ = interrupt.recv() => { app.shutdown_checked().await?; return Ok(()); }
            _ = terminate.recv() => { app.shutdown_checked().await?; return Ok(()); }
            result = TelegramAdapter::start(app.clone(), client, &telegram_root, config) => result,
        };
        match started {
            Ok(adapter) => Some(adapter),
            Err(error) => {
                app.shutdown_checked().await?;
                return Err(error.into());
            }
        }
    } else {
        None
    };
    let mut external = match ExternalTransport::bind(&socket, app.clone()).await {
        Ok(external) => external,
        Err(error) => {
            let telegram_result = match telegram.take() {
                Some(adapter) => adapter.shutdown().await,
                None => Ok(()),
            };
            let runtime_result = app.shutdown_checked().await;
            telegram_result?;
            runtime_result?;
            return Err(error.into());
        }
    };
    eprintln!(
        "pi-acp-workbenchd ready: {} (single process)",
        socket.display()
    );
    let outcome = tokio::select! {
        biased;
        _ = interrupt.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
        result = app.wait_closed() => result.map_err(std::io::Error::other).and_then(|()| Err(std::io::Error::other("runtime ingress exited unexpectedly"))),
        result = external.wait() => result.and_then(|()| Err(std::io::Error::other("external IPC exited unexpectedly"))),
        result = async { match telegram.as_mut() { Some(adapter) => adapter.wait().await, None => std::future::pending().await } } => {
            result.map_err(std::io::Error::other).and_then(|()| Err(std::io::Error::other("Telegram adapter exited unexpectedly")))
        }
    };
    // Close host admission/start physical cleanup before joining adapters that
    // may be waiting on an accepted provider operation. The lease stays held
    // until transports and the joined runtime have both finished.
    app.close_admission();
    // Compute every cleanup result before returning any error.
    let external_result = external.shutdown().await;
    let telegram_result = match telegram.take() {
        Some(adapter) => adapter.shutdown().await,
        None => Ok(()),
    };
    let runtime_result = app.shutdown_checked().await;
    outcome?;
    external_result?;
    telegram_result?;
    runtime_result?;
    Ok(())
}
