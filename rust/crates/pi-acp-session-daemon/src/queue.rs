//! TaskQueue port (src/task-queue.ts): per-session FIFO ordering + global
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

    #[allow(dead_code)] // TS pendingCount parity (diagnostics)
    pub fn pending_count(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    /// Bump the session epoch so operations queued before this call fail check().
    /// TS: `if (this.tails.has(id)) this.epochs.set(id, (this.epochs.get(id)||0)+1)`.
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
        // TS run(): closed → '会话服务正在停止'; queued ≥ limit → '服务排队已满'.
        // The closed check races harmlessly with close(): a late increment is
        // still rejected by check() below, exactly like the TS tail task.
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
                .or_insert_with(|| Arc::new(Lane { lock: Mutex::new(()), queued: AtomicUsize::new(0) }))
                .clone();
            lane.queued.fetch_add(1, Ordering::SeqCst);
            // TS: const epoch = this.epochs.get(id) || 0;
            let epoch = *inner.epochs.get(id).unwrap_or(&0);
            (lane, epoch)
        };
        // TS check(): stale epoch or closed queue → '排队请求已取消'. The closure
        // re-reads the shared epochs map each call, like the TS `tails` lookup.
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
            // Lane mutex = the TS tail chain: same sessionId runs strictly serially.
            let _lane_guard = lane.lock.lock().await;
            // Global budget — the FIFO semaphore replaces the TS waiters/active
            // counter. acquire() only fails on a closed semaphore, which never
            // happens here; the message matches the closest contract error.
            let _permit = self.semaphore.acquire().await.map_err(|_| "会话服务正在停止".to_string())?;
            check()?;
            operation(check).await
        }
        .await;
        // TS finally: queued--; drop the tail and its epoch when it is current.
        // Lane removal follows bridge.rs enqueue: under the inner mutex, only
        // when the lane drained to zero and the map still holds this same Arc.
        if self.queued.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.drained.notify_waiters();
        }
        let mut inner = self.inner.lock().unwrap();
        if lane.queued.fetch_sub(1, Ordering::SeqCst) == 1
            && inner.lanes.get(id).map(|l| Arc::ptr_eq(l, &lane)).unwrap_or(false)
        {
            inner.lanes.remove(id);
            inner.epochs.remove(id);
        }
        result
    }

    /// Reject new work; wait for every in-flight tail to settle.
    /// TS close(): closed=true; await Promise.allSettled([...tails.values()]).
    /// `queued` counts every run() call, so it reaching zero is exactly "all
    /// tails settled"; new work is rejected before it can increment.
    /// TS close() sets `closed` synchronously (async fn bodies run to the first
    /// await). Split so callers can set the flag immediately and drain lazily.
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
