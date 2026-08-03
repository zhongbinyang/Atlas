use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::labview_sequence::SequenceStepResult;

/// Per-channel live progress (polled by the UI as a matrix).
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChannelProgressSnapshot {
    pub channel_index: usize,
    pub name: String,
    pub steps: Vec<SequenceStepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overall: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_name: Option<String>,
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
    inner: Mutex<SequenceProgressSnapshot>,
}

impl std::fmt::Debug for SequenceProgressSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SequenceProgressSlot")
    }
}

impl SequenceProgressSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(SequenceProgressSnapshot::default()),
        })
    }

    pub async fn begin(&self) {
        *self.inner.lock().await = SequenceProgressSnapshot {
            running: true,
            channels: vec![ChannelProgressSnapshot {
                channel_index: 0,
                name: "CH0".into(),
                ..Default::default()
            }],
            steps: Vec::new(),
            current_position: None,
            current_name: None,
        };
    }

    pub async fn begin_channels(&self, channels: &[(usize, String)]) {
        *self.inner.lock().await = SequenceProgressSnapshot {
            running: true,
            channels: channels
                .iter()
                .map(|(idx, name)| ChannelProgressSnapshot {
                    channel_index: *idx,
                    name: name.clone(),
                    ..Default::default()
                })
                .collect(),
            steps: Vec::new(),
            current_position: None,
            current_name: None,
        };
    }

    pub async fn set_current(&self, position: usize, name: String) {
        self.set_channel_current(0, position, name).await;
    }

    pub async fn set_steps(&self, steps: Vec<SequenceStepResult>) {
        self.set_channel_steps(0, steps).await;
    }

    pub async fn finish(&self, steps: Vec<SequenceStepResult>) {
        let overall = channel_overall_from_steps(&steps);
        self.finish_channels(&[(0, "CH0".into(), steps, overall)])
            .await;
    }

    pub async fn set_channel_current(&self, channel_index: usize, position: usize, name: String) {
        let mut g = self.inner.lock().await;
        g.running = true;
        if let Some(ch) = g
            .channels
            .iter_mut()
            .find(|c| c.channel_index == channel_index)
        {
            ch.current_position = Some(position);
            ch.current_name = Some(name.clone());
        }
        // Legacy flat fields follow the first channel / matching channel.
        if g.channels
            .first()
            .map(|c| c.channel_index == channel_index)
            .unwrap_or(channel_index == 0)
        {
            g.current_position = Some(position);
            g.current_name = Some(name);
        }
    }

    pub async fn set_channel_steps(&self, channel_index: usize, steps: Vec<SequenceStepResult>) {
        let mut g = self.inner.lock().await;
        g.running = true;
        if let Some(ch) = g
            .channels
            .iter_mut()
            .find(|c| c.channel_index == channel_index)
        {
            ch.steps = steps.clone();
            ch.current_position = None;
            ch.current_name = None;
        }
        if g.channels
            .first()
            .map(|c| c.channel_index == channel_index)
            .unwrap_or(channel_index == 0)
        {
            g.steps = steps;
            g.current_position = None;
            g.current_name = None;
        }
    }

    /// Mark one channel finished without ending the multi-channel session (`running` stays true).
    pub async fn set_channel_overall(
        &self,
        channel_index: usize,
        name: String,
        steps: Vec<SequenceStepResult>,
        overall: String,
    ) {
        let mut g = self.inner.lock().await;
        if let Some(ch) = g
            .channels
            .iter_mut()
            .find(|c| c.channel_index == channel_index)
        {
            ch.name = name;
            ch.steps = steps.clone();
            ch.overall = Some(overall);
            ch.current_position = None;
            ch.current_name = None;
        } else {
            g.channels.push(ChannelProgressSnapshot {
                channel_index,
                name,
                steps: steps.clone(),
                overall: Some(overall),
                current_position: None,
                current_name: None,
            });
        }
        if g.channels
            .first()
            .map(|c| c.channel_index == channel_index)
            .unwrap_or(channel_index == 0)
        {
            g.steps = steps;
            g.current_position = None;
            g.current_name = None;
        }
    }

    pub async fn finish_channels(
        &self,
        channels: &[(usize, String, Vec<SequenceStepResult>, String)],
    ) {
        let mut g = self.inner.lock().await;
        g.running = false;
        g.current_position = None;
        g.current_name = None;
        for (idx, name, steps, overall) in channels {
            if let Some(ch) = g.channels.iter_mut().find(|c| c.channel_index == *idx) {
                ch.name = name.clone();
                ch.steps = steps.clone();
                ch.overall = Some(overall.clone());
                ch.current_position = None;
                ch.current_name = None;
            } else {
                g.channels.push(ChannelProgressSnapshot {
                    channel_index: *idx,
                    name: name.clone(),
                    steps: steps.clone(),
                    overall: Some(overall.clone()),
                    current_position: None,
                    current_name: None,
                });
            }
        }
        g.channels.sort_by_key(|c| c.channel_index);
        g.steps = g
            .channels
            .first()
            .map(|c| c.steps.clone())
            .unwrap_or_default();
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = SequenceProgressSnapshot::default();
    }

    pub async fn snapshot(&self) -> SequenceProgressSnapshot {
        self.inner.lock().await.clone()
    }
}

fn channel_overall_from_steps(steps: &[SequenceStepResult]) -> String {
    if steps.iter().any(|s| s.status == "fail") {
        "fail".into()
    } else if steps.iter().any(|s| s.status == "error") {
        "error".into()
    } else {
        "pass".into()
    }
}
