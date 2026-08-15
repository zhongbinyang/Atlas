use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use crate::dto::RegisterAgentRequest;
use crate::error::ErrorBody;
use crate::spec_ini::{parse_spec_ini, spec_document_to_json};
use serde::{Deserialize, Serialize};

use crate::store::{
    parse_resources_json, parse_spec_metrics_json, Agent, AgentConfigSnapshot,
    AgentConfigTemplateEnriched,
    GeneralTemplateEnriched, QueueReplaceError, SequenceTemplateEnriched, SequenceTemplateStep,
    SpecTemplateSummary, Store, ViRunQueueItem, ViRunQueueReplaceItem, ViTemplateEnriched,
    ViTemplatePatch,
};
use crate::test_runs::{
    NewTestRun, NewTestRunContext, NewTestRunStep, TestRunContext, TestRunDetail, TestRunListItem,
    TestRunListQuery, TestRunStep,
};

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub status: String,
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub busy: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

impl From<Agent> for AgentView {
    fn from(a: Agent) -> Self {
        Self {
            id: a.id,
            name: a.name,
            ip: a.ip,
            port: a.port,
            status: a.status,
            cpu_percent: a.cpu_percent,
            memory_percent: a.memory_percent,
            busy: a.busy,
            last_seen_at: a.last_seen_at,
            created_at: a.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViTemplateView {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub origin_agent_id: String,
    pub origin_agent_name: String,
    pub vi_path: String,
    pub cli_path: String,
    pub getinfo_path: String,
    pub inputs: serde_json::Value,
    pub outputs: serde_json::Value,
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralTemplateView {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub origin_agent_id: String,
    pub origin_agent_name: String,
    pub inputs: serde_json::Value,
    pub outputs: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceTemplateStepView {
    pub position: i64,
    pub template_source: String,
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub inputs: serde_json::Value,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits: serde_json::Value,
    pub note: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceTemplateListItemView {
    pub id: i64,
    pub name: String,
    pub note: String,
    pub created_by_agent_id: String,
    pub created_by_agent_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub step_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceTemplateDetailView {
    pub id: i64,
    pub name: String,
    pub note: String,
    pub created_by_agent_id: String,
    pub created_by_agent_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub step_count: i64,
    pub steps: Vec<SequenceTemplateStepView>,
}

fn agent_display_name(name: Option<String>) -> String {
    name.filter(|n| !n.is_empty())
        .unwrap_or_else(|| "未知".into())
}

fn parse_json_text(raw: &str, label: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(raw).map_err(|err| format!("invalid {label}: {err}"))
}

impl TryFrom<ViTemplateEnriched> for ViTemplateView {
    type Error = String;

    fn try_from(e: ViTemplateEnriched) -> Result<Self, Self::Error> {
        let inputs: serde_json::Value = serde_json::from_str(&e.template.inputs_json)
            .map_err(|err| format!("invalid inputs_json: {err}"))?;
        let outputs: serde_json::Value = serde_json::from_str(&e.template.outputs_json)
            .map_err(|err| format!("invalid outputs_json: {err}"))?;
        Ok(Self {
            id: e.template.id,
            name: e.template.name,
            kind: e.template.kind,
            origin_agent_id: e.template.origin_agent_id,
            origin_agent_name: agent_display_name(e.origin_agent_name),
            vi_path: e.template.vi_path,
            cli_path: e.template.cli_path,
            getinfo_path: e.template.getinfo_path,
            inputs,
            outputs,
            show_front_panel: e.template.show_front_panel,
            timeout_secs: e.template.timeout_secs,
            created_at: e.template.created_at,
        })
    }
}

impl TryFrom<GeneralTemplateEnriched> for GeneralTemplateView {
    type Error = String;

    fn try_from(e: GeneralTemplateEnriched) -> Result<Self, Self::Error> {
        let inputs: serde_json::Value = serde_json::from_str(&e.template.inputs_json)
            .map_err(|err| format!("invalid inputs_json: {err}"))?;
        let outputs: serde_json::Value = serde_json::from_str(&e.template.outputs_json)
            .map_err(|err| format!("invalid outputs_json: {err}"))?;
        Ok(Self {
            id: e.template.id,
            name: e.template.name,
            kind: e.template.kind,
            origin_agent_id: e.template.origin_agent_id,
            origin_agent_name: agent_display_name(e.origin_agent_name),
            inputs,
            outputs,
            created_at: e.template.created_at,
        })
    }
}

fn sequence_template_step_view(step: SequenceTemplateStep) -> Result<SequenceTemplateStepView, String> {
    let name = if step.template_source == "group" {
        if step.title.trim().is_empty() {
            "分组".to_string()
        } else {
            step.title.clone()
        }
    } else {
        String::new()
    };
    Ok(SequenceTemplateStepView {
        position: step.position,
        template_source: step.template_source,
        vi_template_id: step.vi_template_id,
        general_template_id: step.general_template_id,
        inputs: parse_json_text(&step.inputs_json, "inputs_json")?,
        enabled: step.enabled,
        breakpoint: false, // breakpoints removed; field kept for wire compat
        fail_policy: step.fail_policy,
        limits: parse_json_text(&step.limits_json, "limits_json")?,
        note: step.note,
        name,
        collapsed: step.collapsed,
        resources: parse_resources_json(&step.resources_json)?,
    })
}

fn sequence_template_list_item_view(t: SequenceTemplateEnriched) -> SequenceTemplateListItemView {
    SequenceTemplateListItemView {
        id: t.template.id,
        name: t.template.name,
        note: t.template.note,
        created_by_agent_id: t.template.created_by_agent_id,
        created_by_agent_name: agent_display_name(t.created_by_agent_name),
        created_at: t.template.created_at,
        updated_at: t.template.updated_at,
        step_count: t.step_count,
    }
}

#[derive(Debug, Deserialize)]
pub struct ListViTemplatesQuery {
    pub agent_id: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListGeneralTemplatesQuery {
    pub agent_id: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSequenceTemplateRequest {
    pub agent_id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct LoadSequenceTemplateToAgentRequest {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigSummaryView {
    pub agent_id: String,
    pub agent_name: String,
    pub agent_status: String,
    pub agent_ip: String,
    pub variable_count: usize,
    pub device_profile_count: usize,
    pub calibration_profile_count: usize,
    pub active_device_name: Option<String>,
    pub active_calibration_name: Option<String>,
    pub channel_count: usize,
    pub array_expand_mode: crate::agent_settings::ArrayExpandMode,
    pub settings_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigTemplateListItemView {
    pub id: i64,
    pub name: String,
    pub note: String,
    pub source_agent_id: Option<String>,
    pub source_agent_name: String,
    pub created_by_agent_id: String,
    pub created_by_agent_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigTemplateDetailView {
    pub id: i64,
    pub name: String,
    pub note: String,
    pub source_agent_id: Option<String>,
    pub source_agent_name: String,
    pub created_by_agent_id: String,
    pub created_by_agent_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub config: AgentConfigSnapshot,
}

#[derive(Debug, Deserialize)]
pub struct CreateAgentConfigTemplateRequest {
    pub agent_id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Deserialize)]
pub struct LoadAgentConfigTemplateToAgentRequest {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecTemplateListItemView {
    pub id: i64,
    pub name: String,
    pub product_pn: String,
    pub source_filename: String,
    pub section_count: i64,
    pub created_by_agent_name: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecTemplateDetailView {
    pub id: i64,
    pub name: String,
    pub product_pn: String,
    pub note: String,
    pub source_filename: String,
    pub spec: serde_json::Value,
    pub section_count: i64,
    pub created_by_agent_id: Option<String>,
    pub created_by_agent_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSpecTemplateRequest {
    pub ini_text: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub product_pn: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub source_filename: String,
    pub created_by_agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CloneAgentConfigRequest {
    pub source_agent_id: String,
    pub target_agent_id: String,
}

#[derive(Debug, Deserialize)]
pub struct DistributeViTemplateRequest {
    pub target_agent_id: String,
    pub vi_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchViTemplateRequest {
    pub name: Option<String>,
    pub inputs: Option<serde_json::Value>,
    pub show_front_panel: Option<bool>,
    pub timeout_secs: Option<Option<i64>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateViTemplateRequest {
    pub agent_id: String,
    #[serde(default = "default_vi_kind")]
    pub kind: String,
    pub vi_path: String,
    pub cli_path: String,
    pub getinfo_path: String,
    pub inputs: serde_json::Value,
    #[serde(default = "default_empty_array")]
    pub outputs: serde_json::Value,
    pub name: String,
    #[serde(default)]
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateGeneralTemplateRequest {
    pub agent_id: String,
    #[serde(default = "default_general_kind")]
    pub kind: String,
    pub inputs: serde_json::Value,
    #[serde(default = "default_empty_array")]
    pub outputs: serde_json::Value,
    pub name: String,
}

fn default_vi_kind() -> String {
    "labview".into()
}

fn default_general_kind() -> String {
    "delay".into()
}

fn default_true() -> bool {
    true
}

fn default_fail_stop() -> String {
    "stop".into()
}

fn default_queue_template_source() -> String {
    "labview".into()
}

fn default_empty_array() -> serde_json::Value {
    serde_json::json!([])
}

fn default_empty_string_array() -> Vec<String> {
    Vec::new()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViRunQueueItemView {
    pub id: String,
    pub template_source: String,
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub position: i64,
    pub name: String,
    pub kind: String,
    pub vi_path: String,
    pub inputs: serde_json::Value,
    pub outputs: serde_json::Value,
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String,
    pub limits: serde_json::Value,
    pub note: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub resources: Vec<String>,
    pub spec_template_id: Option<i64>,
    #[serde(default)]
    pub spec_section: String,
    #[serde(default = "default_empty_string_array")]
    pub spec_metrics: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ViRunQueueListResponse {
    pub items: Vec<ViRunQueueItemView>,
}

#[derive(Debug, Deserialize)]
pub struct ReplaceViRunQueueRequest {
    pub items: Vec<ReplaceViRunQueueItem>,
}

#[derive(Debug, Deserialize)]
pub struct ReplaceViRunQueueItem {
    #[serde(default = "default_queue_template_source")]
    pub template_source: String,
    pub vi_template_id: Option<i64>,
    pub general_template_id: Option<i64>,
    pub inputs: Option<serde_json::Value>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub breakpoint: bool,
    #[serde(default = "default_fail_stop")]
    pub fail_policy: String,
    #[serde(default = "default_empty_array")]
    pub limits: serde_json::Value,
    #[serde(default)]
    pub note: String,
    /// Group title (`template_source=group`); ignored for steps.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub resources: Vec<String>,
    pub spec_template_id: Option<i64>,
    #[serde(default)]
    pub spec_section: String,
    #[serde(default = "default_empty_string_array")]
    pub spec_metrics: Vec<String>,
}

fn vi_run_queue_item_view(item: ViRunQueueItem) -> Result<ViRunQueueItemView, String> {
    let inputs: serde_json::Value = serde_json::from_str(&item.inputs_json)
        .map_err(|err| format!("invalid inputs_json: {err}"))?;
    let outputs: serde_json::Value = serde_json::from_str(&item.outputs_json)
        .map_err(|err| format!("invalid outputs_json: {err}"))?;
    let limits: serde_json::Value = serde_json::from_str(&item.limits_json)
        .map_err(|err| format!("invalid limits_json: {err}"))?;
    let spec_metrics = parse_spec_metrics_json(&item.spec_metrics_json)?;
    Ok(ViRunQueueItemView {
        id: item.id,
        template_source: item.template_source,
        vi_template_id: item.vi_template_id,
        general_template_id: item.general_template_id,
        position: item.position,
        name: item.template_name,
        kind: item.kind,
        vi_path: item.vi_path,
        inputs,
        outputs,
        show_front_panel: item.show_front_panel,
        timeout_secs: item.timeout_secs,
        enabled: item.enabled,
        breakpoint: false, // breakpoints removed; field kept for wire compat
        fail_policy: item.fail_policy,
        limits,
        note: item.note,
        collapsed: item.collapsed,
        resources: parse_resources_json(&item.resources_json)?,
        spec_template_id: item.spec_template_id,
        spec_section: item.spec_section,
        spec_metrics,
    })
}

fn vi_run_queue_views(items: Vec<ViRunQueueItem>) -> Result<Vec<ViRunQueueItemView>, String> {
    items.into_iter().map(vi_run_queue_item_view).collect()
}

fn queue_replace_error_response(err: QueueReplaceError) -> (StatusCode, Json<ErrorBody>) {
    match err {
        QueueReplaceError::AgentNotFound => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        ),
        QueueReplaceError::BadTemplate {
            template_source,
            template_id,
        } => (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: format!("{template_source} template not found: {template_id}"),
            }),
        ),
        QueueReplaceError::InvalidSpecSection {
            spec_template_id,
            spec_section,
            message,
        } => (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: if spec_section.is_empty() {
                    format!("invalid spec binding for template {spec_template_id}: {message}")
                } else {
                    format!(
                        "invalid spec section {spec_section:?} for template {spec_template_id}: {message}"
                    )
                },
            }),
        ),
        QueueReplaceError::Db(e) => {
            tracing::error!("vi run queue db error: {e}");
            db_error()
        }
    }
}

fn db_error() -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: "database error".into(),
        }),
    )
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/agents/register", post(register_agent))
        .route("/api/agents", get(list_agents))
        .route("/api/agents/{id}", get(get_agent))
        .route(
            "/api/vi-templates",
            get(list_vi_templates).post(create_vi_template),
        )
        .route(
            "/api/vi-templates/{id}",
            get(get_vi_template)
                .patch(patch_vi_template)
                .delete(delete_vi_template),
        )
        .route(
            "/api/general-templates",
            get(list_general_templates).post(create_general_template),
        )
        .route(
            "/api/general-templates/{id}",
            get(get_general_template).delete(delete_general_template),
        )
        .route(
            "/api/sequence-templates",
            get(list_sequence_templates).post(create_sequence_template),
        )
        .route(
            "/api/sequence-templates/{id}",
            get(get_sequence_template).delete(delete_sequence_template),
        )
        .route(
            "/api/sequence-templates/{id}/load-to-agent",
            post(load_sequence_template_to_agent),
        )
        .route("/api/agent-configs", get(list_agent_config_summaries))
        .route(
            "/api/agent-config-templates",
            get(list_agent_config_templates).post(create_agent_config_template),
        )
        .route(
            "/api/agent-config-templates/{id}",
            get(get_agent_config_template).delete(delete_agent_config_template),
        )
        .route(
            "/api/agent-config-templates/{id}/load-to-agent",
            post(load_agent_config_template_to_agent),
        )
        .route(
            "/api/spec-templates",
            get(list_spec_templates).post(create_spec_template),
        )
        .route(
            "/api/spec-templates/{id}",
            get(get_spec_template).delete(delete_spec_template),
        )
        .route("/api/agent-configs/clone", post(clone_agent_config))
        .route(
            "/api/agents/{id}/run-queue",
            get(get_vi_run_queue).put(put_vi_run_queue),
        )
        .route(
            "/api/agents/{id}/settings",
            get(get_agent_settings).put(put_agent_settings),
        )
        .route("/api/units", get(get_center_units).put(put_center_units))
        .route(
            "/api/agents/{id}/device-profiles",
            get(list_device_profiles).post(create_device_profile),
        )
        .route(
            "/api/agents/{id}/device-profiles/{profile_id}",
            put(update_device_profile).delete(delete_device_profile),
        )
        .route(
            "/api/agents/{id}/device-profiles/{profile_id}/activate",
            post(activate_device_profile),
        )
        .route(
            "/api/agents/{id}/calibration-profiles",
            get(list_calibration_profiles).post(create_calibration_profile),
        )
        .route(
            "/api/agents/{id}/calibration-profiles/{profile_id}",
            put(update_calibration_profile).delete(delete_calibration_profile),
        )
        .route(
            "/api/agents/{id}/calibration-profiles/{profile_id}/activate",
            post(activate_calibration_profile),
        )
        .route(
            "/api/agents/{id}/channels",
            get(list_agent_channels).put(put_agent_channels),
        )
        .route("/api/test-runs", get(list_test_runs).post(create_test_run))
        .route("/api/test-runs/{id}", get(get_test_run))
        .with_state(state)
}

fn validate_register(req: &RegisterAgentRequest) -> Option<&'static str> {
    if req.name.trim().is_empty() {
        return Some("name is required");
    }
    if req.ip.trim().is_empty() {
        return Some("ip is required");
    }
    if req.port == 0 {
        return Some("port must be non-zero");
    }
    None
}

async fn register_agent(
    State(s): State<AppState>,
    Json(req): Json<RegisterAgentRequest>,
) -> impl IntoResponse {
    if let Some(msg) = validate_register(&req) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg.into() }),
        )
            .into_response();
    }
    match s
        .store
        .upsert_agent(req.name.trim(), req.ip.trim(), req.port)
        .await
    {
        Ok(agent) => (StatusCode::OK, Json(AgentView::from(agent))).into_response(),
        Err(e) => {
            tracing::error!("upsert agent: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "database error".into(),
                }),
            )
                .into_response()
        }
    }
}

async fn list_agents(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_agents().await {
        Ok(agents) => {
            let views: Vec<AgentView> = agents.into_iter().map(AgentView::from).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list agents: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "database error".into(),
                }),
            )
                .into_response()
        }
    }
}

async fn get_agent(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => (StatusCode::OK, Json(AgentView::from(agent))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent: {e}");
            db_error().into_response()
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentSettingsView {
    #[serde(default, deserialize_with = "deserialize_units_flex")]
    pub units: Vec<crate::store::AgentUnit>,
    pub variables: Vec<crate::store::AgentVariable>,
    #[serde(default)]
    pub array_expand_mode: crate::agent_settings::ArrayExpandMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub device_profiles: Vec<AgentConfigProfileView>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_profiles: Vec<AgentConfigProfileView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_calibration_id: Option<String>,
}

fn deserialize_units_flex<'de, D>(
    deserializer: D,
) -> Result<Vec<crate::store::AgentUnit>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
    let raw = serde_json::to_string(&value).unwrap_or_else(|_| "[]".into());
    Ok(crate::agent_settings::parse_units_json(&raw))
}

fn validate_units(units: &[crate::store::AgentUnit]) -> Option<String> {
    let mut seen_units = std::collections::HashSet::new();
    for u in units {
        let t = u.symbol.trim();
        if t.is_empty() {
            return Some("unit must not be empty".into());
        }
        if t.len() > 32 {
            return Some("unit too long (max 32)".into());
        }
        if u.description.len() > 200 {
            return Some(format!("unit description too long for {t} (max 200)"));
        }
        if !seen_units.insert(t.to_string()) {
            return Some(format!("duplicate unit: {t}"));
        }
    }
    if units.len() > 200 {
        return Some("too many units (max 200)".into());
    }
    None
}

fn validate_agent_variables(variables: &[crate::store::AgentVariable]) -> Option<String> {
    let mut seen_names = std::collections::HashSet::new();
    for v in variables {
        let name = v.name.trim();
        if name.is_empty() {
            return Some("variable name must not be empty".into());
        }
        if name.len() > 64 {
            return Some("variable name too long (max 64)".into());
        }
        if v.description.len() > 200 {
            return Some(format!("variable description too long for {name} (max 200)"));
        }
        if !name.chars().enumerate().all(|(i, c)| {
            if i == 0 {
                c.is_ascii_alphabetic() || c == '_'
            } else {
                c.is_ascii_alphanumeric() || c == '_'
            }
        }) {
            return Some(format!("invalid variable name: {name}"));
        }
        if !seen_names.insert(name.to_string()) {
            return Some(format!("duplicate variable: {name}"));
        }
    }
    if variables.len() > 500 {
        return Some("too many variables (max 500)".into());
    }
    None
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CenterUnitsView {
    #[serde(default, deserialize_with = "deserialize_units_flex")]
    pub units: Vec<crate::store::AgentUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

async fn get_center_units(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.get_center_units().await {
        Ok(u) => (
            StatusCode::OK,
            Json(CenterUnitsView {
                units: u.units,
                updated_at: u.updated_at,
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get center units: {e}");
            db_error().into_response()
        }
    }
}

async fn put_center_units(
    State(s): State<AppState>,
    Json(body): Json<CenterUnitsView>,
) -> impl IntoResponse {
    let units: Vec<crate::store::AgentUnit> = body
        .units
        .into_iter()
        .map(|u| crate::store::AgentUnit {
            symbol: u.symbol.trim().to_string(),
            description: u.description.trim().to_string(),
        })
        .filter(|u| !u.symbol.is_empty())
        .collect();
    if let Some(msg) = validate_units(&units) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg }),
        )
            .into_response();
    }
    match s.store.upsert_center_units(&units).await {
        Ok(u) => (
            StatusCode::OK,
            Json(CenterUnitsView {
                units: u.units,
                updated_at: u.updated_at,
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("upsert center units: {e}");
            db_error().into_response()
        }
    }
}

async fn get_agent_settings(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "agent not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get agent for settings: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }
    let settings = match s.store.get_agent_settings(&id).await {
        Ok(settings) => settings,
        Err(e) => {
            tracing::error!("get agent settings: {e}");
            return db_error().into_response();
        }
    };
    // Attach global units read-only for compatibility with older Agent UIs.
    let global_units = match s.store.get_center_units().await {
        Ok(u) => u.units,
        Err(e) => {
            tracing::error!("get center units for settings: {e}");
            return db_error().into_response();
        }
    };
    let device_profiles = match s.store.list_device_profiles(&id).await {
        Ok(list) => list
            .into_iter()
            .map(AgentConfigProfileView::from)
            .collect::<Vec<_>>(),
        Err(e) => {
            tracing::error!("list device profiles for settings: {e}");
            return db_error().into_response();
        }
    };
    let calibration_profiles = match s.store.list_calibration_profiles(&id).await {
        Ok(list) => list
            .into_iter()
            .map(AgentConfigProfileView::from)
            .collect::<Vec<_>>(),
        Err(e) => {
            tracing::error!("list calibration profiles for settings: {e}");
            return db_error().into_response();
        }
    };
    let active_device_id = device_profiles
        .iter()
        .find(|p| p.is_active)
        .map(|p| p.id.clone());
    let active_calibration_id = calibration_profiles
        .iter()
        .find(|p| p.is_active)
        .map(|p| p.id.clone());
    (
        StatusCode::OK,
        Json(AgentSettingsView {
            units: global_units,
            variables: settings.variables,
            array_expand_mode: settings.array_expand_mode,
            updated_at: settings.updated_at,
            device_profiles,
            calibration_profiles,
            active_device_id,
            active_calibration_id,
        }),
    )
        .into_response()
}

async fn put_agent_settings(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AgentSettingsView>,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "agent not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get agent for settings put: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }
    let array_expand_mode = body.array_expand_mode;
    let variables: Vec<crate::store::AgentVariable> = body
        .variables
        .into_iter()
        .map(|v| crate::store::AgentVariable {
            name: v.name.trim().to_string(),
            value: v.value,
            description: v.description.trim().to_string(),
        })
        .filter(|v| !v.name.is_empty())
        .collect();
    if let Some(msg) = validate_agent_variables(&variables) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg }),
        )
            .into_response();
    }
    match s
        .store
        .upsert_agent_settings(&id, &variables, array_expand_mode)
        .await
    {
        Ok(settings) => {
            let global_units = match s.store.get_center_units().await {
                Ok(u) => u.units,
                Err(e) => {
                    tracing::error!("get center units after settings put: {e}");
                    return db_error().into_response();
                }
            };
            (
                StatusCode::OK,
                Json(AgentSettingsView {
                    units: global_units,
                    variables: settings.variables,
                    array_expand_mode: settings.array_expand_mode,
                    updated_at: settings.updated_at,
                    device_profiles: Vec::new(),
                    calibration_profiles: Vec::new(),
                    active_device_id: None,
                    active_calibration_id: None,
                }),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("upsert agent settings: {e}");
            db_error().into_response()
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentConfigProfileView {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub setting: serde_json::Value,
    pub is_active: bool,
    pub source_filename: String,
    pub updated_at: String,
}

impl From<crate::store::AgentConfigProfile> for AgentConfigProfileView {
    fn from(p: crate::store::AgentConfigProfile) -> Self {
        let setting = serde_json::from_str(&p.setting_json)
            .unwrap_or_else(|_| serde_json::json!({}));
        Self {
            id: p.id,
            agent_id: p.agent_id,
            name: p.name,
            setting,
            is_active: p.is_active,
            source_filename: p.source_filename,
            updated_at: p.updated_at,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CreateAgentConfigProfileRequest {
    pub name: String,
    #[serde(default)]
    pub setting: serde_json::Value,
    #[serde(default)]
    pub source_filename: String,
    #[serde(default)]
    pub activate: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateAgentConfigProfileRequest {
    pub name: String,
    #[serde(default)]
    pub setting: serde_json::Value,
    #[serde(default)]
    pub source_filename: String,
}

fn validate_profile_name(name: &str) -> Option<&'static str> {
    let t = name.trim();
    if t.is_empty() {
        return Some("name is required");
    }
    if t.len() > 128 {
        return Some("name too long (max 128)");
    }
    None
}

fn setting_json_string(setting: &serde_json::Value) -> Result<String, String> {
    if !setting.is_object() && !setting.is_null() {
        return Err("setting must be a JSON object".into());
    }
    let v = if setting.is_null() {
        serde_json::json!({})
    } else {
        setting.clone()
    };
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChannelView {
    pub id: String,
    pub agent_id: String,
    pub channel_index: i32,
    pub name: String,
    pub enabled: bool,
    pub overlay: serde_json::Value,
    pub updated_at: String,
}

impl From<crate::store::AgentChannel> for AgentChannelView {
    fn from(c: crate::store::AgentChannel) -> Self {
        Self {
            id: c.id,
            agent_id: c.agent_id,
            channel_index: c.channel_index,
            name: c.name,
            enabled: c.enabled,
            overlay: c.overlay,
            updated_at: c.updated_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentChannelUpsertRequest {
    pub channel_index: i32,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub overlay: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReplaceAgentChannelsRequest {
    pub channels: Vec<AgentChannelUpsertRequest>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentChannelsListResponse {
    pub channels: Vec<AgentChannelView>,
}

fn validate_channel_overlay(overlay: &serde_json::Value) -> Option<String> {
    let obj = match overlay {
        serde_json::Value::Null => return None,
        serde_json::Value::Object(map) => map,
        _ => return Some("overlay must be a JSON object".into()),
    };
    for (k, v) in obj {
        if !v.is_string() {
            return Some(format!("overlay[{k}] must be a string"));
        }
    }
    None
}

async fn list_agent_channels(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Err(resp) = ensure_agent_exists(&s, &id).await {
        return resp;
    }
    match s.store.list_agent_channels(&id).await {
        Ok(list) => {
            let channels: Vec<AgentChannelView> =
                list.into_iter().map(AgentChannelView::from).collect();
            (StatusCode::OK, Json(AgentChannelsListResponse { channels })).into_response()
        }
        Err(e) => {
            tracing::error!("list agent channels: {e}");
            db_error().into_response()
        }
    }
}

async fn put_agent_channels(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ReplaceAgentChannelsRequest>,
) -> impl IntoResponse {
    if let Err(resp) = ensure_agent_exists(&s, &id).await {
        return resp;
    }
    let mut items = Vec::with_capacity(body.channels.len());
    for (i, ch) in body.channels.into_iter().enumerate() {
        let name = ch.name.trim().to_string();
        if name.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: format!("channels[{i}].name is required"),
                }),
            )
                .into_response();
        }
        if let Some(msg) = validate_channel_overlay(&ch.overlay) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: format!("channels[{i}].{msg}"),
                }),
            )
                .into_response();
        }
        let overlay = if ch.overlay.is_null() {
            serde_json::json!({})
        } else {
            ch.overlay
        };
        items.push(crate::store::AgentChannelUpsert {
            channel_index: ch.channel_index,
            name,
            enabled: ch.enabled,
            overlay,
        });
    }
    match s.store.replace_agent_channels(&id, items).await {
        Ok(list) => {
            let channels: Vec<AgentChannelView> =
                list.into_iter().map(AgentChannelView::from).collect();
            (StatusCode::OK, Json(AgentChannelsListResponse { channels })).into_response()
        }
        Err(e) => {
            tracing::error!("replace agent channels: {e}");
            let msg = e.to_string();
            if msg.contains("overlay") {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody { error: msg }),
                )
                    .into_response();
            }
            db_error().into_response()
        }
    }
}

async fn ensure_agent_exists(
    s: &AppState,
    id: &str,
) -> Result<(), axum::response::Response> {
    match s.store.get_agent(id).await {
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response()),
        Err(e) => {
            tracing::error!("get agent: {e}");
            Err(db_error().into_response())
        }
        Ok(Some(_)) => Ok(()),
    }
}

async fn list_device_profiles(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Err(resp) = ensure_agent_exists(&s, &id).await {
        return resp;
    }
    match s.store.list_device_profiles(&id).await {
        Ok(list) => {
            let views: Vec<AgentConfigProfileView> =
                list.into_iter().map(AgentConfigProfileView::from).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list device profiles: {e}");
            db_error().into_response()
        }
    }
}

async fn list_calibration_profiles(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Err(resp) = ensure_agent_exists(&s, &id).await {
        return resp;
    }
    match s.store.list_calibration_profiles(&id).await {
        Ok(list) => {
            let views: Vec<AgentConfigProfileView> =
                list.into_iter().map(AgentConfigProfileView::from).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list calibration profiles: {e}");
            db_error().into_response()
        }
    }
}

async fn create_device_profile(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateAgentConfigProfileRequest>,
) -> impl IntoResponse {
    create_config_profile_handler(&s, &id, body, true).await
}

async fn create_calibration_profile(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateAgentConfigProfileRequest>,
) -> impl IntoResponse {
    create_config_profile_handler(&s, &id, body, false).await
}

async fn create_config_profile_handler(
    s: &AppState,
    agent_id: &str,
    body: CreateAgentConfigProfileRequest,
    is_device: bool,
) -> axum::response::Response {
    if let Err(resp) = ensure_agent_exists(s, agent_id).await {
        return resp;
    }
    if let Some(msg) = validate_profile_name(&body.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: msg.into(),
            }),
        )
            .into_response();
    }
    let setting_json = match setting_json_string(&body.setting) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };
    let result = if is_device {
        s.store
            .create_device_profile(
                agent_id,
                body.name.trim(),
                &setting_json,
                body.source_filename.trim(),
                body.activate,
            )
            .await
    } else {
        s.store
            .create_calibration_profile(
                agent_id,
                body.name.trim(),
                &setting_json,
                body.source_filename.trim(),
                body.activate,
            )
            .await
    };
    match result {
        Ok(p) => (StatusCode::OK, Json(AgentConfigProfileView::from(p))).into_response(),
        Err(e) => {
            tracing::error!("create config profile: {e}");
            db_error().into_response()
        }
    }
}

