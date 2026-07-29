use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::Path;

use crate::labview::{
    build_run_args, ensure_vi, error_message, inputs_to_cli_object, normalize_fs_path, run_cli,
    LabviewError, LabviewParam,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueItemForRun {
    pub position: usize,
    pub queue_item_id: String,
    pub template_id: String,
    pub name: String,
    pub kind: String,
    pub vi_path: String,
    pub inputs: Value,
    pub show_front_panel: bool,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceStepResult {
    pub position: usize,
    pub queue_item_id: String,
    pub template_id: String,
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceResponse {
    pub stopped: bool,
    pub failed_at: Option<usize>,
    pub steps: Vec<SequenceStepResult>,
}

pub fn queue_items_for_run(body: &Value) -> Result<Vec<QueueItemForRun>, String> {
    let items = body
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "invalid queue response: missing items".to_string())?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let position = item
            .get("position")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing position".to_string())? as usize;
        let queue_item_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing id".to_string())?
            .to_string();
        let template_id = item.get("vi_template_id").and_then(|v| {
            v.as_i64()
                .map(|n| n.to_string())
                .or_else(|| v.as_u64().map(|n| n.to_string()))
                .or_else(|| v.as_str().map(|s| s.to_string()))
        })
        .ok_or_else(|| "missing vi_template_id".to_string())?;
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let kind = item
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("labview")
            .to_string();
        let vi_path = item
            .get("vi_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing vi_path".to_string())?
            .to_string();
        let inputs = item
            .get("inputs")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let show_front_panel = item
            .get("show_front_panel")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let timeout_secs = item
            .get("timeout_secs")
            .and_then(|v| {
                if v.is_null() {
                    None
                } else {
                    v.as_u64().or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
                }
            });
        out.push(QueueItemForRun {
            position,
            queue_item_id,
            template_id,
            name,
            kind,
            vi_path,
            inputs,
            show_front_panel,
            timeout_secs,
        });
    }
    out.sort_by_key(|i| i.position);
    Ok(out)
}

pub async fn run_sequence_with<F, Fut>(items: &[QueueItemForRun], mut run_one: F) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut steps = Vec::new();
    let mut stopped = false;
    let mut failed_at = None;

    for (i, item) in items.iter().enumerate() {
        match run_one(item).await {
            Ok(result) => {
                steps.push(SequenceStepResult {
                    position: item.position,
                    queue_item_id: item.queue_item_id.clone(),
                    template_id: item.template_id.clone(),
                    name: item.name.clone(),
                    ok: true,
                    result: Some(result),
                    error: None,
                });
            }
            Err(err) => {
                steps.push(SequenceStepResult {
                    position: item.position,
                    queue_item_id: item.queue_item_id.clone(),
                    template_id: item.template_id.clone(),
                    name: item.name.clone(),
                    ok: false,
                    result: None,
                    error: Some(err),
                });
                stopped = true;
                failed_at = Some(i);
                break;
            }
        }
    }

    SequenceResponse {
        stopped,
        failed_at,
        steps,
    }
}

pub async fn run_sequence(
    cli: &Path,
    getinfo: &Path,
    items: &[QueueItemForRun],
) -> SequenceResponse {
    let cli = cli.to_path_buf();
    let getinfo = getinfo.to_path_buf();
    let items = items.to_vec();
    run_sequence_with(&items, |item| {
        let cli = cli.clone();
        let getinfo = getinfo.clone();
        let item = item.clone();
        async move { run_one_step(&cli, &getinfo, &item).await }
    })
    .await
}

async fn run_one_step(
    cli: &Path,
    getinfo: &Path,
    item: &QueueItemForRun,
) -> Result<Value, String> {
    if crate::general::is_delay_template(Some(item.kind.as_str()), &item.vi_path) {
        let delay_ms = crate::general::delay_ms_from_inputs(&item.inputs)?;
        return Ok(crate::general::run_delay_ms(delay_ms).await);
    }

    let vi = std::path::PathBuf::from(normalize_fs_path(&item.vi_path));
    ensure_vi(&vi).map_err(|e| error_message(&e))?;

    let input_map = match &item.inputs {
        Value::Array(arr) => {
            let params: Vec<LabviewParam> = serde_json::from_value(Value::Array(arr.clone()))
                .map_err(|e| format!("invalid inputs array: {e}"))?;
            inputs_to_cli_object(&params)
        }
        Value::Object(map) => map.clone(),
        _ => return Err("inputs must be an array or object".into()),
    };
    let input_json = serde_json::to_string(&Value::Object(input_map))
        .map_err(|e| format!("serialize inputs: {e}"))?;

    let args = build_run_args(
        getinfo,
        &vi,
        &input_json,
        item.show_front_panel,
        item.timeout_secs,
    );
    run_cli(cli, &args)
        .await
        .map_err(|e: LabviewError| error_message(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item(position: usize, name: &str) -> QueueItemForRun {
        QueueItemForRun {
            position,
            queue_item_id: format!("q-{position}"),
            template_id: format!("t-{position}"),
            name: name.into(),
            kind: "labview".into(),
            vi_path: r"C:\x\Add.vi".into(),
            inputs: Value::Array(vec![]),
            show_front_panel: false,
            timeout_secs: None,
        }
    }

    #[tokio::test]
    async fn labview_run_sequence_stops_on_second_failure() {
        let items = vec![
            sample_item(0, "first"),
            sample_item(1, "second"),
            sample_item(2, "third"),
        ];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |_item| {
            call += 1;
            let n = call;
            async move {
                if n == 2 {
                    Err("step failed".into())
                } else {
                    Ok(serde_json::json!({ "step": n }))
                }
            }
        })
        .await;

        assert!(resp.stopped);
        assert_eq!(resp.failed_at, Some(1));
        assert_eq!(resp.steps.len(), 2);
        assert!(resp.steps[0].ok);
        assert!(!resp.steps[1].ok);
        assert_eq!(resp.steps[1].error.as_deref(), Some("step failed"));
        assert_eq!(call, 2);
    }

    #[tokio::test]
    async fn labview_run_sequence_all_success() {
        let items = vec![sample_item(0, "a"), sample_item(1, "b")];
        let resp = run_sequence_with(&items, |item| {
            let name = item.name.clone();
            async move { Ok(serde_json::json!({ "name": name })) }
        })
        .await;

        assert!(!resp.stopped);
        assert!(resp.failed_at.is_none());
        assert_eq!(resp.steps.len(), 2);
        assert!(resp.steps.iter().all(|s| s.ok));
    }
}
