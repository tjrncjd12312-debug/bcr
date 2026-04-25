//! Event Aggregator (Lane R1)
//!
//! Status: **infrastructure-only PR**. This module introduces the batching
//! machinery required by `.forge/perf-plan/plan.md` §3 Lane R1. No emit
//! call-site in `webview_commands.rs` currently qualifies as a high-frequency
//! **non-critical** candidate — the hot paths there (`evolution_multi_event`,
//! `pragmatic_raw_message`, game/betting events) are explicitly out of scope
//! per the plan, and the remaining emit sites are one-shot navigation/
//! discovery events. Migration of additional emit sites is deferred to a
//! follow-up lane with a dedicated test plan.
//!
//! Design (per plan + evidence.md §E1):
//! - Tauri provides no built-in batching; batching happens here.
//! - Bounded `tokio::sync::mpsc::channel(1024)` accepts push messages.
//! - A background flush task drains the channel into per-event-name buffers
//!   and flushes each buffer when either:
//!   - the buffer length reaches `batch_threshold` (default 32), or
//!   - `flush_interval` (default 100ms) has elapsed since the last flush.
//! - On flush, a **single** Tauri event is emitted with name
//!   `{original_event}.batch` carrying `{ "batch": [...payloads] }`.
//! - Per-event-name FIFO order is preserved (buffers are `Vec<Value>` pushed
//!   in arrival order; flush iterates in-order).
//!
//! The aggregator is generic over a `Flusher` trait so unit tests can run
//! without an `AppHandle` (which cannot be constructed in-process).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tracing::warn;

use crate::presentation::metrics::log_emit_batch;

/// Default maximum items per buffer before an early flush triggers.
const DEFAULT_BATCH_THRESHOLD: usize = 32;
/// Default time-based flush cadence.
const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_millis(100);
/// Bounded inbound channel capacity.
const CHANNEL_CAPACITY: usize = 1024;

/// Abstraction over the final event sink. The production impl wraps
/// `AppHandle::emit`; tests use a mock that captures calls.
pub trait Flusher: Send + Sync + 'static {
    /// Emit a single batched event carrying `batch` as its payload.
    fn emit_batch(&self, event_name: &str, batch: Vec<Value>);
}

/// Production flusher: forwards to `AppHandle::emit` with a
/// `{ "batch": [...] }` envelope on the `"{event}.batch"` event name.
pub struct AppHandleFlusher {
    handle: AppHandle,
}

impl AppHandleFlusher {
    pub fn new(handle: AppHandle) -> Self {
        Self { handle }
    }
}

impl Flusher for AppHandleFlusher {
    fn emit_batch(&self, event_name: &str, batch: Vec<Value>) {
        let batched_event = format!("{}.batch", event_name);
        let payload = serde_json::json!({ "batch": batch });
        if let Err(e) = self.handle.emit(&batched_event, payload) {
            warn!(
                target: "perf.emit_count",
                event = %batched_event,
                error = %e,
                "failed to emit batched event"
            );
        }
    }
}

/// Incoming push message on the bounded channel.
struct PushMsg {
    event_name: String,
    payload: Value,
}

