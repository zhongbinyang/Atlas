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
        let mut held: Vec<String> = Vec::with_capacity(ordered.len());

        for name in ordered {
            if let Some(ref mut rx) = cancel {
                if *rx.borrow() {
                    self.release_held(&held);
                    return Err(ResourceLockError::Cancelled);
                }
            }

            match self.try_acquire_one(&name, owner) {
                AcquireOne::Granted => {
                    held.push(name);
                    continue;
                }
                AcquireOne::MustWait { id, rx } => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let wait_result = wait_for_grant(rx, remaining, cancel.as_mut()).await;
                    match wait_result {
                        WaitOutcome::Granted => {
                            self.set_owner(&name, owner);
                            held.push(name);
                        }
                        WaitOutcome::Timeout => {
                            if !self.cancel_waiter(&name, id) {
                                // Race: grant already transferred; take ownership then unwind.
                                held.push(name.clone());
                            }
                            self.release_held(&held);
                            return Err(ResourceLockError::Timeout { resource: name });
                        }
                        WaitOutcome::Cancelled => {
                            if !self.cancel_waiter(&name, id) {
                                held.push(name);
                            }
                            self.release_held(&held);
                            return Err(ResourceLockError::Cancelled);
                        }
                    }
                }
            }
        }

        Ok(ResourceGuard {
            manager: Arc::clone(self),
            names: held,
        })
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
}

enum AcquireOne {
    Granted,
    MustWait { id: u64, rx: oneshot::Receiver<()> },
}

enum WaitOutcome {
    Granted,
    Timeout,
    Cancelled,
}

async fn wait_for_grant(
    mut rx: oneshot::Receiver<()>,
    timeout: Duration,
    cancel: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> WaitOutcome {
    let sleep = tokio::time::sleep(timeout);
    tokio::pin!(sleep);

    if let Some(cancel) = cancel {
        loop {
            tokio::select! {
                biased;
                res = &mut rx => {
                    return match res {
                        Ok(()) => WaitOutcome::Granted,
                        Err(_) => WaitOutcome::Cancelled,
                    };
                }
                _ = &mut sleep => {
                    return WaitOutcome::Timeout;
                }
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        return WaitOutcome::Cancelled;
                    }
                }
            }
        }
    } else {
        tokio::select! {
            biased;
            res = &mut rx => {
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
}
