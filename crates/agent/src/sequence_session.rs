use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::labview_sequence::{QueueItemForRun, SequenceStepResult};

#[derive(Debug, Clone)]
pub struct SequenceSession {
    pub items: Vec<QueueItemForRun>,
    pub next_index: usize,
    pub steps_so_far: Vec<SequenceStepResult>,
    pub sn: Option<String>,
    pub work_order: Option<String>,
    pub sequence_template_id: Option<i64>,
    pub abort: bool,
}

pub struct SequenceSessionSlot {
    inner: Mutex<Option<SequenceSession>>,
}

impl SequenceSessionSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(None),
        })
    }

    pub async fn get(&self) -> Option<SequenceSession> {
        self.inner.lock().await.clone()
    }

    pub async fn set(&self, session: SequenceSession) {
        *self.inner.lock().await = Some(session);
    }

    pub async fn take(&self) -> Option<SequenceSession> {
        self.inner.lock().await.take()
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = None;
    }
}

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

    /// Keep completed steps from a prior pause when resuming.
    pub async fn begin_from(&self, prior_steps: Vec<SequenceStepResult>) {
        *self.inner.lock().await = SequenceProgressSnapshot {
            running: true,
            steps: prior_steps,
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
