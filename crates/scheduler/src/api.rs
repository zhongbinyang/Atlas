use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{ErrorBody, RegisterAgentRequest};
use serde::{Deserialize, Serialize};

use crate::store::{
    Agent, GeneralTemplateEnriched, QueueReplaceError,
    SequenceTemplateEnriched, SequenceTemplateStep, Store,
    ViRunQueueItem, ViRunQueueReplaceItem, ViTemplateEnriched,
    ViTemplatePatch,
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
        breakpoint: step.breakpoint,
        fail_policy: step.fail_policy,
        limits: parse_json_text(&step.limits_json, "limits_json")?,
        note: step.note,
        name,
        collapsed: step.collapsed,
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
}

fn vi_run_queue_item_view(item: ViRunQueueItem) -> Result<ViRunQueueItemView, String> {
    let inputs: serde_json::Value = serde_json::from_str(&item.inputs_json)
        .map_err(|err| format!("invalid inputs_json: {err}"))?;
    let outputs: serde_json::Value = serde_json::from_str(&item.outputs_json)
        .map_err(|err| format!("invalid outputs_json: {err}"))?;
    let limits: serde_json::Value = serde_json::from_str(&item.limits_json)
        .map_err(|err| format!("invalid limits_json: {err}"))?;
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
        breakpoint: item.breakpoint,
        fail_policy: item.fail_policy,
        limits,
        note: item.note,
        collapsed: item.collapsed,
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
        .route(
            "/api/agents/{id}/run-queue",
            get(get_vi_run_queue).put(put_vi_run_queue),
        )
        .route(
            "/api/agents/{id}/settings",
            get(get_agent_settings).put(put_agent_settings),
        )
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

fn deserialize_units_flex<'de, D>(
    deserializer: D,
) -> Result<Vec<crate::store::AgentUnit>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
    let raw = serde_json::to_string(&value).unwrap_or_else(|_| "[]".into());
    Ok(common::parse_units_json(&raw))
}

fn validate_agent_settings(
    units: &[crate::store::AgentUnit],
    variables: &[crate::store::AgentVariable],
) -> Option<String> {
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
        if !name
            .chars()
            .enumerate()
            .all(|(i, c)| {
                if i == 0 {
                    c.is_ascii_alphabetic() || c == '_'
                } else {
                    c.is_ascii_alphanumeric() || c == '_'
                }
            })
        {
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
    match s.store.get_agent_settings(&id).await {
        Ok(settings) => (
            StatusCode::OK,
            Json(AgentSettingsView {
                units: settings.units,
                variables: settings.variables,
                updated_at: settings.updated_at,
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent settings: {e}");
            db_error().into_response()
        }
    }
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
    let units: Vec<crate::store::AgentUnit> = body
        .units
        .into_iter()
        .map(|u| crate::store::AgentUnit {
            symbol: u.symbol.trim().to_string(),
            description: u.description.trim().to_string(),
        })
        .filter(|u| !u.symbol.is_empty())
        .collect();
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
    if let Some(msg) = validate_agent_settings(&units, &variables) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg }),
        )
            .into_response();
    }
    match s.store.upsert_agent_settings(&id, &units, &variables).await {
        Ok(settings) => (
            StatusCode::OK,
            Json(AgentSettingsView {
                units: settings.units,
                variables: settings.variables,
                updated_at: settings.updated_at,
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("upsert agent settings: {e}");
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
        items.push(ViRunQueueReplaceItem {
            template_source: source,
            vi_template_id,
            general_template_id,
            inputs_json,
            enabled: item.enabled,
            breakpoint: item.breakpoint,
            fail_policy: item.fail_policy,
            limits_json,
            note: item.note,
            title,
            collapsed: item.collapsed,
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
        assert!(meta_item.breakpoint);
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
        assert!(get_meta_item.breakpoint);
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
}
