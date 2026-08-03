use std::sync::Arc;
use tokio::sync::Mutex;

/// Single-flight busy slot shared by sequence / delay / REST (not shell tasks).
///
/// Each successful [`Self::try_acquire`] bumps a generation token. [`Self::release`]
/// and cancel teardown must pass that token so a stale run cannot clear a newer hold
/// after force-release.
pub struct TaskSlot {
    inner: Mutex<Inner>,
}

struct Inner {
    busy: bool,
    owner: Option<String>,
    /// Monotonic; incremented on every successful acquire and on force_release.
    generation: u64,
}

impl TaskSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                busy: false,
                owner: None,
                generation: 0,
            }),
        })
    }

    pub async fn is_busy(&self) -> bool {
        self.inner.lock().await.busy
    }

    pub async fn owner(&self) -> Option<String> {
        self.inner.lock().await.owner.clone()
    }

    /// Returns the generation token for this hold, or Err("busy") if occupied.
    pub async fn try_acquire(&self, owner: &str) -> Result<u64, &'static str> {
        let mut g = self.inner.lock().await;
        if g.busy {
            return Err("busy");
        }
        g.generation = g.generation.wrapping_add(1);
        g.busy = true;
        g.owner = Some(owner.to_string());
        Ok(g.generation)
    }

    /// Release only if `generation` is still the active hold.
    /// Returns true if this call cleared the slot.
    pub async fn release(&self, generation: u64) -> bool {
        let mut g = self.inner.lock().await;
        if g.busy && g.generation == generation {
            g.busy = false;
            g.owner = None;
            true
        } else {
            false
        }
    }

    /// Generation of the current hold, if busy.
    pub async fn current_generation_if_busy(&self) -> Option<u64> {
        let g = self.inner.lock().await;
        if g.busy {
            Some(g.generation)
        } else {
            None
        }
    }

    /// Unconditionally clear a busy slot and invalidate its generation so a
    /// subsequent [`Self::release`] from the old holder is a no-op.
    /// Returns the generation that was force-released, if any.
    pub async fn force_release(&self) -> Option<u64> {
        let mut g = self.inner.lock().await;
        if !g.busy {
            return None;
        }
        let gen = g.generation;
        g.busy = false;
        g.owner = None;
        // Invalidate the old generation so stale release(gen) cannot clear a later hold.
        g.generation = g.generation.wrapping_add(1);
        Some(gen)
    }

    /// Force-release only if `generation` is still the active hold.
    /// Keeps the slot busy for other generations (no-op if mismatched).
    pub async fn force_release_if(&self, generation: u64) -> bool {
        let mut g = self.inner.lock().await;
        if g.busy && g.generation == generation {
            g.busy = false;
            g.owner = None;
            g.generation = g.generation.wrapping_add(1);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn try_acquire_rejects_second() {
        let slot = TaskSlot::new();
        let gen = slot.try_acquire("sequence").await.unwrap();
        assert_eq!(slot.owner().await.as_deref(), Some("sequence"));
        assert_eq!(slot.try_acquire("delay").await.unwrap_err(), "busy");
        assert!(slot.release(gen).await);
        assert!(slot.owner().await.is_none());
        let gen2 = slot.try_acquire("delay").await.unwrap();
        assert!(slot.release(gen2).await);
    }

    #[tokio::test]
    async fn stale_release_after_force_release_does_not_clear_new_hold() {
        let slot = TaskSlot::new();
        let gen_a = slot.try_acquire("sequence").await.unwrap();
        assert_eq!(slot.force_release().await, Some(gen_a));
        assert!(!slot.is_busy().await);

        let gen_b = slot.try_acquire("sequence").await.unwrap();
        assert_ne!(gen_a, gen_b);
        // Old run finishes and tries to release its generation — must not touch B.
        assert!(!slot.release(gen_a).await);
        assert!(slot.is_busy().await);
        assert_eq!(slot.owner().await.as_deref(), Some("sequence"));
        assert!(slot.release(gen_b).await);
        assert!(!slot.is_busy().await);
    }

    #[tokio::test]
    async fn release_with_wrong_generation_is_noop() {
        let slot = TaskSlot::new();
        let gen = slot.try_acquire("sequence").await.unwrap();
        assert!(!slot.release(gen.wrapping_add(99)).await);
        assert!(slot.is_busy().await);
        assert!(slot.release(gen).await);
    }

    #[tokio::test]
    async fn force_release_if_mismatched_keeps_busy() {
        let slot = TaskSlot::new();
        let gen = slot.try_acquire("sequence").await.unwrap();
        assert!(!slot.force_release_if(gen.wrapping_add(1)).await);
        assert!(slot.is_busy().await);
        assert_eq!(slot.current_generation_if_busy().await, Some(gen));
        assert!(slot.force_release_if(gen).await);
        assert!(!slot.is_busy().await);
    }
}