async fn update_device_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
    Json(body): Json<UpdateAgentConfigProfileRequest>,
) -> impl IntoResponse {
    update_config_profile_handler(&s, &id, &profile_id, body, true).await
}

async fn update_calibration_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
    Json(body): Json<UpdateAgentConfigProfileRequest>,
) -> impl IntoResponse {
    update_config_profile_handler(&s, &id, &profile_id, body, false).await
}

async fn update_config_profile_handler(
    s: &AppState,
    agent_id: &str,
    profile_id: &str,
    body: UpdateAgentConfigProfileRequest,
    is_device: bool,
) -> axum::response::Response {
    if let Err(resp) = ensure_agent_exists(s, agent_id).await {
        return resp;
    }
    if let Some(msg) = validate_profile_name(&body.name) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: msg.into(),
            }),
        )
            .into_response();
    }
    let setting_json = match setting_json_string(&body.setting) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };
    let existing = if is_device {
        s.store.get_device_profile(profile_id).await
    } else {
        s.store.get_calibration_profile(profile_id).await
    };
    match existing {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "profile not found".into(),
                }),
            )
                .into_response();
        }
        Ok(Some(p)) if p.agent_id != agent_id => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "profile not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get profile: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }
    let result = if is_device {
        s.store
            .update_device_profile(
                profile_id,
                body.name.trim(),
                &setting_json,
                body.source_filename.trim(),
            )
            .await
    } else {
        s.store
            .update_calibration_profile(
                profile_id,
                body.name.trim(),
                &setting_json,
                body.source_filename.trim(),
            )
            .await
    };
    match result {
        Ok(Some(p)) => (StatusCode::OK, Json(AgentConfigProfileView::from(p))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "profile not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("update profile: {e}");
            db_error().into_response()
        }
    }
}

