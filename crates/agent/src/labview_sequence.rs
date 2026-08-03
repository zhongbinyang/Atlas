use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::labview::{
    build_run_args, ensure_vi, error_message, inputs_to_cli_object, normalize_fs_path, run_cli,
    LabviewError, LabviewParam,
};
use crate::limits::{
    extract_sn_from_outputs, judge_limits_with_vars, parse_limits_json, LimitRule, StepJudge,
};
use crate::resource_lock::{ResourceLockError, ResourceLockManager};
use crate::sequence_session::SequenceProgressSlot;

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
    /// Accepted for wire/DB compat; always ignored (breakpoints removed).
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits: Vec<LimitRule>,
    /// Logical instrument names to lock before this step (empty = no lock).
    #[serde(default)]
    pub resources: Vec<String>,
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
pub struct SequenceResponse {
    pub stopped: bool,
    pub failed_at: Option<usize>,
    pub steps: Vec<SequenceStepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_order: Option<String>,
    pub overall: String,
}

#[derive(Debug, Clone)]
pub struct SequenceRunOpts {
    pub sn: Option<String>,
    pub work_order: Option<String>,
    /// Variable map for `${Name}` expansion (empty = no expansion).
    pub vars: std::collections::HashMap<String, String>,
    /// Optional live progress publisher for UI polling.
    pub progress: Option<Arc<SequenceProgressSlot>>,
    /// When set, progress updates target this channel in the multi-channel snapshot.
    pub progress_channel: Option<(usize, String)>,
    /// Must match [`SequenceProgressSlot`] generation for writes to apply.
    pub progress_generation: u64,
    /// Shared resource lock manager (None = no locking).
    pub resource_locks: Option<Arc<ResourceLockManager>>,
    /// Owner label for acquired locks (e.g. `"ch-0"`).
    pub resource_owner: String,
    /// Per-step acquire timeout (default 300s).
    pub resource_timeout: Duration,
    /// Optional cancel signal checked between steps and while waiting for locks.
    pub cancel: Option<tokio::sync::watch::Receiver<bool>>,
}

impl Default for SequenceRunOpts {
    fn default() -> Self {
        Self {
            sn: None,
            work_order: None,
            vars: Default::default(),
            progress: None,
            progress_channel: None,
            progress_generation: 0,
            resource_locks: None,
            resource_owner: "ch-0".into(),
            resource_timeout: Duration::from_secs(300),
            cancel: None,
        }
    }
}

fn cancel_signaled(cancel: &Option<tokio::sync::watch::Receiver<bool>>) -> bool {
    cancel.as_ref().map(|rx| *rx.borrow()).unwrap_or(false)
}

/// Acquire `resources` (if any / if locks configured), run `f`, then release on drop.
/// Empty resources or `locks == None` skips locking.
pub async fn with_step_resources<F, Fut, T>(
    locks: Option<&Arc<ResourceLockManager>>,
    resources: &[String],
    owner: &str,
    timeout: Duration,
    cancel: Option<tokio::sync::watch::Receiver<bool>>,
    f: F,
) -> Result<T, ResourceLockError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    if resources.is_empty() || locks.is_none() {
        return Ok(f().await);
    }
    let locks = locks.expect("checked is_some");
    let _guard = locks.acquire(resources, owner, timeout, cancel).await?;
    Ok(f().await)
}

