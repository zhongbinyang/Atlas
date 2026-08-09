//! Resolve sequence step limits from a Spec template section plus hand-edited overrides.

use common::SpecBound;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

use crate::expand::expand_str;
use crate::limits::LimitRule;

#[derive(Debug, Deserialize)]
struct SpecDocumentJson {
    #[serde(default)]
    #[allow(dead_code)]
    version: u32,
    sections: HashMap<String, HashMap<String, SpecBoundJson>>,
}

#[derive(Debug, Deserialize)]
struct SpecBoundJson {
    min: Option<f64>,
    max: Option<f64>,
}

fn parse_spec_sections(raw: &str) -> Result<HashMap<String, HashMap<String, SpecBound>>, String> {
    let doc: SpecDocumentJson =
        serde_json::from_str(raw).map_err(|e| format!("invalid spec_json: {e}"))?;
    Ok(doc
        .sections
        .into_iter()
        .map(|(section_name, metrics)| {
            let bounds = metrics
                .into_iter()
                .map(|(metric_name, bound)| {
                    (
                        metric_name,
                        SpecBound {
                            min: bound.min,
                            max: bound.max,
                        },
                    )
                })
                .collect();
            (section_name, bounds)
        })
        .collect())
}

fn parse_spec_metrics(raw: &str) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid spec_metrics_json: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "spec_metrics_json must be a JSON array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let Some(name) = item.as_str() else {
            return Err(format!("spec_metrics_json[{i}] must be a string"));
        };
        if name.trim().is_empty() {
            return Err(format!("spec_metrics_json[{i}] must be a non-empty string"));
        }
        out.push(name.to_string());
    }
    Ok(out)
}

pub fn spec_bound_to_limit_rule(output: &str, bound: &SpecBound) -> Option<LimitRule> {
    if bound.min.is_none() && bound.max.is_none() {
        return None;
    }
    Some(LimitRule {
        output: output.to_string(),
        op: None,
        min: bound.min.map(Value::from),
        max: bound.max.map(Value::from),
        expect: None,
        unit: None,
    })
}

pub fn resolve_step_limits(
    hand_limits: &[LimitRule],
    spec_template_json: Option<&str>,
    spec_section: &str,
    spec_metrics_json: &str,
    vars: &HashMap<String, String>,
) -> Result<Vec<LimitRule>, String> {
    let Some(raw_json) = spec_template_json else {
        return Ok(hand_limits.to_vec());
    };

    let section_name = expand_str(spec_section, vars).map_err(|e| e.to_string())?;
    if section_name.trim().is_empty() {
        return Err("spec_section is empty after variable expansion".into());
    }

    let sections = parse_spec_sections(raw_json)?;
    let section = sections
        .get(&section_name)
        .ok_or_else(|| format!("spec section '{section_name}' not found in template"))?;

    let metrics = parse_spec_metrics(spec_metrics_json)?;
    let metric_names: Vec<String> = if metrics.is_empty() {
        let mut keys: Vec<String> = section.keys().cloned().collect();
        keys.sort();
        keys
    } else {
        metrics
    };

    let mut generated = Vec::new();
    for metric in metric_names {
        let Some(bound) = section.get(&metric) else {
            continue;
        };
        if let Some(rule) = spec_bound_to_limit_rule(&metric, bound) {
            generated.push(rule);
        }
    }

    let mut merged: HashMap<String, LimitRule> = generated
        .into_iter()
        .map(|rule| (rule.output.clone(), rule))
        .collect();
    for rule in hand_limits {
        merged.insert(rule.output.clone(), rule.clone());
    }

    let mut out: Vec<LimitRule> = merged.into_values().collect();
    out.sort_by(|a, b| a.output.cmp(&b.output));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE_TEMPLATE: &str = r#"{
        "version": 1,
        "sections": {
            "FMT_HT": {
                "TX_AP": { "min": -2.0, "max": 4.0 },
                "RX_AP": { "min": -10.0, "max": 0.0 },
                "JitterRMS": { "min": null, "max": null }
            }
        }
    }"#;

    #[test]
    fn hand_limit_overrides_template_for_same_output() {
        let hand = vec![LimitRule {
            output: "TX_AP".into(),
            op: None,
            min: Some(json!(-1.0)),
            max: Some(json!(2.0)),
            expect: None,
            unit: Some("dBm".into()),
        }];
        let resolved = resolve_step_limits(
            &hand,
            Some(SAMPLE_TEMPLATE),
            "FMT_HT",
            "[]",
            &HashMap::new(),
        )
        .unwrap();
        let tx = resolved.iter().find(|r| r.output == "TX_AP").unwrap();
        assert_eq!(tx.min, Some(json!(-1.0)));
        assert_eq!(tx.max, Some(json!(2.0)));
        assert_eq!(tx.unit.as_deref(), Some("dBm"));
        assert!(resolved.iter().any(|r| r.output == "RX_AP"));
    }

    #[test]
    fn missing_section_returns_error() {
        let err = resolve_step_limits(
            &[],
            Some(SAMPLE_TEMPLATE),
            "MISSING",
            "[]",
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn empty_metrics_uses_all_section_keys() {
        let resolved = resolve_step_limits(
            &[],
            Some(SAMPLE_TEMPLATE),
            "FMT_HT",
            "[]",
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(resolved.len(), 2);
        assert!(resolved.iter().any(|r| r.output == "TX_AP"));
        assert!(resolved.iter().any(|r| r.output == "RX_AP"));
        assert!(!resolved.iter().any(|r| r.output == "JitterRMS"));
    }

    #[test]
    fn both_unbounded_metric_omitted_from_generated() {
        let template = r#"{
            "version": 1,
            "sections": {
                "S": {
                    "Open": { "min": null, "max": null },
                    "TX_AP": { "min": 0.0, "max": 1.0 }
                }
            }
        }"#;
        let resolved =
            resolve_step_limits(&[], Some(template), "S", "[]", &HashMap::new()).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].output, "TX_AP");
    }

    #[test]
    fn expands_spec_section_with_vars() {
        let mut vars = HashMap::new();
        vars.insert("Corner".into(), "FMT_HT".into());
        let resolved = resolve_step_limits(
            &[],
            Some(SAMPLE_TEMPLATE),
            "${Corner}",
            "[\"TX_AP\"]",
            &vars,
        )
        .unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].output, "TX_AP");
    }

    #[test]
    fn no_template_returns_hand_limits() {
        let hand = vec![LimitRule {
            output: "A".into(),
            op: None,
            min: Some(json!(0.0)),
            max: Some(json!(1.0)),
            expect: None,
            unit: None,
        }];
        let resolved = resolve_step_limits(&hand, None, "", "[]", &HashMap::new()).unwrap();
        assert_eq!(resolved, hand);
    }
}
