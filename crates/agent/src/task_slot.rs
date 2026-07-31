use std::sync::Arc;
use tokio::sync::Mutex;

/// Single-flight busy slot shared by sequence / delay / REST (not shell tasks).
pub struct TaskSlot {
    inner: Mutex<Inner>,
}

struct Inner {
    busy: bool,
    owner: Option<String>,
}

impl TaskSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                busy: false,
                owner: None,
            }),
        })
    }

    pub async fn is_busy(&self) -> bool {
        self.inner.lock().await.busy
    }

    pub async fn owner(&self) -> Option<String> {
        self.inner.lock().await.owner.clone()
    }

    /// Returns Err("busy") if slot occupied.
    pub async fn try_acquire(&self, owner: &str) -> Result<(), &'static str> {
        let mut g = self.inner.lock().await;
        if g.busy {
            return Err("busy");
        }
        g.busy = true;
        g.owner = Some(owner.to_string());
        Ok(())
    }

    pub async fn release(&self) {
        let mut g = self.inner.lock().await;
        g.busy = false;
        g.owner = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn try_acquire_rejects_second() {
        let slot = TaskSlot::new();
        assert!(slot.try_acquire("sequence").await.is_ok());
        assert_eq!(slot.owner().await.as_deref(), Some("sequence"));
        assert_eq!(slot.try_acquire("delay").await.unwrap_err(), "busy");
        slot.release().await;
        assert!(slot.owner().await.is_none());
        assert!(slot.try_acquire("delay").await.is_ok());
        slot.release().await;
    }
}