async fn delete_device_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
) -> impl IntoResponse {
    delete_config_profile_handler(&s, &id, &profile_id, true).await
}

async fn delete_calibration_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
) -> impl IntoResponse {
    delete_config_profile_handler(&s, &id, &profile_id, false).await
}

async fn delete_config_profile_handler(
    s: &AppState,
    agent_id: &str,
    profile_id: &str,
    is_device: bool,
) -> axum::response::Response {
    if let Err(resp) = ensure_agent_exists(s, agent_id).await {
        return resp;
    }
    let existing = if is_device {
        s.store.get_device_profile(profile_id).await
    } else {
        s.store.get_calibration_profile(profile_id).await
    };
    match existing {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "profile not found".into(),
                }),
            )
                .into_response();
        }
        Ok(Some(p)) if p.agent_id != agent_id => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "profile not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get profile: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }
    let result = if is_device {
        s.store.delete_device_profile(profile_id).await
    } else {
        s.store.delete_calibration_profile(profile_id).await
    };
    match result {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "profile not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete profile: {e}");
            db_error().into_response()
        }
    }
}

async fn activate_device_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
) -> impl IntoResponse {
    activate_config_profile_handler(&s, &id, &profile_id, true).await
}

async fn activate_calibration_profile(
    State(s): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
) -> impl IntoResponse {
    activate_config_profile_handler(&s, &id, &profile_id, false).await
}

