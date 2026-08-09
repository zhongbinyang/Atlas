//! Expand `${VarName}` tokens using agent settings variables.
//!
//! UI may use `/` only as a picker trigger; persisted / expanded syntax is `${Name}`.

use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpandError {
    Undefined(String),
}

impl std::fmt::Display for ExpandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExpandError::Undefined(name) => write!(f, "undefined variable: ${{{name}}}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpandMode {
    /// Unknown `${Name}` → error (LabVIEW inputs, Spec, Delay).
    Strict,
    /// Unknown `${Name}` left literal (optional soft fail for REST).
    Lenient,
}

pub fn variables_map(variables: &[(String, String)]) -> HashMap<String, String> {
    variables.iter().cloned().collect()
}

/// Replace `${Name}` tokens where Name is `[A-Za-z_][A-Za-z0-9_]*`.
pub fn expand_str(input: &str, vars: &HashMap<String, String>) -> Result<String, ExpandError> {
    expand_str_with(input, vars, ExpandMode::Strict)
}

fn expand_str_with(
    input: &str,
    vars: &HashMap<String, String>,
    mode: ExpandMode,
) -> Result<String, ExpandError> {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        // Look for `${`
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            let name_start = i + 2;
            if name_start < bytes.len() {
                let b0 = bytes[name_start];
                if b0.is_ascii_alphabetic() || b0 == b'_' {
                    let mut name_end = name_start + 1;
                    while name_end < bytes.len()
                        && (bytes[name_end].is_ascii_alphanumeric() || bytes[name_end] == b'_')
                    {
                        name_end += 1;
                    }
                    if name_end < bytes.len() && bytes[name_end] == b'}' {
                        let name = &input[name_start..name_end];
                        match vars.get(name) {
                            Some(val) => {
                                out.push_str(val);
                                i = name_end + 1;
                                continue;
                            }
                            None => {
                                if mode == ExpandMode::Strict {
                                    return Err(ExpandError::Undefined(name.to_string()));
                                }
                                // Lenient: keep `${name}` as literal.
                                out.push_str(&input[i..=name_end]);
                                i = name_end + 1;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

pub fn expand_json_value(value: &Value, vars: &HashMap<String, String>) -> Result<Value, ExpandError> {
    expand_json_value_mode(value, vars, ExpandMode::Strict)
}

pub fn expand_json_value_mode(
    value: &Value,
    vars: &HashMap<String, String>,
    mode: ExpandMode,
) -> Result<Value, ExpandError> {
    match value {
        Value::String(s) => Ok(Value::String(expand_str_with(s, vars, mode)?)),
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(expand_json_value_mode(item, vars, mode)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), expand_json_value_mode(v, vars, mode)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// Expand Spec min/max when stored as string containing `${…}`; numbers pass through.
pub fn expand_limit_number(
    raw: &Value,
    vars: &HashMap<String, String>,
) -> Result<Option<f64>, String> {
    match raw {
        Value::Null => Ok(None),
        Value::Number(n) => Ok(n.as_f64()),
        Value::String(s) => {
            let expanded = expand_str(s, vars).map_err(|e| e.to_string())?;
            let t = expanded.trim();
            if t.is_empty() {
                return Ok(None);
            }
            if t.eq_ignore_ascii_case("inf")
                || t.eq_ignore_ascii_case("+inf")
                || t.eq_ignore_ascii_case("infinity")
            {
                return Ok(None);
            }
            if t.eq_ignore_ascii_case("-inf") || t.eq_ignore_ascii_case("-infinity") {
                return Ok(None);
            }
            t.parse::<f64>()
                .map(Some)
                .map_err(|_| format!("limit value is not a number after expand: {expanded}"))
        }
        _ => Err("limit min/max must be number or string".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn expands_embedded_and_boundary() {
        let vars = map(&[("LOT", "A12"), ("SN", "9")]);
        assert_eq!(
            expand_str("prefix-${LOT}-suffix", &vars).unwrap(),
            "prefix-A12-suffix"
        );
        assert_eq!(expand_str("${SN}", &vars).unwrap(), "9");
        assert_eq!(expand_str("pre-${LOT}-post", &vars).unwrap(), "pre-A12-post");
        // Incomplete / non-token forms stay literal
        assert_eq!(expand_str("prefix-{LOT}-suffix", &vars).unwrap(), "prefix-{LOT}-suffix");
        assert_eq!(expand_str("${LOTextra}", &vars).unwrap_err(), ExpandError::Undefined("LOTextra".into()));
    }

    #[test]
    fn undefined_errors_in_strict() {
        let vars = map(&[]);
        assert_eq!(
            expand_str("a=${MISSING}", &vars).unwrap_err(),
            ExpandError::Undefined("MISSING".into())
        );
    }

    #[test]
    fn urls_and_mime_are_untouched_without_dollar_brace() {
        let empty = map(&[]);
        assert_eq!(
            expand_str("http://127.0.0.1:8080/add", &empty).unwrap(),
            "http://127.0.0.1:8080/add"
        );
        assert_eq!(
            expand_str("application/json", &empty).unwrap(),
            "application/json"
        );
        let vars = map(&[("LOT", "A12")]);
        assert_eq!(
            expand_str("https://h/${LOT}/x", &vars).unwrap(),
            "https://h/A12/x"
        );
        assert_eq!(
            expand_str("https://h/LOT/x", &vars).unwrap(),
            "https://h/LOT/x"
        );
    }

    #[test]
    fn expand_json_tree() {
        let vars = map(&[("CH", "2")]);
        let v = json!([{"name":"Channel","value":"${CH}"}]);
        let out = expand_json_value(&v, &vars).unwrap();
        assert_eq!(out[0]["value"], "2");
    }

    #[test]
    fn rest_lenient_keeps_undefined_and_expands_defined() {
        let vars = map(&[("LOT", "A12")]);
        let v = json!({
            "url": "http://127.0.0.1:8080/json",
            "headers": { "Content-Type": "application/json" },
            "body": { "path": "/json", "lot": "${LOT}", "missing": "${NOPE}" }
        });
        let out = expand_json_value_mode(&v, &vars, ExpandMode::Lenient).unwrap();
        assert_eq!(out["url"], "http://127.0.0.1:8080/json");
        assert_eq!(out["headers"]["Content-Type"], "application/json");
        assert_eq!(out["body"]["path"], "/json");
        assert_eq!(out["body"]["lot"], "A12");
        assert_eq!(out["body"]["missing"], "${NOPE}");
    }

    #[test]
    fn error_display_uses_dollar_brace() {
        assert_eq!(
            ExpandError::Undefined("json".into()).to_string(),
            "undefined variable: ${json}"
        );
    }

    #[test]
    fn expand_limit_inf_tokens() {
        let vars = HashMap::new();
        assert_eq!(expand_limit_number(&json!("inf"), &vars).unwrap(), None);
        assert_eq!(expand_limit_number(&json!("-inf"), &vars).unwrap(), None);
        assert_eq!(
            expand_limit_number(&json!("8E-5"), &vars).unwrap(),
            Some(8e-5)
        );
    }
}