fn resource_lock_error_message(err: &ResourceLockError) -> String {
    match err {
        ResourceLockError::Timeout { resource } => {
            format!("resource lock timeout waiting for '{resource}'")
        }
        ResourceLockError::Cancelled => "resource lock cancelled".into(),
    }
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

/// Parse step resources: JSON array of non-empty strings.
/// Trims each name, rejects duplicates within one step, and enforces
/// charset `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`.
pub fn parse_resources_json(s: &str) -> Result<Vec<String>, String> {
    let value: Value =
        serde_json::from_str(s).map_err(|e| format!("invalid resources_json: {e}"))?;
    parse_resources_value(&value)
}

fn parse_resources_value(value: &Value) -> Result<Vec<String>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "resources must be a JSON array of strings".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    let mut seen = std::collections::HashSet::new();
    for (i, item) in arr.iter().enumerate() {
        let Some(raw) = item.as_str() else {
            return Err(format!("resources[{i}] must be a string"));
        };
        let name = raw.trim();
        if name.is_empty() {
            return Err(format!("resources[{i}] must be a non-empty string"));
        }
        if !is_valid_resource_name(name) {
            return Err(format!(
                "resources[{i}] invalid name '{name}' (expected ^[A-Za-z][A-Za-z0-9_.-]{{0,63}}$)"
            ));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!("resources[{i}] duplicate '{name}'"));
        }
        out.push(name.to_string());
    }
    Ok(out)
}

