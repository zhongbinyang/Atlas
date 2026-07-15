use common::{AgentTaskView, CreateAgentTaskRequest, TaskStatus};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::executor;

pub struct TaskSlot {
    inner: Mutex<Inner>,
}

struct Inner {
    busy: bool,
    tasks: HashMap<String, AgentTaskView>,
}

impl TaskSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                busy: false,
                tasks: HashMap::new(),
            }),
        })
    }

    pub async fn is_busy(&self) -> bool {
        self.inner.lock().await.busy
    }

    pub async fn list(&self) -> Vec<AgentTaskView> {
        self.inner.lock().await.tasks.values().cloned().collect()
    }

    pub async fn get(&self, id: &str) -> Option<AgentTaskView> {
        self.inner.lock().await.tasks.get(id).cloned()
    }

    /// Returns Err("busy") if slot occupied.
    pub async fn submit(
        self: &Arc<Self>,
        req: CreateAgentTaskRequest,
    ) -> Result<AgentTaskView, &'static str> {
        let id = Uuid::new_v4().to_string();
        {
            let mut g = self.inner.lock().await;
            if g.busy {
                return Err("busy");
            }
            g.busy = true;
            let view = AgentTaskView {
                id: id.clone(),
                command: req.command.clone(),
                status: TaskStatus::Running,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            };
            g.tasks.insert(id.clone(), view.clone());
        }
        let slot = Arc::clone(self);
        let id2 = id.clone();
        tokio::spawn(async move {
            let result = executor::run_command(
                req.shell,
                &req.command,
                req.workdir.as_deref(),
                req.timeout_secs,
            )
            .await;
            let mut g = slot.inner.lock().await;
            if let Some(t) = g.tasks.get_mut(&id2) {
                t.status = result.status;
                t.exit_code = result.exit_code;
                t.stdout = result.stdout;
                t.stderr = result.stderr;
            }
            g.busy = false;
        });
        Ok(self.get(&id).await.unwrap())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use common::ShellKind;

    #[tokio::test]
    async fn rejects_second_while_busy() {
        let slot = TaskSlot::new();
        let req = CreateAgentTaskRequest {
            shell: ShellKind::Cmd,
            command: "ping -n 3 127.0.0.1".into(),
            workdir: None,
            timeout_secs: 30,
        };
        assert!(slot.submit(req.clone()).await.is_ok());
        let err = slot.submit(req).await.unwrap_err();
        assert_eq!(err, "busy");
    }
}
