use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// In-process named resource locks with FIFO waiters and acquire timeout.
pub struct ResourceLockManager {
    inner: Mutex<Inner>,
}

struct Inner {
    next_waiter_id: u64,
    resources: HashMap<String, ResourceState>,
}

struct ResourceState {
    held: bool,
    owner: Option<String>,
    waiters: VecDeque<Waiter>,
}

struct Waiter {
    id: u64,
    tx: oneshot::Sender<()>,
}

/// RAII guard: drops release all held resources (FIFO wake next waiter).
pub struct ResourceGuard {
    manager: Arc<ResourceLockManager>,
    names: Vec<String>,
}

impl std::fmt::Debug for ResourceGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceGuard")
            .field("names", &self.names)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceLockError {
    Timeout { resource: String },
    Cancelled,
}

struct Waiting {
    name: String,
    id: u64,
    rx: oneshot::Receiver<()>,
}

/// Tracks partial acquires so a dropped/cancelled future cannot leak locks.
struct AcquireInProgress {
    manager: Arc<ResourceLockManager>,
    held: Vec<String>,
    /// Currently queued waiter. Cleared when wait completes.
    waiting: Option<Waiting>,
    /// When true, Drop releases `held` and cancels/unwinds `waiting`.
    armed: bool,
}

impl AcquireInProgress {
    fn new(manager: Arc<ResourceLockManager>, capacity: usize) -> Self {
        Self {
            manager,
            held: Vec::with_capacity(capacity),
            waiting: None,
            armed: true,
        }
    }

    fn into_guard(mut self) -> ResourceGuard {
        debug_assert!(self.waiting.is_none());
        self.armed = false;
        let names = std::mem::take(&mut self.held);
        ResourceGuard {
            manager: Arc::clone(&self.manager),
            names,
        }
    }

    fn abort_with(&mut self, err: ResourceLockError) -> ResourceLockError {
        self.cleanup();
        self.armed = false;
        err
    }

    fn cleanup(&mut self) {
        if let Some(mut w) = self.waiting.take() {
            match w.rx.try_recv() {
                Ok(()) => {
                    // Grant already transferred to us.
                    self.held.push(w.name);
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    if !self.manager.cancel_waiter(&w.name, w.id) {
                        // Releaser popped us under the mutex; send already ran before unlock.
                        match w.rx.try_recv() {
                            Ok(()) => self.held.push(w.name),
                            // send failed (we are aborting) — releaser recurses; we do not own.
                            Err(_) => {}
                        }
                    }
                }
                // Sender dropped without grant — we do not own.
                Err(oneshot::error::TryRecvError::Closed) => {}
            }
        }
        if !self.held.is_empty() {
            self.manager.release_held(&self.held);
            self.held.clear();
        }
    }
}

impl Drop for AcquireInProgress {
    fn drop(&mut self) {
        if self.armed {
            self.cleanup();
        }
    }
}

