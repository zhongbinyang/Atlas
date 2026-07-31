use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::{get, patch, post},
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
use crate::labview_sequence::{
    queue_items_for_run, run_sequence, SequencePause, SequenceResponse, SequenceRunOpts,
};
use crate::metrics::MetricsSnapshot;
use crate::sequence_session::{
    SequenceProgressSlot, SequenceSession, SequenceSessionSlot,
};
use crate::task_slot::TaskSlot;
use serde_json::Value;

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
    pub sequence_session: Arc<SequenceSessionSlot>,
    pub sequence_progress: Arc<SequenceProgressSlot>,
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
        .route("/api/sequence/run", post(labview_run_sequence))
        .route(
            "/api/sequence/run/progress",
            get(labview_run_sequence_progress),
        )
        .route(
            "/api/sequence/run/continue",
            post(labview_run_sequence_continue),
        )
        .route(
            "/api/sequence/run/abort",
            post(labview_run_sequence_abort),
        )
        .route("/api/settings", get(agent_settings_get).put(agent_settings_put))
        .route("/api/general/delay/run", post(general_delay_run))
        .route(
            "/api/general/delay/register-template",
            post(general_delay_register),
        )
        .route("/api/general/delay/templates", get(general_delay_templates))
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
    let session = s.sequence_session.get().await;

    if let Some(session) = session {
        let step = session.items.get(session.next_index);
        let step_name = step.map(|i| i.name.clone());
        let before_position = step.map(|i| i.position).unwrap_or(session.next_index);
        let message = match step_name.as_deref() {
            Some(name) if !name.is_empty() => {
                format!("序列在断点处暂停（步骤 #{before_position}: {name}）")
            }
            _ => format!("序列在断点处暂停（步骤 #{before_position}）"),
        };
        return BusySnapshot {
            busy: true,
            busy_reason: Some("sequence_paused".into()),
            busy_message: Some(message),
            can_continue: true,
            can_abort: true,
            can_force_release: true,
            pause_before_position: Some(before_position),
            pause_step_name: step_name,
        };
    }

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
    BusySnapshot {
        busy: true,
        busy_reason: Some(reason),
        busy_message: Some(message),
        can_continue: false,
        can_abort: false,
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
    })
}

async fn slot_force_release(State(s): State<AppState>) -> impl IntoResponse {
    let was_busy = s.slot.is_busy().await || s.sequence_session.get().await.is_some();
    s.sequence_session.clear().await;
    s.sequence_progress.clear().await;
    s.slot.release().await;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "released": was_busy,
            "message": if was_busy { "已强制释放占用" } else { "当前已空闲" },
        })),
    )
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
    if let Err("busy") = s.slot.try_acquire("delay").await {
        let snap = build_busy_snapshot(&s).await;
        return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
    }
    let result = crate::general::run_delay_ms(delay_ms).await;
    s.slot.release().await;
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

    if let Err("busy") = s.slot.try_acquire("rest").await {
        let snap = build_busy_snapshot(&s).await;
        return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
    }
    let result = crate::rest::run_request_from_inputs(&inputs).await;
    s.slot.release().await;
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

fn pause_index(
    items: &[crate::labview_sequence::QueueItemForRun],
    pause: &SequencePause,
) -> Result<usize, String> {
    items
        .iter()
        .position(|i| i.position == pause.before_position)
        .ok_or_else(|| {
            format!(
                "pause position {} not found in run queue",
                pause.before_position
            )
        })
}

async fn log_sequence_run(
    s: &AppState,
    sequence_template_id: Option<i64>,
    items: &[crate::labview_sequence::QueueItemForRun],
    resp: &SequenceResponse,
) {
    let finished_at = chrono::Utc::now();
    let steps: Vec<Value> = resp
        .steps
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
                "measured": step.measured,
                "limits": step.limits,
                "result": step.result,
                "error": step.error,
            })
        })
        .collect();
    let mut payload = serde_json::json!({
        "sequence_template_id": sequence_template_id,
        "overall": resp.overall,
        "stopped": resp.stopped,
        "failed_at": resp.failed_at,
        "sn": resp.sn,
        "work_order": resp.work_order,
        "steps": steps,
        "finished_at": crate::logging::format_finished_at_local(finished_at),
        "hostname": s.hostname,
    });
    if let Some(pause) = &resp.pause {
        payload["pause"] = serde_json::json!({
            "before_position": pause.before_position,
            "message": pause.message,
        });
    }
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
    let sequence_template_id = body
        .as_ref()
        .and_then(|Json(req)| req.sequence_template_id);
    let mut run_opts = body
        .map(|Json(req)| SequenceRunOpts {
            sn: normalize_run_sequence_opt(req.sn.clone()),
            work_order: normalize_run_sequence_opt(req.work_order.clone()),
            vars: Default::default(),
            progress: None,
        })
        .unwrap_or_default();
    run_opts.vars = load_settings_vars(&s).await;

    if let Err("busy") = s.slot.try_acquire("sequence").await {
        let snap = build_busy_snapshot(&s).await;
        return (StatusCode::CONFLICT, Json(busy_conflict_json(&snap))).into_response();
    }

    let agent_id = match resolve_agent_id_for_proxy(&s).await {
        Ok(id) => id,
        Err(resp) => {
            s.slot.release().await;
            return resp;
        }
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
            s.slot.release().await;
            return (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };

    if !status.is_success() {
        s.slot.release().await;
        let axum_status =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return (axum_status, Json(queue_body)).into_response();
    }

    let items = match queue_items_for_run(&queue_body) {
        Ok(v) => v,
        Err(msg) => {
            s.slot.release().await;
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody { error: msg }),
            )
                .into_response();
        }
    };

    if items.is_empty() {
        s.slot.release().await;
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "run queue is empty".into(),
            }),
        )
            .into_response();
    }

    s.sequence_progress.begin().await;
    run_opts.progress = Some(s.sequence_progress.clone());

    let resp = run_sequence(
        &s.labview_cli,
        &s.labview_getinfo,
        &items,
        0,
        run_opts,
        Vec::new(),
        false,
    )
    .await;

    if let Some(ref pause) = resp.pause {
        let next_index = match pause_index(&items, pause) {
            Ok(idx) => idx,
            Err(msg) => {
                s.sequence_session.clear().await;
                s.sequence_progress.clear().await;
                s.slot.release().await;
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorBody { error: msg }),
                )
                    .into_response();
            }
        };
        s.sequence_session
            .set(SequenceSession {
                items,
                next_index,
                steps_so_far: resp.steps.clone(),
                sn: resp.sn.clone(),
                work_order: resp.work_order.clone(),
                sequence_template_id,
                abort: false,
            })
            .await;
        return (StatusCode::OK, Json(resp)).into_response();
    }

    s.sequence_session.clear().await;
    s.slot.release().await;
    log_sequence_run(&s, sequence_template_id, &items, &resp).await;
    (StatusCode::OK, Json(resp)).into_response()
}

