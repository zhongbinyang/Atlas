use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabviewParam {
    pub name: String,
    #[serde(rename = "className")]
    pub class_name: String,
    pub value: Value,
}

#[derive(Debug)]
pub enum LabviewError {
    MissingTool,
    MissingVi,
    Cli {
        exit_code: i32,
        stderr_json: Option<Value>,
        stderr_raw: String,
    },
    Io(String),
}

pub fn inputs_to_cli_object(inputs: &[LabviewParam]) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    for input in inputs {
        m.insert(input.name.clone(), input.value.clone());
    }
    m
}

pub fn build_inspect_args(getinfo: &Path, vi: &Path) -> Vec<String> {
    vec![
        "--action".into(),
        "inspect".into(),
        "--getinfo".into(),
        getinfo.display().to_string(),
        "--vi".into(),
        vi.display().to_string(),
    ]
}

pub fn build_run_args(
    getinfo: &Path,
    vi: &Path,
    input_json: &str,
    show_fp: bool,
    timeout: Option<u64>,
) -> Vec<String> {
    let mut args = vec![
        "--action".into(),
        "run".into(),
        "--getinfo".into(),
        getinfo.display().to_string(),
        "--vi".into(),
        vi.display().to_string(),
        "--input".into(),
        input_json.into(),
    ];
    if show_fp {
        args.push("--show-front-panel".into());
    }
    if let Some(secs) = timeout {
        args.push("--timeout".into());
        args.push(secs.to_string());
    }
    args
}

pub fn ensure_vi(vi: &Path) -> Result<(), LabviewError> {
    if vi.exists() {
        Ok(())
    } else {
        Err(LabviewError::MissingVi)
    }
}

pub fn map_status(err: &LabviewError) -> StatusCode {
    match err {
        LabviewError::MissingTool => StatusCode::NOT_FOUND,
        LabviewError::MissingVi => StatusCode::BAD_REQUEST,
        LabviewError::Cli { exit_code, .. } => match exit_code {
            2 => StatusCode::BAD_REQUEST,
            3 => StatusCode::NOT_FOUND,
            4 | 5 | 6 | 7 => StatusCode::BAD_GATEWAY,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        },
        LabviewError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub async fn run_cli(cli: &Path, args: &[String]) -> Result<Value, LabviewError> {
    if !cli.exists() {
        return Err(LabviewError::MissingTool);
    }

    let cli = cli.to_path_buf();
    let args = args.to_vec();

    tokio::task::spawn_blocking(move || {
        let output = Command::new(&cli)
            .args(&args)
            .output()
            .map_err(|e| LabviewError::Io(e.to_string()))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            serde_json::from_str(&stdout).map_err(|e| LabviewError::Io(e.to_string()))
        } else {
            let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();
            let stderr_json = serde_json::from_str(stderr_raw.trim()).ok();
            Err(LabviewError::Cli {
                exit_code: output.status.code().unwrap_or(-1),
                stderr_json,
                stderr_raw,
            })
        }
    })
    .await
    .map_err(|e| LabviewError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn build_inspect_args_order() {
        let args = build_inspect_args(
            Path::new(r"C:\labview-runner-cli\getinfo.vi"),
            Path::new(r"C:\x\Add.vi"),
        );
        assert_eq!(
            args,
            vec![
                String::from("--action"),
                String::from("inspect"),
                String::from("--getinfo"),
                String::from(r"C:\labview-runner-cli\getinfo.vi"),
                String::from("--vi"),
                String::from(r"C:\x\Add.vi"),
            ]
        );
    }

    #[test]
    fn inputs_to_cli_object_uses_names() {
        let inputs = vec![LabviewParam {
            name: "a".into(),
            class_name: "Digital".into(),
            value: serde_json::json!(3.0),
        }];
        let m = inputs_to_cli_object(&inputs);
        assert_eq!(m.get("a"), Some(&serde_json::json!(3.0)));
    }

    #[test]
    fn build_run_args_includes_input_and_optional_flags() {
        let args = build_run_args(
            Path::new(r"C:\g.vi"),
            Path::new(r"C:\t.vi"),
            r#"{"a":1}"#,
            true,
            Some(30),
        );
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--input" && w[1] == r#"{"a":1}"#));
        assert!(args.iter().any(|a| a == "--show-front-panel"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--timeout" && w[1] == "30"));
    }
}