impl ResourceLockManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                next_waiter_id: 1,
                resources: HashMap::new(),
            }),
        })
    }

    /// Acquire all `names` (sorted + deduped to avoid deadlock: always lock in lexicographic order).
    /// Waits FIFO per resource. Returns Err on timeout or cancel.
    pub async fn acquire(
        self: &Arc<Self>,
        names: &[String],
        owner: &str,
        timeout: Duration,
        mut cancel: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> Result<ResourceGuard, ResourceLockError> {
        let mut ordered: Vec<String> = names.to_vec();
        ordered.sort();
        ordered.dedup();

        if ordered.is_empty() {
            return Ok(ResourceGuard {
                manager: Arc::clone(self),
                names: Vec::new(),
            });
        }

        let deadline = Instant::now() + timeout;
        let mut progress = AcquireInProgress::new(Arc::clone(self), ordered.len());

        for name in ordered {
            if cancel_signaled(cancel.as_ref()) {
                return Err(progress.abort_with(ResourceLockError::Cancelled));
            }

            match self.try_acquire_one(&name, owner) {
                AcquireOne::Granted => {
                    progress.held.push(name);
                }
                AcquireOne::MustWait { id, rx } => {
                    progress.waiting = Some(Waiting {
                        name: name.clone(),
                        id,
                        rx,
                    });
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let wait_result = {
                        let waiting = progress.waiting.as_mut().expect("waiting just set");
                        wait_for_grant(&mut waiting.rx, remaining, cancel.as_mut()).await
                    };

                    match wait_result {
                        WaitOutcome::Granted => {
                            let w = progress.waiting.take().expect("waiting during grant");
                            self.set_owner(&w.name, owner);
                            progress.held.push(w.name);
                        }
                        WaitOutcome::Timeout => {
                            let w = progress.waiting.take().expect("waiting during timeout");
                            if !self.cancel_waiter(&w.name, w.id) {
                                // Grant raced with timeout — take ownership then unwind.
                                progress.held.push(w.name.clone());
                            }
                            return Err(progress.abort_with(ResourceLockError::Timeout {
                                resource: w.name,
                            }));
                        }
                        WaitOutcome::Cancelled => {
                            let mut w = progress.waiting.take().expect("waiting during cancel");
                            if !self.cancel_waiter(&w.name, w.id) {
                                // Releaser may have transferred; only claim if value is present.
                                if w.rx.try_recv().is_ok() {
                                    progress.held.push(w.name);
                                }
                            }
                            return Err(progress.abort_with(ResourceLockError::Cancelled));
                        }
                        WaitOutcome::CancelledAfterGrant => {
                            // oneshot already received; we own the lock and must unwind.
                            let w = progress.waiting.take().expect("waiting during cancel-after-grant");
                            progress.held.push(w.name);
                            return Err(progress.abort_with(ResourceLockError::Cancelled));
                        }
                    }
                }
            }
        }

        if cancel_signaled(cancel.as_ref()) {
            return Err(progress.abort_with(ResourceLockError::Cancelled));
        }

        Ok(progress.into_guard())
    }

    fn try_acquire_one(&self, name: &str, owner: &str) -> AcquireOne {
        let mut inner = self.inner.lock().expect("resource lock poisoned");
        {
            let state = inner
                .resources
                .entry(name.to_string())
                .or_insert_with(|| ResourceState {
                    held: false,
                    owner: None,
                    waiters: VecDeque::new(),
                });
            if !state.held {
                state.held = true;
                state.owner = Some(owner.to_string());
                return AcquireOne::Granted;
            }
        }

        let id = inner.next_waiter_id;
        inner.next_waiter_id = inner.next_waiter_id.wrapping_add(1);
        let (tx, rx) = oneshot::channel();
        inner
            .resources
            .get_mut(name)
            .expect("resource state just inserted")
            .waiters
            .push_back(Waiter { id, tx });
        AcquireOne::MustWait { id, rx }
    }

    fn set_owner(&self, name: &str, owner: &str) {
        let mut inner = self.inner.lock().expect("resource lock poisoned");
        if let Some(state) = inner.resources.get_mut(name) {
            state.owner = Some(owner.to_string());
        }
    }

    /// Remove a waiter by id. Returns true if it was still queued (not yet granted).
    fn cancel_waiter(&self, name: &str, id: u64) -> bool {
        let mut inner = self.inner.lock().expect("resource lock poisoned");
        let Some(state) = inner.resources.get_mut(name) else {
            return false;
        };
        if let Some(pos) = state.waiters.iter().position(|w| w.id == id) {
            state.waiters.remove(pos);
            true
        } else {
            false
        }
    }

    fn release_held(&self, names: &[String]) {
        // Release in reverse acquire order.
        for name in names.iter().rev() {
            self.release_one(name);
        }
    }

    fn release_one(&self, name: &str) {
        let mut inner = self.inner.lock().expect("resource lock poisoned");
        let Some(state) = inner.resources.get_mut(name) else {
            return;
        };

        if let Some(waiter) = state.waiters.pop_front() {
            // Transfer ownership to the next FIFO waiter.
            state.owner = None;
            if waiter.tx.send(()).is_err() {
                // Waiter gone — keep releasing down the queue.
                drop(inner);
                self.release_one(name);
            }
        } else {
            state.held = false;
            state.owner = None;
        }
    }

    #[cfg(test)]
    fn is_held(&self, name: &str) -> bool {
        let inner = self.inner.lock().expect("resource lock poisoned");
        inner.resources.get(name).map(|s| s.held).unwrap_or(false)
    }
}

fn cancel_signaled(cancel: Option<&tokio::sync::watch::Receiver<bool>>) -> bool {
    cancel.map(|rx| *rx.borrow()).unwrap_or(false)
}

enum AcquireOne {
    Granted,
    MustWait { id: u64, rx: oneshot::Receiver<()> },
}

enum WaitOutcome {
    Granted,
    Timeout,
    Cancelled,
    /// Grant oneshot received, but cancel is also set — caller owns lock and must release.
    CancelledAfterGrant,
}