async fn labview_run_sequence_progress(State(s): State<AppState>) -> impl IntoResponse {
    let snap = s.sequence_progress.snapshot().await;
    (StatusCode::OK, Json(snap))
}

async fn labview_run_sequence_continue(State(s): State<AppState>) -> impl IntoResponse {
    let session = match s.sequence_session.take().await {
        Some(v) => v,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "no active sequence session".into(),
                }),
            )
                .into_response();
        }
    };

    s.sequence_progress
        .begin_from(session.steps_so_far.clone())
        .await;

    let resp = run_sequence(
        &s.labview_cli,
        &s.labview_getinfo,
        &session.items,
        session.next_index,
        SequenceRunOpts {
            sn: session.sn.clone(),
            work_order: session.work_order.clone(),
            vars: load_settings_vars(&s).await,
            progress: Some(s.sequence_progress.clone()),
        },
        session.steps_so_far,
        true,
    )
    .await;

    if let Some(ref pause) = resp.pause {
        let next_index = match pause_index(&session.items, pause) {
            Ok(idx) => idx,
            Err(msg) => {
                s.sequence_session.clear().await;
                s.sequence_progress.clear().await;
                s.slot.release().await;
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorBody { error: msg }),
                )
                    .into_response();
            }
        };
        s.sequence_session
            .set(SequenceSession {
                items: session.items,
                next_index,
                steps_so_far: resp.steps.clone(),
                sn: resp.sn.clone(),
                work_order: resp.work_order.clone(),
                sequence_template_id: session.sequence_template_id,
                abort: false,
            })
            .await;
        return (StatusCode::OK, Json(resp)).into_response();
    }

    s.sequence_session.clear().await;
    s.slot.release().await;
    log_sequence_run(&s, session.sequence_template_id, &session.items, &resp).await;
    (StatusCode::OK, Json(resp)).into_response()
}

async fn labview_run_sequence_abort(State(s): State<AppState>) -> impl IntoResponse {
    let session = match s.sequence_session.take().await {
        Some(v) => v,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "no active sequence session".into(),
                }),
            )
                .into_response();
        }
    };

    s.sequence_session.clear().await;
    s.sequence_progress
        .finish(session.steps_so_far.clone())
        .await;
    s.slot.release().await;

    let resp = SequenceResponse {
        overall: "aborted".into(),
        stopped: true,
        failed_at: None,
        steps: session.steps_so_far,
        sn: session.sn,
        work_order: session.work_order,
        pause: None,
    };
    log_sequence_run(&s, session.sequence_template_id, &session.items, &resp).await;
    (StatusCode::OK, Json(resp)).into_response()
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
            sequence_session: SequenceSessionSlot::new(),
            sequence_progress: SequenceProgressSlot::new(),
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
    async fn status_reports_sequence_paused_session() {
        let state = test_state();
        state
            .sequence_session
            .set(SequenceSession {
                items: vec![crate::labview_sequence::QueueItemForRun {
                    position: 2,
                    queue_item_id: "q1".into(),
                    template_id: "t1".into(),
                    name: "BP Step".into(),
                    kind: "vi".into(),
                    vi_path: r"C:\x.vi".into(),
                    inputs: serde_json::json!({}),
                    show_front_panel: false,
                    timeout_secs: None,
                    enabled: true,
                    breakpoint: true,
                    fail_policy: "stop".into(),
                    limits: vec![],
                }],
                next_index: 0,
                steps_so_far: vec![],
                sn: None,
                work_order: None,
                sequence_template_id: None,
                abort: false,
            })
            .await;
        let app = router(state);

        let req = Request::builder()
            .uri("/api/status")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: AgentStatusResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(body.busy);
        assert_eq!(body.busy_reason.as_deref(), Some("sequence_paused"));
        assert_eq!(body.can_continue, Some(true));
        assert_eq!(body.can_abort, Some(true));
        assert_eq!(body.pause_before_position, Some(2));
        assert_eq!(body.pause_step_name.as_deref(), Some("BP Step"));
        assert!(body
            .busy_message
            .as_deref()
            .unwrap_or("")
            .contains("BP Step"));
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
    async fn labview_run_sequence_continue_without_session_409() {
        let app = router(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/sequence/run/continue")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "no active sequence session");
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
}