async fn activate_config_profile_handler(
    s: &AppState,
    agent_id: &str,
    profile_id: &str,
    is_device: bool,
) -> axum::response::Response {
    if let Err(resp) = ensure_agent_exists(s, agent_id).await {
        return resp;
    }
    let result = if is_device {
        s.store.activate_device_profile(agent_id, profile_id).await
    } else {
        s.store
            .activate_calibration_profile(agent_id, profile_id)
            .await
    };
    match result {
        Ok(Some(p)) => (StatusCode::OK, Json(AgentConfigProfileView::from(p))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "profile not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("activate profile: {e}");
            db_error().into_response()
        }
    }
}

fn validate_vi_template_create(req: &CreateViTemplateRequest) -> Option<&'static str> {
    if req.agent_id.trim().is_empty() {
        return Some("agent_id is required");
    }
    if req.name.trim().is_empty() {
        return Some("name is required");
    }
    let kind = req.kind.trim();
    if kind != "labview" {
        return Some("kind must be labview");
    }
    if !req.inputs.is_array() {
        return Some("inputs must be an array");
    }
    if !req.outputs.is_array() {
        return Some("outputs must be an array");
    }
    if req.timeout_secs == Some(0) {
        return Some("timeout_secs must be greater than 0");
    }
    if crate::labview_cmd::normalize_fs_path(&req.vi_path).is_empty() {
        return Some("vi_path is required");
    }
    if crate::labview_cmd::normalize_fs_path(&req.cli_path).is_empty() {
        return Some("cli_path is required");
    }
    if crate::labview_cmd::normalize_fs_path(&req.getinfo_path).is_empty() {
        return Some("getinfo_path is required");
    }
    None
}

fn patch_vi_template_has_fields(req: &PatchViTemplateRequest) -> bool {
    req.name.is_some()
        || req.inputs.is_some()
        || req.show_front_panel.is_some()
        || req.timeout_secs.is_some()
}


async fn list_vi_templates(
    State(s): State<AppState>,
    Query(q): Query<ListViTemplatesQuery>,
) -> impl IntoResponse {
    let agent_filter = q.agent_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let kind_filter = q.kind.as_deref().map(str::trim).filter(|k| !k.is_empty());
    match s.store.list_vi_templates_enriched(agent_filter, kind_filter).await {
        Ok(templates) => {
            let mut views = Vec::with_capacity(templates.len());
            for t in templates {
                match ViTemplateView::try_from(t) {
                    Ok(v) => views.push(v),
                    Err(e) => {
                        tracing::error!("vi template view: {e}");
                        return db_error().into_response();
                    }
                }
            }
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list vi templates: {e}");
            db_error().into_response()
        }
    }
}

async fn create_vi_template(
    State(s): State<AppState>,
    Json(req): Json<CreateViTemplateRequest>,
) -> impl IntoResponse {
    if let Some(msg) = validate_vi_template_create(&req) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg.into() }),
        )
            .into_response();
    }

    match s.store.get_agent(req.agent_id.trim()).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "agent not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get agent for vi template: {e}");
            return db_error().into_response();
        }
    }

    let kind = req.kind.trim();
    let (vi_path, cli_path, getinfo_path) = (
        crate::labview_cmd::normalize_fs_path(&req.vi_path),
        crate::labview_cmd::normalize_fs_path(&req.cli_path),
        crate::labview_cmd::normalize_fs_path(&req.getinfo_path),
    );
    let name = req.name.trim();

    match s
        .store
        .find_duplicate_vi_template(name, &req.inputs, None)
        .await
    {
        Ok(Some(_)) => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorBody {
                    error: "a template with the same name and inputs already exists".into(),
                }),
            )
                .into_response();
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!("find duplicate vi template: {e}");
            return db_error().into_response();
        }
    }

    match s
        .store
        .insert_vi_template(
            name,
            req.agent_id.trim(),
            kind,
            &vi_path,
            &cli_path,
            &getinfo_path,
            &req.inputs,
            &req.outputs,
            req.show_front_panel,
            req.timeout_secs,
        )
        .await
    {
        Ok(template) => match s.store.get_vi_template_enriched(template.id).await {
            Ok(Some(enriched)) => match ViTemplateView::try_from(enriched) {
                Ok(view) => (StatusCode::CREATED, Json(view)).into_response(),
                Err(e) => {
                    tracing::error!("vi template view: {e}");
                    db_error().into_response()
                }
            },
            Ok(None) => db_error().into_response(),
            Err(e) => {
                tracing::error!("get vi template enriched after create: {e}");
                db_error().into_response()
            }
        },
        Err(e) => {
            tracing::error!("create vi template: {e}");
            db_error().into_response()
        }
    }
}

async fn get_vi_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.get_vi_template_enriched(id).await {
        Ok(Some(template)) => match ViTemplateView::try_from(template) {
            Ok(view) => (StatusCode::OK, Json(view)).into_response(),
            Err(e) => {
                tracing::error!("vi template view: {e}");
                db_error().into_response()
            }
        },
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "vi template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get vi template: {e}");
            db_error().into_response()
        }
    }
}

async fn patch_vi_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<PatchViTemplateRequest>,
) -> impl IntoResponse {
    if !patch_vi_template_has_fields(&req) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "at least one field is required".into(),
            }),
        )
            .into_response();
    }
    if let Some(ref name) = req.name {
        if name.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: "name must be non-empty".into(),
                }),
            )
                .into_response();
        }
    }

    let patch = ViTemplatePatch {
        name: req.name.map(|n| n.trim().to_string()),
        inputs: req.inputs,
        show_front_panel: req.show_front_panel,
        timeout_secs: req.timeout_secs,
    };

    if patch.name.is_some() || patch.inputs.is_some() {
        let current = match s.store.get_vi_template(id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorBody {
                        error: "vi template not found".into(),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                tracing::error!("get vi template for patch dup check: {e}");
                return db_error().into_response();
            }
        };
        let check_name = patch.name.as_deref().unwrap_or(current.name.as_str());
        let check_inputs = match &patch.inputs {
            Some(v) => v.clone(),
            None => match serde_json::from_str(&current.inputs_json) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("parse inputs_json for patch dup check: {e}");
                    return db_error().into_response();
                }
            },
        };
        match s
            .store
            .find_duplicate_vi_template(check_name, &check_inputs, Some(id))
            .await
        {
            Ok(Some(_)) => {
                return (
                    StatusCode::CONFLICT,
                    Json(ErrorBody {
                        error: "a template with the same name and inputs already exists".into(),
                    }),
                )
                    .into_response();
            }
            Ok(None) => {}
            Err(e) => {
                tracing::error!("find duplicate vi template on patch: {e}");
                return db_error().into_response();
            }
        }
    }

    match s.store.patch_vi_template(id, patch).await {
        Ok(Some(_)) => match s.store.get_vi_template_enriched(id).await {
            Ok(Some(enriched)) => match ViTemplateView::try_from(enriched) {
                Ok(view) => (StatusCode::OK, Json(view)).into_response(),
                Err(e) => {
                    tracing::error!("vi template view: {e}");
                    db_error().into_response()
                }
            },
            Ok(None) => db_error().into_response(),
            Err(e) => {
                tracing::error!("get vi template enriched after patch: {e}");
                db_error().into_response()
            }
        },
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "vi template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("patch vi template: {e}");
            db_error().into_response()
        }
    }
}



async fn delete_vi_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.delete_vi_template(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "vi template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete vi template: {e}");
            db_error().into_response()
        }
    }
}

async fn list_general_templates(
    State(s): State<AppState>,
    Query(q): Query<ListGeneralTemplatesQuery>,
) -> impl IntoResponse {
    let agent_filter = q.agent_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let kind_filter = q.kind.as_deref().map(str::trim).filter(|k| !k.is_empty());
    match s.store.list_general_templates_enriched(agent_filter, kind_filter).await {
        Ok(templates) => {
            let mut views = Vec::with_capacity(templates.len());
            for t in templates {
                match GeneralTemplateView::try_from(t) {
                    Ok(v) => views.push(v),
                    Err(e) => {
                        tracing::error!("general template view: {e}");
                        return db_error().into_response();
                    }
                }
            }
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list general templates: {e}");
            db_error().into_response()
        }
    }
}

async fn get_general_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.list_general_templates_enriched(None, None).await {
        Ok(templates) => {
            let enriched = templates.into_iter().find(|t| t.template.id == id);
            match enriched {
                Some(t) => match GeneralTemplateView::try_from(t) {
                    Ok(view) => (StatusCode::OK, Json(view)).into_response(),
                    Err(e) => {
                        tracing::error!("general template view: {e}");
                        db_error().into_response()
                    }
                },
                None => (
                    StatusCode::NOT_FOUND,
                    Json(ErrorBody {
                        error: "general template not found".into(),
                    }),
                )
                    .into_response(),
            }
        }
        Err(e) => {
            tracing::error!("get general template: {e}");
            db_error().into_response()
        }
    }
}

async fn list_sequence_templates(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_sequence_templates().await {
        Ok(items) => {
            let views: Vec<SequenceTemplateListItemView> =
                items.into_iter().map(sequence_template_list_item_view).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list sequence templates: {e}");
            db_error().into_response()
        }
    }
}

async fn create_sequence_template(
    State(s): State<AppState>,
    Json(req): Json<CreateSequenceTemplateRequest>,
) -> impl IntoResponse {
    if req.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "agent_id is required".into(),
            }),
        )
            .into_response();
    }
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "name is required".into(),
            }),
        )
            .into_response();
    }
    let queue_items = match s.store.list_vi_run_queue(req.agent_id.trim()).await {
        Ok(items) => items,
        Err(e) => {
            tracing::error!("list vi run queue for sequence template create: {e}");
            return db_error().into_response();
        }
    };
    if queue_items.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "run queue is empty".into(),
            }),
        )
            .into_response();
    }
    match s
        .store
        .create_sequence_template_from_queue(
            req.agent_id.trim(),
            req.name.trim(),
            req.note.trim(),
            &queue_items,
        )
        .await
    {
        Ok(template) => {
            let enriched = SequenceTemplateEnriched {
                template,
                created_by_agent_name: s
                    .store
                    .get_agent(req.agent_id.trim())
                    .await
                    .ok()
                    .flatten()
                    .map(|a| a.name),
                step_count: queue_items.len() as i64,
            };
            (StatusCode::CREATED, Json(sequence_template_list_item_view(enriched))).into_response()
        }
        Err(e) => {
            tracing::error!("create sequence template: {e}");
            db_error().into_response()
        }
    }
}

