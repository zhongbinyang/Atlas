use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tokio::sync::{watch, Mutex};

use crate::labview_sequence::SequenceStepResult;

/// Per-channel live progress (polled by the UI as a matrix).
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChannelProgressSnapshot {
    pub channel_index: usize,
    pub name: String,
    pub running: bool,
    pub generation: u64,
    pub steps: Vec<SequenceStepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overall: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_name: Option<String>,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_elapsed_ms: Option<u64>,
    #[serde(skip)]
    started_at: Option<Instant>,
    #[serde(skip)]
    current_step_started_at: Option<Instant>,
}

/// Live progress while a sequence POST is in flight (polled by the UI).
/// Always uses a `channels` array (even for a single synthetic channel).
#[derive(Debug, Clone, Serialize, Default)]
pub struct SequenceProgressSnapshot {
    pub running: bool,
    pub channels: Vec<ChannelProgressSnapshot>,
    /// Legacy flat view: steps of the first channel (Task 7 migrates UI to `channels`).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub steps: Vec<SequenceStepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_name: Option<String>,
}

pub struct SequenceProgressSlot {
    inner: Mutex<HashMap<usize, ChannelProgressSnapshot>>,
}

impl std::fmt::Debug for SequenceProgressSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SequenceProgressSlot")
    }
}

impl SequenceProgressSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    pub async fn begin_channels(&self, generation: u64, channels: &[(usize, String)]) {
        let mut entries = self.inner.lock().await;
        for (idx, name) in channels {
            if entries
                .get(idx)
                .is_some_and(|channel| channel.generation > generation)
            {
                continue;
            }
            entries.insert(
                *idx,
                ChannelProgressSnapshot {
                    channel_index: *idx,
                    name: name.clone(),
                    running: true,
                    generation,
                    started_at: Some(Instant::now()),
                    ..Default::default()
                },
            );
        }
    }

    /// Generation-scoped current-step update (no-op if this channel generation is stale).
    pub async fn set_channel_current_if(
        &self,
        generation: u64,
        channel_index: usize,
        position: usize,
        name: String,
    ) {
        let mut entries = self.inner.lock().await;
        if let Some(channel) = entries
            .get_mut(&channel_index)
            .filter(|c| c.generation == generation)
        {
            set_channel_current(channel, position, name);
        }
    }

    pub async fn set_channel_steps_if(
        &self,
        generation: u64,
        channel_index: usize,
        steps: Vec<SequenceStepResult>,
    ) {
        let mut entries = self.inner.lock().await;
        if let Some(channel) = entries
            .get_mut(&channel_index)
            .filter(|c| c.generation == generation)
        {
            set_channel_steps(channel, steps);
        }
    }

    pub async fn set_channel_overall_if(
        &self,
        generation: u64,
        channel_index: usize,
        name: String,
        steps: Vec<SequenceStepResult>,
        overall: String,
    ) {
        let mut entries = self.inner.lock().await;
        if let Some(channel) = entries
            .get_mut(&channel_index)
            .filter(|c| c.generation == generation)
        {
            set_channel_overall(channel, name, steps, overall);
        }
    }

    pub async fn finish_channels(
        &self,
        generation: u64,
        channels: &[(usize, String, Vec<SequenceStepResult>, String)],
    ) {
        let mut entries = self.inner.lock().await;
        for (idx, name, steps, overall) in channels {
            if let Some(channel) = entries.get_mut(idx).filter(|c| c.generation == generation) {
                set_channel_overall(channel, name.clone(), steps.clone(), overall.clone());
                channel.running = false;
            }
        }
    }

    /// Clear only an exact channel generation pair.
    pub async fn clear_channel_if(&self, channel_index: usize, generation: u64) -> bool {
        let mut entries = self.inner.lock().await;
        if entries
            .get(&channel_index)
            .is_some_and(|channel| channel.generation == generation)
        {
            entries.remove(&channel_index);
            true
        } else {
            false
        }
    }

    pub async fn snapshot(&self) -> SequenceProgressSnapshot {
        let mut entries = self.inner.lock().await;
        for channel in entries.values_mut() {
            if let Some(started_at) = channel.started_at {
                channel.elapsed_ms = started_at.elapsed().as_millis() as u64;
            }
            channel.current_step_elapsed_ms = channel
                .current_step_started_at
                .map(|started_at| started_at.elapsed().as_millis() as u64);
        }

        let mut channels: Vec<_> = entries.values().cloned().collect();
        channels.sort_by_key(|channel| channel.channel_index);
        let first = channels.first();
        SequenceProgressSnapshot {
            running: channels.iter().any(|channel| channel.running),
            steps: first
                .map(|channel| channel.steps.clone())
                .unwrap_or_default(),
            current_position: first.and_then(|channel| channel.current_position),
            current_name: first.and_then(|channel| channel.current_name.clone()),
            channels,
        }
    }
}

