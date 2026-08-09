use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post, put},
    Json, Router,
};
use common::{AgentStatusResponse, ErrorBody, RegisterAgentRequest};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

use crate::labview::{
    build_inspect_args, build_run_args, ensure_vi, inputs_to_cli_object, map_status,
    normalize_fs_path, run_cli,
    LabviewError, LabviewParam,
};
use crate::channel_run::{
    aggregate_overall, channel_specs_from_list, channels_unavailable_fallback, run_multi_channel,
    ChannelRunRequest, ChannelSequenceResponse, ChannelSpec, MultiChannelSequenceResponse,
};
use crate::labview_sequence::{queue_items_for_run, SequenceResponse};
use crate::metrics::MetricsSnapshot;
use crate::resource_lock::ResourceLockManager;
use crate::sequence_session::{SequenceCancelRegistry, SequenceProgressSlot};
use crate::task_slot::TaskSlot;
use serde_json::Value;
use tokio::sync::watch;

#[derive(Clone)]
pub struct AppState {
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub started: Instant,
    pub slot: Arc<TaskSlot>,
    pub metrics: Arc<RwLock<MetricsSnapshot>>,
    pub center_url: String,
    pub http_client: reqwest::Client,
    pub log_dir: PathBuf,
    pub labview_cli: PathBuf,
    pub labview_getinfo: PathBuf,
    pub sequence_progress: Arc<SequenceProgressSlot>,
    pub resource_locks: Arc<ResourceLockManager>,
    pub sequence_cancel: Arc<SequenceCancelRegistry>,
    pub sequence_lifecycle: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    pub(crate) sequence_lifecycle_test_hooks: Arc<SequenceLifecycleTestHooks>,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct SequenceAdmissionPause {
    channel_index: usize,
    reached: Arc<tokio::sync::Barrier>,
    resume: Arc<tokio::sync::Barrier>,
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct SequenceLifecycleTestHooks {
    admission_pause: Option<SequenceAdmissionPause>,
    abort_before_gate: Option<Arc<tokio::sync::Barrier>>,
    force_release_before_gate: Option<Arc<tokio::sync::Barrier>>,
    rollback_complete: Option<Arc<tokio::sync::Barrier>>,
}

struct SequenceAdmissionLease {
    slot: Arc<TaskSlot>,
    cancel: Arc<SequenceCancelRegistry>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    channel_index: usize,
    generation: u64,
    armed: bool,
    #[cfg(test)]
    rollback_complete: Option<Arc<tokio::sync::Barrier>>,
}

impl SequenceAdmissionLease {
    fn new(state: &AppState, channel_index: usize, generation: u64) -> Self {
        Self {
            slot: state.slot.clone(),
            cancel: state.sequence_cancel.clone(),
            lifecycle: state.sequence_lifecycle.clone(),
            channel_index,
            generation,
            armed: true,
            #[cfg(test)]
            rollback_complete: state
                .sequence_lifecycle_test_hooks
                .rollback_complete
                .clone(),
        }
    }

    async fn release_locked(&mut self) {
        if !self.armed {
            return;
        }
        self.cancel
            .clear_if(self.channel_index, self.generation)
            .await;
        self.slot
            .release_sequence(self.channel_index, self.generation)
            .await;
        self.armed = false;
    }

    async fn release(mut self) {
        let lifecycle = self.lifecycle.clone();
        let _lifecycle = lifecycle.lock().await;
        self.release_locked().await;
    }
}

impl Drop for SequenceAdmissionLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let slot = self.slot.clone();
        let cancel = self.cancel.clone();
        let lifecycle = self.lifecycle.clone();
        let channel_index = self.channel_index;
        let generation = self.generation;
        #[cfg(test)]
        let rollback_complete = self.rollback_complete.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                {
                    let _lifecycle = lifecycle.lock().await;
                    cancel.clear_if(channel_index, generation).await;
                    slot.release_sequence(channel_index, generation).await;
                }
                #[cfg(test)]
                if let Some(barrier) = rollback_complete {
                    barrier.wait().await;
                }
            });
        }
    }
}

struct AdmittedChannelRun {
    spec: ChannelSpec,
    generation: u64,
    cancel: watch::Receiver<bool>,
    lease: SequenceAdmissionLease,
}

struct ChannelAdmission {
    started: Vec<AdmittedChannelRun>,
    skipped_channel_indexes: Vec<usize>,
}

async fn admit_sequence_channels(
    state: &AppState,
    channels: Vec<ChannelSpec>,
) -> Result<ChannelAdmission, &'static str> {
    let _lifecycle = state.sequence_lifecycle.lock().await;
    let mut admission = ChannelAdmission {
        started: Vec::new(),
        skipped_channel_indexes: Vec::new(),
    };

    for spec in channels {
        let channel_index = spec.channel_index;
        let generation = match state.slot.try_acquire_sequence(channel_index).await {
            Ok(generation) => generation,
            Err("channel busy") => {
                admission.skipped_channel_indexes.push(channel_index);
                continue;
            }
            Err(error) => {
                for mut admitted in admission.started.drain(..) {
                    admitted.lease.release_locked().await;
                }
                return Err(error);
            }
        };
        let mut lease = SequenceAdmissionLease::new(state, channel_index, generation);

        #[cfg(test)]
        if let Some(pause) = state
            .sequence_lifecycle_test_hooks
            .admission_pause
            .as_ref()
            .filter(|pause| pause.channel_index == channel_index)
        {
            pause.reached.wait().await;
            pause.resume.wait().await;
        }

        match state
            .sequence_cancel
            .install(channel_index, generation)
            .await
        {
            Ok(cancel) => admission.started.push(AdmittedChannelRun {
                spec,
                generation,
                cancel,
                lease,
            }),
            Err("stale generation") => {
                lease.release_locked().await;
                admission.skipped_channel_indexes.push(channel_index);
            }
            Err(error) => {
                lease.release_locked().await;
                for mut admitted in admission.started.drain(..) {
                    admitted.lease.release_locked().await;
                }
                return Err(error);
            }
        }
    }

    Ok(admission)
}

#[derive(Serialize, Deserialize)]
struct LabviewConfigResponse {
    cli_path: String,
    getinfo_path: String,
}

#[derive(Deserialize)]
struct LabviewInspectRequest {
    vi_path: String,
}

