use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::Path;

use crate::labview::{
    build_run_args, ensure_vi, error_message, inputs_to_cli_object, normalize_fs_path, run_cli,
    LabviewError, LabviewParam,
};
use crate::limits::{
    extract_sn_from_outputs, judge_limits, parse_limits_json, LimitRule, StepJudge,
};

#[derive(Debug, Clone, Deserialize)]
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
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits: Vec<LimitRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceStepResult {
    pub position: usize,
    pub queue_item_id: String,
    pub template_id: String,
    pub name: String,
    pub ok: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencePause {
    pub before_position: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceResponse {
    pub stopped: bool,
    pub failed_at: Option<usize>,
    pub steps: Vec<SequenceStepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_order: Option<String>,
    pub overall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause: Option<SequencePause>,
}

#[derive(Debug, Clone, Default)]
pub struct SequenceRunOpts {
    pub sn: Option<String>,
    pub work_order: Option<String>,
}

fn parse_limits_from_item(item: &Value) -> Result<Vec<LimitRule>, String> {
    if let Some(v) = item.get("limits") {
        if v.is_array() {
            return serde_json::from_value(v.clone()).map_err(|e| e.to_string());
        }
        if let Some(s) = v.as_str() {
            return parse_limits_json(s);
        }
    }
    if let Some(s) = item.get("limits_json").and_then(|v| v.as_str()) {
        return parse_limits_json(s);
    }
    Ok(vec![])
}

fn normalize_fail_policy(raw: &str) -> String {
    if raw == "continue" {
        "continue".into()
    } else {
        "stop".into()
    }
}

fn judge_to_status(judge: &StepJudge) -> String {
    match judge {
        StepJudge::Ok => "ok".into(),
        StepJudge::Pass => "pass".into(),
        StepJudge::Fail { .. } => "fail".into(),
        StepJudge::Error { .. } => "error".into(),
    }
}

fn status_ok(status: &str) -> bool {
    matches!(status, "pass" | "ok" | "skipped")
}

fn judge_message(judge: &StepJudge) -> Option<String> {
    match judge {
        StepJudge::Fail { message } | StepJudge::Error { message } => Some(message.clone()),
        _ => None,
    }
}

fn measured_from_limits(limits: &[LimitRule], outputs: &Value) -> Option<Value> {
    if limits.is_empty() {
        return None;
    }
    let mut map = serde_json::Map::new();
    for rule in limits {
        if let Some(v) = crate::limits::lookup_output_value(outputs, &rule.output) {
            map.insert(rule.output.clone(), v.clone());
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

fn limits_value(rules: &[LimitRule]) -> Option<Value> {
    if rules.is_empty() {
        None
    } else {
        Some(Value::Array(
            rules
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "output": r.output,
                        "min": r.min,
                        "max": r.max,
                        "unit": r.unit,
                    })
                })
                .collect(),
        ))
    }
}

fn compute_overall(steps: &[SequenceStepResult]) -> String {
    if steps.iter().any(|s| s.status == "fail") {
        "fail".into()
    } else if steps.iter().any(|s| s.status == "error") {
        "error".into()
    } else {
        "pass".into()
    }
}

fn should_stop_on_status(status: &str, fail_policy: &str) -> bool {
    matches!(status, "fail" | "error") && fail_policy != "continue"
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
        let template_id = item
            .get("vi_template_id")
            .and_then(|v| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_u64().map(|n| n.to_string()))
                    .or_else(|| v.as_str().map(|s| s.to_string()))
            })
            .or_else(|| {
                item.get("general_template_id").and_then(|v| {
                    v.as_i64()
                        .map(|n| n.to_string())
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                        .or_else(|| v.as_str().map(|s| s.to_string()))
                })
            })
            .ok_or_else(|| "missing template id".to_string())?;
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
        let timeout_secs = item.get("timeout_secs").and_then(|v| {
            if v.is_null() {
                None
            } else {
                v.as_u64()
                    .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
            }
        });
        let enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let breakpoint = item
            .get("breakpoint")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let fail_policy = normalize_fail_policy(
            item.get("fail_policy")
                .and_then(|v| v.as_str())
                .unwrap_or("stop"),
        );
        let limits = parse_limits_from_item(item)?;
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
            enabled,
            breakpoint,
            fail_policy,
            limits,
        });
    }
    out.sort_by_key(|i| i.position);
    Ok(out)
}

