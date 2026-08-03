use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::labview_sequence::SequenceStepResult;

/// Live progress while a sequence POST is in flight (polled by the UI).
#[derive(Debug, Clone, Serialize, Default)]
pub struct SequenceProgressSnapshot {
    pub running: bool,
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
            steps: Vec::new(),
            current_position: None,
            current_name: None,
        };
    }

    pub async fn set_current(&self, position: usize, name: String) {
        let mut g = self.inner.lock().await;
        g.running = true;
        g.current_position = Some(position);
        g.current_name = Some(name);
    }

    pub async fn set_steps(&self, steps: Vec<SequenceStepResult>) {
        let mut g = self.inner.lock().await;
        g.running = true;
        g.steps = steps;
        g.current_position = None;
        g.current_name = None;
    }

    pub async fn finish(&self, steps: Vec<SequenceStepResult>) {
        *self.inner.lock().await = SequenceProgressSnapshot {
            running: false,
            steps,
            current_position: None,
            current_name: None,
        };
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = SequenceProgressSnapshot::default();
    }

    pub async fn snapshot(&self) -> SequenceProgressSnapshot {
        self.inner.lock().await.clone()
    }
}