fn is_valid_resource_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let rest_len = name.len().saturating_sub(first.len_utf8());
    if rest_len > 63 {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

fn parse_resources_from_item(item: &Value) -> Result<Vec<String>, String> {
    if let Some(v) = item.get("resources") {
        if v.is_array() {
            return parse_resources_value(v);
        }
        if let Some(s) = v.as_str() {
            return parse_resources_json(s);
        }
    }
    if let Some(s) = item.get("resources_json").and_then(|v| v.as_str()) {
        return parse_resources_json(s);
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
                        "op": r.op,
                        "min": r.min,
                        "max": r.max,
                        "expect": r.expect,
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
    let mut group_enabled = true;
    for item in items {
        let source = item
            .get("template_source")
            .and_then(|v| v.as_str())
            .unwrap_or("labview");
        if source == "group" {
            group_enabled = item
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            continue;
        }
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
        let step_enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let enabled = step_enabled && group_enabled;
        // Breakpoints removed: accept the field but never pause.
        let _ = item.get("breakpoint");
        let breakpoint = false;
        let fail_policy = normalize_fail_policy(
            item.get("fail_policy")
                .and_then(|v| v.as_str())
                .unwrap_or("stop"),
        );
        let limits = parse_limits_from_item(item)?;
        let resources = parse_resources_from_item(item)?;
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
            resources,
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
    run_sequence_from_with_opts(items, 0, opts, Vec::new(), run_one).await
}

pub async fn run_sequence_from_with_opts<F, Fut>(
    items: &[QueueItemForRun],
    start_index: usize,
    opts: SequenceRunOpts,
    mut steps: Vec<SequenceStepResult>,
    mut run_one: F,
) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let mut stopped = false;
    let mut failed_at = None;
    let mut aborted = false;
    let vars = opts.vars.clone();
    let progress = opts.progress.clone();
    let progress_channel = opts.progress_channel.clone();
    let progress_generation = opts.progress_generation;
    let mut sn = opts.sn;
    let work_order = opts.work_order;

    async fn publish_steps(
        progress: &Option<Arc<SequenceProgressSlot>>,
        progress_channel: &Option<(usize, String)>,
        progress_generation: u64,
        steps: &[SequenceStepResult],
    ) {
        if let Some(p) = progress {
            if let Some((idx, _)) = progress_channel {
                p.set_channel_steps_if(progress_generation, *idx, steps.to_vec())
                    .await;
            } else {
                p.set_channel_steps_if(progress_generation, 0, steps.to_vec())
                    .await;
            }
        }
    }

    async fn publish_current(
        progress: &Option<Arc<SequenceProgressSlot>>,
        progress_channel: &Option<(usize, String)>,
        progress_generation: u64,
        position: usize,
        name: &str,
    ) {
        if let Some(p) = progress {
            if let Some((idx, _)) = progress_channel {
                p.set_channel_current_if(
                    progress_generation,
                    *idx,
                    position,
                    name.to_string(),
                )
                .await;
            } else {
                p.set_channel_current_if(progress_generation, 0, position, name.to_string())
                    .await;
            }
        }
    }

    for (i, item) in items.iter().enumerate().skip(start_index) {
        if cancel_signaled(&opts.cancel) {
            aborted = true;
            stopped = true;
            break;
        }

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
            publish_steps(&progress, &progress_channel, progress_generation, &steps).await;
            continue;
        }

        let _ = item.breakpoint;

        publish_current(
            &progress,
            &progress_channel,
            progress_generation,
            item.position,
            &item.name,
        )
        .await;

        // Progress stays at current step name while waiting for locks (no waiting_resource hint yet).
        let step_outcome = with_step_resources(
            opts.resource_locks.as_ref(),
            &item.resources,
            &opts.resource_owner,
            opts.resource_timeout,
            opts.cancel.clone(),
            || run_one(item),
        )
        .await;

        match step_outcome {
            Err(lock_err) => {
                let cancelled = matches!(lock_err, ResourceLockError::Cancelled);
                steps.push(SequenceStepResult {
                    position: item.position,
                    queue_item_id: item.queue_item_id.clone(),
                    template_id: item.template_id.clone(),
                    name: item.name.clone(),
                    ok: false,
                    status: if cancelled {
                        "aborted".into()
                    } else {
                        "error".into()
                    },
                    measured: None,
                    limits: limits_value(&item.limits),
                    result: None,
                    error: Some(resource_lock_error_message(&lock_err)),
                });
                publish_steps(&progress, &progress_channel, progress_generation, &steps).await;

                if cancelled {
                    aborted = true;
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }

                if should_stop_on_status("error", &item.fail_policy) {
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }
            }
            Ok(Ok(result)) => {
                if let Some(extracted) = extract_sn_from_outputs(&result) {
                    sn = Some(extracted);
                }

                let judge = judge_limits_with_vars(&item.limits, &result, &vars);
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
                publish_steps(&progress, &progress_channel, progress_generation, &steps).await;

                if should_stop_on_status(&status, &item.fail_policy) {
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }
            }
            Ok(Err(err)) => {
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
                publish_steps(&progress, &progress_channel, progress_generation, &steps).await;

                if should_stop_on_status("error", &item.fail_policy) {
                    stopped = true;
                    failed_at = Some(i);
                    break;
                }
            }
        }
    }

    let overall = if aborted {
        "aborted".into()
    } else {
        compute_overall(&steps)
    };

    if let Some(p) = &progress {
        if let Some((idx, name)) = &progress_channel {
            // Multi-channel: leave running=true until orchestrator finishes all workers.
            p.set_channel_overall_if(
                progress_generation,
                *idx,
                name.clone(),
                steps.clone(),
                overall.clone(),
            )
            .await;
        } else {
            p.finish_channels(
                progress_generation,
                &[(0, "CH0".into(), steps.clone(), overall.clone())],
            )
            .await;
        }
    }

    SequenceResponse {
        stopped,
        failed_at,
        steps,
        sn,
        work_order,
        overall,
    }
}

pub async fn run_sequence_with<F, Fut>(items: &[QueueItemForRun], run_one: F) -> SequenceResponse
where
    F: FnMut(&QueueItemForRun) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    run_sequence_with_opts(items, SequenceRunOpts::default(), run_one).await
}

pub async fn run_sequence(
    cli: &Path,
    getinfo: &Path,
    items: &[QueueItemForRun],
    opts: SequenceRunOpts,
) -> SequenceResponse {
    let cli = cli.to_path_buf();
    let getinfo = getinfo.to_path_buf();
    let items = items.to_vec();
    let vars = opts.vars.clone();
    run_sequence_from_with_opts(
        &items,
        0,
        opts,
        Vec::new(),
        |item| {
            let cli = cli.clone();
            let getinfo = getinfo.clone();
            let item = item.clone();
            let vars = vars.clone();
            async move { run_one_step(&cli, &getinfo, &item, &vars).await }
        },
    )
    .await
}

