//! Joined Registry root ownership. Root abort/panic never drops the scope that
//! owns accepted IO/actor jobs; cleanup itself remains owned across caller drops.
use super::registry::{self, RegistryState};
use super::*;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::{
    sync::{watch, Mutex},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
type Outcome = Result<(), DomainError>;
type Recovery = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Outcome> + Send>> + Send + Sync>;
struct Lifecycle {
    task: Option<JoinHandle<Outcome>>,
    result: Option<Outcome>,
    recovering: bool,
}
#[derive(Clone)]
pub struct Runtime {
    pub registry: RegistryHandle,
    lifecycle: Arc<Mutex<Lifecycle>>,
    completion: watch::Receiver<Option<Outcome>>,
    recovery: Recovery,
    workers_stopped: CancellationToken,
    #[cfg(test)]
    root_abort: tokio::task::AbortHandle,
}
impl Runtime {
    pub fn start(store: impl SessionPersistence, mailbox: usize) -> Self {
        let (tx, rx) = mpsc::channel(mailbox);
        let (completion, receiver) = watch::channel(None);
        let shared = Arc::new(Mutex::new(RegistryState::default()));
        let recovery: Recovery = {
            let store = store.clone();
            let shared = shared.clone();
            Arc::new(move || Box::pin(registry::recover(shared.clone(), store.clone(), mailbox)))
        };
        let workers_stopped = CancellationToken::new();
        let task = tokio::spawn(registry::run(
            rx,
            store,
            mailbox,
            shared,
            completion,
            workers_stopped.clone(),
        ));
        #[cfg(test)]
        let root_abort = task.abort_handle();
        Self {
            registry: RegistryHandle { tx },
            lifecycle: Arc::new(Mutex::new(Lifecycle {
                task: Some(task),
                result: None,
                recovering: false,
            })),
            completion: receiver,
            recovery,
            workers_stopped,
            #[cfg(test)]
            root_abort,
        }
    }
    /// Fatal closure may be observed before drain completes. shutdown_checked is
    /// the completion barrier, not this notification.
    pub async fn wait_closed(&self) -> Outcome {
        let mut completion = self.completion.clone();
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            completion.changed().await.map_err(|_| {
                DomainError::Worker("registry supervisor exited unexpectedly".into())
            })?;
        }
    }
    pub(crate) fn workers_stopped(&self) {
        self.workers_stopped.cancel();
    }
    pub async fn shutdown_checked(&self) -> Outcome {
        self.workers_stopped();
        let _ = self.registry.request_shutdown().await;
        let mut lifecycle = self.lifecycle.lock().await;
        if let Some(result) = &lifecycle.result {
            return result.clone();
        }
        let result = loop {
            let joined = match lifecycle.task.as_mut() {
                Some(task) => task.await,
                None => break Err(DomainError::Worker("registry join unavailable".into())),
            };
            lifecycle.task.take();
            match joined {
                Ok(result) => break result,
                Err(_) if !lifecycle.recovering => {
                    lifecycle.recovering = true;
                    let cleanup = self.recovery.clone();
                    lifecycle.task = Some(tokio::spawn(async move {
                        cleanup().await?;
                        Err(DomainError::Worker(
                            "registry supervisor task failed".into(),
                        ))
                    }));
                }
                Err(_) => break Err(DomainError::Worker("registry recovery task failed".into())),
            }
        };
        lifecycle.result = Some(result.clone());
        result
    }
    #[cfg(test)]
    pub(crate) fn abort_root(&self) {
        self.root_abort.abort();
    }
}
