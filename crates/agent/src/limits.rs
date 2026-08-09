use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::expand::{expand_limit_number, expand_str};

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LimitRule {
    pub output: String,
    /// `range` (default) | `eq` | `ne` | `in`
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub min: Option<Value>,
    #[serde(default)]
    pub max: Option<Value>,
    /// Expected value for `eq`/`ne`, or list / comma-separated for `in`.
    #[serde(default)]
    pub expect: Option<Value>,
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
    judge_limits_with_vars(limits, outputs, &HashMap::new())
}

pub fn judge_limits_with_vars(
    limits: &[LimitRule],
    outputs: &Value,
    vars: &HashMap<String, String>,
) -> StepJudge {
    if limits.is_empty() {
        return StepJudge::Ok;
    }

    for rule in limits {
        match check_limit(rule, outputs, vars) {
            StepJudge::Pass => {}
            other => return other,
        }
    }

    StepJudge::Pass
}

fn normalize_op(raw: Option<&str>) -> Result<&'static str, String> {
    let s = raw.map(str::trim).unwrap_or("");
    if s.is_empty() {
        return Ok("range");
    }
    match s.to_ascii_lowercase().as_str() {
        "range" | "between" | "num" | "number" => Ok("range"),
        "eq" | "==" | "=" | "equal" => Ok("eq"),
        "ne" | "!=" | "<>" | "not_equal" => Ok("ne"),
        "in" | "one_of" => Ok("in"),
        other => Err(format!("unsupported Spec op `{other}`")),
    }
}

fn check_limit(
    rule: &LimitRule,
    outputs: &Value,
    vars: &HashMap<String, String>,
) -> StepJudge {
    let op = match normalize_op(rule.op.as_deref()) {
        Ok(op) => op,
        Err(message) => return StepJudge::Error { message },
    };

    match op {
        "range" => check_range(rule, outputs, vars),
        "eq" => check_eq_ne(rule, outputs, vars, true),
        "ne" => check_eq_ne(rule, outputs, vars, false),
        "in" => check_in(rule, outputs, vars),
        _ => StepJudge::Error {
            message: format!("unsupported Spec op `{op}`"),
        },
    }
}

fn check_range(
    rule: &LimitRule,
    outputs: &Value,
    vars: &HashMap<String, String>,
) -> StepJudge {
    let value = match lookup_number(outputs, &rule.output) {
        Ok(v) => v,
        Err(message) => return StepJudge::Error { message },
    };

    let min = match expand_limit_number(rule.min.as_ref().unwrap_or(&Value::Null), vars) {
        Ok(v) => v,
        Err(message) => return StepJudge::Error { message },
    };
    let max = match expand_limit_number(rule.max.as_ref().unwrap_or(&Value::Null), vars) {
        Ok(v) => v,
        Err(message) => return StepJudge::Error { message },
    };

    if let Some(min) = min {
        if value < min {
            return StepJudge::Fail {
                message: format!(
                    "output `{}` value {value} below min {min}",
                    rule.output
                ),
            };
        }
    }

    if let Some(max) = max {
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

fn value_as_compare_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn expand_expect_string(raw: &Value, vars: &HashMap<String, String>) -> Result<String, String> {
    match raw {
        Value::Null => Ok(String::new()),
        Value::String(s) => expand_str(s, vars).map(|s| s.trim().to_string()).map_err(|e| e.to_string()),
        other => Ok(value_as_compare_string(other)),
    }
}

fn lookup_output_required<'a>(outputs: &'a Value, key: &str) -> Result<&'a Value, String> {
    lookup_output_value(outputs, key).ok_or_else(|| format!("missing output `{key}`"))
}