fn set_channel_current(channel: &mut ChannelProgressSnapshot, position: usize, name: String) {
    if channel.started_at.is_none() {
        channel.started_at = Some(Instant::now());
    }
    channel.current_position = Some(position);
    channel.current_name = Some(name);
    channel.current_step_elapsed_ms = Some(0);
    channel.current_step_started_at = Some(Instant::now());
}

fn set_channel_steps(channel: &mut ChannelProgressSnapshot, steps: Vec<SequenceStepResult>) {
    channel.steps = steps;
    channel.current_position = None;
    channel.current_name = None;
    channel.current_step_elapsed_ms = None;
    channel.current_step_started_at = None;
}

fn set_channel_overall(
    channel: &mut ChannelProgressSnapshot,
    name: String,
    steps: Vec<SequenceStepResult>,
    overall: String,
) {
    if let Some(started_at) = channel.started_at.take() {
        channel.elapsed_ms = started_at.elapsed().as_millis() as u64;
    }
    channel.name = name;
    channel.steps = steps;
    channel.overall = Some(overall);
    channel.current_position = None;
    channel.current_name = None;
    channel.current_step_elapsed_ms = None;
    channel.current_step_started_at = None;
}

#[derive(Clone)]
struct ActiveChannelCancel {
    generation: u64,
    tx: watch::Sender<bool>,
}

pub struct SequenceCancelRegistry {
    inner: Mutex<HashMap<usize, ActiveChannelCancel>>,
}

