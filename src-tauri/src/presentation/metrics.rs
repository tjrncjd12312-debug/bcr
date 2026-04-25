//! Performance observability helpers (additive; call-sites are opt-in).
//!
//! Purpose: provide standard `tracing` events for KPIs K3 / K5 in
//! `.forge/perf-plan/baseline.md` so future PRs can record latency and
//! task-leak data without introducing ad-hoc log formats.
//!
//! These helpers are **pure additions**. Nothing in production code calls
//! them yet; wiring is scheduled for subsequent lanes (R2 task registry,
//! R4 lock scope). Until then, clippy will flag them as dead code — this
//! is intentional for the baseline PR; downstream lanes will remove the
//! `#[allow(dead_code)]` markers as call-sites appear.

use std::time::Duration;
use tracing::debug;

/// Emit a `perf.task_count` event so tokio alive-task count can be
/// sampled by log scrapers during long-run soaks.
///
/// Usage (future R2 lane):
/// ```ignore
/// use tokio::runtime::Handle;
/// let alive = Handle::current().metrics().num_alive_tasks();
/// crate::presentation::metrics::log_task_count("evolution_multi", alive);
/// ```
#[allow(dead_code)]
pub fn log_task_count(scope: &str, alive: usize) {
    debug!(
        target: "perf.task_count",
        scope = scope,
        alive = alive,
        "tokio alive_tasks snapshot"
    );
}

/// Emit a `perf.latency` event. Designed for p50/p95 post-processing via
/// `tracing-subscriber` JSON output.
///
/// Usage (future R0-3 wiring or R4 lock scope):
/// ```ignore
/// let t0 = std::time::Instant::now();
/// do_work().await;
/// crate::presentation::metrics::log_latency("request_prediction_v2", t0.elapsed());
/// ```
#[allow(dead_code)]
pub fn log_latency(op: &str, elapsed: Duration) {
    debug!(
        target: "perf.latency",
        op = op,
        elapsed_us = elapsed.as_micros() as u64,
        "op latency"
    );
}

/// Emit a `perf.emit_count` event — a running counter of Tauri events
/// emitted per second. Used to verify R1 (event batching) effectiveness.
///
/// Usage (future R1 lane EventAggregator flush):
/// ```ignore
/// crate::presentation::metrics::log_emit_batch("pragmatic_raw_message", batch_size);
/// ```
#[allow(dead_code)]
pub fn log_emit_batch(event_name: &str, batch_size: usize) {
    debug!(
        target: "perf.emit_count",
        event = event_name,
        batch_size = batch_size,
        "tauri emit batch flushed"
    );
}