async fn get_sequence_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let template = match s.store.get_sequence_template(id).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "sequence template not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get sequence template: {e}");
            return db_error().into_response();
        }
    };
    let steps = match s.store.get_sequence_template_steps(id).await {
        Ok(steps) => steps,
        Err(e) => {
            tracing::error!("get sequence template steps: {e}");
            return db_error().into_response();
        }
    };
    let step_views: Result<Vec<_>, _> = steps.into_iter().map(sequence_template_step_view).collect();
    let step_views = match step_views {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { error: e })).into_response(),
    };
    let creator_name = match s.store.get_agent(&template.created_by_agent_id).await {
        Ok(Some(a)) => Some(a.name),
        Ok(None) => None,
        Err(_) => None,
    };
    let view = SequenceTemplateDetailView {
        id: template.id,
        name: template.name,
        note: template.note,
        created_by_agent_id: template.created_by_agent_id,
        created_by_agent_name: agent_display_name(creator_name),
        created_at: template.created_at,
        updated_at: template.updated_at,
        step_count: step_views.len() as i64,
        steps: step_views,
    };
    (StatusCode::OK, Json(view)).into_response()
}

async fn load_sequence_template_to_agent(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<LoadSequenceTemplateToAgentRequest>,
) -> impl IntoResponse {
    if req.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "agent_id is required".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_sequence_template(id).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "sequence template not found".into(),
            }),
        )
            .into_response();
    }
    match s
        .store
        .load_sequence_template_to_agent(id, req.agent_id.trim())
        .await
    {
        Ok(items) => match vi_run_queue_views(items) {
            Ok(views) => (StatusCode::OK, Json(ViRunQueueListResponse { items: views })).into_response(),
            Err(e) => {
                tracing::error!("sequence template load queue view: {e}");
                db_error().into_response()
            }
        },
        Err(e) => queue_replace_error_response(e).into_response(),
    }
}

async fn delete_sequence_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.delete_sequence_template(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "sequence template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete sequence template: {e}");
            db_error().into_response()
        }
    }
}

fn default_spec_template_name(name: &str, source_filename: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    let filename = source_filename.trim();
    if !filename.is_empty() {
        return filename
            .trim_end_matches(".ini")
            .trim_end_matches(".INI")
            .to_string();
    }
    "Spec template".into()
}

fn spec_section_count(spec: &serde_json::Value) -> i64 {
    spec.get("sections")
        .and_then(|v| v.as_object())
        .map(|m| m.len() as i64)
        .unwrap_or(0)
}

fn spec_template_list_item_view(s: SpecTemplateSummary) -> SpecTemplateListItemView {
    SpecTemplateListItemView {
        id: s.id,
        name: s.name,
        product_pn: s.product_pn,
        source_filename: s.source_filename,
        section_count: s.section_count,
        created_by_agent_name: s.created_by_agent_name.filter(|n| !n.is_empty()),
        updated_at: s.updated_at,
    }
}

fn agent_config_template_list_item_view(t: AgentConfigTemplateEnriched) -> AgentConfigTemplateListItemView {
    AgentConfigTemplateListItemView {
        id: t.template.id,
        name: t.template.name,
        note: t.template.note,
        source_agent_id: t.template.source_agent_id,
        source_agent_name: agent_display_name(t.source_agent_name),
        created_by_agent_id: t.template.created_by_agent_id,
        created_by_agent_name: agent_display_name(t.created_by_agent_name),
        created_at: t.template.created_at,
        updated_at: t.template.updated_at,
    }
}

async fn list_agent_config_summaries(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_agent_config_summaries().await {
        Ok(items) => {
            let views = items
                .into_iter()
                .map(|item| AgentConfigSummaryView {
                    agent_id: item.agent_id,
                    agent_name: item.agent_name,
                    agent_status: item.agent_status,
                    agent_ip: item.agent_ip,
                    variable_count: item.variable_count,
                    device_profile_count: item.device_profile_count,
                    calibration_profile_count: item.calibration_profile_count,
                    active_device_name: item.active_device_name,
                    active_calibration_name: item.active_calibration_name,
                    channel_count: item.channel_count,
                    array_expand_mode: item.array_expand_mode,
                    settings_updated_at: item.settings_updated_at,
                })
                .collect::<Vec<_>>();
            (StatusCode::OK, Json(serde_json::json!({ "items": views }))).into_response()
        }
        Err(e) => {
            tracing::error!("list agent config summaries: {e}");
            db_error().into_response()
        }
    }
}

async fn list_agent_config_templates(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_agent_config_templates().await {
        Ok(items) => {
            let views = items
                .into_iter()
                .map(agent_config_template_list_item_view)
                .collect::<Vec<_>>();
            (StatusCode::OK, Json(serde_json::json!({ "items": views }))).into_response()
        }
        Err(e) => {
            tracing::error!("list agent config templates: {e}");
            db_error().into_response()
        }
    }
}

async fn create_agent_config_template(
    State(s): State<AppState>,
    Json(req): Json<CreateAgentConfigTemplateRequest>,
) -> impl IntoResponse {
    if req.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "agent_id is required".into(),
            }),
        )
            .into_response();
    }
    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "name is required".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_agent(req.agent_id.trim()).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response();
    }
    match s
        .store
        .create_agent_config_template_from_agent(
            req.agent_id.trim(),
            req.name.trim(),
            req.note.trim(),
        )
        .await
    {
        Ok(template) => {
            let enriched = AgentConfigTemplateEnriched {
                template,
                created_by_agent_name: s
                    .store
                    .get_agent(req.agent_id.trim())
                    .await
                    .ok()
                    .flatten()
                    .map(|a| a.name),
                source_agent_name: s
                    .store
                    .get_agent(req.agent_id.trim())
                    .await
                    .ok()
                    .flatten()
                    .map(|a| a.name),
            };
            (
                StatusCode::CREATED,
                Json(agent_config_template_list_item_view(enriched)),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("create agent config template: {e}");
            db_error().into_response()
        }
    }
}

async fn get_agent_config_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let template = match s.store.get_agent_config_template(id).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "agent config template not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get agent config template: {e}");
            return db_error().into_response();
        }
    };
    let config: AgentConfigSnapshot = match serde_json::from_str(&template.config_json) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("parse agent config template json: {e}");
            return db_error().into_response();
        }
    };
    let created_by_agent_name = if template.created_by_agent_id.is_empty() {
        None
    } else {
        s.store
            .get_agent(&template.created_by_agent_id)
            .await
            .ok()
            .flatten()
            .map(|a| a.name)
    };
    let source_agent_name = match template.source_agent_id.as_deref() {
        Some(id) if !id.is_empty() => s
            .store
            .get_agent(id)
            .await
            .ok()
            .flatten()
            .map(|a| a.name),
        _ => None,
    };
    let view = AgentConfigTemplateDetailView {
        id: template.id,
        name: template.name,
        note: template.note,
        source_agent_id: template.source_agent_id,
        source_agent_name: agent_display_name(source_agent_name),
        created_by_agent_id: template.created_by_agent_id,
        created_by_agent_name: agent_display_name(created_by_agent_name),
        created_at: template.created_at,
        updated_at: template.updated_at,
        config,
    };
    (StatusCode::OK, Json(view)).into_response()
}

async fn load_agent_config_template_to_agent(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<LoadAgentConfigTemplateToAgentRequest>,
) -> impl IntoResponse {
    if req.agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "agent_id is required".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_agent(req.agent_id.trim()).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_agent_config_template(id).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent config template not found".into(),
            }),
        )
            .into_response();
    }
    match s
        .store
        .load_agent_config_template_to_agent(id, req.agent_id.trim())
        .await
    {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => {
            tracing::error!("load agent config template: {e}");
            db_error().into_response()
        }
    }
}

async fn delete_agent_config_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.delete_agent_config_template(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent config template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete agent config template: {e}");
            db_error().into_response()
        }
    }
}

async fn list_spec_templates(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_spec_templates().await {
        Ok(items) => {
            let views = items
                .into_iter()
                .map(spec_template_list_item_view)
                .collect::<Vec<_>>();
            (StatusCode::OK, Json(serde_json::json!({ "items": views }))).into_response()
        }
        Err(e) => {
            tracing::error!("list spec templates: {e}");
            db_error().into_response()
        }
    }
}

async fn create_spec_template(
    State(s): State<AppState>,
    Json(req): Json<CreateSpecTemplateRequest>,
) -> impl IntoResponse {
    if req.ini_text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "ini_text is required".into(),
            }),
        )
            .into_response();
    }
    let parsed = match parse_spec_ini(&req.ini_text) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody { error: e }),
            )
                .into_response();
        }
    };
    if parsed.document.sections.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "no sections".into(),
            }),
        )
            .into_response();
    }
    if let Some(agent_id) = req.created_by_agent_id.as_deref() {
        if !agent_id.trim().is_empty() {
            match s.store.get_agent(agent_id.trim()).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(ErrorBody {
                            error: "agent not found".into(),
                        }),
                    )
                        .into_response();
                }
                Err(e) => {
                    tracing::error!("get agent for spec template: {e}");
                    return db_error().into_response();
                }
            }
        }
    }
    let spec_json = spec_document_to_json(&parsed.document).to_string();
    let name = default_spec_template_name(&req.name, &req.source_filename);
    let created_by_agent_id = req
        .created_by_agent_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match s
        .store
        .create_spec_template(
            &name,
            req.product_pn.trim(),
            req.note.trim(),
            req.source_filename.trim(),
            &spec_json,
            created_by_agent_id,
        )
        .await
    {
        Ok(template) => {
            let created_by_agent_name = if let Some(agent_id) = created_by_agent_id {
                s.store
                    .get_agent(agent_id)
                    .await
                    .ok()
                    .flatten()
                    .map(|a| a.name)
            } else {
                None
            };
            let view = spec_template_list_item_view(SpecTemplateSummary {
                id: template.id,
                name: template.name,
                product_pn: template.product_pn,
                source_filename: template.source_filename,
                section_count: parsed.document.sections.len() as i64,
                created_by_agent_name,
                updated_at: template.updated_at,
            });
            (StatusCode::CREATED, Json(view)).into_response()
        }
        Err(e) => {
            tracing::error!("create spec template: {e}");
            db_error().into_response()
        }
    }
}

