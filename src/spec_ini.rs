use std::collections::HashMap;

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct SpecBound {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecDocument {
    pub version: u32,
    pub sections: HashMap<String, HashMap<String, SpecBound>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecParseResult {
    pub document: SpecDocument,
    pub warnings: Vec<String>,
}

pub fn parse_bound_token(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.eq_ignore_ascii_case("inf")
        || t.eq_ignore_ascii_case("+inf")
        || t.eq_ignore_ascii_case("infinity")
    {
        return None;
    }
    if t.eq_ignore_ascii_case("-inf") || t.eq_ignore_ascii_case("-infinity") {
        return None;
    }
    t.parse::<f64>().ok()
}

fn is_comment_line(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('#') || t.starts_with(';') || t.starts_with("//")
}

fn parse_key_value(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || is_comment_line(line) {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    let value = value.trim();
    if key.is_empty() {
        return None;
    }
    Some((key, value))
}

fn parse_section_header(line: &str) -> Option<&str> {
    let line = line.trim();
    if !line.starts_with('[') || !line.ends_with(']') || line.len() < 3 {
        return None;
    }
    let name = line[1..line.len() - 1].trim();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn metric_base_and_side(key: &str) -> Option<(&str, bool)> {
    if key.ends_with("_UL") {
        Some((&key[..key.len() - 3], true))
    } else if key.ends_with("_LL") {
        Some((&key[..key.len() - 3], false))
    } else {
        None
    }
}

pub fn parse_spec_ini(text: &str) -> Result<SpecParseResult, String> {
    let mut sections: HashMap<String, HashMap<String, SpecBound>> = HashMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut current_section: Option<String> = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || is_comment_line(line) {
            continue;
        }

        if let Some(section_name) = parse_section_header(line) {
            current_section = Some(section_name.to_string());
            sections
                .entry(section_name.to_string())
                .or_insert_with(HashMap::new);
            continue;
        }

        let Some((key, value)) = parse_key_value(line) else {
            continue;
        };

        let Some((metric, is_upper)) = metric_base_and_side(key) else {
            continue;
        };

        let Some(section_name) = current_section.as_ref() else {
            warnings.push(format!("orphan limit key outside section: {key}"));
            continue;
        };

        let bound_value = parse_bound_token(value);
        let section = sections.get_mut(section_name).unwrap();
        let entry = section
            .entry(metric.to_string())
            .or_insert(SpecBound {
                min: None,
                max: None,
            });

        if is_upper {
            entry.max = bound_value;
        } else {
            entry.min = bound_value;
        }
    }

    if sections.is_empty() {
        return Err("no sections found in spec INI".to_string());
    }

    Ok(SpecParseResult {
        document: SpecDocument {
            version: 1,
            sections,
        },
        warnings,
    })
}

pub fn spec_document_to_json(doc: &SpecDocument) -> Value {
    let mut sections = serde_json::Map::new();

    for (section_name, metrics) in &doc.sections {
        let mut metric_map = serde_json::Map::new();
        for (metric_name, bound) in metrics {
            metric_map.insert(
                metric_name.clone(),
                json!({
                    "min": bound.min,
                    "max": bound.max,
                }),
            );
        }
        sections.insert(section_name.clone(), Value::Object(metric_map));
    }

    json!({
        "version": doc.version,
        "sections": Value::Object(sections),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ul_ll_pairs() {
        let ini = r#"
[FMT_HT]
TX_AP_UL = 4.0
TX_AP_LL = -2
"#;
        let r = parse_spec_ini(ini).unwrap();
        let sec = r.document.sections.get("FMT_HT").unwrap();
        let tx = sec.get("TX_AP").unwrap();
        assert_eq!(tx.min, Some(-2.0));
        assert_eq!(tx.max, Some(4.0));
    }

    #[test]
    fn inf_is_unbounded() {
        let ini = "[S]\nJitterRMS_UL = inf\nJitterRMS_LL = -inf\n";
        let r = parse_spec_ini(ini).unwrap();
        let sec = r.document.sections.get("S").unwrap();
        let j = sec.get("JitterRMS").unwrap();
        assert_eq!(j.min, None);
        assert_eq!(j.max, None);
    }

    #[test]
    fn ignores_standalone_keys() {
        let ini = "[S]\nMax_Ber_Curve=6\nTX_AP_UL=1\nTX_AP_LL=0\n";
        let r = parse_spec_ini(ini).unwrap();
        let sec = r.document.sections.get("S").unwrap();
        assert!(!sec.contains_key("Max_Ber_Curve"));
        assert!(sec.contains_key("TX_AP"));
    }

    #[test]
    fn scientific_notation() {
        let ini = "[S]\nQk_Csen_BER_UL = 8E-5\nQk_Csen_BER_LL = 1E-5\n";
        let r = parse_spec_ini(ini).unwrap();
        let sec = r.document.sections.get("S").unwrap();
        let q = sec.get("Qk_Csen_BER").unwrap();
        assert!((q.max.unwrap() - 8e-5).abs() < 1e-10);
    }

    #[test]
    fn errors_on_zero_sections() {
        let ini = "TX_AP_UL = 1\n";
        assert!(parse_spec_ini(ini).is_err());
    }

    #[test]
    fn spec_document_to_json_null_for_unbounded() {
        let ini = "[S]\nJitterRMS_UL = inf\nJitterRMS_LL = -inf\n";
        let doc = parse_spec_ini(ini).unwrap().document;
        let json = spec_document_to_json(&doc);
        assert_eq!(json["version"], 1);
        assert!(json["sections"]["S"]["JitterRMS"]["min"].is_null());
        assert!(json["sections"]["S"]["JitterRMS"]["max"].is_null());
    }
}
