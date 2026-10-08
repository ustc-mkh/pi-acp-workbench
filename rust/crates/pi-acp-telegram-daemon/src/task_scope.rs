//! Local task ownership. Dropping a task handle cancels its observer, never the remote model turn.
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

pub struct OwnedTask<T>(JoinHandle<T>);
impl<T: Send + 'static> OwnedTask<T> {
    pub fn spawn(future: impl Future<Output = T> + Send + 'static) -> Self {
        Self(tokio::spawn(future))
    }
    pub fn abort(&self) {
        self.0.abort();
    }
}
impl<T> Future for OwnedTask<T> {
    type Output = Result<T, JoinError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx)
    }
}
impl<T> Drop for OwnedTask<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub struct TaskScope {
    stop: CancellationToken,
    tasks: Mutex<JoinSet<()>>,
}
impl TaskScope {
    pub fn new(stop: CancellationToken) -> Self {
        Self {
            stop,
            tasks: Mutex::new(JoinSet::new()),
        }
    }
    pub async fn spawn(
        &self,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> Result<bool, String> {
        let mut tasks = self.tasks.lock().await;
        while let Some(result) = tasks.try_join_next() {
            result.map_err(|e| format!("Telegram 后台任务异常：{e}"))?;
        }
        if self.stop.is_cancelled() {
            return Ok(false);
        }
        tasks.spawn(future);
        Ok(true)
    }
    /// The transport is closed by the caller first, so pending turns can settle normally.
    /// The deadline bounds shutdown even if an unexpected handler never cooperates.
    pub async fn shutdown(&self) {
        self.shutdown_after(Duration::from_secs(5)).await;
    }

    async fn shutdown_after(&self, grace: Duration) {
        self.stop.cancel();
        let mut tasks = self.tasks.lock().await;
        let drained = async { while tasks.join_next().await.is_some() {} };
        if tokio::time::timeout(grace, drained).await.is_err() {
            tasks.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    #[tokio::test]
    async fn dropping_an_observer_releases_its_resources() {
        let (started, ready) = oneshot::channel();
        let (finished, closed) = oneshot::channel::<()>();
        let observer = OwnedTask::spawn(async move {
            let _held = finished;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        drop(observer);
        assert!(tokio::time::timeout(Duration::from_secs(1), closed)
            .await
            .unwrap()
            .is_err());
    }
    #[tokio::test]
    async fn shutdown_drains_owned_handlers_and_rejects_late_work() {
        let stop = CancellationToken::new();
        let scope = TaskScope::new(stop.clone());
        let (started, ready) = oneshot::channel();
        let (finished, done) = oneshot::channel();
        scope
            .spawn(async move {
                started.send(()).unwrap();
                stop.cancelled().await;
                finished.send(()).unwrap();
            })
            .await
            .unwrap();
        ready.await.unwrap();
        scope.shutdown().await;
        done.await.unwrap();
        assert!(!scope
            .spawn(async { panic!("work after shutdown") })
            .await
            .unwrap());
        assert!(scope.tasks.lock().await.is_empty());
    }
    #[tokio::test]
    async fn completed_observer_returns_its_value_and_scoped_panics_are_reported() {
        assert_eq!(OwnedTask::spawn(async { 42 }).await.unwrap(), 42);
        let scope = TaskScope::new(CancellationToken::new());
        scope
            .spawn(async { panic!("unexpected handler panic") })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if scope.spawn(async {}).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        scope.shutdown().await;
    }
    #[tokio::test]
    async fn shutdown_reclaims_a_handler_that_ignores_cancellation() {
        let scope = TaskScope::new(CancellationToken::new());
        let (started, ready) = oneshot::channel();
        let (held, released) = oneshot::channel::<()>();
        scope
            .spawn(async move {
                let _resource = held;
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            })
            .await
            .unwrap();
        ready.await.unwrap();
        scope.shutdown_after(Duration::from_millis(10)).await;
        assert!(released.await.is_err());
        assert!(scope.tasks.lock().await.is_empty());
    }
}