fn check_eq_ne(
    rule: &LimitRule,
    outputs: &Value,
    vars: &HashMap<String, String>,
    want_equal: bool,
) -> StepJudge {
    let actual = match lookup_output_required(outputs, &rule.output) {
        Ok(v) => value_as_compare_string(v),
        Err(message) => return StepJudge::Error { message },
    };
    let expect_raw = match rule.expect.as_ref().or(rule.min.as_ref()) {
        Some(v) => v,
        None => {
            return StepJudge::Error {
                message: format!("Spec `{}` missing expect", rule.output),
            };
        }
    };
    let expected = match expand_expect_string(expect_raw, vars) {
        Ok(s) => s,
        Err(message) => return StepJudge::Error { message },
    };

    let equal = actual == expected;
    if want_equal && !equal {
        return StepJudge::Fail {
            message: format!(
                "output `{}` value `{actual}` != expect `{expected}`",
                rule.output
            ),
        };
    }
    if !want_equal && equal {
        return StepJudge::Fail {
            message: format!(
                "output `{}` value `{actual}` == forbidden `{expected}`",
                rule.output
            ),
        };
    }
    StepJudge::Pass
}

fn expect_list(raw: &Value, vars: &HashMap<String, String>) -> Result<Vec<String>, String> {
    match raw {
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(expand_expect_string(item, vars)?);
            }
            Ok(out)
        }
        Value::String(s) => {
            let expanded = expand_str(s, vars).map_err(|e| e.to_string())?;
            Ok(expanded
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect())
        }
        other => Ok(vec![value_as_compare_string(other)]),
    }
}

fn check_in(
    rule: &LimitRule,
    outputs: &Value,
    vars: &HashMap<String, String>,
) -> StepJudge {
    let actual = match lookup_output_required(outputs, &rule.output) {
        Ok(v) => value_as_compare_string(v),
        Err(message) => return StepJudge::Error { message },
    };
    let expect_raw = match rule.expect.as_ref().or(rule.min.as_ref()) {
        Some(v) => v,
        None => {
            return StepJudge::Error {
                message: format!("Spec `{}` missing expect list", rule.output),
            };
        }
    };
    let list = match expect_list(expect_raw, vars) {
        Ok(v) => v,
        Err(message) => return StepJudge::Error { message },
    };
    if list.is_empty() {
        return StepJudge::Error {
            message: format!("Spec `{}` expect list is empty", rule.output),
        };
    }
    if list.iter().any(|x| x == &actual) {
        StepJudge::Pass
    } else {
        StepJudge::Fail {
            message: format!(
                "output `{}` value `{actual}` not in {:?}",
                rule.output, list
            ),
        }
    }
}

/// Resolve an output value from either map form (`{"sum": 20}`) or LabVIEW
/// array form (`{"outputs":[{"name":"sum","value":20}]}`).
pub fn lookup_output_value<'a>(outputs: &'a Value, key: &str) -> Option<&'a Value> {
    let candidates = [outputs.get("outputs"), Some(outputs)];
    for candidate in candidates.into_iter().flatten() {
        if let Some(v) = candidate.get(key) {
            return Some(v);
        }
        if let Some(arr) = candidate.as_array() {
            for item in arr {
                if item.get("name").and_then(|n| n.as_str()) == Some(key) {
                    return item.get("value");
                }
            }
        }
    }
    None
}

fn lookup_number(outputs: &Value, key: &str) -> Result<f64, String> {
    let v = lookup_output_value(outputs, key)
        .ok_or_else(|| format!("missing output `{key}`"))?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .ok_or_else(|| format!("output `{key}` is not numeric"))
}

