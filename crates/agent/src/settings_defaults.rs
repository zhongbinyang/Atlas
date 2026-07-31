//! Fill empty settings with optical-module defaults and live Hostname/IP.

use crate::register::AgentSettingsPayload;

/// Apply defaults when lists are empty; refresh Hostname/IP from this machine.
pub fn enrich_settings(
    mut settings: AgentSettingsPayload,
    hostname: &str,
    ip: &str,
) -> AgentSettingsPayload {
    if settings.units.is_empty() {
        settings.units = common::default_agent_units();
    } else {
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

/// Variable map for `/VarName` expand, with live Hostname/IP.
pub fn variables_map_for_expand(
    settings: &AgentSettingsPayload,
    hostname: &str,
    ip: &str,
) -> std::collections::HashMap<String, String> {
    let enriched = enrich_settings(settings.clone(), hostname, ip);
    enriched
        .variables
        .into_iter()
        .map(|v| (v.name, v.value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_settings_get_optical_units_and_host_vars() {
        let out = enrich_settings(
            AgentSettingsPayload::default(),
            "bench-01",
            "10.0.0.8",
        );
        assert!(out.units.iter().any(|u| u.symbol == "dBm"));
        assert!(out.units.iter().any(|u| u.symbol == "nm" && !u.description.is_empty()));
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
            },
            "live-host",
            "1.2.3.4",
        );
        assert_eq!(out.units.len(), 1);
        assert_eq!(out.units[0].symbol, "dBm");
        assert_eq!(out.variables[0].value, "live-host");
    }
}
