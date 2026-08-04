use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

/// Single-flight busy slot shared by sequence / delay / REST (not shell tasks).
///
/// Each successful acquisition bumps a generation token. Releases must pass that
/// token so a stale run cannot clear a newer hold after force-release.
pub struct TaskSlot {
    inner: Mutex<Inner>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskHold {
    pub owner: String,
    pub channel_index: Option<usize>,
    pub generation: u64,
}

enum Holds {
    Idle,
    Exclusive { owner: String, generation: u64 },
    Sequence(HashMap<usize, u64>),
}

struct Inner {
    holds: Holds,
    /// Monotonic; incremented before every acquisition and on force release.
    next_generation: u64,
}

impl TaskSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                holds: Holds::Idle,
                next_generation: 0,
            }),
        })
    }

    pub async fn is_busy(&self) -> bool {
        !matches!(self.inner.lock().await.holds, Holds::Idle)
    }

    pub async fn owner(&self) -> Option<String> {
        match &self.inner.lock().await.holds {
            Holds::Idle => None,
            Holds::Exclusive { owner, .. } => Some(owner.clone()),
            Holds::Sequence(_) => Some("sequence".to_string()),
        }
    }

    /// Returns the generation token for this hold, or Err("busy") if occupied.
    pub async fn try_acquire(&self, owner: &str) -> Result<u64, &'static str> {
        let mut g = self.inner.lock().await;
        if !matches!(g.holds, Holds::Idle) {
            return Err("busy");
        }
        g.next_generation = g.next_generation.wrapping_add(1);
        let generation = g.next_generation;
        g.holds = Holds::Exclusive {
            owner: owner.to_string(),
            generation,
        };
        Ok(generation)
    }

    /// Acquire a sequence hold for one channel. Different channels may hold
    /// concurrently; duplicate channels are rejected.
    pub async fn try_acquire_sequence(&self, channel_index: usize) -> Result<u64, &'static str> {
        let mut g = self.inner.lock().await;
        if matches!(g.holds, Holds::Exclusive { .. }) {
            return Err("busy");
        }
        if matches!(&g.holds, Holds::Sequence(channels) if channels.contains_key(&channel_index)) {
            return Err("channel busy");
        }

        g.next_generation = g.next_generation.wrapping_add(1);
        let generation = g.next_generation;
        match &mut g.holds {
            Holds::Idle => {
                let mut channels = HashMap::new();
                channels.insert(channel_index, generation);
                g.holds = Holds::Sequence(channels);
            }
            Holds::Sequence(channels) => {
                channels.insert(channel_index, generation);
            }
            Holds::Exclusive { .. } => unreachable!("exclusive holds return above"),
        }
        Ok(generation)
    }

    /// Release only if `generation` is still the active hold.
    /// Returns true if this call cleared the slot.
    pub async fn release(&self, generation: u64) -> bool {
        let mut g = self.inner.lock().await;
        if matches!(g.holds, Holds::Exclusive { generation: active, .. } if active == generation) {
            g.holds = Holds::Idle;
            true
        } else {
            false
        }
    }

    /// Release a sequence hold only if both channel and generation still match.
    pub async fn release_sequence(&self, channel_index: usize, generation: u64) -> bool {
        let mut g = self.inner.lock().await;
        let Holds::Sequence(channels) = &mut g.holds else {
            return false;
        };
        if channels.get(&channel_index) != Some(&generation) {
            return false;
        }
        channels.remove(&channel_index);
        if channels.is_empty() {
            g.holds = Holds::Idle;
        }
        true
    }

    /// Snapshot every exact live hold without changing admission state.
    pub async fn snapshot_holds(&self) -> Vec<TaskHold> {
        let g = self.inner.lock().await;
        let mut holds = match &g.holds {
            Holds::Idle => Vec::new(),
            Holds::Exclusive { owner, generation } => vec![TaskHold {
                owner: owner.clone(),
                channel_index: None,
                generation: *generation,
            }],
            Holds::Sequence(channels) => channels
                .iter()
                .map(|(channel_index, generation)| TaskHold {
                    owner: "sequence".to_string(),
                    channel_index: Some(*channel_index),
                    generation: *generation,
                })
                .collect(),
        };
        holds.sort_by_key(|hold| (hold.channel_index, hold.generation));
        holds
    }

    /// Unconditionally clear all holds and invalidate their generations.
    pub async fn force_release_all(&self) -> Vec<TaskHold> {
        let mut g = self.inner.lock().await;
        let previous = std::mem::replace(&mut g.holds, Holds::Idle);
        g.next_generation = g.next_generation.wrapping_add(1);
        match previous {
            Holds::Idle => Vec::new(),
            Holds::Exclusive { owner, generation } => vec![TaskHold {
                owner,
                channel_index: None,
                generation,
            }],
            Holds::Sequence(channels) => channels
                .into_iter()
                .map(|(channel_index, generation)| TaskHold {
                    owner: "sequence".to_string(),
                    channel_index: Some(channel_index),
                    generation,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn try_acquire_rejects_second() {
        let slot = TaskSlot::new();
        let gen = slot.try_acquire("delay").await.unwrap();
        assert_eq!(slot.owner().await.as_deref(), Some("delay"));
        assert_eq!(slot.try_acquire("delay").await.unwrap_err(), "busy");
        assert!(slot.release(gen).await);
        assert!(slot.owner().await.is_none());
        let gen2 = slot.try_acquire("delay").await.unwrap();
        assert!(slot.release(gen2).await);
    }

    #[tokio::test]
    async fn stale_release_after_force_release_does_not_clear_new_hold() {
        let slot = TaskSlot::new();
        let gen_a = slot.try_acquire("delay").await.unwrap();
        assert_eq!(slot.force_release_all().await.len(), 1);
        assert!(!slot.is_busy().await);

        let gen_b = slot.try_acquire("delay").await.unwrap();
        assert_ne!(gen_a, gen_b);
        // Old run finishes and tries to release its generation — must not touch B.
        assert!(!slot.release(gen_a).await);
        assert!(slot.is_busy().await);
        assert_eq!(slot.owner().await.as_deref(), Some("delay"));
        assert!(slot.release(gen_b).await);
        assert!(!slot.is_busy().await);
    }

    #[tokio::test]
    async fn release_with_wrong_generation_is_noop() {
        let slot = TaskSlot::new();
        let gen = slot.try_acquire("delay").await.unwrap();
        assert!(!slot.release(gen.wrapping_add(99)).await);
        assert!(slot.is_busy().await);
        assert!(slot.release(gen).await);
    }

    #[tokio::test]
    async fn distinct_sequence_channels_share_admission_but_duplicates_do_not() {
        let slot = TaskSlot::new();
        let ch0 = slot.try_acquire_sequence(0).await.unwrap();
        let ch1 = slot.try_acquire_sequence(1).await.unwrap();

        assert_ne!(ch0, ch1);
        assert_eq!(
            slot.try_acquire_sequence(0).await.unwrap_err(),
            "channel busy"
        );
        assert_eq!(slot.owner().await.as_deref(), Some("sequence"));
        assert!(slot.release_sequence(0, ch0).await);
        assert!(slot.is_busy().await);
        assert!(slot.release_sequence(1, ch1).await);
        assert!(!slot.is_busy().await);
    }

    #[tokio::test]
    async fn exclusive_and_sequence_admission_exclude_each_other() {
        let slot = TaskSlot::new();
        let delay = slot.try_acquire("delay").await.unwrap();
        assert_eq!(slot.try_acquire_sequence(0).await.unwrap_err(), "busy");
        assert!(slot.release(delay).await);

        let ch0 = slot.try_acquire_sequence(0).await.unwrap();
        assert_eq!(slot.try_acquire("rest").await.unwrap_err(), "busy");
        assert!(slot.release_sequence(0, ch0).await);
    }

    #[tokio::test]
    async fn stale_sequence_release_cannot_clear_a_newer_generation() {
        let slot = TaskSlot::new();
        let old = slot.try_acquire_sequence(3).await.unwrap();
        let released = slot.force_release_all().await;
        assert_eq!(released.len(), 1);
        let new = slot.try_acquire_sequence(3).await.unwrap();

        assert!(!slot.release_sequence(3, old).await);
        assert!(slot.is_busy().await);
        assert!(slot.release_sequence(3, new).await);
    }

    #[tokio::test]
    async fn snapshot_holds_reports_exact_live_channel_generations() {
        let slot = TaskSlot::new();
        let ch2 = slot.try_acquire_sequence(2).await.unwrap();
        let ch0 = slot.try_acquire_sequence(0).await.unwrap();

        assert_eq!(
            slot.snapshot_holds().await,
            vec![
                TaskHold {
                    owner: "sequence".into(),
                    channel_index: Some(0),
                    generation: ch0,
                },
                TaskHold {
                    owner: "sequence".into(),
                    channel_index: Some(2),
                    generation: ch2,
                },
            ]
        );
    }
}