pub fn extract_sn_from_outputs(outputs: &Value) -> Option<String> {
    for key in ["SN", "sn"] {
        if let Some(v) = lookup_output_value(outputs, key) {
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

    fn range_rule(output: &str, min: Option<f64>, max: Option<f64>) -> LimitRule {
        LimitRule {
            output: output.into(),
            op: None,
            min: min.map(Value::from),
            max: max.map(Value::from),
            expect: None,
            unit: None,
        }
    }

    #[test]
    fn empty_limits_ok() {
        assert!(matches!(
            judge_limits(&[], &json!({"Power_dBm": 0.0})),
            StepJudge::Ok
        ));
    }

    #[test]
    fn inclusive_pass() {
        let mut limits = vec![range_rule("Power_dBm", Some(-5.0), Some(3.0))];
        limits[0].unit = Some("dBm".into());
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
        let limits = vec![range_rule("Power_dBm", Some(-5.0), Some(3.0))];
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": 4.0})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn missing_value_error() {
        let limits = vec![range_rule("Power_dBm", Some(-5.0), None)];
        assert!(matches!(
            judge_limits(&limits, &json!({})),
            StepJudge::Error { .. }
        ));
    }

    #[test]
    fn open_bound_null_min() {
        let limits = vec![range_rule("x", None, Some(10.0))];
        assert!(matches!(
            judge_limits(&limits, &json!({"x": -100.0})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn eq_string_pass_and_fail() {
        let limits = vec![LimitRule {
            output: "Status".into(),
            op: Some("eq".into()),
            min: None,
            max: None,
            expect: Some(json!("PASS")),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Status": "PASS"})),
            StepJudge::Pass
        ));
        assert!(matches!(
            judge_limits(&limits, &json!({"Status": "FAIL"})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn ne_string() {
        let limits = vec![LimitRule {
            output: "Mode".into(),
            op: Some("ne".into()),
            min: None,
            max: None,
            expect: Some(json!("ERR")),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Mode": "OK"})),
            StepJudge::Pass
        ));
        assert!(matches!(
            judge_limits(&limits, &json!({"Mode": "ERR"})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn in_list_from_array_and_csv() {
        let arr = vec![LimitRule {
            output: "Mode".into(),
            op: Some("in".into()),
            min: None,
            max: None,
            expect: Some(json!(["A", "B"])),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&arr, &json!({"Mode": "B"})),
            StepJudge::Pass
        ));
        assert!(matches!(
            judge_limits(&arr, &json!({"Mode": "C"})),
            StepJudge::Fail { .. }
        ));

        let csv = vec![LimitRule {
            output: "Mode".into(),
            op: Some("in".into()),
            min: None,
            max: None,
            expect: Some(json!("A, B")),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&csv, &json!({"Mode": "A"})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn eq_accepts_legacy_min_as_expect() {
        let limits = vec![LimitRule {
            output: "Status".into(),
            op: Some("eq".into()),
            min: Some(json!("OK")),
            max: None,
            expect: None,
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Status": "OK"})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn first_failing_rule_wins() {
        let limits = vec![
            range_rule("a", Some(0.0), Some(1.0)),
            range_rule("b", Some(0.0), Some(1.0)),
        ];
        assert!(matches!(
            judge_limits(&limits, &json!({"a": 0.5, "b": 2.0})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn extract_sn_prefers_SN_then_sn() {
        assert_eq!(
            extract_sn_from_outputs(&json!({"SN": "ABC", "sn": "xyz"})).as_deref(),
            Some("ABC")
        );
        assert_eq!(
            extract_sn_from_outputs(&json!({"sn": "xyz"})).as_deref(),
            Some("xyz")
        );
    }

    #[test]
    fn labview_array_outputs_form() {
        let body = json!({
            "outputs": [
                {"className": "Digital", "name": "sum", "value": 20},
                {"className": "String", "name": "output", "value": "hello world!!!"}
            ]
        });
        let limits = vec![range_rule("sum", Some(10.0), Some(30.0))];
        assert!(matches!(judge_limits(&limits, &body), StepJudge::Pass));
    }

    #[test]
    fn range_only_max_passes() {
        let limits = vec![LimitRule {
            output: "TX_AP".into(),
            op: None,
            min: None,
            max: Some(json!(4.0)),
            expect: None,
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"TX_AP": 3.0})),
            StepJudge::Pass
        ));
    }
}