#[derive(Deserialize)]
struct LabviewRunRequest {
    vi_path: String,
    #[serde(default)]
    inputs: Option<Value>,
    #[serde(default)]
    show_front_panel: bool,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
struct RunSequenceRequest {
    #[serde(default)]
    sn: Option<String>,
    #[serde(default)]
    work_order: Option<String>,
    #[serde(default)]
    sequence_template_id: Option<i64>,
    /// If set, run only these enabled channel indexes; omit = all enabled.
    #[serde(default)]
    channel_indexes: Option<Vec<usize>>,
}

#[derive(Debug, Deserialize)]
struct AbortSequenceChannelRequest {
    generation: u64,
}

fn normalize_run_sequence_opt(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

#[derive(Deserialize)]
struct LabviewRegisterTemplateRequest {
    vi_path: String,
    #[serde(default)]
    inputs: Option<Value>,
    #[serde(default)]
    outputs: Option<Value>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    show_front_panel: bool,
    timeout_secs: Option<u64>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/status", get(status))
        .route("/api/slot/force-release", post(slot_force_release))
        .route("/api/register-now", post(register_now))
        .route("/api/labview/config", get(labview_config))
        .route("/api/labview/inspect", post(labview_inspect))
        .route("/api/labview/run", post(labview_run))
        .route(
            "/api/labview/register-template",
            post(labview_register_template),
        )
        .route(
            "/api/labview/registered-templates",
            get(labview_registered_templates),
        )
        .route("/api/labview/all-templates", get(labview_all_templates))
        .route("/api/labview/agent-id", get(labview_agent_id))
        .route(
            "/api/labview/templates/{id}",
            patch(labview_patch_template),
        )
        .route("/api/sequence/run-queue", get(labview_run_queue_get).put(labview_run_queue_put))
        .route(
            "/api/sequence-templates",
            get(sequence_templates_list).post(sequence_templates_create),
        )
        .route(
            "/api/sequence-templates/{id}/load",
            post(sequence_template_load_to_agent),
        )
        .route(
            "/api/agent-config-templates",
            get(agent_config_templates_list).post(agent_config_templates_create),
        )
        .route(
            "/api/agent-config-templates/{id}/load",
            post(agent_config_template_load_to_agent),
        )
        .route(
            "/api/spec-templates",
            get(spec_templates_list).post(spec_templates_create),
        )
        .route(
            "/api/spec-templates/{id}",
            get(spec_templates_get).delete(spec_templates_delete),
        )
        .route("/api/sequence/run", post(labview_run_sequence))
        .route(
            "/api/sequence/run/progress",
            get(labview_run_sequence_progress),
        )
        .route(
            "/api/sequence/run/continue",
            post(labview_run_sequence_continue_gone),
        )
        .route(
            "/api/sequence/run/channels/{channel_index}/abort",
            post(labview_run_sequence_channel_abort),
        )
        .route(
            "/api/sequence/run/abort",
            post(labview_run_sequence_abort),
        )
        .route("/api/settings", get(agent_settings_get).put(agent_settings_put))
        .route("/api/units", get(agent_units_get))
        .route(
            "/api/channels",
            get(agent_channels_get).put(agent_channels_put),
        )
        .route(
            "/api/device-profiles",
            get(device_profiles_list).post(device_profiles_create),
        )
        .route(
            "/api/device-profiles/{profile_id}",
            put(device_profiles_update).delete(device_profiles_delete),
        )
        .route(
            "/api/device-profiles/{profile_id}/activate",
            post(device_profiles_activate),
        )
        .route(
            "/api/calibration-profiles",
            get(calibration_profiles_list).post(calibration_profiles_create),
        )
        .route(
            "/api/calibration-profiles/{profile_id}",
            put(calibration_profiles_update).delete(calibration_profiles_delete),
        )
        .route(
            "/api/calibration-profiles/{profile_id}/activate",
            post(calibration_profiles_activate),
        )
        .route("/api/general/delay/run", post(general_delay_run))
        .route(
            "/api/general/delay/register-template",
            post(general_delay_register),
        )
        .route("/api/general/delay/templates", get(general_delay_templates))
        .route("/api/general/version/run", post(general_version_run))
        .route(
            "/api/general/version/register-template",
            post(general_version_register),
        )
        .route(
            "/api/general/version/templates",
            get(general_version_templates),
        )
        .route("/api/general/rest/run", post(general_rest_run))
        .route(
            "/api/general/rest/register-template",
            post(general_rest_register),
        )
        .route("/api/general/rest/templates", get(general_rest_templates))
        .route("/api/general/all-templates", get(general_all_templates))
        .with_state(state)
}

fn labview_error_response(err: &LabviewError) -> (StatusCode, Json<Value>) {
    let status = map_status(err);
    let body = match err {
        LabviewError::MissingTool => serde_json::json!({ "error": "labview cli not found" }),
        LabviewError::MissingVi => serde_json::json!({ "error": "vi not found" }),
        LabviewError::Cli {
            stderr_json,
            stderr_raw,
            ..
        } => {
            if let Some(j) = stderr_json {
                if let Some(err_obj) = j.get("error") {
                    serde_json::json!({ "error": err_obj.clone() })
                } else if j.get("kind").is_some() && j.get("message").is_some() {
                    serde_json::json!({
                        "error": {
                            "kind": j.get("kind").cloned().unwrap_or(Value::Null),
                            "message": j.get("message").cloned().unwrap_or(Value::Null),
                        }
                    })
                } else {
                    serde_json::json!({ "error": stderr_raw })
                }
            } else {
                serde_json::json!({ "error": stderr_raw })
            }
        }
        LabviewError::Io(msg) => serde_json::json!({ "error": msg }),
    };
    (status, Json(body))
}

fn inputs_to_map(inputs: Option<Value>) -> Result<serde_json::Map<String, Value>, String> {
    match inputs.unwrap_or_else(|| Value::Object(serde_json::Map::new())) {
        Value::Array(arr) => {
            let params: Vec<LabviewParam> = serde_json::from_value(Value::Array(arr))
                .map_err(|e| format!("invalid inputs array: {e}"))?;
            Ok(inputs_to_cli_object(&params))
        }
        Value::Object(map) => Ok(map),
        _ => Err("inputs must be an array or object".into()),
    }
}

async fn labview_config(State(s): State<AppState>) -> Json<LabviewConfigResponse> {
    Json(LabviewConfigResponse {
        cli_path: s.labview_cli.display().to_string(),
        getinfo_path: s.labview_getinfo.display().to_string(),
    })
}

async fn labview_inspect(
    State(s): State<AppState>,
    Json(req): Json<LabviewInspectRequest>,
) -> impl IntoResponse {
    let vi = PathBuf::from(normalize_fs_path(&req.vi_path));
    if let Err(e) = ensure_vi(&vi) {
        let (status, Json(body)) = labview_error_response(&e);
        return (status, Json(body)).into_response();
    }
    let args = build_inspect_args(&s.labview_getinfo, &vi);
    match run_cli(&s.labview_cli, &args).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => {
            let (status, Json(body)) = labview_error_response(&e);
            (status, Json(body)).into_response()
        }
    }
}

async fn labview_run(
    State(s): State<AppState>,
    Json(req): Json<LabviewRunRequest>,
) -> impl IntoResponse {
    let vi = PathBuf::from(normalize_fs_path(&req.vi_path));
    if let Err(e) = ensure_vi(&vi) {
        let (status, Json(body)) = labview_error_response(&e);
        return (status, Json(body)).into_response();
    }
    let mut input_map = match inputs_to_map(req.inputs) {
        Ok(m) => m,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response();
        }
    };
    let vars = load_settings_vars(&s).await;
    let expanded = match crate::expand::expand_json_value(&Value::Object(input_map), &vars) {
        Ok(Value::Object(m)) => m,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "expanded inputs must be object" })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    input_map = expanded;
    let input_json = match serde_json::to_string(&Value::Object(input_map)) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    let args = build_run_args(
        &s.labview_getinfo,
        &vi,
        &input_json,
        req.show_front_panel,
        req.timeout_secs,
    );
    match run_cli(&s.labview_cli, &args).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => {
            let (status, Json(body)) = labview_error_response(&e);
            (status, Json(body)).into_response()
        }
    }
}

async fn build_busy_snapshot(s: &AppState) -> BusySnapshot {
    let busy = s.slot.is_busy().await;
    let owner = s.slot.owner().await;

    if !busy {
        return BusySnapshot {
            busy: false,
            busy_reason: None,
            busy_message: None,
            can_continue: false,
            can_abort: false,
            can_force_release: false,
            pause_before_position: None,
            pause_step_name: None,
        };
    }

    let reason = owner.unwrap_or_else(|| "unknown".into());
    let message = match reason.as_str() {
        "sequence" => "序列正在执行中".to_string(),
        "delay" => "Delay 试跑进行中".to_string(),
        "rest" => "REST 试跑进行中".to_string(),
        other => format!("机台忙碌（{other}）"),
    };
    let can_abort = reason == "sequence";
    BusySnapshot {
        busy: true,
        busy_reason: Some(reason),
        busy_message: Some(message),
        can_continue: false,
        can_abort,
        can_force_release: true,
        pause_before_position: None,
        pause_step_name: None,
    }
}

#[derive(Clone)]
struct BusySnapshot {
    busy: bool,
    busy_reason: Option<String>,
    busy_message: Option<String>,
    can_continue: bool,
    can_abort: bool,
    can_force_release: bool,
    pause_before_position: Option<usize>,
    pause_step_name: Option<String>,
}

fn busy_conflict_json(snap: &BusySnapshot) -> Value {
    serde_json::json!({
        "error": "agent is busy",
        "busy_reason": snap.busy_reason,
        "busy_message": snap.busy_message,
        "can_continue": snap.can_continue,
        "can_abort": snap.can_abort,
        "can_force_release": snap.can_force_release,
        "pause_before_position": snap.pause_before_position,
        "pause_step_name": snap.pause_step_name,
    })
}

async fn status(State(s): State<AppState>) -> Json<AgentStatusResponse> {
    let metrics = *s.metrics.read().await;
    let snap = build_busy_snapshot(&s).await;
    Json(AgentStatusResponse {
        hostname: s.hostname.clone(),
        ip: s.ip.clone(),
        cpu_percent: metrics.cpu_percent,
        memory_percent: metrics.memory_percent,
        busy: snap.busy,
        uptime_secs: s.started.elapsed().as_secs(),
        busy_reason: snap.busy_reason,
        busy_message: snap.busy_message,
        can_continue: Some(snap.can_continue),
        can_abort: Some(snap.can_abort),
        can_force_release: Some(snap.can_force_release),
        pause_before_position: snap.pause_before_position,
        pause_step_name: snap.pause_step_name,
        log_dir: Some(s.log_dir.display().to_string()),
        center_url: Some(s.center_url.clone()),
    })
}

async fn slot_force_release(State(s): State<AppState>) -> impl IntoResponse {
    #[cfg(test)]
    if let Some(barrier) = &s.sequence_lifecycle_test_hooks.force_release_before_gate {
        barrier.wait().await;
    }
    let _lifecycle = s.sequence_lifecycle.lock().await;

    // Publish cancellation and clear progress from the exact live holds before
    // freeing admission, so a new exclusive owner cannot overlap an uncancelled run.
    let _ = s.sequence_cancel.signal_all().await;
    let live_holds = s.slot.snapshot_holds().await;
    for hold in &live_holds {
        if let Some(channel_index) = hold.channel_index {
            let _ = s
                .sequence_progress
                .clear_channel_if(channel_index, hold.generation)
                .await;
        }
    }
    let released_holds = s.slot.force_release_all().await;
    for hold in &released_holds {
        if let Some(channel_index) = hold.channel_index {
            s.sequence_cancel
                .clear_if(channel_index, hold.generation)
                .await;
        }
    }
    let released = !released_holds.is_empty();

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "released": released,
            "message": if released { "已强制释放占用" } else { "当前已空闲" },
        })),
    )
        .into_response()
}