pub async fn run_sequence_with_opts<F, Fut>(
    items: &[QueueItemForRun],
    opts: SequenceRunOpts,
    run_one: F,
) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    run_sequence_from_with_opts(items, 0, opts, Vec::new(), false, run_one).await
}

pub async fn run_sequence_from_with_opts<F, Fut>(
    items: &[QueueItemForRun],
    start_index: usize,
    opts: SequenceRunOpts,
    mut steps: Vec<SequenceStepResult>,
    resume_breakpoint: bool,
    mut run_one: F,
) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut stopped = false;
    let mut failed_at = None;
    let mut sn = opts.sn;
    let work_order = opts.work_order;

    for (i, item) in items.iter().enumerate().skip(start_index) {
        if !item.enabled {
            steps.push(SequenceStepResult {
                position: item.position,
                queue_item_id: item.queue_item_id.clone(),
                template_id: item.template_id.clone(),
                name: item.name.clone(),
                ok: true,
                status: "skipped".into(),
                measured: None,
                limits: limits_value(&item.limits),
                result: None,
                error: None,
            });
            continue;
        }

        if item.breakpoint && !(i == start_index && resume_breakpoint) {
            let overall = compute_overall(&steps);
            return SequenceResponse {
                stopped: false,
                failed_at: None,
                steps,
                sn,
                work_order,
                overall,
                pause: Some(SequencePause {
                    before_position: item.position,
                    message: "breakpoint".into(),
                }),
            };
        }

        match run_one(item).await {
            Ok(result) => {
                if let Some(extracted) = extract_sn_from_outputs(&result) {
                    sn = Some(extracted);
                }

                let judge = judge_limits(&item.limits, &result);
                let mut status = judge_to_status(&judge);
                // Builtin steps (e.g. REST expect_status) may return ok:false without limits.
                if status_ok(&status) && result.get("ok") == Some(&Value::Bool(false)) {
                    status = "fail".into();
                }
                let ok = status_ok(&status);

                steps.push(SequenceStepResult {
                    position: item.position,
                    queue_item_id: item.queue_item_id.clone(),
                    template_id: item.template_id.clone(),
                    name: item.name.clone(),
                    ok,
                    status: status.clone(),
                    measured: measured_from_limits(&item.limits, &result),
                    limits: limits_value(&item.limits),
                    result: Some(result.clone()),
                    error: judge_message(&judge).or_else(|| {
                        if status == "fail" {
                            result
                                .get("error")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        } else {
                            None
                        }
                    }),
                });

                if should_stop_on_status(&status, &item.fail_policy) {
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }
            }
            Err(err) => {
                steps.push(SequenceStepResult {
                    position: item.position,
                    queue_item_id: item.queue_item_id.clone(),
                    template_id: item.template_id.clone(),
                    name: item.name.clone(),
                    ok: false,
                    status: "error".into(),
                    measured: None,
                    limits: limits_value(&item.limits),
                    result: None,
                    error: Some(err),
                });

                if should_stop_on_status("error", &item.fail_policy) {
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }
            }
        }
    }

    let overall = compute_overall(&steps);

    SequenceResponse {
        stopped,
        failed_at,
        steps,
        sn,
        work_order,
        overall,
        pause: None,
    }
}

pub async fn run_sequence_with<F, Fut>(items: &[QueueItemForRun], run_one: F) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    run_sequence_with_opts(
        items,
        SequenceRunOpts {
            sn: None,
            work_order: None,
        },
        run_one,
    )
    .await
}

