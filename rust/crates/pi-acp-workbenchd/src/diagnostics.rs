//! Opt-in, fixed-space diagnostics: static labels only, no session IDs or content.
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
const BOUNDS_NS: [u64; 8] = [
    100_000,
    1_000_000,
    5_000_000,
    10_000_000,
    50_000_000,
    100_000_000,
    250_000_000,
    1_000_000_000,
];
#[derive(Clone, Debug, Default, Serialize)]
pub struct Histogram {
    pub count: u64,
    pub sum_ns: u64,
    pub max_ns: u64,
    /// Disjoint buckets, including an overflow bucket. Never exact percentiles.
    pub buckets: [u64; 9],
}
impl Histogram {
    pub(crate) fn record(&mut self, value: Duration) {
        let ns = value.as_nanos().min(u64::MAX as u128) as u64;
        self.count = self.count.saturating_add(1);
        self.sum_ns = self.sum_ns.saturating_add(ns);
        self.max_ns = self.max_ns.max(ns);
        let index = BOUNDS_NS.partition_point(|bound| *bound < ns);
        self.buckets[index] = self.buckets[index].saturating_add(1);
    }
}
#[derive(Clone, Default, Serialize)]
struct Gauge {
    current: usize,
    peak: usize,
}
#[derive(Default, Serialize)]
struct Metrics {
    timings: BTreeMap<&'static str, Histogram>,
    gauges: BTreeMap<&'static str, Gauge>,
}
pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("WORKBENCH_DIAGNOSTICS").is_some_and(|v| v == "1"))
}
fn metrics() -> &'static Mutex<Metrics> {
    static METRICS: OnceLock<Mutex<Metrics>> = OnceLock::new();
    METRICS.get_or_init(Default::default)
}
/// Enqueue timestamp. Disabled diagnostics never read the monotonic clock.
pub(crate) struct Stamp(Option<Instant>);
impl Stamp {
    pub(crate) fn now() -> Self {
        Self(enabled().then(Instant::now))
    }
    pub(crate) fn finish(self, label: &'static str) {
        if let Some(start) = self.0 {
            if let Ok(mut metrics) = metrics().lock() {
                metrics
                    .timings
                    .entry(label)
                    .or_default()
                    .record(start.elapsed());
            }
        }
    }
}
pub(crate) struct Span {
    stamp: Option<Stamp>,
    label: &'static str,
}
impl Span {
    pub(crate) fn new(label: &'static str) -> Self {
        Self {
            stamp: Some(Stamp::now()),
            label,
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(stamp) = self.stamp.take() {
            stamp.finish(self.label);
        }
    }
}
pub(crate) fn gauge(label: &'static str, current: usize) {
    if enabled() {
        if let Ok(mut metrics) = metrics().lock() {
            let gauge = metrics.gauges.entry(label).or_default();
            gauge.current = current;
            gauge.peak = gauge.peak.max(current);
        }
    }
}
#[derive(Serialize)]
struct Report<'a, T> {
    version: u8,
    bucket_upper_bounds_ns: [u64; 8],
    runtime: &'a Metrics,
    storage: T,
    storage_execution_scope: &'static str,
}
pub(crate) fn emit(storage: impl Serialize) {
    if enabled() {
        if let Ok(metrics) = metrics().lock() {
            if let Ok(json) = serde_json::to_string(&Report {
                version: 1,
                bucket_upper_bounds_ns: BOUNDS_NS,
                runtime: &metrics,
                storage,
                storage_execution_scope: "SQL plus serialization/validation, not pure SQL",
            }) {
                eprintln!("workbench-metrics: {json}");
            }
        }
    }
}
/// Time SQLite's COMMIT call only, not statement preparation or serialization.
pub(crate) fn sqlite_commit(tx: rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    let _span = Span::new("sqlite_commit_call");
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn histogram_keeps_disjoint_inclusive_bounds_and_overflow() {
        let mut h = Histogram::default();
        for ns in [0, 100_000, 100_001, 250_000_000, 1_000_000_001] {
            h.record(Duration::from_nanos(ns));
        }
        assert_eq!(h.buckets, [2, 1, 0, 0, 0, 0, 1, 0, 1]);
        assert_eq!(h.count, h.buckets.iter().sum::<u64>());
        assert_eq!(h.max_ns, 1_000_000_001);
        assert_eq!(h.sum_ns, 1_250_200_002);
    }
}
