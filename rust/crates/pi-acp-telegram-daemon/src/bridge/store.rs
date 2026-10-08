//! The only mutable owner of relay persistence. Readers cannot bypass a durable transaction.
use super::BridgeState;
use pi_acp_core::atomic::write_atomic_json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, RwLockReadGuard};

pub(super) struct StateStore {
    path: PathBuf,
    current: RwLock<BridgeState>,
    transactions: Mutex<()>,
    // The same switches are shared by delivery streams; only commit changes them.
    pub(super) notifications: Arc<AtomicBool>,
    pub(super) silent: Arc<AtomicBool>,
}

impl StateStore {
    pub(super) fn new(path: PathBuf, state: BridgeState) -> Self {
        Self {
            path,
            notifications: Arc::new(AtomicBool::new(state.notifications != Some(false))),
            silent: Arc::new(AtomicBool::new(state.silent == Some(true))),
            current: RwLock::new(state),
            transactions: Mutex::new(()),
        }
    }

    pub(super) async fn read(&self) -> RwLockReadGuard<'_, BridgeState> {
        self.current.read().await
    }

    pub(super) async fn update(&self, update: impl FnOnce(&mut BridgeState)) -> Result<(), String> {
        let _transaction = self.transactions.lock().await;
        let mut next = self.current.read().await.clone();
        update(&mut next);
        write_atomic_json(&self.path, &next, true)
            .await
            .map_err(|e| format!("无法保存 Telegram 游标/状态：{e}"))?;
        self.notifications
            .store(next.notifications != Some(false), Ordering::SeqCst);
        self.silent
            .store(next.silent == Some(true), Ordering::SeqCst);
        *self.current.write().await = next;
        Ok(())
    }
}