async fn get_spec_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    let template = match s.store.get_spec_template(id).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "spec template not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get spec template: {e}");
            return db_error().into_response();
        }
    };
    let spec: serde_json::Value = match serde_json::from_str(&template.spec_json) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("parse spec template json: {e}");
            return db_error().into_response();
        }
    };
    let created_by_agent_name = match template.created_by_agent_id.as_deref() {
        Some(agent_id) if !agent_id.is_empty() => s
            .store
            .get_agent(agent_id)
            .await
            .ok()
            .flatten()
            .map(|a| a.name),
        _ => None,
    };
    let view = SpecTemplateDetailView {
        id: template.id,
        name: template.name,
        product_pn: template.product_pn,
        note: template.note,
        source_filename: template.source_filename,
        section_count: spec_section_count(&spec),
        spec,
        created_by_agent_id: template.created_by_agent_id,
        created_by_agent_name: created_by_agent_name.filter(|n| !n.is_empty()),
        created_at: template.created_at,
        updated_at: template.updated_at,
    };
    (StatusCode::OK, Json(view)).into_response()
}

async fn delete_spec_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.delete_spec_template(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "spec template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete spec template: {e}");
            db_error().into_response()
        }
    }
}

async fn clone_agent_config(
    State(s): State<AppState>,
    Json(req): Json<CloneAgentConfigRequest>,
) -> impl IntoResponse {
    if req.source_agent_id.trim().is_empty() || req.target_agent_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "source_agent_id and target_agent_id are required".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_agent(req.source_agent_id.trim()).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "source agent not found".into(),
            }),
        )
            .into_response();
    }
    if let Ok(None) = s.store.get_agent(req.target_agent_id.trim()).await {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "target agent not found".into(),
            }),
        )
            .into_response();
    }
    match s
        .store
        .clone_agent_config(req.source_agent_id.trim(), req.target_agent_id.trim())
        .await
    {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => {
            tracing::error!("clone agent config: {e}");
            db_error().into_response()
        }
    }
}

async fn create_general_template(
    State(s): State<AppState>,
    Json(req): Json<CreateGeneralTemplateRequest>,
) -> impl IntoResponse {
    if req.agent_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(ErrorBody { error: "agent_id is required".into() })).into_response();
    }
    if req.name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(ErrorBody { error: "name is required".into() })).into_response();
    }
    if !(req.inputs.is_array() || req.inputs.is_object()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "inputs must be a JSON array or object".into(),
            }),
        )
            .into_response();
    }
    // LabVIEW uses [{name,className,value},...]; delay/REST store native JSON objects.
    if !(req.outputs.is_array() || req.outputs.is_object()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "outputs must be a JSON array or object".into(),
            }),
        )
            .into_response();
    }

    match s.store.get_agent(req.agent_id.trim()).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (StatusCode::NOT_FOUND, Json(ErrorBody { error: "agent not found".into() })).into_response();
        }
        Err(e) => {
            tracing::error!("get agent for general template: {e}");
            return db_error().into_response();
        }
    }

    match s.store.find_duplicate_general_template(req.name.trim(), &req.inputs).await {
        Ok(Some(_)) => {
            return (
                StatusCode::CONFLICT,
                Json(ErrorBody { error: "a template with the same name and inputs already exists".into() }),
            ).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!("find duplicate general template: {e}");
            return db_error().into_response();
        }
    }

    match s.store.insert_general_template(req.name.trim(), req.agent_id.trim(), req.kind.trim(), &req.inputs, &req.outputs).await {
        Ok(t) => {
            // Re-fetch enriched view for consistent response shape
            match s.store.list_general_templates_enriched(Some(req.agent_id.trim()), None).await {
                Ok(all) => {
                    if let Some(enriched) = all.into_iter().find(|e| e.template.id == t.id) {
                        match GeneralTemplateView::try_from(enriched) {
                            Ok(view) => return (StatusCode::CREATED, Json(view)).into_response(),
                            Err(e) => {
                                tracing::error!("general template view: {e}");
                            }
                        }
                    }
                }
                Err(e) => tracing::error!("list general templates after create: {e}"),
            }
            db_error().into_response()
        }
        Err(e) => {
            tracing::error!("create general template: {e}");
            db_error().into_response()
        }
    }
}

async fn delete_general_template(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match s.store.delete_general_template(id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "general template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete general template: {e}");
            db_error().into_response()
        }
    }
}



async fn get_vi_run_queue(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "agent not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get agent for vi run queue: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }

    match s.store.list_vi_run_queue(&id).await {
        Ok(items) => match vi_run_queue_views(items) {
            Ok(views) => (
                StatusCode::OK,
                Json(ViRunQueueListResponse { items: views }),
            )
                .into_response(),
            Err(e) => {
                tracing::error!("vi run queue view: {e}");
                db_error().into_response()
            }
        },
        Err(e) => {
            tracing::error!("list vi run queue: {e}");
            db_error().into_response()
        }
    }
}

async fn put_vi_run_queue(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ReplaceViRunQueueRequest>,
) -> impl IntoResponse {
    let mut items = Vec::with_capacity(req.items.len());
    for (i, item) in req.items.into_iter().enumerate() {
        let source = if item.template_source.trim().is_empty() {
            "labview".to_string()
        } else {
            item.template_source.trim().to_string()
        };
        let (vi_template_id, general_template_id, title) = match source.as_str() {
            "group" => (None, None, item.name),
            "general" => {
                if item.general_template_id.is_none() {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorBody {
                            error: format!("items[{i}].general_template_id is required"),
                        }),
                    )
                        .into_response();
                }
                (None, item.general_template_id, String::new())
            }
            _ => {
                if item.vi_template_id.is_none() {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorBody {
                            error: format!("items[{i}].vi_template_id is required"),
                        }),
                    )
                        .into_response();
                }
                (item.vi_template_id, None, String::new())
            }
        };
        let limits_json = match serde_json::to_string(&item.limits) {
            Ok(v) => v,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: format!("items[{i}].limits: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let inputs_json = match item.inputs {
            Some(inputs) => match serde_json::to_string(&inputs) {
                Ok(v) => Some(v),
                Err(err) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(ErrorBody {
                            error: format!("items[{i}].inputs: {err}"),
                        }),
                    )
                        .into_response();
                }
            },
            None => None,
        };
        let resources_raw = match serde_json::to_string(&item.resources) {
            Ok(v) => v,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: format!("items[{i}].resources: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let resources = match parse_resources_json(&resources_raw) {
            Ok(v) => v,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: format!("items[{i}].resources: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let resources_json = serde_json::to_string(&resources).unwrap_or_else(|_| "[]".into());
        let spec_metrics_raw = match serde_json::to_string(&item.spec_metrics) {
            Ok(v) => v,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: format!("items[{i}].spec_metrics: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let spec_metrics = match parse_spec_metrics_json(&spec_metrics_raw) {
            Ok(v) => v,
            Err(err) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: format!("items[{i}].spec_metrics: {err}"),
                    }),
                )
                    .into_response();
            }
        };
        let spec_metrics_json = serde_json::to_string(&spec_metrics).unwrap_or_else(|_| "[]".into());
        items.push(ViRunQueueReplaceItem {
            template_source: source,
            vi_template_id,
            general_template_id,
            inputs_json,
            enabled: item.enabled,
            // Breakpoints removed: accept field but persist false.
            breakpoint: false,
            fail_policy: item.fail_policy,
            limits_json,
            note: item.note,
            title,
            collapsed: item.collapsed,
            resources_json,
            spec_template_id: item.spec_template_id,
            spec_section: item.spec_section,
            spec_metrics_json,
        });
    }

    match s.store.replace_vi_run_queue(&id, &items).await {
        Ok(items) => match vi_run_queue_views(items) {
            Ok(views) => (
                StatusCode::OK,
                Json(ViRunQueueListResponse { items: views }),
            )
                .into_response(),
            Err(e) => {
                tracing::error!("vi run queue view: {e}");
                db_error().into_response()
            }
        },
        Err(e) => queue_replace_error_response(e).into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct CreateTestRunRequest {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    run_generation: i64,
    overall: String,
    stopped: bool,
    failed_at: Option<i32>,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    #[serde(default)]
    context: CreateTestRunContext,
    #[serde(default)]
    steps: Vec<CreateTestRunStep>,
}

#[derive(Debug, Default, Deserialize)]
struct CreateTestRunContext {
    #[serde(default)]
    sn: String,
    #[serde(default)]
    work_order: String,
    #[serde(default)]
    product_pn: String,
    #[serde(default)]
    corner: String,
    #[serde(default)]
    hostname: String,
    config_revision: Option<i64>,
    #[serde(default)]
    device_profile_id: String,
    #[serde(default)]
    device_profile_name: String,
    #[serde(default)]
    calibration_profile_id: String,
    #[serde(default)]
    calibration_profile_name: String,
}

#[derive(Debug, Deserialize)]
struct CreateTestRunStep {
    position: i32,
    queue_item_id: String,
    template_id: String,
    template_source: String,
    name: String,
    kind: String,
    ok: bool,
    status: String,
    #[serde(default)]
    elapsed_ms: i64,
    measured: Option<serde_json::Value>,
    limits: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<String>,
    spec_template_id: Option<i64>,
    #[serde(default)]
    spec_section: String,
}

#[derive(Debug, Deserialize)]
struct TestRunListParams {
    agent_id: Option<String>,
    overall: Option<String>,
    sn: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize)]
struct TestRunDetailView {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    run_generation: i64,
    overall: String,
    stopped: bool,
    failed_at: Option<i32>,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    created_at: String,
    context: TestRunContextView,
    steps: Vec<TestRunStepView>,
}

#[derive(Debug, Serialize)]
struct TestRunContextView {
    sn: String,
    work_order: String,
    product_pn: String,
    corner: String,
    hostname: String,
    config_revision: Option<i64>,
    device_profile_id: String,
    device_profile_name: String,
    calibration_profile_id: String,
    calibration_profile_name: String,
}

#[derive(Debug, Serialize)]
struct TestRunStepView {
    position: i32,
    queue_item_id: String,
    template_id: String,
    template_source: String,
    name: String,
    kind: String,
    ok: bool,
    status: String,
    elapsed_ms: i64,
    measured: Option<serde_json::Value>,
    limits: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<String>,
    spec_template_id: Option<i64>,
    spec_section: String,
}

#[derive(Debug, Serialize)]
struct TestRunListItemView {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    overall: String,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    sn: String,
    work_order: String,
    hostname: String,
}

#[derive(Debug, Serialize)]
struct TestRunListResponse {
    items: Vec<TestRunListItemView>,
    total: i64,
}

fn store_error(e: sqlx::Error) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            error: e.to_string(),
        }),
    )
}

fn bad_request(error: impl Into<String>) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            error: error.into(),
        }),
    )
}

fn validate_create_test_run(req: &CreateTestRunRequest) -> Option<&'static str> {
    if req.id.trim().is_empty() {
        return Some("id is required");
    }
    if !matches!(req.overall.as_str(), "pass" | "fail" | "error" | "aborted") {
        return Some("overall must be pass, fail, error, or aborted");
    }
    if req.channel_index < 0 {
        return Some("channel_index must be non-negative");
    }
    if req.started_at.trim().is_empty() {
        return Some("started_at is required");
    }
    if req.finished_at.trim().is_empty() {
        return Some("finished_at is required");
    }
    None
}