pub async fn run_one_step(
    cli: &Path,
    getinfo: &Path,
    item: &QueueItemForRun,
    vars: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let expand_mode = if crate::rest::is_rest_template(Some(item.kind.as_str()), &item.vi_path) {
        // REST: lenient so typos in optional ${vars} don't hard-fail every call.
        crate::expand::ExpandMode::Lenient
    } else {
        crate::expand::ExpandMode::Strict
    };
    let inputs = crate::expand::expand_json_value_mode(&item.inputs, vars, expand_mode)
        .map_err(|e| e.to_string())?;

    if crate::general::is_delay_template(Some(item.kind.as_str()), &item.vi_path) {
        let delay_ms = crate::general::delay_ms_from_inputs(&inputs)?;
        return Ok(crate::general::run_delay_ms(delay_ms).await);
    }
    if crate::general::is_version_template(Some(item.kind.as_str()), &item.vi_path) {
        return Ok(crate::general::run_read_version());
    }
    if crate::rest::is_rest_template(Some(item.kind.as_str()), &item.vi_path) {
        return crate::rest::run_request_from_inputs(&inputs).await;
    }

    let vi = std::path::PathBuf::from(normalize_fs_path(&item.vi_path));
    ensure_vi(&vi).map_err(|e| error_message(&e))?;

    let input_map = match &inputs {
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
    use crate::resource_lock::ResourceLockManager;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

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
            resources: vec![],
        }
    }

    fn sample_limit() -> LimitRule {
        LimitRule {
            output: "Power_dBm".into(),
            op: None,
            min: Some(serde_json::json!(-5.0)),
            max: Some(serde_json::json!(3.0)),
            expect: None,
            unit: None,
        }
    }

    #[tokio::test]
    async fn with_step_resources_serializes_concurrent_holders() {
        let locks = ResourceLockManager::new();
        let resources = vec!["station.dca".to_string()];
        let concurrent = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let run = |owner: &'static str| {
            let locks = locks.clone();
            let resources = resources.clone();
            let concurrent = concurrent.clone();
            let max_seen = max_seen.clone();
            async move {
                with_step_resources(
                    Some(&locks),
                    &resources,
                    owner,
                    Duration::from_secs(5),
                    None,
                    || {
                        let concurrent = concurrent.clone();
                        let max_seen = max_seen.clone();
                        async move {
                            let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                            max_seen.fetch_max(now, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            concurrent.fetch_sub(1, Ordering::SeqCst);
                            1usize
                        }
                    },
                )
                .await
            }
        };

        let (a, b) = tokio::join!(run("ch-1"), run("ch-2"));
        assert_eq!(a.unwrap(), 1);
        assert_eq!(b.unwrap(), 1);
        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn with_step_resources_empty_skips_lock() {
        let locks = ResourceLockManager::new();
        let held = locks
            .acquire(
                &["station.dca".into()],
                "holder",
                Duration::from_secs(1),
                None,
            )
            .await
            .unwrap();

        // Empty resources must not wait on the held lock.
        let out = tokio::time::timeout(
            Duration::from_millis(200),
            with_step_resources(
                Some(&locks),
                &[],
                "ch-0",
                Duration::from_secs(5),
                None,
                || async { 42usize },
            ),
        )
        .await
        .expect("empty resources should not block")
        .unwrap();
        assert_eq!(out, 42);
        drop(held);
    }

    #[tokio::test]
    async fn lock_timeout_marks_step_error_and_stops() {
        let locks = ResourceLockManager::new();
        let _holder = locks
            .acquire(
                &["station.dca".into()],
                "holder",
                Duration::from_secs(5),
                None,
            )
            .await
            .unwrap();

        let mut item = sample_item(0, "needs-lock");
        item.resources = vec!["station.dca".into()];
        item.fail_policy = "stop".into();
        let items = vec![item, sample_item(1, "next")];

        let mut call = 0usize;
        let resp = run_sequence_with_opts(
            &items,
            SequenceRunOpts {
                resource_locks: Some(locks.clone()),
                resource_owner: "ch-0".into(),
                resource_timeout: Duration::from_millis(40),
                ..Default::default()
            },
            |_item| {
                call += 1;
                async move { Ok(serde_json::json!({})) }
            },
        )
        .await;

        assert_eq!(call, 0);
        assert!(resp.stopped);
        assert_eq!(resp.failed_at, Some(0));
        assert_eq!(resp.steps.len(), 1);
        assert_eq!(resp.steps[0].status, "error");
        assert!(!resp.steps[0].ok);
        let err = resp.steps[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("station.dca"),
            "error should mention resource, got: {err}"
        );
        assert_eq!(resp.overall, "error");
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
            SequenceRunOpts::default(),
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
            SequenceRunOpts::default(),
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
    async fn breakpoint_flag_is_ignored_and_run_continues() {
        let mut bp = sample_item(1, "breakpoint");
        bp.breakpoint = true;
        let items = vec![sample_item(0, "first"), bp, sample_item(2, "third")];
        let mut call = 0usize;
        let resp = run_sequence_with(&items, |_item| {
            call += 1;
            async move { Ok(serde_json::json!({})) }
        })
        .await;

        assert_eq!(call, 3);
        assert_eq!(resp.steps.len(), 3);
        assert_eq!(resp.overall, "pass");
        assert!(!resp.stopped);
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
        assert!(items[0].resources.is_empty());
    }

    #[test]
    fn queue_items_for_run_parses_resources_array_and_json() {
        let body = serde_json::json!({
            "items": [{
                "position": 0,
                "id": "q1",
                "vi_template_id": 42,
                "name": "Add",
                "vi_path": "C:\\x\\Add.vi",
                "resources": ["station.dca", " ch.evb "]
            }]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert_eq!(
            items[0].resources,
            vec!["station.dca".to_string(), "ch.evb".to_string()]
        );

        let body_json = serde_json::json!({
            "items": [{
                "position": 0,
                "id": "q1",
                "vi_template_id": 42,
                "name": "Add",
                "vi_path": "C:\\x\\Add.vi",
                "resources_json": "[\"station.osa\"]"
            }]
        });
        let items = queue_items_for_run(&body_json).unwrap();
        assert_eq!(items[0].resources, vec!["station.osa".to_string()]);
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
        assert!(!items[0].breakpoint);
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

    #[test]
    fn queue_items_for_run_skips_group_headers() {
        let body = serde_json::json!({
            "items": [
                {
                    "position": 0,
                    "id": "g1",
                    "template_source": "group",
                    "name": "预处理",
                    "enabled": true
                },
                {
                    "position": 1,
                    "id": "q1",
                    "template_source": "labview",
                    "vi_template_id": 42,
                    "name": "Add",
                    "vi_path": "C:\\x\\Add.vi",
                    "enabled": true
                }
            ]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].queue_item_id, "q1");
        assert!(items[0].enabled);
    }

    #[test]
    fn queue_items_for_run_disables_steps_when_group_disabled() {
        let body = serde_json::json!({
            "items": [
                {
                    "position": 0,
                    "id": "g1",
                    "template_source": "group",
                    "name": "预处理",
                    "enabled": false
                },
                {
                    "position": 1,
                    "id": "q1",
                    "template_source": "labview",
                    "vi_template_id": 42,
                    "name": "Add",
                    "vi_path": "C:\\x\\Add.vi",
                    "enabled": true
                },
                {
                    "position": 2,
                    "id": "g2",
                    "template_source": "group",
                    "name": "测试",
                    "enabled": true
                },
                {
                    "position": 3,
                    "id": "q2",
                    "template_source": "labview",
                    "vi_template_id": 43,
                    "name": "Mul",
                    "vi_path": "C:\\x\\Mul.vi",
                    "enabled": true
                }
            ]
        });
        let items = queue_items_for_run(&body).unwrap();
        assert_eq!(items.len(), 2);
        assert!(!items[0].enabled);
        assert!(items[1].enabled);
    }
}
