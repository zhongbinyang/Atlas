//! Builtin general (non-LabVIEW) steps, starting with delay.

pub const KIND_LABVIEW: &str = "labview";
pub const KIND_DELAY: &str = "delay";
pub const DELAY_VI_PATH: &str = "__builtin__/delay";

use serde_json::Value;
use std::time::Duration;

pub fn delay_ms_from_inputs(inputs: &Value) -> Result<u64, String> {
    let arr = inputs
        .as_array()
        .ok_or_else(|| "delay inputs must be an array".to_string())?;
    for item in arr {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name != "delay_ms" {
            continue;
        }
        let value = item.get("value").ok_or_else(|| "delay_ms missing value".to_string())?;
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
        return Err("delay_ms value must be a number".into());
    }
    Err("delay_ms input required".into())
}

pub fn delay_inputs(delay_ms: u64) -> Value {
    serde_json::json!([{
        "name": "delay_ms",
        "className": "Digital",
        "value": delay_ms
    }])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_delay_ms() {
        let inputs = delay_inputs(1500);
        assert_eq!(delay_ms_from_inputs(&inputs).unwrap(), 1500);
    }

    #[test]
    fn detects_delay() {
        assert!(is_delay_template(Some(KIND_DELAY), "x"));
        assert!(is_delay_template(None, DELAY_VI_PATH));
        assert!(!is_delay_template(Some(KIND_LABVIEW), r"C:\a.vi"));
    }
}