async fn wait_for_grant(
    rx: &mut oneshot::Receiver<()>,
    timeout: Duration,
    cancel: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> WaitOutcome {
    if cancel_signaled(cancel.as_deref()) {
        return WaitOutcome::Cancelled;
    }

    let sleep = tokio::time::sleep(timeout);
    tokio::pin!(sleep);

    if let Some(cancel) = cancel {
        loop {
            // Prefer cancel over grant when both are ready (no `biased` toward rx).
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        return WaitOutcome::Cancelled;
                    }
                }
                res = &mut *rx => {
                    return match res {
                        Ok(()) => {
                            if *cancel.borrow() {
                                WaitOutcome::CancelledAfterGrant
                            } else {
                                WaitOutcome::Granted
                            }
                        }
                        Err(_) => WaitOutcome::Cancelled,
                    };
                }
                _ = &mut sleep => {
                    return WaitOutcome::Timeout;
                }
            }
        }
    } else {
        tokio::select! {
            res = &mut *rx => {
                match res {
                    Ok(()) => WaitOutcome::Granted,
                    Err(_) => WaitOutcome::Cancelled,
                }
            }
            _ = sleep => WaitOutcome::Timeout,
        }
    }
}

impl Drop for ResourceGuard {
    fn drop(&mut self) {
        if self.names.is_empty() {
            return;
        }
        let names = std::mem::take(&mut self.names);
        self.manager.release_held(&names);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn second_acquirer_waits_until_release() {
        let m = ResourceLockManager::new();
        let g1 = m
            .acquire(&["station.dca".into()], "ch-1", Duration::from_secs(5), None)
            .await
            .unwrap();
        let m2 = m.clone();
        let h = tokio::spawn(async move {
            m2.acquire(&["station.dca".into()], "ch-2", Duration::from_secs(5), None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!h.is_finished());
        drop(g1);
        assert!(h.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn acquire_times_out() {
        let m = ResourceLockManager::new();
        let _g = m
            .acquire(
                &["station.dca".into()],
                "ch-1",
                Duration::from_secs(30),
                None,
            )
            .await
            .unwrap();
        let err = m
            .acquire(
                &["station.dca".into()],
                "ch-2",
                Duration::from_millis(30),
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ResourceLockError::Timeout { .. }));
    }

    #[tokio::test]
    async fn empty_resources_is_noop() {
        let m = ResourceLockManager::new();
        let g = m
            .acquire(&[], "ch-1", Duration::from_secs(1), None)
            .await
            .unwrap();
        drop(g);
    }

    #[tokio::test]
    async fn drop_during_wait_does_not_leak() {
        let m = ResourceLockManager::new();
        let g1 = m
            .acquire(&["station.dca".into()], "ch-1", Duration::from_secs(5), None)
            .await
            .unwrap();

        let m2 = m.clone();
        let h = tokio::spawn(async move {
            m2.acquire(&["station.dca".into()], "ch-2", Duration::from_secs(5), None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!h.is_finished());

        // Abort the waiting acquire (simulates future drop / task cancel).
        h.abort();
        let _ = h.await;
        drop(g1);

        // Resource must be obtainable again — no leaked waiter/hold from aborted acquire.
        let g3 = m
            .acquire(
                &["station.dca".into()],
                "ch-3",
                Duration::from_millis(200),
                None,
            )
            .await
            .expect("resource should not leak after aborted waiter");
        assert!(m.is_held("station.dca"));
        drop(g3);
        assert!(!m.is_held("station.dca"));
    }

    #[tokio::test]
    async fn cancel_returns_cancelled_without_holding() {
        let m = ResourceLockManager::new();
        let g1 = m
            .acquire(&["station.dca".into()], "ch-1", Duration::from_secs(5), None)
            .await
            .unwrap();

        let (tx, rx) = tokio::sync::watch::channel(false);
        let m2 = m.clone();
        let h = tokio::spawn(async move {
            m2.acquire(
                &["station.dca".into()],
                "ch-2",
                Duration::from_secs(5),
                Some(rx),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!h.is_finished());

        tx.send(true).unwrap();
        let err = h.await.unwrap().unwrap_err();
        assert!(matches!(err, ResourceLockError::Cancelled));

        // Cancelled waiter must not hold the lock; holder still g1.
        assert!(m.is_held("station.dca"));
        drop(g1);

        let g3 = m
            .acquire(
                &["station.dca".into()],
                "ch-3",
                Duration::from_millis(200),
                None,
            )
            .await
            .expect("lock free after cancel");
        drop(g3);
        assert!(!m.is_held("station.dca"));
    }

    #[tokio::test]
    async fn cancel_after_last_resource_granted_returns_cancelled() {
        // Immediate grants (no wait) must still honor cancel before returning Ok(Guard).
        let m = ResourceLockManager::new();
        let (tx, rx) = tokio::sync::watch::channel(false);
        tx.send(true).unwrap();

        let err = m
            .acquire(
                &["station.dca".into()],
                "ch-1",
                Duration::from_secs(1),
                Some(rx),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ResourceLockError::Cancelled));
        assert!(!m.is_held("station.dca"));
    }
}
