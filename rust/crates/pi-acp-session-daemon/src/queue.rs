//! TaskQueue: per-session FIFO ordering + global
//! concurrency budget + epoch invalidation via cancel().
//!
//! Semantics to preserve (docs/service-protocol.md §6):
//! - Same sessionId: operations run strictly serially (tail chain).
//! - Global: at most `capacity` operations concurrently; excess wait FIFO.
//! - queued (waiting+running) bounded by `limit` (default 100) → '服务排队已满'.
//! - cancel(id): bumps the session epoch; the `check` closure fails with
//!   '排队请求已取消' for operations queued before the bump. Running ops are
//!   NOT aborted — check() is only consulted at defined points by the caller.
//! - close(): rejects new work ('会话服务正在停止'), drains all tails.
//!
//! Implementation note: mirror the lane approach used by the telegram daemon —
//! `HashMap<sessionId, Arc<Lane>>` where Lane owns a `Mutex<()>` for ordering;
//! the global budget is a `tokio::sync::Semaphore` (FIFO). Epoch check closure:
//! `Arc<dyn Fn() -> Result<(),String> + Send + Sync>` recreated per run() call,
//! reading a shared epochs map under the inner mutex. Removal: under the inner
//! mutex, drop the lane entry only when its queued count hits zero and it is
//! still the same Arc (see bridge.rs enqueue for the proven pattern).
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{Mutex, Notify, Semaphore};

pub struct TaskQueue {
    limit: usize,
    // std::sync::Mutex (not tokio): critical sections never await, and the sync
    // check() closure reads `epochs` through a shared Arc of the same mutex.
    inner: Arc<StdMutex<Inner>>,
    semaphore: Semaphore,
    closed: Arc<AtomicBool>,
    queued: AtomicUsize,
    drained: Notify,
}

#[derive(Default)]
struct Inner {
    lanes: HashMap<String, Arc<Lane>>,
    epochs: HashMap<String, u64>,
}

struct Lane {
    lock: Mutex<()>,
    queued: AtomicUsize,
}

