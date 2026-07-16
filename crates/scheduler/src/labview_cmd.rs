use crate::store::ViTemplate;

pub fn cmd_escape_arg(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

pub fn build_dispatch_command(t: &ViTemplate) -> Result<String, String> {
    let inputs: Vec<serde_json::Value> =
        serde_json::from_str(&t.inputs_json).map_err(|e| format!("invalid inputs_json: {e}"))?;

    let mut input_obj = serde_json::Map::new();
    for item in inputs {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "each input must have a name".to_string())?;
        let value = item
            .get("value")
            .cloned()
            .ok_or_else(|| format!("input '{name}' must have a value"))?;
        input_obj.insert(name.to_string(), value);
    }
    let compact = serde_json::to_string(&input_obj)
        .map_err(|e| format!("failed to serialize inputs: {e}"))?;

    let mut parts = vec![
        cmd_escape_arg(&t.cli_path),
        "--action".into(),
        "run".into(),
        "--getinfo".into(),
        cmd_escape_arg(&t.getinfo_path),
        "--vi".into(),
        cmd_escape_arg(&t.vi_path),
        "--input".into(),
        cmd_escape_arg(&compact),
    ];

    if t.show_front_panel {
        parts.push("--show-front-panel".into());
    }

    if let Some(timeout) = t.timeout_secs {
        parts.push("--timeout".into());
        parts.push(timeout.to_string());
    }

    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn dummy() -> ViTemplate {
        ViTemplate {
            id: "id".into(),
            name: "n".into(),
            agent_id: "agent".into(),
            vi_path: String::new(),
            cli_path: String::new(),
            getinfo_path: String::new(),
            inputs_json: "[]".into(),
            show_front_panel: false,
            timeout_secs: None,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn cmd_escape_arg_doubles_inner_quotes() {
        assert_eq!(cmd_escape_arg(r#"say "hi""#), r#""say ""hi""""#);
    }

    #[test]
    fn dispatch_command_quotes_paths_and_embeds_input() {
        let t = ViTemplate {
            cli_path: r"C:\labview-runner-cli\labview-runner-cli.exe".into(),
            getinfo_path: r"C:\labview-runner-cli\getinfo.vi".into(),
            vi_path: r"C:\x\Add.vi".into(),
            inputs_json: r#"[{"name":"a","className":"Digital","value":3.0}]"#.into(),
            show_front_panel: true,
            timeout_secs: Some(30),
            ..dummy()
        };
        let cmd = build_dispatch_command(&t).unwrap();
        assert!(cmd.contains(r#""C:\labview-runner-cli\labview-runner-cli.exe""#));
        assert!(cmd.contains("--action run"));
        assert!(cmd.contains("--show-front-panel"));
        assert!(cmd.contains("--timeout 30"));
        assert!(cmd.contains("--input "));
        assert!(cmd.contains(r#""{""a"":3.0}""#));
    }

    #[test]
    fn dispatch_command_omits_optional_flags() {
        let t = ViTemplate {
            cli_path: r"C:\cli.exe".into(),
            getinfo_path: r"C:\getinfo.vi".into(),
            vi_path: r"C:\x\Add.vi".into(),
            inputs_json: r#"[]"#.into(),
            show_front_panel: false,
            timeout_secs: None,
            ..dummy()
        };
        let cmd = build_dispatch_command(&t).unwrap();
        assert!(!cmd.contains("--show-front-panel"));
        assert!(!cmd.contains("--timeout"));
        assert!(cmd.contains(r#"--input "{}""#));
    }
}
