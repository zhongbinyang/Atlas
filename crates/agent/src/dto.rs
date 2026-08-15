use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecBound {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentUnit {
    pub symbol: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentVariable {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ArrayExpandMode {
    #[default]
    Semicolon,
    Json,
}

pub const VAR_HOSTNAME: &str = "Hostname";
pub const VAR_IP: &str = "IP";

pub fn default_agent_units() -> Vec<AgentUnit> {
    [
        ("dBm", "光功率，相对 1 mW"),
        ("dB", "相对量（消光比、回损、增益等）"),
        ("nm", "波长"),
        ("°C", "温度（壳体/环境）"),
        ("V", "电压（供电/监测）"),
        ("mA", "电流（偏置、功耗）"),
        ("mW", "光功率（毫瓦）"),
        ("µW", "光功率（微瓦）"),
        ("Gbps", "线速率 / 比特率"),
        ("ps", "时间或抖动（皮秒）"),
        ("UI", "Unit Interval（归一化抖动）"),
        ("%", "百分比"),
    ]
    .into_iter()
    .map(|(symbol, description)| AgentUnit {
        symbol: symbol.to_string(),
        description: description.to_string(),
    })
    .collect()
}

pub fn default_agent_variables() -> Vec<AgentVariable> {
    vec![
        AgentVariable {
            name: VAR_HOSTNAME.to_string(),
            value: String::new(),
            description: "本机主机名；打开配置或展开时按本机刷新".into(),
        },
        AgentVariable {
            name: VAR_IP.to_string(),
            value: String::new(),
            description: "本机 IP；打开配置或展开时按本机刷新".into(),
        },
    ]
}

pub fn parse_units_json(raw: &str) -> Vec<AgentUnit> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            if let Some(sym) = item.as_str() {
                let symbol = sym.trim();
                if symbol.is_empty() {
                    return None;
                }
                return Some(AgentUnit {
                    symbol: symbol.to_string(),
                    description: String::new(),
                });
            }
            let symbol = item
                .get("symbol")
                .and_then(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let description = item
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Some(AgentUnit {
                symbol: symbol.to_string(),
                description,
            })
        })
        .collect()
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

    #[test]
    fn parse_units_json_accepts_legacy_strings() {
        let units = parse_units_json(r#"["dBm", {"symbol":"V","description":"电压"}]"#);
        assert_eq!(units[0].symbol, "dBm");
        assert_eq!(units[1].symbol, "V");
        assert_eq!(units[1].description, "电压");
    }
}