impl TaskQueue {
    pub fn new(capacity: usize, limit: usize) -> Self {
        TaskQueue {
            limit,
            inner: Arc::new(StdMutex::new(Inner::default())),
            semaphore: Semaphore::new(capacity),
            closed: Arc::new(AtomicBool::new(false)),
            queued: AtomicUsize::new(0),
            drained: Notify::new(),
        }
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    pub async fn cancel(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.lanes.contains_key(id) {
            *inner.epochs.entry(id.to_string()).or_insert(0) += 1;
        }
    }

    /// Run `operation` serially within the session and within global capacity.
    /// `operation` receives a check closure: Err('排队请求已取消') when the epoch
    /// moved or the queue closed.
    pub async fn run<F, Fut, T>(&self, id: &str, operation: F) -> Result<T, String>
    where
        F: FnOnce(Check) -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        if self.closed.load(Ordering::SeqCst) {
            return Err("会话服务正在停止".into());
        }
        let (lane, epoch) = {
            let mut inner = self.inner.lock().unwrap();
            if self.queued.load(Ordering::SeqCst) >= self.limit {
                return Err("服务排队已满".into());
            }
            self.queued.fetch_add(1, Ordering::SeqCst);
            let lane = inner
                .lanes
                .entry(id.to_string())
                .or_insert_with(|| {
                    Arc::new(Lane {
                        lock: Mutex::new(()),
                        queued: AtomicUsize::new(0),
                    })
                })
                .clone();
            lane.queued.fetch_add(1, Ordering::SeqCst);
            let epoch = *inner.epochs.get(id).unwrap_or(&0);
            (lane, epoch)
        };
        let check: Check = {
            let inner = Arc::clone(&self.inner);
            let closed = Arc::clone(&self.closed);
            let key = id.to_string();
            Arc::new(move || {
                let inner = inner.lock().unwrap();
                if closed.load(Ordering::SeqCst) || epoch != *inner.epochs.get(&key).unwrap_or(&0) {
                    Err("排队请求已取消".into())
                } else {
                    Ok(())
                }
            })
        };
        let result = async {
            let _lane_guard = lane.lock.lock().await;
            let _permit = self
                .semaphore
                .acquire()
                .await
                .map_err(|_| "会话服务正在停止".to_string())?;
            check()?;
            operation(check).await
        }
        .await;
        if self.queued.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.drained.notify_waiters();
        }
        let mut inner = self.inner.lock().unwrap();
        if lane.queued.fetch_sub(1, Ordering::SeqCst) == 1
            && inner
                .lanes
                .get(id)
                .map(|l| Arc::ptr_eq(l, &lane))
                .unwrap_or(false)
        {
            inner.lanes.remove(id);
            inner.epochs.remove(id);
        }
        result
    }

    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    pub async fn close(&self) {
        self.mark_closed();
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            // Register before re-checking so a decrement between check and await
            // cannot be missed (notify_waiters stores no permit).
            notified.as_mut().enable();
            if self.queued.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub type Check = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    use tokio::time::{timeout, Duration};

    async fn pending(queue: &TaskQueue, count: usize) {
        timeout(Duration::from_secs(2), async {
            while queue.pending_count() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancels_old_generations_but_preserves_later_session_work() {
        let queue = Arc::new(TaskQueue::new(1, 100));
        let ran = Arc::new(StdMutex::new(Vec::new()));
        let (release, held) = oneshot::channel();
        let (entered, started) = oneshot::channel();
        let q = queue.clone();
        let events = ran.clone();
        let first = tokio::spawn(async move {
            q.run("one", |_| async move {
                events.lock().unwrap().push("first");
                entered.send(()).unwrap();
                held.await.unwrap();
                Ok(())
            })
            .await
        });
        started.await.unwrap();
        let q = queue.clone();
        let events = ran.clone();
        let second = tokio::spawn(async move {
            q.run("one", |_| async move {
                events.lock().unwrap().push("second");
                Ok(())
            })
            .await
        });
        pending(&queue, 2).await;
        queue.cancel("one").await;
        let q = queue.clone();
        let events = ran.clone();
        let third = tokio::spawn(async move {
            q.run("one", |_| async move {
                events.lock().unwrap().push("third");
                Ok(())
            })
            .await
        });
        pending(&queue, 3).await;
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        assert_eq!(second.await.unwrap().unwrap_err(), "排队请求已取消");
        third.await.unwrap().unwrap();
        assert_eq!(*ran.lock().unwrap(), vec!["first", "third"]);
        assert_eq!(queue.pending_count(), 0);
        {
            let inner = queue.inner.lock().unwrap();
            assert!(inner.lanes.is_empty());
            assert!(inner.epochs.is_empty());
        }
        queue.close().await;
    }

    #[tokio::test]
    async fn rejects_queue_overflow_without_leaking_a_lane_or_slot() {
        let queue = Arc::new(TaskQueue::new(1, 1));
        let hold = Arc::new(Semaphore::new(0));
        let q = queue.clone();
        let gate = hold.clone();
        let first = tokio::spawn(async move {
            q.run("a", |_| async move {
                gate.acquire().await.unwrap().forget();
                Ok(())
            })
            .await
        });
        pending(&queue, 1).await;
        assert_eq!(
            queue.run("b", |_| async { Ok(()) }).await.unwrap_err(),
            "服务排队已满"
        );
        assert_eq!(queue.pending_count(), 1);
        hold.add_permits(1);
        first.await.unwrap().unwrap();
        queue.run("b", |_| async { Ok(()) }).await.unwrap();
        assert_eq!(queue.pending_count(), 0);
        assert!(queue.inner.lock().unwrap().lanes.is_empty());
        queue.close().await;
    }

    #[tokio::test]
    async fn caps_global_execution_and_rejects_new_work_while_draining() {
        let queue = Arc::new(TaskQueue::new(2, 100));
        let hold = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for id in ["a", "b", "c"] {
            let q = queue.clone();
            let gate = hold.clone();
            let running = active.clone();
            tasks.push(tokio::spawn(async move {
                q.run(id, |_| async move {
                    running.fetch_add(1, Ordering::SeqCst);
                    gate.acquire().await.unwrap().forget();
                    Ok(())
                })
                .await
            }));
        }
        pending(&queue, 3).await;
        timeout(Duration::from_secs(2), async {
            while active.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        queue.mark_closed();
        assert_eq!(
            queue.run("d", |_| async { Ok(()) }).await.unwrap_err(),
            "会话服务正在停止"
        );
        hold.add_permits(2);
        let mut completed = 0;
        let mut cancelled = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(()) => completed += 1,
                Err(error) => {
                    assert_eq!(error, "排队请求已取消");
                    cancelled += 1;
                }
            }
        }
        assert_eq!((completed, cancelled), (2, 1));
        queue.close().await;
        assert_eq!(queue.pending_count(), 0);
    }
}