/// Public API for high-frequency emit sites to hand events to.
///
/// Clone-friendly via `Arc`. Construct with `EventAggregator::new(handle)`
/// which spawns the background flush task.
pub struct EventAggregator {
    tx: mpsc::Sender<PushMsg>,
    shutdown_tx: AsyncMutex<Option<mpsc::Sender<()>>>,
    join_handle: AsyncMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl EventAggregator {
    /// Construct a new aggregator wired to a real Tauri `AppHandle`.
    pub fn new(handle: AppHandle) -> Self {
        Self::with_flusher(
            Arc::new(AppHandleFlusher::new(handle)),
            DEFAULT_BATCH_THRESHOLD,
            DEFAULT_FLUSH_INTERVAL,
        )
    }

    /// Construct with a custom flusher. Exposed for tests.
    pub fn with_flusher(
        flusher: Arc<dyn Flusher>,
        batch_threshold: usize,
        flush_interval: Duration,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<PushMsg>(CHANNEL_CAPACITY);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let join_handle = tokio::spawn(flush_loop(
            rx,
            shutdown_rx,
            flusher,
            batch_threshold,
            flush_interval,
        ));

        Self {
            tx,
            shutdown_tx: AsyncMutex::new(Some(shutdown_tx)),
            join_handle: AsyncMutex::new(Some(join_handle)),
        }
    }

    /// Non-blocking push. On channel full, logs a `warn!` and drops the
    /// event — never panics and never blocks the caller.
    pub fn push(&self, event_name: &str, payload: Value) {
        let msg = PushMsg {
            event_name: event_name.to_string(),
            payload,
        };
        if let Err(e) = self.tx.try_send(msg) {
            warn!(
                target: "perf.emit_count",
                event = event_name,
                error = %e,
                "event_aggregator channel full; dropping event"
            );
        }
    }

    /// Flush remaining buffered events and stop the background task.
    pub async fn shutdown(self) {
        // Signal shutdown; errors here mean the task already exited.
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(()).await;
        }
        if let Some(handle) = self.join_handle.lock().await.take() {
            let _ = handle.await;
        }
    }
}

/// Internal flush loop.
///
/// Keeps typed buffers keyed by event name. Drains the inbound channel,
/// flushing any buffer that reaches `batch_threshold` immediately and all
/// remaining buffers on each `flush_interval` tick. Per-type FIFO is
/// preserved because items are pushed to their buffer in arrival order and
/// flushed with `std::mem::take` in-order.
async fn flush_loop(
    mut rx: mpsc::Receiver<PushMsg>,
    mut shutdown_rx: mpsc::Receiver<()>,
    flusher: Arc<dyn Flusher>,
    batch_threshold: usize,
    flush_interval: Duration,
) {
    let mut buffers: HashMap<String, Vec<Value>> = HashMap::new();
    let mut ticker = tokio::time::interval(flush_interval);
    // `MissedTickBehavior::Delay` avoids burst flushes after a pause.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume the immediate first tick so the initial window is a full
    // `flush_interval`.
    ticker.tick().await;

    loop {
        tokio::select! {
            biased;

            _ = shutdown_rx.recv() => {
                // Drain anything still queued before flushing.
                while let Ok(msg) = rx.try_recv() {
                    buffers.entry(msg.event_name).or_default().push(msg.payload);
                }
                flush_all(&mut buffers, &*flusher);
                break;
            }

            maybe_msg = rx.recv() => {
                match maybe_msg {
                    Some(msg) => {
                        let entry = buffers.entry(msg.event_name.clone()).or_default();
                        entry.push(msg.payload);
                        if entry.len() >= batch_threshold {
                            let batch = std::mem::take(entry);
                            let size = batch.len();
                            flusher.emit_batch(&msg.event_name, batch);
                            log_emit_batch(&msg.event_name, size);
                        }
                    }
                    None => {
                        // Sender dropped; flush remaining and exit.
                        flush_all(&mut buffers, &*flusher);
                        break;
                    }
                }
            }

            _ = ticker.tick() => {
                flush_all(&mut buffers, &*flusher);
            }
        }
    }
}

