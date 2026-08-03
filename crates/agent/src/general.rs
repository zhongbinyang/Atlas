//! Builtin general (non-LabVIEW) steps: delay, version, …

pub const KIND_LABVIEW: &str = "labview";
pub const KIND_DELAY: &str = "delay";
pub const KIND_VERSION: &str = "version";
pub const DELAY_VI_PATH: &str = "__builtin__/delay";
pub const VERSION_VI_PATH: &str = "__builtin__/version";

use serde_json::Value;
use std::time::Duration;

fn delay_ms_from_value(value: &Value) -> Result<u64, String> {
    if let Some(n) = value.as_u64() {
        return Ok(n);
    }
    if let Some(n) = value.as_i64() {
        if n < 0 {
            return Err("delay_ms must be >= 0".into());
        }
        return Ok(n as u64);
    }
    if let Some(n) = value.as_f64() {
        if n < 0.0 || !n.is_finite() {
            return Err("delay_ms must be a non-negative number".into());
        }
        return Ok(n.round() as u64);
    }
    if let Some(s) = value.as_str() {
        return s
            .trim()
            .parse::<u64>()
            .map_err(|_| "delay_ms value must be a number".into());
    }
    Err("delay_ms value must be a number".into())
}

pub fn delay_ms_from_inputs(inputs: &Value) -> Result<u64, String> {
    // Native object form: {"delay_ms": 1000}
    if let Some(obj) = inputs.as_object() {
        let value = obj
            .get("delay_ms")
            .ok_or_else(|| "delay_ms input required".to_string())?;
        return delay_ms_from_value(value);
    }
    // Legacy VI-style array: [{"name":"delay_ms","className":"Digital","value":1000}]
    let arr = inputs
        .as_array()
        .ok_or_else(|| "delay inputs must be an object or array".to_string())?;
    for item in arr {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name != "delay_ms" {
            continue;
        }
        let value = item
            .get("value")
            .ok_or_else(|| "delay_ms missing value".to_string())?;
        return delay_ms_from_value(value);
    }
    Err("delay_ms input required".into())
}

/// Native delay inputs JSON (not LabVIEW VI param array).
pub fn delay_inputs(delay_ms: u64) -> Value {
    serde_json::json!({ "delay_ms": delay_ms })
}

/// Output schema registered with delay templates — same object shape as `run_delay_ms`.
pub fn delay_outputs() -> Value {
    serde_json::json!({
        "ok": true,
        "kind": KIND_DELAY,
        "delay_ms": 0
    })
}

pub fn is_delay_template(kind: Option<&str>, vi_path: &str) -> bool {
    kind == Some(KIND_DELAY) || vi_path == DELAY_VI_PATH
}

pub async fn run_delay_ms(delay_ms: u64) -> Value {
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    serde_json::json!({
        "ok": true,
        "kind": KIND_DELAY,
        "delay_ms": delay_ms
    })
}

/// Agent package version from Cargo.toml (`CARGO_PKG_VERSION`).
pub fn agent_package_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn version_inputs() -> Value {
    serde_json::json!({})
}

pub fn version_outputs() -> Value {
    serde_json::json!({
        "ok": true,
        "kind": KIND_VERSION,
        "version": agent_package_version()
    })
}

pub fn is_version_template(kind: Option<&str>, vi_path: &str) -> bool {
    kind == Some(KIND_VERSION) || vi_path == VERSION_VI_PATH
}

pub fn run_read_version() -> Value {
    serde_json::json!({
        "ok": true,
        "kind": KIND_VERSION,
        "version": agent_package_version()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_outputs_matches_runtime_object_shape() {
        let outs = delay_outputs();
        assert!(outs.is_object());
        assert_eq!(outs.get("kind").and_then(|v| v.as_str()), Some(KIND_DELAY));
        assert_eq!(outs.get("ok"), Some(&serde_json::json!(true)));
        assert!(outs.get("delay_ms").is_some());
    }

    #[test]
    fn parses_delay_ms_object_and_legacy_array() {
        assert_eq!(delay_ms_from_inputs(&delay_inputs(1500)).unwrap(), 1500);
        let legacy = serde_json::json!([{
            "name": "delay_ms",
            "className": "Digital",
            "value": 800
        }]);
        assert_eq!(delay_ms_from_inputs(&legacy).unwrap(), 800);
    }

    #[test]
    fn detects_delay() {
        assert!(is_delay_template(Some(KIND_DELAY), "x"));
        assert!(is_delay_template(None, DELAY_VI_PATH));
        assert!(!is_delay_template(Some(KIND_LABVIEW), r"C:\a.vi"));
    }

    #[test]
    fn version_outputs_match_runtime() {
        let outs = version_outputs();
        let run = run_read_version();
        assert_eq!(outs.get("kind").and_then(|v| v.as_str()), Some(KIND_VERSION));
        assert_eq!(
            outs.get("version").and_then(|v| v.as_str()),
            Some(agent_package_version())
        );
        assert_eq!(outs, run);
        assert!(!agent_package_version().is_empty());
    }

    #[test]
    fn detects_version() {
        assert!(is_version_template(Some(KIND_VERSION), "x"));
        assert!(is_version_template(None, VERSION_VI_PATH));
        assert!(!is_version_template(Some(KIND_DELAY), "x"));
    }
}