pub async fn run_sequence(
    cli: &Path,
    getinfo: &Path,
    items: &[QueueItemForRun],
    start_index: usize,
    opts: SequenceRunOpts,
    prior_steps: Vec<SequenceStepResult>,
    resume_breakpoint: bool,
) -> SequenceResponse {
    let cli = cli.to_path_buf();
    let getinfo = getinfo.to_path_buf();
    let items = items.to_vec();
    run_sequence_from_with_opts(
        &items,
        start_index,
        opts,
        prior_steps,
        resume_breakpoint,
        |item| {
            let cli = cli.clone();
            let getinfo = getinfo.clone();
            let item = item.clone();
            async move { run_one_step(&cli, &getinfo, &item).await }
        },
    )
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
    if crate::rest::is_rest_template(Some(item.kind.as_str()), &item.vi_path) {
        return crate::rest::run_request_from_inputs(&item.inputs).await;
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
            enabled: true,
            breakpoint: false,
            fail_policy: "stop".into(),
            limits: vec![],
        }
    }

    fn sample_limit() -> LimitRule {
        LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: Some(3.0),
            unit: None,
        }
    }

    #[tokio::test]
    async fn skips_disabled_steps() {
        let mut disabled = sample_item(0, "disabled");
        disabled.enabled = false;
        let items = vec![disabled, sample_item(1, "enabled")];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |item| {
            call += 1;
            let name = item.name.clone();
            async move {
                Ok(serde_json::json!({ "name": name }))
            }
        })
        .await;

        assert_eq!(call, 1);
        assert_eq!(resp.steps.len(), 2);
        assert_eq!(resp.steps[0].status, "skipped");
        assert!(resp.steps[0].ok);
        assert_eq!(resp.steps[1].status, "ok");
        assert_eq!(resp.overall, "pass");
    }

    #[tokio::test]
    async fn fail_policy_stop_halts_on_limit_fail() {
        let mut first = sample_item(0, "first");
        first.limits = vec![sample_limit()];
        let items = vec![first, sample_item(1, "second")];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |_item| {
            call += 1;
            async move { Ok(serde_json::json!({ "Power_dBm": 4.0 })) }
        })
        .await;

        assert_eq!(call, 1);
        assert!(resp.stopped);
        assert_eq!(resp.failed_at, Some(0));
        assert_eq!(resp.steps.len(), 1);
        assert_eq!(resp.steps[0].status, "fail");
        assert!(!resp.steps[0].ok);
        assert_eq!(resp.overall, "fail");
    }

    #[tokio::test]
    async fn fail_policy_continue_runs_next() {
        let mut first = sample_item(0, "first");
        first.limits = vec![sample_limit()];
        first.fail_policy = "continue".into();
        let items = vec![first, sample_item(1, "second")];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |_item| {
            call += 1;
            async move { Ok(serde_json::json!({ "Power_dBm": 4.0 })) }
        })
        .await;

        assert_eq!(call, 2);
        assert!(!resp.stopped);
        assert_eq!(resp.steps.len(), 2);
        assert_eq!(resp.steps[0].status, "fail");
        assert_eq!(resp.steps[1].status, "ok");
        assert_eq!(resp.overall, "fail");
    }

    #[tokio::test]
    async fn sn_from_step_output_when_opts_empty() {
        let items = vec![sample_item(0, "a")];
        let resp = run_sequence_with_opts(
            &items,
            SequenceRunOpts {
                sn: None,
                work_order: None,
            },
            |_item| async move { Ok(serde_json::json!({ "SN": "DUT1" })) },
        )
        .await;

        assert_eq!(resp.sn.as_deref(), Some("DUT1"));
        assert_eq!(resp.overall, "pass");
    }

    #[tokio::test]
    async fn missing_sn_still_runs() {
        let items = vec![sample_item(0, "a"), sample_item(1, "b")];
        let resp = run_sequence_with_opts(
            &items,
            SequenceRunOpts {
                sn: None,
                work_order: None,
            },
            |item| {
                let name = item.name.clone();
                async move { Ok(serde_json::json!({ "name": name })) }
            },
        )
        .await;

        assert!(resp.sn.is_none());
        assert_eq!(resp.overall, "pass");
        assert_eq!(resp.steps.len(), 2);
    }

    #[tokio::test]
    async fn empty_limits_status_ok() {
        let items = vec![sample_item(0, "a")];
        let resp = run_sequence_with(&items, |_item| {
            async move { Ok(serde_json::json!({ "x": 1 })) }
        })
        .await;

        assert_eq!(resp.steps[0].status, "ok");
        assert!(resp.steps[0].ok);
        assert_eq!(resp.overall, "pass");
    }

    #[tokio::test]
    async fn result_ok_false_fails_without_limits() {
        let items = vec![sample_item(0, "rest-step"), sample_item(1, "next")];
        let resp = run_sequence_with(&items, |item| {
            let name = item.name.clone();
            async move {
                if name == "rest-step" {
                    Ok(serde_json::json!({
                        "ok": false,
                        "status": 404,
                        "error": "expected status 200, got 404"
                    }))
                } else {
                    Ok(serde_json::json!({ "ok": true }))
                }
            }
        })
        .await;

        assert_eq!(resp.steps[0].status, "fail");
        assert!(!resp.steps[0].ok);
        assert_eq!(
            resp.steps[0].error.as_deref(),
            Some("expected status 200, got 404")
        );
        assert!(resp.stopped);
        assert_eq!(resp.steps.len(), 1);
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
        assert_eq!(resp.steps[0].status, "ok");
        assert!(!resp.steps[1].ok);
        assert_eq!(resp.steps[1].status, "error");
        assert_eq!(resp.steps[1].error.as_deref(), Some("step failed"));
        assert_eq!(resp.overall, "error");
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
        assert_eq!(resp.overall, "pass");
    }

    #[tokio::test]
    async fn pauses_before_breakpoint_step() {
        let mut bp = sample_item(1, "breakpoint");
        bp.breakpoint = true;
        let items = vec![sample_item(0, "first"), bp, sample_item(2, "third")];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |_item| {
            call += 1;
            async move { Ok(serde_json::json!({})) }
        })
        .await;

        assert_eq!(call, 1);
        assert_eq!(resp.steps.len(), 1);
        assert_eq!(resp.overall, "pass");
        assert!(!resp.stopped);
        let pause = resp.pause.expect("pause");
        assert_eq!(pause.before_position, 1);
        assert_eq!(pause.message, "breakpoint");
    }

    #[tokio::test]
    async fn continue_executes_breakpoint_step() {
        let mut bp = sample_item(1, "breakpoint");
        bp.breakpoint = true;
        let items = vec![sample_item(0, "first"), bp, sample_item(2, "third")];
        let mut call = 0usize;
        let resp1 = run_sequence_with(&items, |_item| {
            call += 1;
            async move { Ok(serde_json::json!({})) }
        })
        .await;

        assert!(resp1.pause.is_some());
        assert_eq!(call, 1);

        let resp2 = run_sequence_from_with_opts(
            &items,
            1,
            SequenceRunOpts {
                sn: resp1.sn.clone(),
                work_order: resp1.work_order.clone(),
            },
            resp1.steps,
            true,
            |_item| {
                call += 1;
                async move { Ok(serde_json::json!({})) }
            },
        )
        .await;

        assert!(resp2.pause.is_none());
        assert_eq!(call, 3);
        assert_eq!(resp2.steps.len(), 3);
        assert_eq!(resp2.overall, "pass");
    }

    #[test]
    fn queue_items_for_run_parses_new_fields_with_defaults() {
        let body = serde_json::json!({
            "items": [{
                "position": 0,
                "id": "q1",
                "vi_template_id": 42,
                "name": "Add",
                "vi_path": "C:\\x\\Add.vi"
            }]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].enabled);
        assert!(!items[0].breakpoint);
        assert_eq!(items[0].fail_policy, "stop");
        assert!(items[0].limits.is_empty());
    }

    #[test]
    fn queue_items_for_run_parses_limits_array_and_meta() {
        let body = serde_json::json!({
            "items": [{
                "position": 0,
                "id": "q1",
                "vi_template_id": 42,
                "name": "Add",
                "vi_path": "C:\\x\\Add.vi",
                "enabled": false,
                "breakpoint": true,
                "fail_policy": "continue",
                "limits": [{"output":"Power_dBm","min":-5.0,"max":3.0}]
            }]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert!(!items[0].enabled);
        assert!(items[0].breakpoint);
        assert_eq!(items[0].fail_policy, "continue");
        assert_eq!(items[0].limits.len(), 1);
        assert_eq!(items[0].limits[0].output, "Power_dBm");
    }

    #[test]
    fn queue_items_for_run_accepts_general_template_id_when_vi_template_id_is_null() {
        let body = serde_json::json!({
            "items": [{
                "position": 0,
                "id": "q1",
                "vi_template_id": null,
                "general_template_id": 88,
                "name": "Delay",
                "kind": "delay",
                "vi_path": ""
            }]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].template_id, "88");
        assert_eq!(items[0].kind, "delay");
    }
}
