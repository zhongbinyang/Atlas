//! Fill empty settings with optical-module defaults and live Hostname/IP.
//! Merge active device/calibration profile flats into `${Var}` expand maps.

use crate::register::AgentSettingsPayload;
use serde_json::Value;

/// Refresh Hostname/IP from this machine. Units are center-global (not filled here).
pub fn enrich_settings(
    mut settings: AgentSettingsPayload,
    hostname: &str,
    ip: &str,
) -> AgentSettingsPayload {
    if !settings.units.is_empty() {
        fill_unit_descriptions(&mut settings.units);
    }
    if settings.variables.is_empty() {
        settings.variables = common::default_agent_variables()
            .into_iter()
            .map(|mut v| {
                v.value = builtin_value(&v.name, hostname, ip);
                v
            })
            .collect();
        return settings;
    }
    for v in &mut settings.variables {
        if v.name == common::VAR_HOSTNAME {
            v.value = hostname.to_string();
            if v.description.trim().is_empty() {
                v.description = "本机主机名；打开配置或展开时按本机刷新".into();
            }
        } else if v.name == common::VAR_IP {
            v.value = ip.to_string();
            if v.description.trim().is_empty() {
                v.description = "本机 IP；打开配置或展开时按本机刷新".into();
            }
        }
    }
    settings
}

fn fill_unit_descriptions(units: &mut [common::AgentUnit]) {
    let defaults = common::default_agent_units();
    for u in units.iter_mut() {
        if !u.description.trim().is_empty() {
            continue;
        }
        if let Some(d) = defaults.iter().find(|d| d.symbol == u.symbol) {
            u.description = d.description.clone();
        }
    }
}

fn builtin_value(name: &str, hostname: &str, ip: &str) -> String {
    if name == common::VAR_HOSTNAME {
        hostname.to_string()
    } else if name == common::VAR_IP {
        ip.to_string()
    } else {
        String::new()
    }
}

/// Sanitize section/key into a valid variable identifier (mirrors UI `sanitizeDeviceCfgIdent`).
pub fn sanitize_profile_ident(raw: &str) -> Option<String> {
    let mut s: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        return None;
    }
    let mut s = if s
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic() || c == '_')
        .unwrap_or(false)
    {
        s
    } else {
        format!("V_{s}")
    };
    if s.len() > 64 {
        s.truncate(64);
        while s.ends_with('_') {
            s.pop();
        }
        if s.is_empty() {
            return None;
        }
    }
    if !s
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic() || c == '_')
        .unwrap_or(false)
    {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    Some(s)
}

/// Flatten nested `{ Section: { Key: value } }` into `Section_Key` → string.
/// Empty values are skipped. Invalid names are skipped.
/// Arrays use `array_expand_mode`: semicolon join or JSON text.
pub fn flatten_setting_json(
    setting: &Value,
    array_expand_mode: common::ArrayExpandMode,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(sections) = setting.as_object() else {
        return out;
    };
    for (section, keys) in sections {
        if section.starts_with("__") {
            continue;
        }
        let Some(map) = keys.as_object() else {
            continue;
        };
        for (key, val) in map {
            let value = match val {
                Value::Null => continue,
                Value::String(s) => {
                    let t = s.trim().to_string();
                    if t.is_empty() {
                        continue;
                    }
                    t
                }
                Value::Array(arr) => {
                    if arr.is_empty() {
                        continue;
                    }
                    match array_expand_mode {
                        common::ArrayExpandMode::Json => {
                            serde_json::to_string(arr).unwrap_or_default()
                        }
                        common::ArrayExpandMode::Semicolon => arr
                            .iter()
                            .filter_map(|v| match v {
                                Value::Null => None,
                                Value::String(s) => {
                                    let t = s.trim();
                                    if t.is_empty() {
                                        None
                                    } else {
                                        Some(t.to_string())
                                    }
                                }
                                Value::Number(n) => Some(n.to_string()),
                                Value::Bool(b) => Some(b.to_string()),
                                other => Some(other.to_string()),
                            })
                            .collect::<Vec<_>>()
                            .join(";"),
                    }
                }
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                other => other.to_string(),
            };
            if value.is_empty() {
                continue;
            }
            let raw = format!("{section}_{key}");
            let Some(name) = sanitize_profile_ident(&raw) else {
                continue;
            };
            out.insert(name, value);
        }
    }
    out
}

/// Build expand map: calibration flatten < device flatten < manual variables (Hostname/IP refreshed).
pub fn variables_map_for_expand(
    settings: &AgentSettingsPayload,
    hostname: &str,
    ip: &str,
) -> std::collections::HashMap<String, String> {
    let device = settings
        .device_profiles
        .iter()
        .find(|p| p.is_active)
        .map(|p| p.setting.clone());
    let cal = settings
        .calibration_profiles
        .iter()
        .find(|p| p.is_active)
        .map(|p| p.setting.clone());
    variables_map_for_expand_with_profiles(
        settings,
        device.as_ref(),
        cal.as_ref(),
        hostname,
        ip,
    )
}