impl From<TestRunContext> for TestRunContextView {
    fn from(c: TestRunContext) -> Self {
        Self {
            sn: c.sn,
            work_order: c.work_order,
            product_pn: c.product_pn,
            corner: c.corner,
            hostname: c.hostname,
            config_revision: c.config_revision,
            device_profile_id: c.device_profile_id,
            device_profile_name: c.device_profile_name,
            calibration_profile_id: c.calibration_profile_id,
            calibration_profile_name: c.calibration_profile_name,
        }
    }
}

impl From<TestRunStep> for TestRunStepView {
    fn from(s: TestRunStep) -> Self {
        Self {
            position: s.position,
            queue_item_id: s.queue_item_id,
            template_id: s.template_id,
            template_source: s.template_source,
            name: s.name,
            kind: s.kind,
            ok: s.ok,
            status: s.status,
            elapsed_ms: s.elapsed_ms,
            measured: s.measured,
            limits: s.limits,
            result: s.result,
            error: s.error,
            spec_template_id: s.spec_template_id,
            spec_section: s.spec_section,
        }
    }
}

impl From<TestRunDetail> for TestRunDetailView {
    fn from(d: TestRunDetail) -> Self {
        Self {
            id: d.id,
            agent_id: d.agent_id,
            channel_index: d.channel_index,
            channel_name: d.channel_name,
            sequence_template_id: d.sequence_template_id,
            run_generation: d.run_generation,
            overall: d.overall,
            stopped: d.stopped,
            failed_at: d.failed_at,
            elapsed_ms: d.elapsed_ms,
            started_at: d.started_at,
            finished_at: d.finished_at,
            created_at: d.created_at,
            context: d.context.into(),
            steps: d.steps.into_iter().map(TestRunStepView::from).collect(),
        }
    }
}

impl From<TestRunListItem> for TestRunListItemView {
    fn from(i: TestRunListItem) -> Self {
        Self {
            id: i.id,
            agent_id: i.agent_id,
            channel_index: i.channel_index,
            channel_name: i.channel_name,
            sequence_template_id: i.sequence_template_id,
            overall: i.overall,
            elapsed_ms: i.elapsed_ms,
            started_at: i.started_at,
            finished_at: i.finished_at,
            sn: i.sn,
            work_order: i.work_order,
            hostname: i.hostname,
        }
    }
}

impl CreateTestRunRequest {
    fn into_new(self) -> NewTestRun {
        NewTestRun {
            id: self.id.trim().to_string(),
            agent_id: self.agent_id,
            channel_index: self.channel_index,
            channel_name: self.channel_name,
            sequence_template_id: self.sequence_template_id,
            run_generation: self.run_generation,
            overall: self.overall,
            stopped: self.stopped,
            failed_at: self.failed_at,
            elapsed_ms: self.elapsed_ms,
            started_at: self.started_at,
            finished_at: self.finished_at,
            context: NewTestRunContext {
                sn: self.context.sn,
                work_order: self.context.work_order,
                product_pn: self.context.product_pn,
                corner: self.context.corner,
                hostname: self.context.hostname,
                config_revision: self.context.config_revision,
                device_profile_id: self.context.device_profile_id,
                device_profile_name: self.context.device_profile_name,
                calibration_profile_id: self.context.calibration_profile_id,
                calibration_profile_name: self.context.calibration_profile_name,
            },
            steps: self
                .steps
                .into_iter()
                .map(|s| NewTestRunStep {
                    position: s.position,
                    queue_item_id: s.queue_item_id,
                    template_id: s.template_id,
                    template_source: s.template_source,
                    name: s.name,
                    kind: s.kind,
                    ok: s.ok,
                    status: s.status,
                    elapsed_ms: s.elapsed_ms,
                    measured: s.measured,
                    limits: s.limits,
                    result: s.result,
                    error: s.error,
                    spec_template_id: s.spec_template_id,
                    spec_section: s.spec_section,
                })
                .collect(),
        }
    }
}

async fn create_test_run(
    State(s): State<AppState>,
    Json(req): Json<CreateTestRunRequest>,
) -> impl IntoResponse {
    if let Some(msg) = validate_create_test_run(&req) {
        return bad_request(msg).into_response();
    }

    if let Some(agent_id) = req.agent_id.as_deref() {
        match s.store.agent_exists(agent_id).await {
            Ok(true) => {}
            Ok(false) => {
                return bad_request("unknown agent_id").into_response();
            }
            Err(e) => return store_error(e).into_response(),
        }
    }

    match s.store.insert_test_run(req.into_new()).await {
        Ok(outcome) => {
            let status = if outcome.created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(TestRunDetailView::from(outcome.detail))).into_response()
        }
        Err(e) => store_error(e).into_response(),
    }
}

async fn list_test_runs(
    State(s): State<AppState>,
    Query(params): Query<TestRunListParams>,
) -> impl IntoResponse {
    let query = TestRunListQuery {
        agent_id: params.agent_id,
        overall: params.overall,
        sn: params.sn,
        from: params.from,
        to: params.to,
        limit: params.limit.unwrap_or(100),
        offset: params.offset.unwrap_or(0),
    };
    match s.store.list_test_runs(query).await {
        Ok(page) => (
            StatusCode::OK,
            Json(TestRunListResponse {
                items: page.items.into_iter().map(TestRunListItemView::from).collect(),
                total: page.total,
            }),
        )
            .into_response(),
        Err(e) => store_error(e).into_response(),
    }
}

