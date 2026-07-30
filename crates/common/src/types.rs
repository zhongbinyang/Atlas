use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Dispatched,
    Running,
    Succeeded,
    Failed,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Cmd,
    Powershell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOnlineStatus {
    Online,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterAgentRequest {
    pub name: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusResponse {
    pub hostname: String,
    pub ip: String,
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub busy: bool,
    pub uptime_secs: u64,
    /// idle | sequence | sequence_paused | delay | rest | shell_task | unknown
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_continue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_abort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_force_release: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_before_position: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_step_name: Option<String>,
    /// Resolved Agent log directory (file logging root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentTaskRequest {
    pub shell: ShellKind,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskView {
    pub id: String,
    pub command: String,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_serializes_snake_case() {
        let v = serde_json::to_string(&TaskStatus::Succeeded).unwrap();
        assert_eq!(v, "\"succeeded\"");
        let back: TaskStatus = serde_json::from_str(&v).unwrap();
        assert_eq!(back, TaskStatus::Succeeded);
    }

    #[test]
    fn register_request_roundtrip() {
        let req = RegisterAgentRequest {
            name: "LINE-01".into(),
            ip: "192.168.1.20".into(),
            port: 26631,
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: RegisterAgentRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.port, 26631);
        assert_eq!(back.name, "LINE-01");
    }
}
