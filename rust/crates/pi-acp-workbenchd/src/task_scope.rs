//! Cancellation-safe ownership of Tokio task handles. Metadata only; no actor
//! state. A consumed/dropped observer cannot detach a registered running task.
use crate::domain::error::DomainError;
use std::{
    future::Future,
    sync::{Arc, Mutex as StdMutex, MutexGuard},
};
use tokio::{sync::Mutex, task::JoinHandle};

#[derive(Clone)]
pub(crate) struct OwnedTask(Arc<Mutex<Option<JoinHandle<()>>>>);
impl OwnedTask {
    pub fn is_finished(&self) -> bool {
        self.0
            .try_lock()
            .is_ok_and(|task| task.as_ref().is_none_or(JoinHandle::is_finished))
    }
    pub async fn join(&self) {
        let mut task = self.0.lock().await;
        if let Some(task) = task.as_mut() {
            let _ = task.await;
        }
        task.take();
    }
    #[cfg(test)]
    pub async fn abort(&self) {
        if let Some(task) = self.0.lock().await.as_ref() {
            task.abort();
        }
    }
}
#[derive(Default)]
struct State {
    closed: bool,
    tasks: Vec<OwnedTask>,
}
#[derive(Default)]
pub(crate) struct TaskScope {
    state: StdMutex<State>,
}
pub(crate) struct SpawnGuard<'a>(MutexGuard<'a, State>);
impl TaskScope {
    pub(crate) fn record_counts(&self, retained: &'static str, unfinished: &'static str) {
        if !crate::diagnostics::enabled() {
            return;
        }
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        crate::diagnostics::gauge(retained, state.tasks.len());
        crate::diagnostics::gauge(
            unfinished,
            state
                .tasks
                .iter()
                .filter(|task| !task.is_finished())
                .count(),
        );
    }
    pub fn entry(&self) -> Result<SpawnGuard<'_>, DomainError> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.closed {
            return Err(DomainError::Worker("task scope closed".into()));
        }
        state.tasks.retain(|task| !task.is_finished());
        Ok(SpawnGuard(state))
    }
    pub fn spawn(
        &self,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> Result<OwnedTask, DomainError> {
        Ok(self.entry()?.spawn(future))
    }
    pub async fn close_and_join(&self) {
        let tasks = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.closed = true;
            state.tasks.clone()
        };
        // Snapshot, do not take: cancellation of this join leaves ownership in
        // the scope, allowing another shutdown caller to finish the same work.
        for task in tasks {
            task.join().await;
        }
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .tasks
            .clear();
    }
}
impl SpawnGuard<'_> {
    pub fn spawn(&mut self, future: impl Future<Output = ()> + Send + 'static) -> OwnedTask {
        let task = OwnedTask(Arc::new(Mutex::new(Some(tokio::spawn(future)))));
        self.0.tasks.push(task.clone());
        task
    }
}