impl SequenceCancelRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    pub async fn install(
        &self,
        channel_index: usize,
        generation: u64,
    ) -> Result<watch::Receiver<bool>, &'static str> {
        let mut entries = self.inner.lock().await;
        if let Some(active) = entries.get(&channel_index) {
            if active.generation > generation {
                return Err("stale generation");
            }
            let _ = active.tx.send(true);
        }
        let (tx, rx) = watch::channel(false);
        entries.insert(channel_index, ActiveChannelCancel { generation, tx });
        Ok(rx)
    }

    pub async fn clear_if(&self, channel_index: usize, generation: u64) -> bool {
        let mut entries = self.inner.lock().await;
        if entries
            .get(&channel_index)
            .is_some_and(|active| active.generation == generation)
        {
            entries.remove(&channel_index);
            true
        } else {
            false
        }
    }

    pub async fn signal_channel_if(&self, channel_index: usize, generation: u64) -> bool {
        let entries = self.inner.lock().await;
        entries.get(&channel_index).is_some_and(|active| {
            active.generation == generation && !*active.tx.borrow() && active.tx.send(true).is_ok()
        })
    }

    pub async fn signal_all(&self) -> Vec<usize> {
        let entries = self.inner.lock().await;
        let mut signalled: Vec<usize> = entries
            .iter()
            .filter_map(|(index, active)| {
                (!*active.tx.borrow() && active.tx.send(true).is_ok()).then_some(*index)
            })
            .collect();
        signalled.sort_unstable();
        signalled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn clear_channel_if_does_not_wipe_another_channel_in_same_generation() {
        let slot = SequenceProgressSlot::new();
        slot.begin_channels(7, &[(0, "A".into()), (1, "B".into())])
            .await;

        assert!(slot.clear_channel_if(0, 7).await);
        let snapshot = slot.snapshot().await;
        assert_eq!(snapshot.channels.len(), 1);
        assert_eq!(snapshot.channels[0].channel_index, 1);
        assert_eq!(snapshot.channels[0].name, "B");
    }

    #[tokio::test]
    async fn snapshot_reports_live_and_final_channel_timing() {
        let slot = SequenceProgressSlot::new();
        slot.begin_channels(1, &[(0, "CH0".into())]).await;
        slot.set_channel_current_if(1, 0, 0, "step".into()).await;
        tokio::time::sleep(Duration::from_millis(25)).await;

        let live = slot.snapshot().await.channels.remove(0);
        assert!(live.elapsed_ms >= 20);
        assert!(live.current_step_elapsed_ms.unwrap_or_default() >= 20);

        slot.set_channel_overall_if(1, 0, "CH0".into(), vec![], "pass".into())
            .await;
        let finished = slot.snapshot().await.channels.remove(0);
        assert!(finished.elapsed_ms >= 20);
        assert!(finished.current_step_elapsed_ms.is_none());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(
            slot.snapshot().await.channels[0].elapsed_ms,
            finished.elapsed_ms
        );
    }

    #[tokio::test]
    async fn finishing_one_generation_keeps_another_channel_running() {
        let progress = SequenceProgressSlot::new();
        progress.begin_channels(11, &[(0, "CH0".into())]).await;
        progress.begin_channels(12, &[(1, "CH1".into())]).await;
        progress
            .finish_channels(11, &[(0, "CH0".into(), vec![], "pass".into())])
            .await;

        let snapshot = progress.snapshot().await;
        assert!(snapshot.running);
        assert_eq!(snapshot.channels.len(), 2);
        assert!(
            !snapshot
                .channels
                .iter()
                .find(|c| c.channel_index == 0)
                .unwrap()
                .running
        );
        assert!(
            snapshot
                .channels
                .iter()
                .find(|c| c.channel_index == 1)
                .unwrap()
                .running
        );
    }

    #[tokio::test]
    async fn stale_channel_write_does_not_replace_newer_run() {
        let progress = SequenceProgressSlot::new();
        progress.begin_channels(20, &[(2, "old".into())]).await;
        progress.begin_channels(21, &[(2, "new".into())]).await;
        progress
            .begin_channels(20, &[(2, "late old begin".into())])
            .await;
        progress
            .set_channel_current_if(20, 2, 7, "stale".into())
            .await;

        let channel = progress.snapshot().await.channels.remove(0);
        assert_eq!(channel.generation, 21);
        assert_eq!(channel.name, "new");
        assert_eq!(channel.current_name, None);
    }

    #[tokio::test]
    async fn channel_cancel_and_global_cancel_signal_the_expected_receivers() {
        let registry = SequenceCancelRegistry::new();
        let rx0 = registry.install(0, 31).await.unwrap();
        let rx1 = registry.install(1, 32).await.unwrap();

        assert!(registry.signal_channel_if(0, 31).await);
        assert!(*rx0.borrow());
        assert!(!*rx1.borrow());
        assert_eq!(registry.signal_all().await, vec![1]);
        assert!(*rx1.borrow());
    }

    #[tokio::test]
    async fn stale_cancel_install_cannot_replace_a_newer_generation() {
        let registry = SequenceCancelRegistry::new();
        let new_rx = registry.install(4, 42).await.unwrap();
        assert_eq!(
            registry.install(4, 41).await.unwrap_err(),
            "stale generation"
        );
        assert!(registry.signal_channel_if(4, 42).await);
        assert!(*new_rx.borrow());
    }

    #[tokio::test]
    async fn stale_channel_cancel_cannot_signal_a_replacement_generation() {
        let registry = SequenceCancelRegistry::new();
        let _old_rx = registry.install(6, 51).await.unwrap();
        assert!(registry.clear_if(6, 51).await);
        let new_rx = registry.install(6, 52).await.unwrap();

        assert!(!registry.signal_channel_if(6, 51).await);
        assert!(!*new_rx.borrow());
        assert!(registry.signal_channel_if(6, 52).await);
        assert!(*new_rx.borrow());
    }
}
