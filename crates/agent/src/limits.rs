use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LimitRule {
    pub output: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepJudge {
    Ok,
    Pass,
    Fail { message: String },
    Error { message: String },
}

pub fn judge_limits(limits: &[LimitRule], outputs: &Value) -> StepJudge {
    if limits.is_empty() {
        return StepJudge::Ok;
    }

    for rule in limits {
        match check_limit(rule, outputs) {
            StepJudge::Pass => {}
            other => return other,
        }
    }

    StepJudge::Pass
}

fn check_limit(rule: &LimitRule, outputs: &Value) -> StepJudge {
    let value = match lookup_number(outputs, &rule.output) {
        Ok(v) => v,
        Err(message) => return StepJudge::Error { message },
    };

    if let Some(min) = rule.min {
        if value < min {
            return StepJudge::Fail {
                message: format!(
                    "output `{}` value {value} below min {min}",
                    rule.output
                ),
            };
        }
    }

    if let Some(max) = rule.max {
        if value > max {
            return StepJudge::Fail {
                message: format!(
                    "output `{}` value {value} above max {max}",
                    rule.output
                ),
            };
        }
    }

    StepJudge::Pass
}

fn lookup_number(outputs: &Value, key: &str) -> Result<f64, String> {
    let root = outputs.get("outputs").unwrap_or(outputs);
    let v = root
        .get(key)
        .ok_or_else(|| format!("missing output `{key}`"))?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .ok_or_else(|| format!("output `{key}` is not numeric"))
}

pub fn extract_sn_from_outputs(outputs: &Value) -> Option<String> {
    let root = outputs.get("outputs").unwrap_or(outputs);

    for key in ["SN", "sn"] {
        if let Some(v) = root.get(key) {
            let s = if let Some(s) = v.as_str() {
                s.to_string()
            } else if let Some(n) = v.as_i64() {
                n.to_string()
            } else if let Some(n) = v.as_u64() {
                n.to_string()
            } else if let Some(n) = v.as_f64() {
                n.to_string()
            } else {
                continue;
            };
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }

    None
}

pub fn parse_limits_json(raw: &str) -> Result<Vec<LimitRule>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(vec![]);
    }

    serde_json::from_str(trimmed).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_limits_ok() {
        assert!(matches!(judge_limits(&[], &json!({"Power_dBm": 0.0})), StepJudge::Ok));
    }

    #[test]
    fn inclusive_pass() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: Some(3.0),
            unit: Some("dBm".into()),
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": -5.0})),
            StepJudge::Pass
        ));
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": 3.0})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn out_of_range_fail() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: Some(3.0),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": 4.0})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn missing_value_error() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: None,
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({})),
            StepJudge::Error { .. }
        ));
    }

    #[test]
    fn open_bound_null_min() {
        let limits = vec![LimitRule {
            output: "x".into(),
            min: None,
            max: Some(10.0),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"x": -100.0})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn extract_sn_prefers_SN_then_sn() {
        assert_eq!(
            extract_sn_from_outputs(&json!({"SN": "A1"})).as_deref(),
            Some("A1")
        );
        assert_eq!(
            extract_sn_from_outputs(&json!({"sn": "b2"})).as_deref(),
            Some("b2")
        );
        assert_eq!(extract_sn_from_outputs(&json!({})), None);
    }

    #[test]
    fn multi_limit_all_must_pass() {
        let limits = vec![
            LimitRule { output: "a".into(), min: Some(0.0), max: Some(1.0), unit: None },
            LimitRule { output: "b".into(), min: Some(0.0), max: Some(1.0), unit: None },
        ];
        assert!(matches!(
            judge_limits(&limits, &json!({"a": 0.5, "b": 2.0})),
            StepJudge::Fail { .. }
        ));
    }
}