async fn labview_register_template(
    State(s): State<AppState>,
    Json(req): Json<LabviewRegisterTemplateRequest>,
) -> impl IntoResponse {
    let vi_path = normalize_fs_path(&req.vi_path);
    if vi_path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "vi_path is required" })),
        )
            .into_response();
    }

    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    }

    let inputs = match req.inputs {
        Some(Value::Array(arr)) => Value::Array(arr),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "inputs must be an array" })),
            )
                .into_response();
        }
        None => Value::Array(vec![]),
    };

    let outputs = match req.outputs {
        Some(Value::Array(arr)) => Value::Array(arr),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "outputs must be an array" })),
            )
                .into_response();
        }
        None => Value::Array(vec![]),
    };

    let agent_id = match crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    {
        Ok(id) => id,
        Err(e) if e == "agent not found on center" => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    let center_body = serde_json::json!({
        "agent_id": agent_id,
        "vi_path": vi_path,
        "cli_path": s.labview_cli.display().to_string(),
        "getinfo_path": s.labview_getinfo.display().to_string(),
        "inputs": inputs,
        "outputs": outputs,
        "name": req.name.trim(),
        "show_front_panel": req.show_front_panel,
        "timeout_secs": req.timeout_secs,
    });

    match crate::register::register_vi_template(&s.http_client, &s.center_url, &center_body).await {
        Ok((status, body)) => {
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, Json(body)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

async fn labview_patch_template(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match crate::register::patch_vi_template(&s.http_client, &s.center_url, &id, &body).await {
        Ok((status, resp_body)) => {
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, Json(resp_body)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

async fn labview_registered_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => match crate::register::list_vi_templates_for_agent(
            &s.http_client,
            &s.center_url,
            &agent_id,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn labview_all_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_all_vi_templates(&s.http_client, &s.center_url).await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn labview_agent_id(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => (StatusCode::OK, Json(serde_json::json!({ "agent_id": agent_id })))
            .into_response(),
        Err(resp) => resp,
    }
}

async fn resolve_agent_id_for_proxy(
    s: &AppState,
) -> Result<String, axum::response::Response> {
    match crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    {
        Ok(id) => Ok(id),
        Err(e) if e == "agent not found on center" => Err((
            StatusCode::NOT_FOUND,
            Json(ErrorBody { error: e }),
        )
            .into_response()),
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response()),
    }
}

async fn load_settings_vars(s: &AppState) -> std::collections::HashMap<String, String> {
    let Ok(agent_id) = crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    else {
        return crate::settings_defaults::variables_map_for_expand(
            &crate::register::AgentSettingsPayload::default(),
            &s.hostname,
            &s.ip,
        );
    };
    match crate::register::get_agent_settings(&s.http_client, &s.center_url, &agent_id).await {
        Ok(settings) => {
            crate::settings_defaults::variables_map_for_expand(&settings, &s.hostname, &s.ip)
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to load agent settings for expand");
            crate::settings_defaults::variables_map_for_expand(
                &crate::register::AgentSettingsPayload::default(),
                &s.hostname,
                &s.ip,
            )
        }
    }
}

async fn agent_settings_get(State(s): State<AppState>) -> impl IntoResponse {
    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::get_agent_settings(&s.http_client, &s.center_url, &agent_id).await {
        Ok(body) => {
            let body = crate::settings_defaults::enrich_settings(body, &s.hostname, &s.ip);
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn agent_units_get(State(s): State<AppState>) -> impl IntoResponse {
    match crate::register::get_center_units(&s.http_client, &s.center_url).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn agent_settings_put(
    State(s): State<AppState>,
    Json(body): Json<crate::register::AgentSettingsPayload>,
) -> impl IntoResponse {
    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::put_agent_settings(&s.http_client, &s.center_url, &agent_id, &body).await
    {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn agent_channels_get(State(s): State<AppState>) -> impl IntoResponse {
    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::get_agent_channels(&s.http_client, &s.center_url, &agent_id).await {
        Ok((status, body)) => (status, Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn agent_channels_put(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::put_agent_channels(&s.http_client, &s.center_url, &agent_id, &body)
        .await
    {
        Ok((status, body)) => (status, Json(body)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

const DEVICE_PROFILES_KIND: &str = "device-profiles";
const CALIBRATION_PROFILES_KIND: &str = "calibration-profiles";

async fn device_profiles_list(State(s): State<AppState>) -> impl IntoResponse {
    proxy_list_profiles(&s, DEVICE_PROFILES_KIND).await
}

async fn calibration_profiles_list(State(s): State<AppState>) -> impl IntoResponse {
    proxy_list_profiles(&s, CALIBRATION_PROFILES_KIND).await
}

async fn proxy_list_profiles(s: &AppState, kind: &str) -> axum::response::Response {
    let agent_id = match resolve_agent_id_for_proxy(s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::list_config_profiles(&s.http_client, &s.center_url, &agent_id, kind)
        .await
    {
        Ok(list) => (StatusCode::OK, Json(list)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn device_profiles_create(
    State(s): State<AppState>,
    Json(body): Json<crate::register::CreateAgentConfigProfileBody>,
) -> impl IntoResponse {
    proxy_create_profile(&s, DEVICE_PROFILES_KIND, body).await
}

async fn calibration_profiles_create(
    State(s): State<AppState>,
    Json(body): Json<crate::register::CreateAgentConfigProfileBody>,
) -> impl IntoResponse {
    proxy_create_profile(&s, CALIBRATION_PROFILES_KIND, body).await
}

async fn proxy_create_profile(
    s: &AppState,
    kind: &str,
    body: crate::register::CreateAgentConfigProfileBody,
) -> axum::response::Response {
    let agent_id = match resolve_agent_id_for_proxy(s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::create_config_profile(
        &s.http_client,
        &s.center_url,
        &agent_id,
        kind,
        &body,
    )
    .await
    {
        Ok(p) => (StatusCode::OK, Json(p)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn device_profiles_update(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
    Json(body): Json<crate::register::UpdateAgentConfigProfileBody>,
) -> impl IntoResponse {
    proxy_update_profile(&s, DEVICE_PROFILES_KIND, &profile_id, body).await
}

async fn calibration_profiles_update(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
    Json(body): Json<crate::register::UpdateAgentConfigProfileBody>,
) -> impl IntoResponse {
    proxy_update_profile(&s, CALIBRATION_PROFILES_KIND, &profile_id, body).await
}

async fn proxy_update_profile(
    s: &AppState,
    kind: &str,
    profile_id: &str,
    body: crate::register::UpdateAgentConfigProfileBody,
) -> axum::response::Response {
    let agent_id = match resolve_agent_id_for_proxy(s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::update_config_profile(
        &s.http_client,
        &s.center_url,
        &agent_id,
        kind,
        profile_id,
        &body,
    )
    .await
    {
        Ok(p) => (StatusCode::OK, Json(p)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn device_profiles_delete(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
) -> impl IntoResponse {
    proxy_delete_profile(&s, DEVICE_PROFILES_KIND, &profile_id).await
}

async fn calibration_profiles_delete(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
) -> impl IntoResponse {
    proxy_delete_profile(&s, CALIBRATION_PROFILES_KIND, &profile_id).await
}

async fn proxy_delete_profile(
    s: &AppState,
    kind: &str,
    profile_id: &str,
) -> axum::response::Response {
    let agent_id = match resolve_agent_id_for_proxy(s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::delete_config_profile(
        &s.http_client,
        &s.center_url,
        &agent_id,
        kind,
        profile_id,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn device_profiles_activate(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
) -> impl IntoResponse {
    proxy_activate_profile(&s, DEVICE_PROFILES_KIND, &profile_id).await
}

async fn calibration_profiles_activate(
    State(s): State<AppState>,
    Path(profile_id): Path<String>,
) -> impl IntoResponse {
    proxy_activate_profile(&s, CALIBRATION_PROFILES_KIND, &profile_id).await
}

async fn proxy_activate_profile(
    s: &AppState,
    kind: &str,
    profile_id: &str,
) -> axum::response::Response {
    let agent_id = match resolve_agent_id_for_proxy(s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    match crate::register::activate_config_profile(
        &s.http_client,
        &s.center_url,
        &agent_id,
        kind,
        profile_id,
    )
    .await
    {
        Ok(p) => (StatusCode::OK, Json(p)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ErrorBody { error: e })).into_response(),
    }
}

async fn labview_run_queue_get(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => match crate::register::get_vi_run_queue(
            &s.http_client,
            &s.center_url,
            &agent_id,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn labview_run_queue_put(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => match crate::register::put_vi_run_queue(
            &s.http_client,
            &s.center_url,
            &agent_id,
            &body,
        )
        .await
        {
            Ok((status, resp_body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(resp_body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn sequence_templates_list(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_sequence_templates(&s.http_client, &s.center_url).await {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn sequence_templates_create(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => {
            let mut center_body = body;
            center_body["agent_id"] = Value::String(agent_id);
            match crate::register::create_sequence_template(&s.http_client, &s.center_url, &center_body).await {
                Ok((status, resp_body)) => {
                    let axum_status =
                        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    (axum_status, Json(resp_body)).into_response()
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody { error: e }),
                )
                    .into_response(),
            }
        }
        Err(resp) => resp,
    }
}

async fn sequence_template_load_to_agent(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => match crate::register::load_sequence_template_to_agent(
            &s.http_client,
            &s.center_url,
            &id,
            &agent_id,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn agent_config_templates_list(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => {
            match crate::register::list_agent_config_templates(&s.http_client, &s.center_url).await {
                Ok((status, body)) => {
                    let axum_status =
                        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    (axum_status, Json(body)).into_response()
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody { error: e }),
                )
                    .into_response(),
            }
        }
        Err(resp) => resp,
    }
}

async fn agent_config_templates_create(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => {
            let mut center_body = body;
            center_body["agent_id"] = Value::String(agent_id);
            match crate::register::create_agent_config_template(
                &s.http_client,
                &s.center_url,
                &center_body,
            )
            .await
            {
                Ok((status, resp_body)) => {
                    let axum_status =
                        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    (axum_status, Json(resp_body)).into_response()
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody { error: e }),
                )
                    .into_response(),
            }
        }
        Err(resp) => resp,
    }
}

async fn agent_config_template_load_to_agent(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => match crate::register::load_agent_config_template_to_agent(
            &s.http_client,
            &s.center_url,
            &id,
            &agent_id,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn spec_templates_list(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_spec_templates(&s.http_client, &s.center_url).await {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn spec_templates_get(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::get_spec_template(&s.http_client, &s.center_url, &id).await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn spec_templates_create(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(agent_id) => {
            let mut center_body = body;
            center_body["created_by_agent_id"] = Value::String(agent_id);
            match crate::register::create_spec_template(&s.http_client, &s.center_url, &center_body)
                .await
            {
                Ok((status, resp_body)) => {
                    let axum_status =
                        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                    (axum_status, Json(resp_body)).into_response()
                }
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody { error: e }),
                )
                    .into_response(),
            }
        }
        Err(resp) => resp,
    }
}

async fn spec_templates_delete(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::delete_spec_template(&s.http_client, &s.center_url, &id).await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                if axum_status == StatusCode::NO_CONTENT {
                    axum_status.into_response()
                } else {
                    (axum_status, Json(body)).into_response()
                }
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct DelayRunRequest {
    delay_ms: Value,
}

#[derive(Deserialize)]
struct DelayRegisterRequest {
    name: String,
    delay_ms: u64,
}

fn resolve_delay_ms(raw: &Value, vars: &std::collections::HashMap<String, String>) -> Result<u64, String> {
    match raw {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_f64().map(|f| f as u64))
            .ok_or_else(|| "delay_ms must be a non-negative integer".into()),
        Value::String(s) => {
            let expanded = crate::expand::expand_str(s, vars).map_err(|e| e.to_string())?;
            expanded
                .trim()
                .parse::<u64>()
                .map_err(|_| format!("delay_ms is not a number after expand: {expanded}"))
        }
        _ => Err("delay_ms must be number or string".into()),
    }
}

async fn general_delay_run(
    State(s): State<AppState>,
    Json(req): Json<DelayRunRequest>,
) -> impl IntoResponse {
    let vars = load_settings_vars(&s).await;
    let delay_ms = match resolve_delay_ms(&req.delay_ms, &vars) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };
    let slot_gen = match s.slot.try_acquire("delay").await {
        Ok(g) => g,
        Err("busy") => {
            let snap = build_busy_snapshot(&s).await;
            return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
        }
        Err(_) => unreachable!(),
    };
    let result = crate::general::run_delay_ms(delay_ms).await;
    let _ = s.slot.release(slot_gen).await;
    (StatusCode::OK, Json(result)).into_response()
}

async fn general_delay_register(
    State(s): State<AppState>,
    Json(req): Json<DelayRegisterRequest>,
) -> impl IntoResponse {
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    }

    let agent_id = match crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    {
        Ok(id) => id,
        Err(e) if e == "agent not found on center" => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    let center_body = serde_json::json!({
        "agent_id": agent_id,
        "kind": crate::general::KIND_DELAY,
        "inputs": crate::general::delay_inputs(req.delay_ms),
        "outputs": crate::general::delay_outputs(),
        "name": req.name.trim(),
    });

    match crate::register::register_general_template(&s.http_client, &s.center_url, &center_body).await {
        Ok((status, body)) => {
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, Json(body)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

async fn general_delay_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_general_templates_by_kind(
            &s.http_client,
            &s.center_url,
            crate::general::KIND_DELAY,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct VersionRegisterRequest {
    name: String,
}

async fn general_version_run(State(s): State<AppState>) -> impl IntoResponse {
    let slot_gen = match s.slot.try_acquire("version").await {
        Ok(g) => g,
        Err("busy") => {
            let snap = build_busy_snapshot(&s).await;
            return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
        }
        Err(_) => unreachable!(),
    };
    let result = crate::general::run_read_version();
    let _ = s.slot.release(slot_gen).await;
    (StatusCode::OK, Json(result)).into_response()
}

async fn general_version_register(
    State(s): State<AppState>,
    Json(req): Json<VersionRegisterRequest>,
) -> impl IntoResponse {
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    }

    let agent_id = match crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    {
        Ok(id) => id,
        Err(e) if e == "agent not found on center" => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    let center_body = serde_json::json!({
        "agent_id": agent_id,
        "kind": crate::general::KIND_VERSION,
        "inputs": crate::general::version_inputs(),
        "outputs": crate::general::version_outputs(),
        "name": req.name.trim(),
    });

    match crate::register::register_general_template(&s.http_client, &s.center_url, &center_body)
        .await
    {
        Ok((status, body)) => {
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, Json(body)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

async fn general_version_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_general_templates_by_kind(
            &s.http_client,
            &s.center_url,
            crate::general::KIND_VERSION,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

async fn general_all_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_all_general_templates(
            &s.http_client,
            &s.center_url,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct RestRunRequest {
    method: Option<String>,
    url: String,
    headers: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    expect_status: Option<u16>,
}

#[derive(Deserialize)]
struct RestRegisterRequest {
    name: String,
    method: Option<String>,
    url: String,
    headers: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    expect_status: Option<u16>,
    /// Response body JSON from trial run (native API payload, not VI outputs array).
    #[serde(default)]
    outputs: Option<Value>,
}

fn rest_inputs_from_request(
    method: Option<&str>,
    url: &str,
    headers: Option<&str>,
    body: Option<&str>,
    timeout_ms: Option<u64>,
    expect_status: Option<u16>,
) -> Result<serde_json::Value, String> {
    let method = method.unwrap_or("POST");
    let headers = headers.unwrap_or("{}");
    let body = body.unwrap_or("");
    let timeout_ms = timeout_ms.unwrap_or(crate::rest::DEFAULT_TIMEOUT_MS);
    let expect_status = expect_status.unwrap_or(crate::rest::DEFAULT_EXPECT_STATUS);
    let inputs = crate::rest::rest_inputs(
        method,
        url,
        headers,
        body,
        timeout_ms,
        expect_status,
    );
    // Validate early so API returns 400 instead of failing mid-run.
    crate::rest::rest_request_from_inputs(&inputs)?;
    Ok(inputs)
}

async fn general_rest_run(
    State(s): State<AppState>,
    Json(req): Json<RestRunRequest>,
) -> impl IntoResponse {
    let inputs = match rest_inputs_from_request(
        req.method.as_deref(),
        &req.url,
        req.headers.as_deref(),
        req.body.as_deref(),
        req.timeout_ms,
        req.expect_status,
    ) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };
    let vars = load_settings_vars(&s).await;
    // Lenient: undefined ${Name} left as-is; MIME/URL paths no longer collide with vars.
    let inputs = match crate::expand::expand_json_value_mode(
        &inputs,
        &vars,
        crate::expand::ExpandMode::Lenient,
    ) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };

    let slot_gen = match s.slot.try_acquire("rest").await {
        Ok(g) => g,
        Err("busy") => {
            let snap = build_busy_snapshot(&s).await;
            return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
        }
        Err(_) => unreachable!(),
    };
    let result = crate::rest::run_request_from_inputs(&inputs).await;
    let _ = s.slot.release(slot_gen).await;
    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

async fn general_rest_register(
    State(s): State<AppState>,
    Json(req): Json<RestRegisterRequest>,
) -> impl IntoResponse {
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "name is required" })),
        )
            .into_response();
    }

    let inputs = match rest_inputs_from_request(
        req.method.as_deref(),
        &req.url,
        req.headers.as_deref(),
        req.body.as_deref(),
        req.timeout_ms,
        req.expect_status,
    ) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };

    let agent_id = match crate::register::resolve_agent_id(
        &s.http_client,
        &s.center_url,
        &s.hostname,
        &s.ip,
        s.port,
    )
    .await
    {
        Ok(id) => id,
        Err(e) if e == "agent not found on center" => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    let outputs = match req.outputs {
        Some(Value::Object(map)) => Value::Object(map),
        Some(Value::Null) | None => Value::Object(serde_json::Map::new()),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "outputs must be a JSON object (response body from trial run)"
                })),
            )
                .into_response();
        }
    };

    let center_body = serde_json::json!({
        "agent_id": agent_id,
        "kind": crate::rest::KIND_REST,
        "inputs": inputs,
        "outputs": outputs,
        "name": req.name.trim(),
    });

    match crate::register::register_general_template(&s.http_client, &s.center_url, &center_body)
        .await
    {
        Ok((status, body)) => {
            let axum_status =
                StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (axum_status, Json(body)).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

async fn general_rest_templates(State(s): State<AppState>) -> impl IntoResponse {
    match resolve_agent_id_for_proxy(&s).await {
        Ok(_) => match crate::register::list_general_templates_by_kind(
            &s.http_client,
            &s.center_url,
            crate::rest::KIND_REST,
        )
        .await
        {
            Ok((status, body)) => {
                let axum_status =
                    StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                (axum_status, Json(body)).into_response()
            }
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response(),
        },
        Err(resp) => resp,
    }
}

fn steps_log_json(
    items: &[crate::labview_sequence::QueueItemForRun],
    steps: &[crate::labview_sequence::SequenceStepResult],
) -> Vec<Value> {
    steps
        .iter()
        .map(|step| {
            let item = items.iter().find(|i| i.position == step.position);
            let is_general = item.is_some_and(|i| i.kind != "labview" && i.vi_path.is_empty());
            serde_json::json!({
                "position": step.position,
                "template_id": step.template_id,
                "template_source": if is_general { "general" } else { "labview" },
                "name": step.name,
                "kind": item.map(|i| i.kind.clone()).unwrap_or_default(),
                "ok": step.ok,
                "status": step.status,
                "elapsed_ms": step.elapsed_ms,
                "measured": step.measured,
                "limits": step.limits,
                "result": step.result,
                "error": step.error,
            })
        })
        .collect()
}

async fn log_multi_channel_run(
    s: &AppState,
    sequence_template_id: Option<i64>,
    items: &[crate::labview_sequence::QueueItemForRun],
    resp: &MultiChannelSequenceResponse,
) {
    let finished_at = chrono::Utc::now();
    let channels: Vec<Value> = resp
        .channels
        .iter()
        .map(|ch| {
            serde_json::json!({
                "channel_index": ch.channel_index,
                "channel_name": ch.channel_name,
                "overall": ch.response.overall,
                "stopped": ch.response.stopped,
                "failed_at": ch.response.failed_at,
                "elapsed_ms": ch.response.elapsed_ms,
                "sn": ch.response.sn,
                "steps": steps_log_json(items, &ch.response.steps),
            })
        })
        .collect();
    let payload = serde_json::json!({
        "sequence_template_id": sequence_template_id,
        "overall": resp.overall,
        "sn": resp.sn,
        "work_order": resp.work_order,
        "channels": channels,
        "finished_at": crate::logging::format_finished_at_local(finished_at),
        "hostname": s.hostname,
    });
    match crate::logging::write_sequence_run_log(
        &s.log_dir,
        &payload,
        finished_at,
        &resp.overall,
        resp.sn.as_deref(),
    ) {
        Ok(path) => {
            let rel = path
                .strip_prefix(&s.log_dir)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| path.display().to_string());
            tracing::info!(
                target: "sequence_run",
                overall = %resp.overall,
                path = %rel,
                "sequence run finished"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "sequence_run",
                error = %e,
                "failed to write sequence run log"
            );
        }
    }
}

async fn labview_run_sequence(
    State(s): State<AppState>,
    body: Option<Json<RunSequenceRequest>>,
) -> impl IntoResponse {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let sequence_template_id = req.sequence_template_id;
    let sn = normalize_run_sequence_opt(req.sn.clone());
    let work_order = normalize_run_sequence_opt(req.work_order.clone());
    let channel_indexes = req.channel_indexes.clone();

    if s.slot
        .owner()
        .await
        .as_deref()
        .is_some_and(|owner| owner != "sequence")
    {
        let snap = build_busy_snapshot(&s).await;
        return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
    }

    let base_vars = load_settings_vars(&s).await;

    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };

    let (status, queue_body) = match crate::register::get_vi_run_queue(
        &s.http_client,
        &s.center_url,
        &agent_id,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    if !status.is_success() {
        let axum_status =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return (axum_status, Json(queue_body)).into_response();
    }

    let items = match queue_items_for_run(&queue_body) {
        Ok(v) => v,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody { error: msg }),
            )
                .into_response();
        }
    };

    if items.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "run queue is empty".into(),
            }),
        )
            .into_response();
    }

    // Load enabled channels (empty table → synthetic CH0 inside orchestrator).
    // If channel_indexes was requested, load failure is hard (no silent CH0).
    let channels = match crate::register::get_agent_channels(
        &s.http_client,
        &s.center_url,
        &agent_id,
    )
    .await
    {
        Ok((ch_status, ch_body)) if ch_status.is_success() => {
            match channel_specs_from_list(
                &ch_body,
                channel_indexes.as_deref(),
            ) {
                Ok(v) => {
                    if channel_indexes.is_some() && v.is_empty() {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(ErrorBody {
                                error: "no enabled channels match channel_indexes".into(),
                            }),
                        )
                            .into_response();
                    }
                    v
                }
                Err(msg) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorBody { error: msg }),
                    )
                        .into_response();
                }
            }
        }
        Ok((ch_status, ch_body)) => {
            let reason = format!("status={ch_status} body={ch_body}");
            match channels_unavailable_fallback(channel_indexes.as_deref(), &reason) {
                Ok(v) => {
                    tracing::warn!(
                        status = %ch_status,
                        body = %ch_body,
                        "failed to load channels; falling back to synthetic CH0"
                    );
                    v
                }
                Err(msg) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        Json(ErrorBody { error: msg }),
                    )
                        .into_response();
                }
            }
        }
        Err(e) => match channels_unavailable_fallback(channel_indexes.as_deref(), &e) {
            Ok(v) => {
                tracing::warn!(error = %e, "failed to load channels; falling back to synthetic CH0");
                v
            }
            Err(msg) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorBody { error: msg }),
                )
                    .into_response();
            }
        },
    };

    let channels = if channels.is_empty() {
        vec![ChannelSpec {
            channel_index: 0,
            name: "CH0".into(),
            overlay: serde_json::json!({}),
        }]
    } else {
        channels
    };

    let admission = match admit_sequence_channels(&s, channels).await {
        Ok(admission) => admission,
        Err("busy") => {
            let snap = build_busy_snapshot(&s).await;
            return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
        }
        Err(_) => unreachable!(),
    };

    if admission.started.is_empty() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "requested channels are already running",
                "skipped_channel_indexes": admission.skipped_channel_indexes,
            })),
        )
            .into_response();
    }

    let skipped_channel_indexes = admission.skipped_channel_indexes;
    let request_sn = sn.clone();
    let request_work_order = work_order.clone();
    let mut workers = Vec::new();
    for admitted in admission.started {
        let AdmittedChannelRun {
            spec,
            generation,
            cancel,
            lease,
        } = admitted;
        let state = s.clone();
        let items = items.clone();
        let base_vars = base_vars.clone();
        let channel_index = spec.channel_index;
        let channel_name = spec.name.clone();
        let supervisor_channel_name = channel_name.clone();
        let sn = request_sn.clone();
        let work_order = request_work_order.clone();
        let handle = tokio::spawn(async move {
            // This supervisor outlives the HTTP request and always owns cleanup.
            let run_state = state.clone();
            let error_sn = sn.clone();
            let error_work_order = work_order.clone();
            let error_channel_name = supervisor_channel_name;
            let execution = tokio::spawn(async move {
                run_multi_channel(
                    &run_state.labview_cli,
                    &run_state.labview_getinfo,
                    ChannelRunRequest {
                        items,
                        base_vars,
                        channels: vec![spec],
                        resource_locks: run_state.resource_locks.clone(),
                        resource_timeout: std::time::Duration::from_secs(300),
                        sn,
                        work_order,
                        progress: run_state.sequence_progress.clone(),
                        cancel,
                        run_generation: generation,
                    },
                )
                .await
            });

            let response = match execution.await {
                Ok(response) => response,
                Err(join_error) => {
                    tracing::error!(
                        channel_index,
                        generation,
                        error = %join_error,
                        "sequence channel worker panicked"
                    );
                    state
                        .sequence_progress
                        .begin_channels(generation, &[(channel_index, error_channel_name.clone())])
                        .await;
                    state
                        .sequence_progress
                        .finish_channels(
                            generation,
                            &[(
                                channel_index,
                                error_channel_name.clone(),
                                Vec::new(),
                                "error".into(),
                            )],
                        )
                        .await;
                    MultiChannelSequenceResponse {
                        channels: vec![ChannelSequenceResponse {
                            channel_index,
                            channel_name: error_channel_name,
                            run_generation: generation,
                            response: SequenceResponse {
                                stopped: true,
                                failed_at: None,
                                steps: Vec::new(),
                                sn: error_sn,
                                work_order: error_work_order,
                                overall: "error".into(),
                                elapsed_ms: 0,
                            },
                        }],
                        skipped_channel_indexes: Vec::new(),
                        overall: "fail".into(),
                        sn: None,
                        work_order: None,
                    }
                }
            };

            lease.release().await;
            response
        });
        workers.push((channel_index, channel_name, generation, handle));
    }

    let mut channels = Vec::with_capacity(workers.len());
    for (channel_index, channel_name, generation, handle) in workers {
        match handle.await {
            Ok(response) => channels.extend(response.channels),
            Err(join_error) => {
                tracing::error!(
                    channel_index,
                    generation,
                    error = %join_error,
                    "sequence channel supervisor panicked"
                );
                s.sequence_progress
                    .begin_channels(generation, &[(channel_index, channel_name.clone())])
                    .await;
                s.sequence_progress
                    .finish_channels(
                        generation,
                        &[(
                            channel_index,
                            channel_name.clone(),
                            Vec::new(),
                            "error".into(),
                        )],
                    )
                    .await;
                channels.push(ChannelSequenceResponse {
                    channel_index,
                    channel_name,
                    run_generation: generation,
                    response: SequenceResponse {
                        stopped: true,
                        failed_at: None,
                        steps: Vec::new(),
                        sn: request_sn.clone(),
                        work_order: request_work_order.clone(),
                        overall: "error".into(),
                        elapsed_ms: 0,
                    },
                });
            }
        }
    }

    channels.sort_by_key(|channel| channel.channel_index);
    let overalls: Vec<&str> = channels
        .iter()
        .map(|channel| channel.response.overall.as_str())
        .collect();
    let overall = aggregate_overall(&overalls);
    let resp = MultiChannelSequenceResponse {
        channels,
        skipped_channel_indexes,
        overall,
        sn: request_sn,
        work_order: request_work_order,
    };

    log_multi_channel_run(&s, sequence_template_id, &items, &resp).await;
    (StatusCode::OK, Json(resp)).into_response()
}

async fn labview_run_sequence_progress(State(s): State<AppState>) -> impl IntoResponse {
    let snap = s.sequence_progress.snapshot().await;
    (StatusCode::OK, Json(snap))
}

async fn labview_run_sequence_continue_gone() -> impl IntoResponse {
    (
        StatusCode::GONE,
        Json(ErrorBody {
            error: "sequence breakpoints were removed".into(),
        }),
    )
}

async fn labview_run_sequence_channel_abort(
    State(s): State<AppState>,
    Path(channel_index): Path<usize>,
    Json(request): Json<AbortSequenceChannelRequest>,
) -> impl IntoResponse {
    #[cfg(test)]
    if let Some(barrier) = &s.sequence_lifecycle_test_hooks.abort_before_gate {
        barrier.wait().await;
    }
    let _lifecycle = s.sequence_lifecycle.lock().await;
    if s.sequence_cancel
        .signal_channel_if(channel_index, request.generation)
        .await
    {
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "aborting": channel_index,
                "generation": request.generation,
            })),
        )
            .into_response()
    } else {
        (
            StatusCode::CONFLICT,
            Json(ErrorBody {
                error: format!(
                    "channel {channel_index} generation {} is not running",
                    request.generation
                ),
            }),
        )
            .into_response()
    }
}

async fn labview_run_sequence_abort(State(s): State<AppState>) -> impl IntoResponse {
    #[cfg(test)]
    if let Some(barrier) = &s.sequence_lifecycle_test_hooks.abort_before_gate {
        barrier.wait().await;
    }
    let _lifecycle = s.sequence_lifecycle.lock().await;
    let aborting = s.sequence_cancel.signal_all().await;
    if aborting.is_empty() {
        (
            StatusCode::CONFLICT,
            Json(ErrorBody {
                error: "no active sequence session".into(),
            }),
        )
            .into_response()
    } else {
        (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "aborting": aborting })),
        )
            .into_response()
    }
}

async fn register_now(State(s): State<AppState>) -> impl IntoResponse {
    let body = RegisterAgentRequest {
        name: s.hostname.clone(),
        ip: s.ip.clone(),
        port: s.port,
    };
    match crate::register::register_with_center(&s.http_client, &s.center_url, &body).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            hostname: "test-host".into(),
            ip: "127.0.0.1".into(),
            port: 8080,
            started: Instant::now(),
            slot: TaskSlot::new(),
            metrics: Arc::new(RwLock::new(MetricsSnapshot::default())),
            center_url: "http://localhost:3000".into(),
            http_client: crate::register::http_client(),
            log_dir: std::env::temp_dir().join("atlas-agent-test-logs"),
            labview_cli: PathBuf::from(r"C:\labview-runner-cli\labview-runner-cli.exe"),
            labview_getinfo: PathBuf::from(r"C:\labview-runner-cli\getinfo.vi"),
            sequence_progress: SequenceProgressSlot::new(),
            resource_locks: ResourceLockManager::new(),
            sequence_cancel: SequenceCancelRegistry::new(),
            sequence_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            sequence_lifecycle_test_hooks: Arc::new(SequenceLifecycleTestHooks::default()),
        }
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    fn test_state_with_labview(cli: PathBuf, getinfo: PathBuf) -> AppState {
        AppState {
            labview_cli: cli,
            labview_getinfo: getinfo,
            ..test_state()
        }
    }

    async fn mount_sequence_run_center(mock_server: &wiremock::MockServer) {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "id": "agent-uuid-1",
                    "name": "test-host",
                    "ip": "127.0.0.1",
                    "port": 8080,
                    "status": "online",
                    "cpu_percent": 0.0,
                    "memory_percent": 0.0,
                    "busy": false,
                    "last_seen_at": null,
                    "created_at": "2026-01-01T00:00:00Z"
                }])),
            )
            .mount(mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "variables": [],
                "units": []
            })))
            .mount(mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/run-queue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "position": 0,
                    "id": "q-delay",
                    "vi_template_id": null,
                    "general_template_id": 88,
                    "name": "Delay",
                    "kind": "delay",
                    "vi_path": "",
                    "inputs": [{ "name": "delay_ms", "value": 0 }]
                }]
            })))
            .mount(mock_server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/channels"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "channels": [
                    { "channel_index": 0, "name": "CH0", "enabled": true, "overlay": {} },
                    { "channel_index": 1, "name": "CH1", "enabled": true, "overlay": {} }
                ]
            })))
            .mount(mock_server)
            .await;
    }

    #[tokio::test]
    async fn channel_abort_signals_only_the_requested_channel() {
        let state = test_state();
        let rx0 = state.sequence_cancel.install(0, 51).await.unwrap();
        let rx1 = state.sequence_cancel.install(1, 52).await.unwrap();
        let app = router(state);
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/channels/0/abort")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"generation":51}"#))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "ok": true, "aborting": 0, "generation": 51 })
        );
        assert!(*rx0.borrow());
        assert!(!*rx1.borrow());
    }

    #[tokio::test]
    async fn channel_abort_rejects_a_stale_generation_without_signalling_the_replacement() {
        let state = test_state();
        let replacement_rx = state.sequence_cancel.install(6, 52).await.unwrap();
        let app = router(state);
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/channels/6/abort")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"generation":51}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let error: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error.error, "channel 6 generation 51 is not running");
        assert!(!*replacement_rx.borrow());
    }

    #[tokio::test]
    async fn global_abort_signals_every_running_channel() {
        let state = test_state();
        let rx0 = state.sequence_cancel.install(0, 61).await.unwrap();
        let rx1 = state.sequence_cancel.install(1, 62).await.unwrap();
        let app = router(state);
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/abort")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, serde_json::json!({ "ok": true, "aborting": [0, 1] }));
        assert!(*rx0.borrow());
        assert!(*rx1.borrow());
    }

    #[tokio::test]
    async fn channel_abort_reports_when_channel_is_not_running() {
        let app = router(test_state());
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/channels/7/abort")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"generation":71}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let error: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error.error, "channel 7 generation 71 is not running");
    }

    #[tokio::test]
    async fn admission_starts_idle_channels_and_skips_only_duplicates() {
        let state = test_state();
        let existing = state.slot.try_acquire_sequence(0).await.unwrap();
        let mut admitted = admit_sequence_channels(
            &state,
            vec![
                ChannelSpec {
                    channel_index: 0,
                    name: "CH0".into(),
                    overlay: serde_json::json!({}),
                },
                ChannelSpec {
                    channel_index: 1,
                    name: "CH1".into(),
                    overlay: serde_json::json!({}),
                },
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            admitted
                .started
                .iter()
                .map(|run| run.spec.channel_index)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(admitted.skipped_channel_indexes, vec![0]);
        admitted.started.pop().unwrap().lease.release().await;
        assert!(state.slot.release_sequence(0, existing).await);
    }

    #[tokio::test]
    async fn admission_rejects_exclusive_delay_without_admitting_channels() {
        let state = test_state();
        let delay = state.slot.try_acquire("delay").await.unwrap();
        let result = admit_sequence_channels(
            &state,
            vec![ChannelSpec {
                channel_index: 0,
                name: "CH0".into(),
                overlay: serde_json::json!({}),
            }],
        )
        .await;
        assert!(matches!(result, Err("busy")));
        assert_eq!(state.slot.owner().await.as_deref(), Some("delay"));
        assert!(state.slot.release(delay).await);
        let channel = state.slot.try_acquire_sequence(0).await.unwrap();
        assert!(state.slot.release_sequence(0, channel).await);
    }

    #[tokio::test]
    async fn sequence_run_all_skipped_reports_requested_channel_indexes() {
        let mock_server = wiremock::MockServer::start().await;
        mount_sequence_run_center(&mock_server).await;
        let mut state = test_state();
        state.center_url = mock_server.uri();
        let existing = state.slot.try_acquire_sequence(0).await.unwrap();
        let app = router(state.clone());
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"channel_indexes":[0]}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "requested channels are already running");
        assert_eq!(body["skipped_channel_indexes"], serde_json::json!([0]));
        assert!(state.slot.release_sequence(0, existing).await);
    }

    #[tokio::test]
    async fn sequence_run_partial_admission_returns_only_started_channel_and_skipped_indexes() {
        let mock_server = wiremock::MockServer::start().await;
        mount_sequence_run_center(&mock_server).await;
        let mut state = test_state();
        state.center_url = mock_server.uri();
        let existing = state.slot.try_acquire_sequence(0).await.unwrap();
        let app = router(state.clone());
        let request = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"channel_indexes":[0,1]}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["skipped_channel_indexes"], serde_json::json!([0]));
        assert_eq!(body["channels"].as_array().unwrap().len(), 1);
        assert_eq!(body["channels"][0]["channel_index"], 1);
        assert!(body["channels"][0]["run_generation"].is_number());
        assert!(state.slot.release_sequence(0, existing).await);
    }

    #[tokio::test]
    async fn global_abort_waits_for_admission_install_then_signals_the_channel() {
        let admission_reached = Arc::new(tokio::sync::Barrier::new(2));
        let admission_resume = Arc::new(tokio::sync::Barrier::new(2));
        let abort_reached = Arc::new(tokio::sync::Barrier::new(2));
        let mut state = test_state();
        state.sequence_lifecycle_test_hooks = Arc::new(SequenceLifecycleTestHooks {
            admission_pause: Some(SequenceAdmissionPause {
                channel_index: 0,
                reached: admission_reached.clone(),
                resume: admission_resume.clone(),
            }),
            abort_before_gate: Some(abort_reached.clone()),
            ..Default::default()
        });

        let admission_state = state.clone();
        let admission_task = tokio::spawn(async move {
            admit_sequence_channels(
                &admission_state,
                vec![ChannelSpec {
                    channel_index: 0,
                    name: "CH0".into(),
                    overlay: serde_json::json!({}),
                }],
            )
            .await
        });
        admission_reached.wait().await;

        let app = router(state.clone());
        let abort_task = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri("/api/sequence/run/abort")
                .body(Body::empty())
                .unwrap();
            app.oneshot(request).await.unwrap()
        });
        abort_reached.wait().await;
        admission_resume.wait().await;

        let admitted = admission_task.await.unwrap().unwrap();
        let admitted_run = admitted.started.into_iter().next().unwrap();
        let cancel = admitted_run.cancel.clone();
        let response = abort_task.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body, serde_json::json!({ "ok": true, "aborting": [0] }));
        assert!(*cancel.borrow());

        admitted_run.lease.release().await;
    }

    #[tokio::test]
    async fn channel_abort_waits_for_admission_install_then_signals_only_that_channel() {
        let admission_reached = Arc::new(tokio::sync::Barrier::new(2));
        let admission_resume = Arc::new(tokio::sync::Barrier::new(2));
        let abort_reached = Arc::new(tokio::sync::Barrier::new(2));
        let mut state = test_state();
        state.sequence_lifecycle_test_hooks = Arc::new(SequenceLifecycleTestHooks {
            admission_pause: Some(SequenceAdmissionPause {
                channel_index: 0,
                reached: admission_reached.clone(),
                resume: admission_resume.clone(),
            }),
            abort_before_gate: Some(abort_reached.clone()),
            ..Default::default()
        });

        let rx1 = state.sequence_cancel.install(1, 500).await.unwrap();
        let admission_state = state.clone();
        let admission_task = tokio::spawn(async move {
            admit_sequence_channels(
                &admission_state,
                vec![ChannelSpec {
                    channel_index: 0,
                    name: "CH0".into(),
                    overlay: serde_json::json!({}),
                }],
            )
            .await
        });
        admission_reached.wait().await;
        let generation = state.slot.snapshot_holds().await[0].generation;

        let app = router(state.clone());
        let abort_task = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri("/api/sequence/run/channels/0/abort")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({ "generation": generation })).unwrap(),
                ))
                .unwrap();
            app.oneshot(request).await.unwrap()
        });
        abort_reached.wait().await;
        admission_resume.wait().await;

        let admitted = admission_task.await.unwrap().unwrap();
        let admitted_run = admitted.started.into_iter().next().unwrap();
        let cancel = admitted_run.cancel.clone();
        let response = abort_task.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(*cancel.borrow());
        assert!(!*rx1.borrow());

        admitted_run.lease.release().await;
        assert!(state.sequence_cancel.clear_if(1, 500).await);
    }

    #[tokio::test]
    async fn force_release_waits_for_admission_and_cleans_the_exact_live_hold() {
        let admission_reached = Arc::new(tokio::sync::Barrier::new(2));
        let admission_resume = Arc::new(tokio::sync::Barrier::new(2));
        let force_reached = Arc::new(tokio::sync::Barrier::new(2));
        let mut state = test_state();
        state.sequence_lifecycle_test_hooks = Arc::new(SequenceLifecycleTestHooks {
            admission_pause: Some(SequenceAdmissionPause {
                channel_index: 0,
                reached: admission_reached.clone(),
                resume: admission_resume.clone(),
            }),
            force_release_before_gate: Some(force_reached.clone()),
            ..Default::default()
        });

        let admission_state = state.clone();
        let admission_task = tokio::spawn(async move {
            admit_sequence_channels(
                &admission_state,
                vec![ChannelSpec {
                    channel_index: 0,
                    name: "CH0".into(),
                    overlay: serde_json::json!({}),
                }],
            )
            .await
        });
        admission_reached.wait().await;
        let hold = state.slot.snapshot_holds().await.remove(0);
        state
            .sequence_progress
            .begin_channels(hold.generation, &[(0, "CH0".into())])
            .await;

        let app = router(state.clone());
        let force_task = tokio::spawn(async move {
            let request = Request::builder()
                .method("POST")
                .uri("/api/slot/force-release")
                .body(Body::empty())
                .unwrap();
            app.oneshot(request).await.unwrap()
        });
        force_reached.wait().await;
        admission_resume.wait().await;

        let admitted = admission_task.await.unwrap().unwrap();
        let admitted_run = admitted.started.into_iter().next().unwrap();
        let cancel = admitted_run.cancel.clone();
        let response = force_task.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(*cancel.borrow());
        assert!(state.slot.snapshot_holds().await.is_empty());
        assert!(state.sequence_progress.snapshot().await.channels.is_empty());
        assert!(
            !state
                .sequence_cancel
                .signal_channel_if(0, admitted_run.generation)
                .await
        );
        admitted_run.lease.release().await;
    }

    #[tokio::test]
    async fn cancelled_request_during_multi_channel_admission_rolls_back_every_generation() {
        let admission_reached = Arc::new(tokio::sync::Barrier::new(2));
        let admission_resume = Arc::new(tokio::sync::Barrier::new(2));
        let rollback_complete = Arc::new(tokio::sync::Barrier::new(3));
        let mut state = test_state();
        state.sequence_lifecycle_test_hooks = Arc::new(SequenceLifecycleTestHooks {
            admission_pause: Some(SequenceAdmissionPause {
                channel_index: 1,
                reached: admission_reached.clone(),
                resume: admission_resume,
            }),
            rollback_complete: Some(rollback_complete.clone()),
            ..Default::default()
        });

        let admission_state = state.clone();
        let admission_task = tokio::spawn(async move {
            admit_sequence_channels(
                &admission_state,
                vec![
                    ChannelSpec {
                        channel_index: 0,
                        name: "CH0".into(),
                        overlay: serde_json::json!({}),
                    },
                    ChannelSpec {
                        channel_index: 1,
                        name: "CH1".into(),
                        overlay: serde_json::json!({}),
                    },
                ],
            )
            .await
        });
        admission_reached.wait().await;

        admission_task.abort();
        let join_result = admission_task.await;
        assert!(matches!(join_result, Err(error) if error.is_cancelled()));
        rollback_complete.wait().await;

        assert!(state.slot.snapshot_holds().await.is_empty());
        assert!(!state.sequence_cancel.signal_channel_if(0, 0).await);
        assert!(!state.sequence_cancel.signal_channel_if(1, 0).await);
    }

    #[tokio::test]
    async fn status_responds_within_150_ms() {
        let state = test_state();
        *state.metrics.write().await = MetricsSnapshot {
            cpu_percent: 12.5,
            memory_percent: 34.5,
        };
        let app = router(state);
        let started = Instant::now();
        let req = Request::builder()
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: AgentStatusResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.cpu_percent, 12.5);
        assert_eq!(body.memory_percent, 34.5);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(150),
            "status request took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn status_reports_busy_metadata_and_force_release() {
        let state = test_state();
        state.slot.try_acquire("delay").await.unwrap();
        let app = router(state.clone());

        let req = Request::builder()
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: AgentStatusResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(body.busy);
        assert_eq!(body.busy_reason.as_deref(), Some("delay"));
        assert!(body.busy_message.as_deref().unwrap_or("").contains("Delay"));
        assert_eq!(body.can_force_release, Some(true));
        assert_eq!(body.can_continue, Some(false));

        let req = Request::builder()
            .method("POST")
            .uri("/api/slot/force-release")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["released"], true);

        let req = Request::builder()
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: AgentStatusResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(!body.busy);
        assert!(body.busy_reason.is_none());
        assert_eq!(body.can_force_release, Some(false));
    }

    #[tokio::test]
    async fn labview_config_returns_paths() {
        let cli = PathBuf::from(r"C:\tools\cli.exe");
        let getinfo = PathBuf::from(r"C:\tools\getinfo.vi");
        let app = router(test_state_with_labview(cli.clone(), getinfo.clone()));

        let req = Request::builder()
            .uri("/api/labview/config")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: LabviewConfigResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.cli_path, cli.display().to_string());
        assert_eq!(body.getinfo_path, getinfo.display().to_string());
    }

    #[tokio::test]
    async fn labview_inspect_returns_cli_json() {
        let dir = tempfile::tempdir().unwrap();
        let vi = dir.path().join("Add.vi");
        std::fs::write(&vi, b"").unwrap();
        let getinfo = dir.path().join("getinfo.vi");
        std::fs::write(&getinfo, b"").unwrap();

        let app = router(test_state_with_labview(
            fixture_path("fake-labview-inspect.bat"),
            getinfo,
        ));

        let payload = serde_json::json!({ "vi_path": vi.display().to_string() });
        let req = Request::builder()
            .method("POST")
            .uri("/api/labview/inspect")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.get("action").and_then(|v| v.as_str()), Some("inspect"));
    }

    #[tokio::test]
    async fn labview_run_returns_cli_json() {
        let dir = tempfile::tempdir().unwrap();
        let vi = dir.path().join("Add.vi");
        std::fs::write(&vi, b"").unwrap();
        let getinfo = dir.path().join("getinfo.vi");
        std::fs::write(&getinfo, b"").unwrap();

        let app = router(test_state_with_labview(
            fixture_path("fake-labview-run.bat"),
            getinfo,
        ));

        let payload = serde_json::json!({
            "vi_path": vi.display().to_string(),
            "inputs": [{ "name": "a", "className": "Digital", "value": 1.0 }]
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/labview/run")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.get("action").and_then(|v| v.as_str()), Some("run"));
    }

    #[tokio::test]
    async fn labview_register_template_without_name_400() {
        let app = router(test_state());

        let payload = serde_json::json!({
            "vi_path": "C:\\x\\Add.vi",
            "inputs": []
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/labview/register-template")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body.get("error").and_then(|v| v.as_str()),
            Some("name is required")
        );

        let payload = serde_json::json!({
            "vi_path": "C:\\x\\Add.vi",
            "inputs": [],
            "name": "   "
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/labview/register-template")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body.get("error").and_then(|v| v.as_str()),
            Some("name is required")
        );
    }

    #[tokio::test]
    async fn labview_patch_template_proxies_to_center() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("PATCH"))
            .and(path("/api/vi-templates/tpl-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "tpl-1",
                "name": "Renamed",
                "agent_id": "agent-uuid-1",
                "vi_path": "C:\\x\\Add.vi",
                "cli_path": "C:\\tools\\cli.exe",
                "getinfo_path": "C:\\tools\\getinfo.vi",
                "inputs": [],
                "show_front_panel": false,
                "timeout_secs": null,
                "created_at": "2026-01-01T00:00:00Z"
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let payload = serde_json::json!({ "name": "Renamed" });
        let req = Request::builder()
            .method("PATCH")
            .uri("/api/labview/templates/tpl-1")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.get("id").and_then(|v| v.as_str()), Some("tpl-1"));
        assert_eq!(body.get("name").and_then(|v| v.as_str()), Some("Renamed"));
    }

    #[tokio::test]
    async fn labview_register_template_proxies_to_center() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("POST"))
            .and(path("/api/vi-templates"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": "tpl-1",
                "name": "Add",
                "agent_id": "agent-uuid-1",
                "vi_path": "C:\\x\\Add.vi",
                "cli_path": "C:\\tools\\cli.exe",
                "getinfo_path": "C:\\tools\\getinfo.vi",
                "inputs": [{ "name": "a", "className": "Digital", "value": 1.0 }],
                "show_front_panel": false,
                "timeout_secs": null,
                "created_at": "2026-01-01T00:00:00Z"
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        state.labview_cli = PathBuf::from(r"C:\tools\cli.exe");
        state.labview_getinfo = PathBuf::from(r"C:\tools\getinfo.vi");

        let app = router(state);

        let payload = serde_json::json!({
            "vi_path": "C:\\x\\Add.vi",
            "inputs": [{ "name": "a", "className": "Digital", "value": 1.0 }],
            "name": "Add"
        });
        let req = Request::builder()
            .method("POST")
            .uri("/api/labview/register-template")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.get("id").and_then(|v| v.as_str()), Some("tpl-1"));
        assert_eq!(
            body.get("agent_id").and_then(|v| v.as_str()),
            Some("agent-uuid-1")
        );
    }

    #[tokio::test]
    async fn labview_registered_templates_filters_via_center() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/vi-templates"))
            .and(query_param("agent_id", "agent-uuid-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "tpl-1",
                "name": "Add",
                "agent_id": "agent-uuid-1",
                "vi_path": "C:\\x\\Add.vi",
                "cli_path": "C:\\tools\\cli.exe",
                "getinfo_path": "C:\\tools\\getinfo.vi",
                "inputs": [{ "name": "a", "className": "Digital", "value": 1.0 }],
                "show_front_panel": false,
                "timeout_secs": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/api/labview/registered-templates")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let arr = body.as_array().expect("array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0].get("id").and_then(|v| v.as_str()), Some("tpl-1"));
        assert_eq!(arr[0].get("name").and_then(|v| v.as_str()), Some("Add"));
    }

    #[tokio::test]
    async fn labview_all_templates_proxies_center_list() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/vi-templates"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "id": "tpl-a",
                    "name": "A",
                    "origin_agent_id": "agent-uuid-1",
                    "origin_agent_name": "test-host",
                    "vi_path": "C:\\a.vi",
                    "cli_path": "C:\\cli.exe",
                    "getinfo_path": "C:\\getinfo.vi",
                    "inputs": [{ "name": "x", "className": "Digital", "value": 1.0 }],
                    "show_front_panel": false,
                    "timeout_secs": null,
                    "created_at": "2026-01-01T00:00:00Z"
                },
                {
                    "id": "tpl-b",
                    "name": "B",
                    "origin_agent_id": "agent-other",
                    "origin_agent_name": "other",
                    "vi_path": "C:\\b.vi",
                    "cli_path": "C:\\cli.exe",
                    "getinfo_path": "C:\\getinfo.vi",
                    "inputs": [],
                    "show_front_panel": false,
                    "timeout_secs": null,
                    "created_at": "2026-01-01T00:00:00Z"
                }
            ])))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/api/labview/all-templates")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let arr = body.as_array().expect("array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1].get("id").and_then(|v| v.as_str()), Some("tpl-b"));
    }


    #[tokio::test]
    async fn labview_run_queue_get_proxies_to_center() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/run-queue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "id": "q-1",
                    "vi_template_id": "tpl-1",
                    "position": 0,
                    "name": "Add",
                    "vi_path": "C:\\x\\Add.vi",
                    "inputs": [],
                    "show_front_panel": false,
                    "timeout_secs": null
                }]
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let req = Request::builder()
            .method("GET")
            .uri("/api/sequence/run-queue")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let items = body.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("name").and_then(|v| v.as_str()), Some("Add"));
    }

    #[tokio::test]
    async fn labview_run_sequence_empty_queue_400() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/run-queue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": []
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "run queue is empty");
    }

    #[tokio::test]
    async fn labview_run_sequence_optional_body_empty_queue_still_400() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/run-queue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": []
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state);

        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "sn": "  ",
                    "work_order": "WO-1"
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "run queue is empty");
    }

    #[tokio::test]
    async fn labview_run_sequence_conflict_when_busy() {
        let state = test_state();
        state.slot.try_acquire("delay").await.unwrap();
        let app = router(state);

        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent is busy");
        let rich: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rich["busy_reason"], "delay");
        assert_eq!(rich["can_force_release"], true);
    }

    #[tokio::test]
    async fn labview_run_sequence_continue_is_gone() {
        let app = router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/continue")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::GONE);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "sequence breakpoints were removed");
    }

    #[tokio::test]
    async fn labview_run_sequence_abort_without_session_409() {
        let app = router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/abort")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "no active sequence session");
    }

    #[tokio::test]
    async fn stale_run_teardown_does_not_clear_newer_cancel_or_slot() {
        let state = test_state();
        let gen_a = state.slot.try_acquire_sequence(0).await.unwrap();
        let rx_a = state.sequence_cancel.install(0, gen_a).await.unwrap();
        assert!(!*rx_a.borrow());

        // Force-release invalidates A's generation and cancels A only.
        let app = router(state.clone());
        let req = Request::builder()
            .method("POST")
            .uri("/api/slot/force-release")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(*rx_a.borrow(), "force-release must cancel generation A");
        assert!(!state.slot.is_busy().await);

        // Newer run B installs its own cancel + slot hold.
        let gen_b = state.slot.try_acquire_sequence(0).await.unwrap();
        assert_ne!(gen_a, gen_b);
        let rx_b = state.sequence_cancel.install(0, gen_b).await.unwrap();

        // Stale finish of A must not wipe B.
        assert!(!state.sequence_cancel.clear_if(0, gen_a).await);
        assert!(!state.slot.release_sequence(0, gen_a).await);
        assert!(state.slot.is_busy().await);
        assert!(!*rx_b.borrow());

        // B can still abort and tear down itself.
        assert!(state.sequence_cancel.signal_channel_if(0, gen_b).await);
        assert!(*rx_b.borrow());
        assert!(state.sequence_cancel.clear_if(0, gen_b).await);
        assert!(state.slot.release_sequence(0, gen_b).await);
    }

    #[tokio::test]
    async fn force_release_publishes_cancel_before_slot_free_and_scopes_progress() {
        let state = test_state();
        let gen_a = state.slot.try_acquire_sequence(0).await.unwrap();
        let rx_a = state.sequence_cancel.install(0, gen_a).await.unwrap();
        state
            .sequence_progress
            .begin_channels(gen_a, &[(0, "A".into())])
            .await;

        // Simulate the critical section of force-release without freeing the slot yet:
        // cancel + progress clear must happen while still busy.
        assert!(state.slot.is_busy().await);
        assert_eq!(state.sequence_cancel.signal_all().await, vec![0]);
        assert!(*rx_a.borrow(), "cancel must be visible before slot free");
        assert!(state.sequence_progress.clear_channel_if(0, gen_a).await);
        assert!(!state.sequence_progress.snapshot().await.running);

        // An exclusive run cannot acquire until all sequence holds are released.
        assert_eq!(state.slot.try_acquire("delay").await.unwrap_err(), "busy");
        assert!(state.sequence_cancel.clear_if(0, gen_a).await);
        assert_eq!(state.slot.force_release_all().await.len(), 1);

        // Newer run B's progress must survive a stale exact clear for A.
        let gen_b = state.slot.try_acquire_sequence(0).await.unwrap();
        state
            .sequence_progress
            .begin_channels(gen_b, &[(0, "B".into())])
            .await;
        assert!(!state.sequence_progress.clear_channel_if(0, gen_a).await);
        assert_eq!(state.sequence_progress.snapshot().await.channels[0].name, "B");

        // Full HTTP force-release path also cancels B and frees the slot.
        let rx_b = state.sequence_cancel.install(0, gen_b).await.unwrap();
        let app = router(state.clone());
        let req = Request::builder()
            .method("POST")
            .uri("/api/slot/force-release")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(*rx_b.borrow());
        assert!(!state.slot.is_busy().await);
        assert!(!state.sequence_progress.snapshot().await.running);
    }

    #[tokio::test]
    async fn run_with_channel_indexes_errors_when_channels_unavailable() {
        let mock_server = wiremock::MockServer::start().await;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        Mock::given(method("GET"))
            .and(path("/api/agents"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                "id": "agent-uuid-1",
                "name": "test-host",
                "ip": "127.0.0.1",
                "port": 8080,
                "status": "online",
                "cpu_percent": 0.0,
                "memory_percent": 0.0,
                "busy": false,
                "last_seen_at": null,
                "created_at": "2026-01-01T00:00:00Z"
            }])))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/run-queue"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [{
                    "id": "q0",
                    "vi_template_id": "t0",
                    "position": 0,
                    "name": "step",
                    "vi_path": "C:\\x\\Add.vi",
                    "inputs": [],
                    "show_front_panel": false,
                    "timeout_secs": null
                }]
            })))
            .mount(&mock_server)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/channels"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": "boom"
            })))
            .mount(&mock_server)
            .await;

        // Settings fetch used by load_settings_vars — return empty.
        Mock::given(method("GET"))
            .and(path("/api/agents/agent-uuid-1/settings"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "variables": [],
                "units": []
            })))
            .mount(&mock_server)
            .await;

        let mut state = test_state();
        state.center_url = mock_server.uri();
        let app = router(state.clone());

        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "channel_indexes": [0]
                }))
                .unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert!(
            err.error.contains("channel_indexes"),
            "unexpected error: {}",
            err.error
        );
        assert!(
            !state.slot.is_busy().await,
            "slot must be released after hard-fail"
        );
    }
}
