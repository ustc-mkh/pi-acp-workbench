//! Fixed-space storage telemetry. No identities, SQL, paths, text or tokens.
//! Execution includes SQL, serialization and validation until finer spans are
//! added; it must not be presented as pure SQL time.
use serde::Serialize;
use std::{collections::BTreeMap, sync::Mutex, time::Duration};

#[derive(Clone, Default, Debug, Serialize)]
pub struct RequestMetrics {
    pub accepted_requests: u64,
    pub requests: u64,
    pub enqueue_wait_ns: u64,
    pub queue_wait_ns: u64,
    pub execution_ns: u64,
    pub total_ns: u64,
    pub max_total_ns: u64,
    pub max_queue_depth: usize,
}
#[derive(Default)]
pub(super) struct Metrics(Mutex<BTreeMap<&'static str, RequestMetrics>>);
impl Metrics {
    pub fn accepted(&self, kind: &'static str, depth: usize) {
        let mut map = self.0.lock().expect("storage metrics lock poisoned");
        let metric = map.entry(kind).or_default();
        metric.accepted_requests = metric.accepted_requests.saturating_add(1);
        metric.max_queue_depth = metric.max_queue_depth.max(depth);
    }
    pub fn record(
        &self,
        kind: &'static str,
        enqueue: Duration,
        queue: Duration,
        execution: Duration,
        depth: usize,
    ) {
        let ns = |duration: Duration| duration.as_nanos().min(u64::MAX as u128) as u64;
        let total = ns(enqueue.saturating_add(queue).saturating_add(execution));
        let mut map = self.0.lock().expect("storage metrics lock poisoned");
        let metric = map.entry(kind).or_default();
        metric.requests = metric.requests.saturating_add(1);
        metric.enqueue_wait_ns = metric.enqueue_wait_ns.saturating_add(ns(enqueue));
        metric.queue_wait_ns = metric.queue_wait_ns.saturating_add(ns(queue));
        metric.execution_ns = metric.execution_ns.saturating_add(ns(execution));
        metric.total_ns = metric.total_ns.saturating_add(total);
        metric.max_total_ns = metric.max_total_ns.max(total);
        metric.max_queue_depth = metric.max_queue_depth.max(depth);
    }
    pub fn snapshot(&self) -> BTreeMap<&'static str, RequestMetrics> {
        self.0
            .lock()
            .expect("storage metrics lock poisoned")
            .clone()
    }
}