fn flush_all(buffers: &mut HashMap<String, Vec<Value>>, flusher: &dyn Flusher) {
    // Iterate deterministically-ish; HashMap order is arbitrary but
    // per-type FIFO is what we must preserve, which is satisfied by the
    // per-buffer Vec order, not the cross-type order.
    for (event_name, buf) in buffers.iter_mut() {
        if buf.is_empty() {
            continue;
        }
        let batch = std::mem::take(buf);
        let size = batch.len();
        flusher.emit_batch(event_name, batch);
        log_emit_batch(event_name, size);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Test flusher that records every emit call.
    #[derive(Default)]
    struct MockFlusher {
        calls: StdMutex<Vec<(String, Vec<Value>)>>,
    }

    impl MockFlusher {
        fn snapshot(&self) -> Vec<(String, Vec<Value>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Flusher for MockFlusher {
        fn emit_batch(&self, event_name: &str, batch: Vec<Value>) {
            self.calls
                .lock()
                .unwrap()
                .push((event_name.to_string(), batch));
        }
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn pushes_below_threshold_do_not_flush_before_timer() {
        let mock = Arc::new(MockFlusher::default());
        let agg = EventAggregator::with_flusher(
            mock.clone(),
            8,                            // threshold
            Duration::from_millis(100),   // interval
        );

        for i in 0..4u64 {
            agg.push("evt", Value::from(i));
        }

        // Yield so the flush loop drains the channel into buffers.
        tokio::task::yield_now().await;
        // Advance a little, but less than the flush interval.
        tokio::time::advance(Duration::from_millis(40)).await;
        tokio::task::yield_now().await;

        assert!(
            mock.snapshot().is_empty(),
            "no flush should occur before threshold or interval"
        );

        // Now cross the interval boundary.
        tokio::time::advance(Duration::from_millis(80)).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        let calls = mock.snapshot();
        assert_eq!(calls.len(), 1, "one timer-driven flush expected");
        assert_eq!(calls[0].0, "evt");
        assert_eq!(calls[0].1.len(), 4);

        agg.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn threshold_triggers_immediate_flush() {
        let mock = Arc::new(MockFlusher::default());
        let agg = EventAggregator::with_flusher(
            mock.clone(),
            3,
            Duration::from_millis(10_000), // very long so only threshold can fire
        );

        for i in 0..3u64 {
            agg.push("evt", Value::from(i));
        }

        // Let the flush loop process the three pushes.
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }

        let calls = mock.snapshot();
        assert_eq!(calls.len(), 1, "threshold flush should fire");
        assert_eq!(calls[0].0, "evt");
        assert_eq!(calls[0].1, vec![Value::from(0u64), Value::from(1u64), Value::from(2u64)]);

        agg.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn per_type_fifo_preserved_with_interleaved_pushes() {
        let mock = Arc::new(MockFlusher::default());
        let agg = EventAggregator::with_flusher(
            mock.clone(),
            1024,
            Duration::from_millis(50),
        );

        // Interleave two event names.
        agg.push("a", Value::from(1u64));
        agg.push("b", Value::from(100u64));
        agg.push("a", Value::from(2u64));
        agg.push("b", Value::from(200u64));
        agg.push("a", Value::from(3u64));
        agg.push("b", Value::from(300u64));

        // Drain then wait for a timer tick.
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(60)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }

        let calls = mock.snapshot();
        // Expect one flush per event name this tick.
        let mut by_name: HashMap<String, Vec<Value>> = HashMap::new();
        for (name, batch) in calls {
            by_name.entry(name).or_default().extend(batch);
        }
        assert_eq!(
            by_name.get("a").cloned().unwrap_or_default(),
            vec![Value::from(1u64), Value::from(2u64), Value::from(3u64)],
            "type 'a' must preserve FIFO"
        );
        assert_eq!(
            by_name.get("b").cloned().unwrap_or_default(),
            vec![Value::from(100u64), Value::from(200u64), Value::from(300u64)],
            "type 'b' must preserve FIFO"
        );

        agg.shutdown().await;
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn push_on_full_channel_does_not_panic() {
        // Build aggregator with a flusher that never runs fast: we stall
        // the loop by not yielding. More directly, we construct the
        // channel at CHANNEL_CAPACITY by pushing synchronously without
        // letting the loop run, then push one more.
        let mock = Arc::new(MockFlusher::default());
        let agg = EventAggregator::with_flusher(
            mock.clone(),
            100_000,                       // never trigger threshold flush
            Duration::from_secs(3600),     // never trigger timer flush
        );

        // Fill the bounded channel. We do NOT yield to the runtime so the
        // flush loop cannot drain. Because the runtime is current-thread
        // and paused, the spawned task has not executed and the channel
        // fills up deterministically.
        for i in 0..CHANNEL_CAPACITY {
            agg.push("evt", Value::from(i as u64));
        }
        // This push MUST NOT panic even though the channel is full.
        agg.push("evt", Value::from(u64::MAX));

        // Sanity: nothing flushed yet.
        assert!(mock.snapshot().is_empty());

        agg.shutdown().await;
    }
}
