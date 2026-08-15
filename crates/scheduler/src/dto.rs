use serde::{Deserialize, Serialize};

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
    /// idle | sequence | delay | rest | shell_task | unknown
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
    /// ATLAS center base URL (for WebUI deep links from Agent UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_request_roundtrip() {
        let req = RegisterAgentRequest {
            name: "LINE-01".into(),
            ip: "192.168.1.20".into(),
            port: 9090,
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: RegisterAgentRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.port, 9090);
        assert_eq!(back.name, "LINE-01");
    }
}
