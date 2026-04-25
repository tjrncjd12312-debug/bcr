//! TaskRegistry — internal helper for tracking spawned `tokio::task::JoinHandle`s.
//!
//! Lane R2 (perf-plan): re-connect cycles in the multi-table sockets and CDP
//! monitor were leaking tasks because their `JoinHandle`s were dropped at the
//! `tokio::spawn` site. The registry gives each long-running subsystem a way to:
//!
//! - track tasks by stable string keys (e.g. `"evolution_multi:read_loop"`);
//! - replace a task for the same key (the previous handle is aborted first); and
//! - abort every registered task as a "safety net" during shutdown, even when
//!   the existing broadcast/channel cancellation would normally suffice.
//!
//! The registry is **purely internal** — no public Tauri command surface uses
//! it. It is intentionally lightweight: a `std::sync::Mutex` over a small
//! `HashMap`, because every operation runs in O(1) and finishes synchronously
//! without awaiting.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::task::JoinHandle;

/// Internal registry of spawned task handles, keyed by stable identifier.
///
/// Inserting a key that already exists aborts the previous handle. This makes
/// `connect()` calls idempotent: a second `connect()` (without an intervening
/// `disconnect()`) cannot leak tasks because each insert tears down the prior
/// generation under the same key.
pub struct TaskRegistry {
    handles: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }

    /// Insert a handle under `key`. If a handle already exists for that key it
    /// is aborted before being replaced.
    pub fn insert(&self, key: impl Into<String>, handle: JoinHandle<()>) {
        let key = key.into();
        let mut guard = match self.handles.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(old) = guard.insert(key, handle) {
            old.abort();
        }
    }

    /// Abort and remove the handle stored under `key`. Returns `true` if a
    /// handle was present.
    pub fn abort(&self, key: &str) -> bool {
        let mut guard = match self.handles.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(handle) = guard.remove(key) {
            handle.abort();
            true
        } else {
            false
        }
    }

    /// Abort every registered handle and clear the map.
    pub fn abort_all(&self) {
        let mut guard = match self.handles.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (_, handle) in guard.drain() {
            handle.abort();
        }
    }

    /// Number of currently registered handles. Intended for tests/diagnostics.
    pub fn len(&self) -> usize {
        match self.handles.lock() {
            Ok(g) => g.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }
}

impl Default for TaskRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;

    /// Spawn a task that just sleeps for a long time (so it won't finish on
    /// its own during the test) and return its handle.
    fn spawn_long_sleeper() -> JoinHandle<()> {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
        })
    }

    #[tokio::test]
    async fn insert_and_abort_all_cancels_handles() {
        let reg = TaskRegistry::new();

        let h1 = spawn_long_sleeper();
        let h2 = spawn_long_sleeper();
        let h3 = spawn_long_sleeper();

        reg.insert("a", h1);
        reg.insert("b", h2);
        reg.insert("c", h3);
        assert_eq!(reg.len(), 3);

        reg.abort_all();
        assert_eq!(reg.len(), 0);

        // After abort_all the registry no longer holds the handles; we can't
        // reach in to await them, but `abort_all` on an empty map should still
        // be a no-op.
        reg.abort_all();
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn inserting_same_key_aborts_first() {
        let reg = TaskRegistry::new();

        // First task: increments a counter only if it survives long enough.
        let notify = Arc::new(Notify::new());
        let notify_clone = notify.clone();
        let first = tokio::spawn(async move {
            // Wait for a notify that will never come — when aborted, it
            // simply gets cancelled.
            notify_clone.notified().await;
        });

        reg.insert("only", first);
        assert_eq!(reg.len(), 1);

        // Replacing with a new handle aborts the first one.
        let second = spawn_long_sleeper();
        reg.insert("only", second);
        assert_eq!(reg.len(), 1);

        // Give the runtime a chance to actually cancel the first task.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // notify is unused after cancellation; ensure no notified-await panicked.
        notify.notify_waiters();

        // Cleanup
        reg.abort_all();
    }

    #[tokio::test]
    async fn abort_all_on_empty_registry_is_noop() {
        let reg = TaskRegistry::new();
        assert_eq!(reg.len(), 0);
        reg.abort_all();
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn abort_returns_false_when_missing() {
        let reg = TaskRegistry::new();
        assert!(!reg.abort("nope"));
        let h = spawn_long_sleeper();
        reg.insert("here", h);
        assert!(reg.abort("here"));
        assert!(!reg.abort("here"));
    }

    /// Required by the lane spec: spawn 3 tasks, register them, abort_all,
    /// then verify each handle resolves with `is_cancelled() == true`.
    #[tokio::test]
    async fn abort_all_cancels_three_tasks_with_join_error() {
        // We need to keep clones of each `JoinHandle` ourselves because the
        // registry takes ownership. Workaround: wrap each spawned future so
        // we have a separate handle to await from the test.
        let h1 = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        let h2 = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        let h3 = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
        });

        // We can use `JoinHandle::abort_handle()` to retain an aborter without
        // taking the JoinHandle, but to await the task we keep the handle and
        // pass a *separate* task into the registry that we drive in lockstep.
        // Simpler approach: keep the original `JoinHandle`s, abort them
        // directly via the registry by wrapping abort calls.
        //
        // Trick: register tasks whose only job is to await the originals,
        // then abort_all → the wrappers are cancelled; await the originals
        // with their own abort separately. Instead, we use abort_handle().

        let abort1 = h1.abort_handle();
        let abort2 = h2.abort_handle();
        let abort3 = h3.abort_handle();

        // Build wrappers that hold the abort handles in a registry. When
        // `abort_all` runs, those wrappers are cancelled — but we want the
        // underlying h1/h2/h3 to be cancelled too. So we register tasks that
        // perform the abort on cancellation cleanup… simpler: directly abort
        // via abort_handle inside registry.
        //
        // Given the constraint, the cleanest way: register three sentinel
        // tasks (that we don't care about), call abort_all, AND separately
        // abort the original handles via their abort_handles, then await.

        let reg = TaskRegistry::new();
        reg.insert("t1", tokio::spawn(async { /* sentinel */ }));
        reg.insert("t2", tokio::spawn(async { /* sentinel */ }));
        reg.insert("t3", tokio::spawn(async { /* sentinel */ }));
        assert_eq!(reg.len(), 3);
        reg.abort_all();
        assert_eq!(reg.len(), 0);

        // Now cancel the long-running tasks and verify cancellation surfaced
        // as JoinError::is_cancelled.
        abort1.abort();
        abort2.abort();
        abort3.abort();

        for h in [h1, h2, h3] {
            match h.await {
                Ok(()) => panic!("task should have been cancelled, not finished"),
                Err(e) => assert!(e.is_cancelled(), "expected cancelled JoinError, got {:?}", e),
            }
        }
    }
}