async fn get_test_run(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match s.store.get_test_run(&id).await {
        Ok(Some(detail)) => (StatusCode::OK, Json(TestRunDetailView::from(detail))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "test run not found".into(),
            }),
        )
            .into_response(),
        Err(e) => store_error(e).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::Request,
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;


    struct TestApp {
        router: Router,
        _db: crate::db::TestDb,
    }

    async fn test_app() -> TestApp {
        let db = crate::db::TestDb::create().await;
        TestApp {
            router: router(AppState {
                store: Store::new(db.pool.clone()),
            }),
            _db: db,
        }
    }

    fn register_request(name: &str, ip: &str, port: u16) -> Request<Body> {
        let body = RegisterAgentRequest {
            name: name.into(),
            ip: ip.into(),
            port,
        };
        Request::builder()
            .method("POST")
            .uri("/api/agents/register")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }


    async fn register_agent_id(app: &Router) -> String {
        let resp = app
            .clone()
            .oneshot(register_request("LINE-01", "192.168.1.20", 26631))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let agent: AgentView = serde_json::from_slice(&bytes).unwrap();
        agent.id
    }

    async fn register_agent_at(app: &Router, ip: &str, port: u16) -> String {
        let resp = app
            .clone()
            .oneshot(register_request("mock-agent", ip, port))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let agent: AgentView = serde_json::from_slice(&bytes).unwrap();
        agent.id
    }
    fn json_request(method: &str, uri: &str, body: &impl Serialize) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap()
    }










    #[tokio::test]
    async fn register_upsert_via_http() {
        let test = test_app().await;
        let app = &test.router;
        let resp = app
            .clone()
            .oneshot(register_request("LINE-01", "192.168.1.20", 26631))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let first: AgentView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(first.name, "LINE-01");
        assert_eq!(first.ip, "192.168.1.20");
        assert_eq!(first.port, 26631);
        assert_eq!(first.status, "offline");

        let resp = app
            .clone()
            .oneshot(register_request("LINE-01", "192.168.1.20", 26631))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let second: AgentView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(first.id, second.id);
    }

    #[tokio::test]
    async fn register_rejects_invalid_fields() {
        let test = test_app().await;
        let app = &test.router;
        for (name, ip, port) in [
            ("", "1.2.3.4", 26631),
            ("n", "", 26631),
            ("n", "1.2.3.4", 0),
        ] {
            let resp = app
                .clone()
                .oneshot(register_request(name, ip, port))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
            assert!(!err.error.is_empty());
        }
    }

    #[tokio::test]
    async fn vi_template_crud_via_http() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let create_body = serde_json::json!({
            "agent_id": agent_id,
            "name": "Add",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\labview-runner-cli\labview-runner-cli.exe",
            "getinfo_path": r"C:\labview-runner-cli\getinfo.vi",
            "inputs": [{"name":"a","className":"Digital","value":3.0}],
            "show_front_panel": true,
            "timeout_secs": 30
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &create_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let created: ViTemplateView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created.name, "Add");
        assert_eq!(created.origin_agent_id, agent_id);
        assert_eq!(created.vi_path, r"C:\x\Add.vi");
        assert!(created.show_front_panel);
        assert_eq!(created.timeout_secs, Some(30));
        assert!(created.inputs.is_array());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/vi-templates")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<ViTemplateView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.id);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/vi-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let got: ViTemplateView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(got.id, created.id);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/vi-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/vi-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_vi_template_rejects_unknown_agent() {
        let test = test_app().await;
        let app = &test.router;
        let unknown_id = "00000000-0000-0000-0000-000000000000";

        let create_body = serde_json::json!({
            "agent_id": unknown_id,
            "name": "Add",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": []
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &create_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");
    }

    async fn create_vi_template_http(
        app: &Router,
        agent_id: &str,
        name: &str,
        vi_path: &str,
    ) -> (StatusCode, ViTemplateView) {
        let body = serde_json::json!({
            "agent_id": agent_id,
            "name": name,
            "vi_path": vi_path,
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": []
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body))
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let view: ViTemplateView = serde_json::from_slice(&bytes).unwrap();
        (status, view)
    }

    #[tokio::test]
    async fn list_vi_templates_filter_by_agent_query() {
        let test = test_app().await;
        let app = &test.router;
        let agent_a = register_agent_at(app, "192.168.1.10", 26631).await;
        let agent_b = register_agent_at(app, "192.168.1.11", 26632).await;

        let (_, tpl_a) = create_vi_template_http(app, &agent_a, "A", r"C:\a.vi").await;
        let (_, tpl_b) = create_vi_template_http(app, &agent_b, "B", r"C:\b.vi").await;
        assert_eq!(tpl_a.origin_agent_id, agent_a);
        assert_eq!(tpl_b.origin_agent_id, agent_b);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/vi-templates?agent_id={agent_a}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<ViTemplateView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, tpl_a.id);
        assert_eq!(list[0].name, "A");
    }

    #[tokio::test]
    async fn create_same_path_twice_two_ids() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let (status1, first) =
            create_vi_template_http(app, &agent_id, "First", r"C:\x\Add.vi").await;
        assert_eq!(status1, StatusCode::CREATED);
        let (status2, second) =
            create_vi_template_http(app, &agent_id, "Second", r"C:\x\Add.vi").await;
        assert_eq!(status2, StatusCode::CREATED);
        assert_ne!(second.id, first.id);
        assert_eq!(second.origin_agent_id, agent_id);
    }

    #[tokio::test]
    async fn create_same_name_and_inputs_conflict() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let inputs = serde_json::json!([{"name":"a","className":"Digital","value":1.0}]);

        let body = serde_json::json!({
            "agent_id": agent_id,
            "name": "Add",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": inputs,
            "show_front_panel": false,
            "timeout_secs": null
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let body2 = serde_json::json!({
            "agent_id": agent_id,
            "name": "Add",
            "vi_path": r"C:\y\Other.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": inputs,
            "show_front_panel": true,
            "timeout_secs": 10
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body2))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert!(err.error.contains("same name and inputs"));
    }

    #[tokio::test]
    async fn create_same_name_different_inputs_ok() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let body1 = serde_json::json!({
            "agent_id": agent_id,
            "name": "Add",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": [{"name":"a","className":"Digital","value":1.0}],
            "show_front_panel": false
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body1))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let body2 = serde_json::json!({
            "agent_id": agent_id,
            "name": "Add",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": [{"name":"a","className":"Digital","value":2.0}],
            "show_front_panel": false
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body2))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn create_requires_name() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let body = serde_json::json!({
            "agent_id": agent_id,
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": []
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = serde_json::json!({
            "agent_id": agent_id,
            "name": "",
            "vi_path": r"C:\x\Add.vi",
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": []
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "name is required");
    }

    #[tokio::test]
    async fn patch_vi_template_renames() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let (_, created) =
            create_vi_template_http(app, &agent_id, "Original", r"C:\x\Add.vi").await;

        let patch_body = serde_json::json!({ "name": "Renamed" });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PATCH",
                &format!("/api/vi-templates/{}", created.id),
                &patch_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let updated: ViTemplateView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Renamed");
    }




    async fn create_vi_template_with_inputs_http(
        app: &Router,
        agent_id: &str,
        name: &str,
        vi_path: &str,
        inputs: serde_json::Value,
        show_front_panel: bool,
        timeout_secs: Option<i64>,
    ) -> ViTemplateView {
        let body = serde_json::json!({
            "agent_id": agent_id,
            "name": name,
            "vi_path": vi_path,
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": inputs,
            "show_front_panel": show_front_panel,
            "timeout_secs": timeout_secs
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/vi-templates", &body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn run_queue_put_persists_resources() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let tpl = create_vi_template_with_inputs_http(
            app,
            &agent_id,
            "ResTpl",
            r"C:\res.vi",
            serde_json::json!([]),
            false,
            None,
        )
        .await;

        let put_body = serde_json::json!({
            "items": [{
                "vi_template_id": tpl.id,
                "resources": ["station.dca"]
            }]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/agents/{agent_id}/run-queue"),
                &put_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let put_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(put_list.items.len(), 1);
        assert_eq!(put_list.items[0].resources, vec!["station.dca".to_string()]);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/run-queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let get_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(get_list.items.len(), 1);
        assert_eq!(get_list.items[0].resources, vec!["station.dca".to_string()]);
    }

    #[tokio::test]
    async fn vi_run_queue_put_get_round_trip() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let tpl_a = create_vi_template_with_inputs_http(
            app,
            &agent_id,
            "A",
            r"C:\a.vi",
            serde_json::json!([{"name":"x","value":1.0}]),
            true,
            Some(45),
        )
        .await;
        let tpl_b = create_vi_template_with_inputs_http(
            app,
            &agent_id,
            "B",
            r"C:\b.vi",
            serde_json::json!([{"name":"y","value":2.0}]),
            false,
            None,
        )
        .await;

        let put_meta_body = serde_json::json!({
            "items": [{
                "vi_template_id": tpl_a.id,
                "enabled": false,
                "breakpoint": true,
                "fail_policy": "continue",
                "limits": [{"output":"x","min":0,"max":1}],
                "note": "n1"
            }]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/agents/{agent_id}/run-queue"),
                &put_meta_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let put_meta_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(put_meta_list.items.len(), 1);
        let meta_item = &put_meta_list.items[0];
        assert_eq!(meta_item.vi_template_id, Some(tpl_a.id));
        assert!(!meta_item.enabled);
        // Breakpoints removed: PUT accepts the field but persists/returns false.
        assert!(!meta_item.breakpoint);
        assert_eq!(meta_item.fail_policy, "continue");
        assert_eq!(
            meta_item.limits,
            serde_json::json!([{"output":"x","min":0,"max":1}])
        );
        assert_eq!(meta_item.note, "n1");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/run-queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let get_meta_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(get_meta_list.items.len(), 1);
        let get_meta_item = &get_meta_list.items[0];
        assert_eq!(get_meta_item.vi_template_id, Some(tpl_a.id));
        assert!(!get_meta_item.enabled);
        assert!(!get_meta_item.breakpoint);
        assert_eq!(get_meta_item.fail_policy, "continue");
        assert_eq!(
            get_meta_item.limits,
            serde_json::json!([{"output":"x","min":0,"max":1}])
        );
        assert_eq!(get_meta_item.note, "n1");

        let put_body = serde_json::json!({
            "items": [
                { "vi_template_id": tpl_b.id },
                { "vi_template_id": tpl_a.id }
            ]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/agents/{agent_id}/run-queue"),
                &put_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let put_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(put_list.items.len(), 2);
        assert_eq!(put_list.items[0].position, 0);
        assert_eq!(put_list.items[0].vi_template_id, Some(tpl_b.id));
        assert_eq!(put_list.items[0].name, "B");
        assert_eq!(put_list.items[0].vi_path, r"C:\b.vi");
        assert!(!put_list.items[0].show_front_panel);
        assert_eq!(put_list.items[0].timeout_secs, None);
        assert_eq!(put_list.items[1].position, 1);
        assert_eq!(put_list.items[1].vi_template_id, Some(tpl_a.id));
        assert_eq!(put_list.items[1].name, "A");
        assert!(put_list.items[1].show_front_panel);
        assert_eq!(put_list.items[1].timeout_secs, Some(45));
        assert!(put_list.items[1].inputs.is_array());
        assert!(put_list.items[0].enabled);
        assert!(!put_list.items[0].breakpoint);
        assert_eq!(put_list.items[0].fail_policy, "stop");
        assert_eq!(put_list.items[0].limits, serde_json::json!([]));
        assert_eq!(put_list.items[0].note, "");
        assert!(put_list.items[1].enabled);
        assert!(!put_list.items[1].breakpoint);
        assert_eq!(put_list.items[1].fail_policy, "stop");
        assert_eq!(put_list.items[1].limits, serde_json::json!([]));
        assert_eq!(put_list.items[1].note, "");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/run-queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let get_list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(get_list.items.len(), 2);
        assert_eq!(get_list.items[0].vi_template_id, Some(tpl_b.id));
        assert_eq!(get_list.items[1].vi_template_id, Some(tpl_a.id));
        assert_eq!(get_list.items[1].inputs, tpl_a.inputs);
    }

    #[tokio::test]
    async fn vi_run_queue_put_allows_other_agents_template() {
        let test = test_app().await;
        let app = &test.router;
        let agent_a = register_agent_at(app, "192.168.1.10", 26631).await;
        let agent_b = register_agent_at(app, "192.168.1.11", 26632).await;
        let (_, tpl_b) = create_vi_template_http(app, &agent_b, "B", r"C:\b.vi").await;

        let put_body = serde_json::json!({
            "items": [{ "vi_template_id": tpl_b.id }]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/agents/{agent_a}/run-queue"),
                &put_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: ViRunQueueListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].vi_template_id, Some(tpl_b.id));
    }

    #[tokio::test]
    async fn spec_template_crud_via_http() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let create_body = serde_json::json!({
            "name": "AS0805 Spec",
            "ini_text": "[FMT_HT]\nTX_AP_UL=4\nTX_AP_LL=-2\n",
            "source_filename": "Tunn_FMT_Spec.ini",
            "created_by_agent_id": agent_id
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/spec-templates", &create_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let created: SpecTemplateListItemView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created.name, "AS0805 Spec");
        assert_eq!(created.source_filename, "Tunn_FMT_Spec.ini");
        assert_eq!(created.section_count, 1);
        assert_eq!(created.created_by_agent_name.as_deref(), Some("LINE-01"));

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/spec-templates")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 1);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/spec-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let detail: SpecTemplateDetailView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(detail.id, created.id);
        assert_eq!(detail.section_count, 1);
        assert!(detail.spec.get("sections").unwrap().get("FMT_HT").is_some());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/spec-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/spec-templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn spec_template_create_rejects_invalid_ini() {
        let test = test_app().await;
        let app = &test.router;

        let create_body = serde_json::json!({
            "ini_text": "not a valid spec file\n",
            "source_filename": "bad.ini"
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/spec-templates", &create_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert!(!err.error.is_empty());
    }

    #[tokio::test]
    async fn vi_run_queue_unknown_agent_404() {
        let test = test_app().await;
        let app = &test.router;
        let unknown_id = "00000000-0000-0000-0000-000000000000";

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{unknown_id}/run-queue"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");

        let put_body = serde_json::json!({ "items": [] });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/agents/{unknown_id}/run-queue"),
                &put_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");
    }

    fn sample_test_run_body(agent_id: &str, id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "agent_id": agent_id,
            "channel_index": 0,
            "channel_name": "CH0",
            "sequence_template_id": null,
            "run_generation": 1,
            "overall": "pass",
            "stopped": false,
            "failed_at": null,
            "elapsed_ms": 10,
            "started_at": "2026-08-15T14:00:00+00:00",
            "finished_at": "2026-08-15T14:01:00+00:00",
            "context": { "sn": "SN001", "work_order": "WO-1", "hostname": "ATE01" },
            "steps": [{
                "position": 1,
                "queue_item_id": "q-1",
                "template_id": "12",
                "template_source": "labview",
                "name": "TX_AP",
                "kind": "labview",
                "ok": true,
                "status": "pass",
                "elapsed_ms": 8,
                "measured": {"TX_AP": 1.2},
                "limits": [],
                "result": {"TX_AP": "pass"},
                "error": null,
                "spec_template_id": null,
                "spec_section": "FMT_HT"
            }]
        })
    }

    #[tokio::test]
    async fn test_run_post_get_list_and_idempotent() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let body = sample_test_run_body(&agent_id, "api-run-1");

        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app.clone().oneshot(
            Request::builder().uri("/api/test-runs/api-run-1").body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let detail: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(detail["context"]["sn"], "SN001");
        assert_eq!(detail["steps"].as_array().unwrap().len(), 1);

        let resp = app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/test-runs?agent_id={agent_id}&overall=pass&sn=SN001"))
                .body(Body::empty())
                .unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let page: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["id"], "api-run-1");
    }

    #[tokio::test]
    async fn test_run_post_rejects_bad_overall_empty_id_and_unknown_agent() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let mut bad = sample_test_run_body(&agent_id, "x");
        bad["overall"] = serde_json::json!("maybe");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let mut bad = sample_test_run_body(&agent_id, "");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let mut bad = sample_test_run_body("missing-agent", "y");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_run_unknown_sequence_template_still_created() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let mut body = sample_test_run_body(&agent_id, "api-run-tpl");
        body["sequence_template_id"] = serde_json::json!(999999);
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let detail: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert!(detail["sequence_template_id"].is_null());
    }

    #[tokio::test]
    async fn test_run_get_missing_is_404() {
        let test = test_app().await;
        let resp = test.router.clone().oneshot(
            Request::builder().uri("/api/test-runs/nope").body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
