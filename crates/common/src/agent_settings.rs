//! Shared defaults and types for per-agent units / variables.

use serde::{Deserialize, Serialize};

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

/// Common units for optical-module (光模块) test Specs.
pub fn default_agent_units() -> Vec<AgentUnit> {
    DEFAULT_AGENT_UNITS
        .iter()
        .map(|(symbol, description)| AgentUnit {
            symbol: (*symbol).to_string(),
            description: (*description).to_string(),
        })
        .collect()
}

/// `(symbol, description)` for optical-module Specs.
pub const DEFAULT_AGENT_UNITS: &[(&str, &str)] = &[
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
];

pub const VAR_HOSTNAME: &str = "Hostname";
pub const VAR_IP: &str = "IP";

/// Seed variables when the agent has none yet. Values are filled by the agent.
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

/// Parse units JSON, accepting legacy `["dBm"]` or `[{symbol, description}]`.
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