/// Merge expand map from manual settings + optional active profile JSON values.
pub fn variables_map_for_expand_with_profiles(
    settings: &AgentSettingsPayload,
    device_setting: Option<&Value>,
    calibration_setting: Option<&Value>,
    hostname: &str,
    ip: &str,
) -> std::collections::HashMap<String, String> {
    let enriched = enrich_settings(settings.clone(), hostname, ip);
    let mode = settings.array_expand_mode;
    let mut map = std::collections::HashMap::new();
    if let Some(s) = calibration_setting {
        map.extend(flatten_setting_json(s, mode));
    }
    if let Some(s) = device_setting {
        map.extend(flatten_setting_json(s, mode));
    }
    for v in enriched.variables {
        if v.name.trim().is_empty() {
            continue;
        }
        map.insert(v.name, v.value);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::register::AgentConfigProfilePayload;
    use serde_json::json;

    #[test]
    fn empty_settings_get_optical_units_and_host_vars() {
        let out = enrich_settings(
            AgentSettingsPayload::default(),
            "bench-01",
            "10.0.0.8",
        );
        // Units are center-global; enrich no longer seeds defaults into empty settings.
        assert!(out.units.is_empty());
        let host = out.variables.iter().find(|v| v.name == "Hostname").unwrap();
        assert_eq!(host.value, "bench-01");
        assert!(!host.description.is_empty());
        assert_eq!(
            out.variables
                .iter()
                .find(|v| v.name == "IP")
                .map(|v| v.value.as_str()),
            Some("10.0.0.8")
        );
    }

    #[test]
    fn existing_hostname_refreshed_from_machine() {
        let out = enrich_settings(
            AgentSettingsPayload {
                units: vec![common::AgentUnit {
                    symbol: "dBm".into(),
                    description: "光功率".into(),
                }],
                variables: vec![common::AgentVariable {
                    name: "Hostname".into(),
                    value: "stale".into(),
                    description: String::new(),
                }],
                updated_at: None,
                ..Default::default()
            },
            "live-host",
            "1.2.3.4",
        );
        assert_eq!(out.units.len(), 1);
        assert_eq!(out.units[0].symbol, "dBm");
        assert_eq!(out.variables[0].value, "live-host");
    }

    #[test]
    fn flatten_nested_setting_skips_empty() {
        let setting = json!({
            "EVB_Setting": {
                "IP_Add": "10.0.0.1",
                "Com_Add": "",
                "Port": "5025"
            },
            "DCA_Setting": {
                "Intru_Com_Add": "192.168.1.10"
            }
        });
        let map = flatten_setting_json(&setting, common::ArrayExpandMode::Semicolon);
        assert_eq!(map.get("EVB_Setting_IP_Add").map(String::as_str), Some("10.0.0.1"));
        assert_eq!(map.get("EVB_Setting_Port").map(String::as_str), Some("5025"));
        assert!(!map.contains_key("EVB_Setting_Com_Add"));
        assert_eq!(
            map.get("DCA_Setting_Intru_Com_Add").map(String::as_str),
            Some("192.168.1.10")
        );
    }

    #[test]
    fn flatten_array_joins_with_semicolon() {
        let setting = json!({
            "Cal": {
                "Light_ER": [4.58, 4.5, 4.6, 4.6],
                "Note": "ok"
            }
        });
        let map = flatten_setting_json(&setting, common::ArrayExpandMode::Semicolon);
        assert_eq!(
            map.get("Cal_Light_ER").map(String::as_str),
            Some("4.58;4.5;4.6;4.6")
        );
        assert_eq!(map.get("Cal_Note").map(String::as_str), Some("ok"));
    }

    #[test]
    fn flatten_array_as_json_text() {
        let setting = json!({
            "Cal": {
                "Light_ER": [4.58, 4.5, 4.6, 4.6]
            }
        });
        let map = flatten_setting_json(&setting, common::ArrayExpandMode::Json);
        assert_eq!(
            map.get("Cal_Light_ER").map(String::as_str),
            Some("[4.58,4.5,4.6,4.6]")
        );
    }

    #[test]
    fn expand_priority_manual_over_device_over_cal() {
        let settings = AgentSettingsPayload {
            variables: vec![common::AgentVariable {
                name: "EVB_Setting_IP_Add".into(),
                value: "manual".into(),
                description: String::new(),
            }],
            device_profiles: vec![AgentConfigProfilePayload {
                id: "d1".into(),
                name: "DUT1".into(),
                setting: json!({ "EVB_Setting": { "IP_Add": "device", "Port": "1" } }),
                is_active: true,
                ..Default::default()
            }],
            calibration_profiles: vec![AgentConfigProfilePayload {
                id: "c1".into(),
                name: "800G".into(),
                setting: json!({
                    "EVB_Setting": { "IP_Add": "cal", "Port": "2" },
                    "Cal": { "Gain": "1.0" }
                }),
                is_active: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let map = variables_map_for_expand(&settings, "h", "1.1.1.1");
        assert_eq!(map.get("EVB_Setting_IP_Add").map(String::as_str), Some("manual"));
        assert_eq!(map.get("EVB_Setting_Port").map(String::as_str), Some("1"));
        assert_eq!(map.get("Cal_Gain").map(String::as_str), Some("1.0"));
    }
}
