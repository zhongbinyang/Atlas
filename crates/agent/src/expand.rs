//! Expand `/VarName` tokens using agent settings variables.

use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpandError {
    Undefined(String),
}

impl std::fmt::Display for ExpandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExpandError::Undefined(name) => write!(f, "undefined variable: /{name}"),
        }
    }
}

pub fn variables_map(variables: &[(String, String)]) -> HashMap<String, String> {
    variables.iter().cloned().collect()
}

/// Replace `/Name` tokens where Name is `[A-Za-z_][A-Za-z0-9_]*`
/// and the next char is end or not alphanumeric/underscore.
pub fn expand_str(input: &str, vars: &HashMap<String, String>) -> Result<String, ExpandError> {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' {
            let start = i + 1;
            if start < bytes.len() {
                let b0 = bytes[start];
                if b0.is_ascii_alphabetic() || b0 == b'_' {
                    let mut end = start + 1;
                    while end < bytes.len()
                        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                    {
                        end += 1;
                    }
                    let name = &input[start..end];
                    match vars.get(name) {
                        Some(val) => {
                            out.push_str(val);
                            i = end;
                            continue;
                        }
                        None => return Err(ExpandError::Undefined(name.to_string())),
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
    match value {
        Value::String(s) => Ok(Value::String(expand_str(s, vars)?)),
        Value::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(expand_json_value(item, vars)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), expand_json_value(v, vars)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

/// Expand Spec min/max when stored as string containing `/`; numbers pass through.
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
        // brace form is NOT expanded — only /Name
        assert_eq!(expand_str("prefix-{LOT}-suffix", &vars).unwrap(), "prefix-{LOT}-suffix");
        assert_eq!(expand_str("path-/LOT-next", &vars).unwrap(), "path-A12-next");
        assert_eq!(expand_str("/SN", &vars).unwrap(), "9");
        assert_eq!(expand_str("pre-/LOT-post", &vars).unwrap(), "pre-A12-post");
        assert!(matches!(
            expand_str("/LOTextra", &vars),
            Err(ExpandError::Undefined(_))
        ));
    }

    #[test]
    fn undefined_errors() {
        let vars = map(&[]);
        assert_eq!(
            expand_str("a=/MISSING", &vars).unwrap_err(),
            ExpandError::Undefined("MISSING".into())
        );
    }

    #[test]
    fn expand_json_tree() {
        let vars = map(&[("CH", "2")]);
        let v = json!([{"name":"Channel","value":"/CH"}]);
        let out = expand_json_value(&v, &vars).unwrap();
        assert_eq!(out[0]["value"], "2");
    }
}
