use std::sync::Arc;

use tokio::sync::Mutex;

use crate::labview_sequence::{QueueItemForRun, SequenceStepResult};

#[derive(Debug, Clone)]
pub struct SequenceSession {
    pub items: Vec<QueueItemForRun>,
    pub next_index: usize,
    pub steps_so_far: Vec<SequenceStepResult>,
    pub sn: Option<String>,
    pub work_order: Option<String>,
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
