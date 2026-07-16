use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, Request, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{ErrorBody, RegisterAgentRequest};
use serde::{Deserialize, Serialize};

use crate::screenshot::{capture_and_archive, CaptureError};
use crate::store::{
    Agent, CreateTaskParams, Screenshot, Store, Task, TaskTemplate, UpdateTemplateParams,
    ViTemplateEnriched,
};
use crate::vi_distribute::{distribute_template, DistributeViTemplateResponse};

pub use crate::vi_distribute::DistributeResultItem;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub client: reqwest::Client,
    /// LabVIEW inspect/run/config can block for minutes; keep a longer timeout than `client`.
    pub labview_client: reqwest::Client,
    pub screenshot_dir: String,
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
pub struct TemplateView {
    pub id: String,
    pub name: String,
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: i64,
    pub created_at: String,
}

impl From<TaskTemplate> for TemplateView {
    fn from(t: TaskTemplate) -> Self {
        Self {
            id: t.id,
            name: t.name,
            shell: t.shell,
            command: t.command,
            workdir: t.workdir,
            timeout_secs: t.timeout_secs,
            created_at: t.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskView {
    pub id: String,
    pub agent_id: String,
    pub source: String,
    pub template_id: Option<String>,
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: i64,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub agent_task_id: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl From<Task> for TaskView {
    fn from(t: Task) -> Self {
        Self {
            id: t.id,
            agent_id: t.agent_id,
            source: t.source,
            template_id: t.template_id,
            shell: t.shell,
            command: t.command,
            workdir: t.workdir,
            timeout_secs: t.timeout_secs,
            status: t.status,
            exit_code: t.exit_code,
            stdout: t.stdout,
            stderr: t.stderr,
            agent_task_id: t.agent_task_id,
            created_at: t.created_at,
            started_at: t.started_at,
            finished_at: t.finished_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    #[serde(default = "default_shell")]
    pub shell: String,
    pub command: String,
    pub workdir: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTemplateRequest {
    pub name: Option<String>,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub workdir: Option<Option<String>>,
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViTemplateView {
    pub id: String,
    pub name: String,
    pub agent_id: String,
    pub origin_agent_id: String,
    pub agent_name: String,
    pub origin_agent_name: String,
    pub vi_path: String,
    pub cli_path: String,
    pub getinfo_path: String,
    pub inputs: serde_json::Value,
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
    pub created_at: String,
}

fn agent_display_name(name: Option<String>) -> String {
    name.filter(|n| !n.is_empty())
        .unwrap_or_else(|| "未知".into())
}

impl TryFrom<ViTemplateEnriched> for ViTemplateView {
    type Error = String;

    fn try_from(e: ViTemplateEnriched) -> Result<Self, Self::Error> {
        let inputs: serde_json::Value = serde_json::from_str(&e.template.inputs_json)
            .map_err(|err| format!("invalid inputs_json: {err}"))?;
        Ok(Self {
            id: e.template.id,
            name: e.template.name,
            agent_id: e.template.agent_id,
            origin_agent_id: e.template.origin_agent_id,
            agent_name: agent_display_name(e.agent_name),
            origin_agent_name: agent_display_name(e.origin_agent_name),
            vi_path: e.template.vi_path,
            cli_path: e.template.cli_path,
            getinfo_path: e.template.getinfo_path,
            inputs,
            show_front_panel: e.template.show_front_panel,
            timeout_secs: e.template.timeout_secs,
            created_at: e.template.created_at,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct ListViTemplatesQuery {
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DistributeViTemplateRequest {
    pub target_agent_ids: Vec<String>,
    pub vi_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateViTemplateRequest {
    pub agent_id: String,
    pub vi_path: String,
    pub cli_path: String,
    pub getinfo_path: String,
    pub inputs: serde_json::Value,
    pub name: Option<String>,
    #[serde(default)]
    pub show_front_panel: bool,
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub agent_id: String,
    pub template_id: Option<String>,
    pub shell: Option<String>,
    pub command: Option<String>,
    pub workdir: Option<String>,
    pub timeout_secs: Option<i64>,
}

fn default_shell() -> String {
    "cmd".into()
}

fn default_timeout() -> i64 {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotView {
    pub id: String,
    pub agent_id: String,
    pub file_path: String,
    pub content_type: String,
    pub byte_size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub created_at: String,
}

impl From<Screenshot> for ScreenshotView {
    fn from(s: Screenshot) -> Self {
        Self {
            id: s.id,
            agent_id: s.agent_id,
            file_path: s.file_path,
            content_type: s.content_type,
            byte_size: s.byte_size,
            width: s.width,
            height: s.height,
            created_at: s.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ListScreenshotsQuery {
    #[serde(default = "default_list_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_list_limit() -> i64 {
    50
}

fn clamp_list_limit(limit: i64) -> i64 {
    limit.clamp(1, 200)
}

fn capture_error_response(err: CaptureError) -> (StatusCode, Json<ErrorBody>) {
    match err {
        CaptureError::AgentNotFound => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        ),
        CaptureError::Unreachable(msg) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody { error: msg }),
        ),
        CaptureError::BadImage(msg) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody { error: msg }),
        ),
        CaptureError::Io(msg) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody { error: msg }),
        ),
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
            "/api/templates",
            get(list_templates).post(create_template),
        )
        .route(
            "/api/templates/{id}",
            get(get_template)
                .put(update_template)
                .delete(delete_template),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{id}", get(get_task))
        .route(
            "/api/vi-templates",
            get(list_vi_templates).post(create_vi_template),
        )
        .route(
            "/api/vi-templates/{id}",
            get(get_vi_template).delete(delete_vi_template),
        )
        .route(
            "/api/vi-templates/{id}/distribute",
            post(distribute_vi_template),
        )
        .route(
            "/api/agents/{id}/screenshots",
            get(list_agent_screenshots).post(capture_agent_screenshot),
        )
        .route("/api/agents/{id}/files", get(list_agent_files))
        .route("/api/agents/{id}/files/content", get(get_agent_file_content))
        .route(
            "/api/agents/{id}/labview/config",
            get(proxy_labview_config),
        )
        .route(
            "/api/agents/{id}/labview/inspect",
            post(proxy_labview_inspect),
        )
        .route("/api/agents/{id}/labview/run", post(proxy_labview_run))
        .route("/api/screenshots/{id}", get(get_screenshot))
        .route("/api/screenshots/{id}/image", get(get_screenshot_image))
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

fn validate_template_create(req: &CreateTemplateRequest) -> Option<&'static str> {
    if req.name.trim().is_empty() {
        return Some("name is required");
    }
    if req.command.trim().is_empty() {
        return Some("command is required");
    }
    if req.shell.trim().is_empty() {
        return Some("shell is required");
    }
    if req.timeout_secs == 0 {
        return Some("timeout_secs must be greater than 0");
    }
    None
}

async fn list_templates(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_templates().await {
        Ok(templates) => {
            let views: Vec<TemplateView> = templates.into_iter().map(TemplateView::from).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list templates: {e}");
            db_error().into_response()
        }
    }
}

async fn create_template(
    State(s): State<AppState>,
    Json(req): Json<CreateTemplateRequest>,
) -> impl IntoResponse {
    if let Some(msg) = validate_template_create(&req) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: msg.into() }),
        )
            .into_response();
    }
    match s
        .store
        .create_template(
            req.name.trim(),
            req.shell.trim(),
            req.command.trim(),
            req.workdir.as_deref(),
            req.timeout_secs,
        )
        .await
    {
        Ok(template) => (StatusCode::CREATED, Json(TemplateView::from(template))).into_response(),
        Err(e) => {
            tracing::error!("create template: {e}");
            db_error().into_response()
        }
    }
}

async fn get_template(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match s.store.get_template(&id).await {
        Ok(Some(template)) => (StatusCode::OK, Json(TemplateView::from(template))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get template: {e}");
            db_error().into_response()
        }
    }
}

async fn update_template(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTemplateRequest>,
) -> impl IntoResponse {
    match s
        .store
        .update_template(
            &id,
            UpdateTemplateParams {
                name: req.name,
                shell: req.shell,
                command: req.command,
                workdir: req.workdir,
                timeout_secs: req.timeout_secs,
            },
        )
        .await
    {
        Ok(Some(template)) => (StatusCode::OK, Json(TemplateView::from(template))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("update template: {e}");
            db_error().into_response()
        }
    }
}

async fn delete_template(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.delete_template(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "template not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("delete template: {e}");
            db_error().into_response()
        }
    }
}

async fn list_tasks(State(s): State<AppState>) -> impl IntoResponse {
    match s.store.list_tasks().await {
        Ok(tasks) => {
            let views: Vec<TaskView> = tasks.into_iter().map(TaskView::from).collect();
            (StatusCode::OK, Json(views)).into_response()
        }
        Err(e) => {
            tracing::error!("list tasks: {e}");
            db_error().into_response()
        }
    }
}

async fn create_task(
    State(s): State<AppState>,
    Json(req): Json<CreateTaskRequest>,
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
            tracing::error!("get agent for task: {e}");
            return db_error().into_response();
        }
    }

    let params = if let Some(template_id) = req.template_id {
        if template_id.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: "template_id is required".into(),
                }),
            )
                .into_response();
        }
        let template = match s.store.get_template(template_id.trim()).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(ErrorBody {
                        error: "template not found".into(),
                    }),
                )
                    .into_response();
            }
            Err(e) => {
                tracing::error!("get template for task: {e}");
                return db_error().into_response();
            }
        };
        CreateTaskParams {
            agent_id: req.agent_id.trim().into(),
            source: "template".into(),
            template_id: Some(template.id),
            shell: template.shell,
            command: template.command,
            workdir: template.workdir,
            timeout_secs: template.timeout_secs,
        }
    } else {
        let command = match req.command {
            Some(c) if !c.trim().is_empty() => c,
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorBody {
                        error: "command is required for ad-hoc tasks".into(),
                    }),
                )
                    .into_response();
            }
        };
        if req.timeout_secs == Some(0) {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorBody {
                    error: "timeout_secs must be greater than 0".into(),
                }),
            )
                .into_response();
        }
        CreateTaskParams {
            agent_id: req.agent_id.trim().into(),
            source: "ad_hoc".into(),
            template_id: None,
            shell: req.shell.unwrap_or_else(default_shell),
            command,
            workdir: req.workdir,
            timeout_secs: req.timeout_secs.unwrap_or_else(default_timeout),
        }
    };

    match s.store.create_task(params).await {
        Ok(task) => (StatusCode::CREATED, Json(TaskView::from(task))).into_response(),
        Err(e) => {
            tracing::error!("create task: {e}");
            db_error().into_response()
        }
    }
}

fn vi_path_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("vi-template")
        .to_string()
}

fn validate_vi_template_create(req: &CreateViTemplateRequest) -> Option<&'static str> {
    if req.agent_id.trim().is_empty() {
        return Some("agent_id is required");
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
    if !req.inputs.is_array() {
        return Some("inputs must be an array");
    }
    if req.timeout_secs == Some(0) {
        return Some("timeout_secs must be greater than 0");
    }
    None
}

async fn list_vi_templates(
    State(s): State<AppState>,
    Query(q): Query<ListViTemplatesQuery>,
) -> impl IntoResponse {
    let agent_filter = q.agent_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    match s.store.list_vi_templates_enriched(agent_filter).await {
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

    let vi_path = crate::labview_cmd::normalize_fs_path(&req.vi_path);
    let cli_path = crate::labview_cmd::normalize_fs_path(&req.cli_path);
    let getinfo_path = crate::labview_cmd::normalize_fs_path(&req.getinfo_path);

    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| vi_path_stem(&vi_path));

    match s
        .store
        .upsert_vi_template(
            &name,
            req.agent_id.trim(),
            req.agent_id.trim(),
            &vi_path,
            &cli_path,
            &getinfo_path,
            &req.inputs,
            req.show_front_panel,
            req.timeout_secs,
        )
        .await
    {
        Ok((template, created)) => match s.store.get_vi_template_enriched(&template.id).await {
            Ok(Some(enriched)) => match ViTemplateView::try_from(enriched) {
                Ok(view) => {
                    let status = if created {
                        StatusCode::CREATED
                    } else {
                        StatusCode::OK
                    };
                    (status, Json(view)).into_response()
                }
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
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.get_vi_template_enriched(&id).await {
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

async fn distribute_vi_template(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<DistributeViTemplateRequest>,
) -> impl IntoResponse {
    let source = match s.store.get_vi_template(&id).await {
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
            tracing::error!("get vi template for distribute: {e}");
            return db_error().into_response();
        }
    };

    let results = distribute_template(
        &s.store,
        &s.labview_client,
        &source,
        &req.target_agent_ids,
        req.vi_path.as_deref(),
    )
    .await;

    (
        StatusCode::OK,
        Json(DistributeViTemplateResponse { results }),
    )
        .into_response()
}

async fn delete_vi_template(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.delete_vi_template(&id).await {
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

async fn get_task(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match s.store.get_task(&id).await {
        Ok(Some(task)) => (StatusCode::OK, Json(TaskView::from(task))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "task not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get task: {e}");
            db_error().into_response()
        }
    }
}

fn agent_path_and_query(base: &str, query: Option<&str>) -> String {
    match query {
        Some(q) => format!("{base}?{q}"),
        None => base.to_string(),
    }
}

async fn proxy_agent_get(
    client: &reqwest::Client,
    agent: &Agent,
    path_and_query: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    let url = format!("http://{}:{}{}", agent.ip, agent.port, path_and_query);
    client.get(url).send().await
}

async fn proxy_agent_post(
    client: &reqwest::Client,
    agent: &Agent,
    path: &str,
    body: Bytes,
) -> Result<reqwest::Response, reqwest::Error> {
    let url = format!("http://{}:{}{}", agent.ip, agent.port, path);
    client
        .post(url)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
}

async fn proxied_agent_response(resp: reqwest::Response) -> axum::response::Response {
    let status = StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let content_disposition = resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match resp.bytes().await {
        Ok(bytes) => {
            let mut builder = axum::response::Response::builder().status(status);
            if let Some(ct) = content_type {
                builder = builder.header(header::CONTENT_TYPE, ct);
            }
            if let Some(cd) = content_disposition {
                builder = builder.header(header::CONTENT_DISPOSITION, cd);
            }
            builder.body(Body::from(bytes)).unwrap().into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody {
                error: format!("failed to read agent response: {e}"),
            }),
        )
            .into_response(),
    }
}

async fn proxy_agent_request(
    client: &reqwest::Client,
    agent: &Agent,
    path_and_query: &str,
) -> axum::response::Response {
    match proxy_agent_get(client, agent, path_and_query).await {
        Ok(resp) => proxied_agent_response(resp).await,
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn proxy_agent_post_request(
    client: &reqwest::Client,
    agent: &Agent,
    path: &str,
    body: Bytes,
) -> axum::response::Response {
    match proxy_agent_post(client, agent, path, body).await {
        Ok(resp) => proxied_agent_response(resp).await,
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn list_agent_files(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => {
            let path_and_query = agent_path_and_query("/api/files", uri.query());
            proxy_agent_request(&s.client, &agent, &path_and_query).await
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent for files list: {e}");
            db_error().into_response()
        }
    }
}

async fn get_agent_file_content(
    State(s): State<AppState>,
    Path(id): Path<String>,
    uri: Uri,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => {
            let path_and_query = agent_path_and_query("/api/files/content", uri.query());
            proxy_agent_request(&s.client, &agent, &path_and_query).await
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent for file content: {e}");
            db_error().into_response()
        }
    }
}

async fn proxy_labview_config(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => {
            proxy_agent_request(&s.labview_client, &agent, "/api/labview/config").await
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent for labview config: {e}");
            db_error().into_response()
        }
    }
}

async fn proxy_labview_inspect(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => {
            proxy_agent_post_request(&s.labview_client, &agent, "/api/labview/inspect", body).await
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent for labview inspect: {e}");
            db_error().into_response()
        }
    }
}

async fn proxy_labview_run(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    match s.store.get_agent(&id).await {
        Ok(Some(agent)) => {
            proxy_agent_post_request(&s.labview_client, &agent, "/api/labview/run", body).await
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "agent not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get agent for labview run: {e}");
            db_error().into_response()
        }
    }
}

async fn capture_agent_screenshot(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match capture_and_archive(&s.store, &s.client, &s.screenshot_dir, &id).await {
        Ok(meta) => (StatusCode::OK, Json(ScreenshotView::from(meta))).into_response(),
        Err(e) => {
            tracing::error!("capture screenshot for agent {id}: {e:?}");
            capture_error_response(e).into_response()
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ScreenshotListResponse {
    items: Vec<ScreenshotView>,
    total: i64,
}

async fn list_agent_screenshots(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ListScreenshotsQuery>,
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
            tracing::error!("get agent for screenshot list: {e}");
            return db_error().into_response();
        }
        Ok(Some(_)) => {}
    }

    let limit = clamp_list_limit(q.limit);
    let offset = q.offset.max(0);

    match s.store.count_screenshots(&id).await {
        Ok(total) => match s.store.list_screenshots(&id, limit, offset).await {
            Ok(items) => {
                let views: Vec<ScreenshotView> =
                    items.into_iter().map(ScreenshotView::from).collect();
                (
                    StatusCode::OK,
                    Json(ScreenshotListResponse { items: views, total }),
                )
                    .into_response()
            }
            Err(e) => {
                tracing::error!("list screenshots: {e}");
                db_error().into_response()
            }
        },
        Err(e) => {
            tracing::error!("count screenshots: {e}");
            db_error().into_response()
        }
    }
}

async fn get_screenshot(State(s): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match s.store.get_screenshot(&id).await {
        Ok(Some(meta)) => (StatusCode::OK, Json(ScreenshotView::from(meta))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "screenshot not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("get screenshot: {e}");
            db_error().into_response()
        }
    }
}

async fn get_screenshot_image(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let meta = match s.store.get_screenshot(&id).await {
        Ok(Some(m)) => m,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    error: "screenshot not found".into(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!("get screenshot for image: {e}");
            return db_error().into_response();
        }
    };

    match tokio::fs::read(&meta.file_path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "image/png")],
            bytes,
        )
            .into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "screenshot file not found".into(),
            }),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("read screenshot file {}: {e}", meta.file_path);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "failed to read screenshot file".into(),
                }),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use std::net::SocketAddr;
    use tower::ServiceExt;

    /// Minimal valid 1x1 PNG (well-known constant).
    pub const MINIMAL_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    struct TestApp {
        router: Router,
        _db_dir: tempfile::TempDir,
        screenshot_dir: String,
    }

    async fn test_app() -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        let screenshot_dir = dir.path().join("shots");
        let screenshot_dir_str = screenshot_dir.to_string_lossy().to_string();
        let labview_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        TestApp {
            router: router(AppState {
                store: Store::new(pool),
                client: reqwest::Client::new(),
                labview_client,
                screenshot_dir: screenshot_dir_str.clone(),
            }),
            _db_dir: dir,
            screenshot_dir: screenshot_dir_str,
        }
    }

    async fn start_mock_agent() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        start_mock_agent_responding(StatusCode::OK, "image/png", MINIMAL_PNG).await
    }

    async fn start_mock_agent_responding(
        status: StatusCode,
        content_type: &'static str,
        body: &'static [u8],
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let mock = Router::new().route(
            "/api/screenshot",
            get(move || async move {
                (status, [(header::CONTENT_TYPE, content_type)], body)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        (addr, handle)
    }

    const MOCK_FILES_LIST: &str =
        r#"{"path":"","entries":[{"name":"Log.txt","kind":"file","size":5,"ext":"txt"}]}"#;
    const MOCK_FILE_BYTES: &[u8] = b"hello";

    async fn start_mock_agent_files() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let list_json = MOCK_FILES_LIST.to_string();
        let mock = Router::new()
            .route(
                "/api/files",
                get({
                    let list_json = list_json.clone();
                    move |Query(q): Query<std::collections::HashMap<String, String>>| {
                        let list_json = list_json.clone();
                        async move {
                            if q.get("path").map(String::as_str) == Some("missing") {
                                return (
                                    StatusCode::NOT_FOUND,
                                    Json(ErrorBody {
                                        error: "not found".into(),
                                    }),
                                )
                                    .into_response();
                            }
                            (
                                StatusCode::OK,
                                [(header::CONTENT_TYPE, "application/json")],
                                list_json,
                            )
                                .into_response()
                        }
                    }
                }),
            )
            .route(
                "/api/files/content",
                get(
                    |Query(q): Query<std::collections::HashMap<String, String>>| async move {
                        let download = q.get("download").map(String::as_str) == Some("1");
                        let mut headers = axum::http::HeaderMap::new();
                        headers.insert(
                            header::CONTENT_TYPE,
                            "text/plain".parse().expect("content-type"),
                        );
                        if download {
                            headers.insert(
                                header::CONTENT_DISPOSITION,
                                "attachment; filename=\"Log.txt\""
                                    .parse()
                                    .expect("content-disposition"),
                            );
                        }
                        (StatusCode::OK, headers, MOCK_FILE_BYTES).into_response()
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        (addr, handle)
    }

    const MOCK_LABVIEW_CONFIG: &str =
        r#"{"cli_path":"C:\\cli\\LabVIEWCLI.exe","getinfo_path":"C:\\cli\\GetInfo.exe"}"#;
    const MOCK_LABVIEW_INSPECT: &str =
        r#"{"action":"inspect","controls":[{"name":"X","type":"Numeric"}]}"#;
    const MOCK_LABVIEW_RUN: &str = r#"{"action":"run","status":"ok"}"#;

    async fn start_mock_agent_labview() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let config_json = MOCK_LABVIEW_CONFIG.to_string();
        let inspect_json = MOCK_LABVIEW_INSPECT.to_string();
        let run_json = MOCK_LABVIEW_RUN.to_string();
        let mock = Router::new()
            .route(
                "/api/labview/config",
                get({
                    let config_json = config_json.clone();
                    move || async move {
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            config_json,
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/api/labview/inspect",
                post({
                    let inspect_json = inspect_json.clone();
                    move |Json(body): Json<serde_json::Value>| async move {
                        if body.get("vi_path").and_then(|v| v.as_str()) == Some("missing") {
                            return (
                                StatusCode::BAD_REQUEST,
                                Json(ErrorBody {
                                    error: "vi not found".into(),
                                }),
                            )
                                .into_response();
                        }
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            inspect_json,
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/api/labview/run",
                post({
                    let run_json = run_json.clone();
                    move |Json(_body): Json<serde_json::Value>| async move {
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "application/json")],
                            run_json,
                        )
                            .into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, mock).await.unwrap();
        });
        (addr, handle)
    }

    async fn post_capture_screenshot(app: &Router, agent_id: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/agents/{agent_id}/screenshots"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn assert_no_screenshot_artifacts(app: &Router, test: &TestApp, agent_id: &str) {
        let shot_root = std::path::Path::new(&test.screenshot_dir);
        if shot_root.exists() {
            let count: usize = std::fs::read_dir(shot_root)
                .map(|rd| rd.count())
                .unwrap_or(0);
            assert_eq!(count, 0);
        }

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/screenshots"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: ScreenshotListResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.total, 0);
        assert!(list.items.is_empty());
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

    fn json_request(method: &str, uri: &str, body: &impl Serialize) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).unwrap()))
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

    #[tokio::test]
    async fn capture_screenshot_happy_path() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent().await;
        let agent_id = register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/agents/{agent_id}/screenshots"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let meta: ScreenshotView = serde_json::from_slice(&bytes).unwrap();
        assert!(!meta.id.is_empty());
        assert_eq!(meta.agent_id, agent_id);
        assert_eq!(meta.content_type, "image/png");
        assert_eq!(meta.byte_size, MINIMAL_PNG.len() as i64);

        let file_path = std::path::Path::new(&test.screenshot_dir)
            .join(&agent_id)
            .join(format!("{}.png", meta.id));
        assert!(file_path.exists());

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/screenshots/{}/image", meta.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let image_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(image_bytes.as_ref(), MINIMAL_PNG);

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/screenshots"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: ScreenshotListResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(list.total >= 1);
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, meta.id);
    }

    #[tokio::test]
    async fn capture_screenshot_agent_unreachable() {
        let test = test_app().await;
        let agent_id = register_agent_at(&test.router, "127.0.0.1", 1).await;

        let resp = post_capture_screenshot(&test.router, &agent_id).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        assert_no_screenshot_artifacts(&test.router, &test, &agent_id).await;
    }

    #[tokio::test]
    async fn capture_screenshot_agent_returns_500() {
        let test = test_app().await;
        let (addr, _mock) =
            start_mock_agent_responding(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", b"error")
                .await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = post_capture_screenshot(&test.router, &agent_id).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        assert_no_screenshot_artifacts(&test.router, &test, &agent_id).await;
    }

    #[tokio::test]
    async fn capture_screenshot_agent_returns_non_png() {
        let test = test_app().await;
        let (addr, _mock) =
            start_mock_agent_responding(StatusCode::OK, "image/png", b"not-a-png-body").await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = post_capture_screenshot(&test.router, &agent_id).await;
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);

        assert_no_screenshot_artifacts(&test.router, &test, &agent_id).await;
    }

    #[tokio::test]
    async fn capture_screenshot_unknown_agent_returns_404() {
        let test = test_app().await;
        let unknown_id = "00000000-0000-0000-0000-000000000000";

        let resp = post_capture_screenshot(&test.router, unknown_id).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");
    }

    #[tokio::test]
    async fn get_screenshot_image_unknown_returns_404() {
        let test = test_app().await;
        let unknown_id = "00000000-0000-0000-0000-000000000099";

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/screenshots/{unknown_id}/image"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "screenshot not found");
    }

    #[tokio::test]
    async fn template_crud_via_http() {
        let test = test_app().await;
        let app = &test.router;

        let create_body = serde_json::json!({
            "name": "echo-test",
            "shell": "powershell",
            "command": "Write-Host hi",
            "workdir": "C:\\tmp",
            "timeout_secs": 120
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/templates", &create_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let created: TemplateView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created.name, "echo-test");
        assert_eq!(created.shell, "powershell");
        assert_eq!(created.command, "Write-Host hi");
        assert_eq!(created.workdir.as_deref(), Some("C:\\tmp"));
        assert_eq!(created.timeout_secs, 120);

        let resp = app
            .clone()
            .oneshot(Request::builder().uri("/api/templates").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<TemplateView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.id);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let update_body = serde_json::json!({ "name": "echo-renamed" });
        let resp = app
            .clone()
            .oneshot(json_request(
                "PUT",
                &format!("/api/templates/{}", created.id),
                &update_body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let updated: TemplateView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(updated.name, "echo-renamed");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/templates/{}", created.id))
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
                    .uri(format!("/api/templates/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_task_from_template_via_http() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let template_body = serde_json::json!({
            "name": "ping",
            "shell": "powershell",
            "command": "ping localhost",
            "workdir": "C:\\work",
            "timeout_secs": 60
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/templates", &template_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let template: TemplateView = serde_json::from_slice(&bytes).unwrap();

        let task_body = serde_json::json!({
            "agent_id": agent_id,
            "template_id": template.id
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/tasks", &task_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let task: TaskView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(task.agent_id, agent_id);
        assert_eq!(task.source, "template");
        assert_eq!(task.template_id.as_deref(), Some(template.id.as_str()));
        assert_eq!(task.shell, "powershell");
        assert_eq!(task.command, "ping localhost");
        assert_eq!(task.workdir.as_deref(), Some("C:\\work"));
        assert_eq!(task.timeout_secs, 60);
        assert_eq!(task.status, "queued");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/tasks/{}", task.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let got: TaskView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(got.id, task.id);
        assert_eq!(got.status, "queued");
    }

    #[tokio::test]
    async fn create_ad_hoc_task_via_http() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let task_body = serde_json::json!({
            "agent_id": agent_id,
            "command": "echo hello"
        });
        let resp = app
            .clone()
            .oneshot(json_request("POST", "/api/tasks", &task_body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let task: TaskView = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(task.agent_id, agent_id);
        assert_eq!(task.source, "ad_hoc");
        assert!(task.template_id.is_none());
        assert_eq!(task.shell, "cmd");
        assert_eq!(task.command, "echo hello");
        assert_eq!(task.timeout_secs, 300);
        assert_eq!(task.status, "queued");

        let resp = app
            .clone()
            .oneshot(Request::builder().uri("/api/tasks").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<TaskView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
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
    async fn proxy_agent_files_list_forwards_json() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_files().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/files"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_FILES_LIST.as_bytes());
    }

    #[tokio::test]
    async fn proxy_agent_files_list_forwards_query_string() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_files().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/agents/{agent_id}/files?path=EyeDiagram%2F35"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_FILES_LIST.as_bytes());
    }

    #[tokio::test]
    async fn proxy_agent_files_list_forwards_agent_status() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_files().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/files?path=missing"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "not found");
    }

    #[tokio::test]
    async fn proxy_agent_file_content_forwards_bytes_and_headers() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_files().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/agents/{agent_id}/files/content?path=Log.txt"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert!(resp.headers().get(header::CONTENT_DISPOSITION).is_none());
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_FILE_BYTES);
    }

    #[tokio::test]
    async fn proxy_agent_file_content_forwards_download_header() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_files().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/agents/{agent_id}/files/content?path=Log.txt&download=1"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"Log.txt\""
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_FILE_BYTES);
    }

    #[tokio::test]
    async fn proxy_agent_files_unreachable_returns_503() {
        let test = test_app().await;
        let agent_id = register_agent_at(&test.router, "127.0.0.1", 1).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/files"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert!(!err.error.is_empty());
    }

    #[tokio::test]
    async fn proxy_agent_files_unknown_agent_returns_404() {
        let test = test_app().await;
        let unknown_id = "00000000-0000-0000-0000-000000000000";

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{unknown_id}/files"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");
    }

    #[tokio::test]
    async fn proxy_agent_labview_config_forwards_json() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let resp = test
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/agents/{agent_id}/labview/config"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_LABVIEW_CONFIG.as_bytes());
    }

    #[tokio::test]
    async fn proxy_agent_labview_inspect_forwards_json() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let body = serde_json::json!({ "vi_path": "C:\\test.vi" });
        let resp = test
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/agents/{agent_id}/labview/inspect"),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_LABVIEW_INSPECT.as_bytes());
    }

    #[tokio::test]
    async fn proxy_agent_labview_run_forwards_json() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let body = serde_json::json!({
            "vi_path": "C:\\test.vi",
            "inputs": { "X": 1.0 }
        });
        let resp = test
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/agents/{agent_id}/labview/run"),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), MOCK_LABVIEW_RUN.as_bytes());
    }

    #[tokio::test]
    async fn proxy_agent_labview_inspect_forwards_agent_status() {
        let test = test_app().await;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_id =
            register_agent_at(&test.router, &addr.ip().to_string(), addr.port()).await;

        let body = serde_json::json!({ "vi_path": "missing" });
        let resp = test
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/agents/{agent_id}/labview/inspect"),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "vi not found");
    }

    #[tokio::test]
    async fn proxy_agent_labview_unreachable_returns_503() {
        let test = test_app().await;
        let agent_id = register_agent_at(&test.router, "127.0.0.1", 1).await;

        let body = serde_json::json!({ "vi_path": "C:\\test.vi" });
        let resp = test
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/agents/{agent_id}/labview/inspect"),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert!(!err.error.is_empty());
    }

    #[tokio::test]
    async fn proxy_agent_labview_unknown_agent_returns_404() {
        let test = test_app().await;
        let unknown_id = "00000000-0000-0000-0000-000000000000";

        let body = serde_json::json!({ "vi_path": "C:\\test.vi" });
        let resp = test
            .router
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/agents/{unknown_id}/labview/inspect"),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent not found");
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
        assert_eq!(created.agent_id, agent_id);
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
        name: Option<&str>,
        vi_path: &str,
    ) -> (StatusCode, ViTemplateView) {
        let mut body = serde_json::json!({
            "agent_id": agent_id,
            "vi_path": vi_path,
            "cli_path": r"C:\cli.exe",
            "getinfo_path": r"C:\getinfo.vi",
            "inputs": []
        });
        if let Some(n) = name {
            body["name"] = serde_json::json!(n);
        }
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

        let (_, tpl_a) = create_vi_template_http(app, &agent_a, Some("A"), r"C:\a.vi").await;
        let (_, tpl_b) = create_vi_template_http(app, &agent_b, Some("B"), r"C:\b.vi").await;
        assert_eq!(tpl_a.agent_id, agent_a);
        assert_eq!(tpl_b.agent_id, agent_b);

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
    async fn create_vi_template_upsert_keeps_origin() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let (status1, first) =
            create_vi_template_http(app, &agent_id, Some("First"), r"C:\x\Add.vi").await;
        assert_eq!(status1, StatusCode::CREATED);
        assert_eq!(first.origin_agent_id, agent_id);

        let (status2, second) =
            create_vi_template_http(app, &agent_id, Some("Second"), r"C:\x\Add.vi").await;
        assert_eq!(status2, StatusCode::OK);
        assert_eq!(second.id, first.id);
        assert_eq!(second.name, "Second");
        assert_eq!(second.origin_agent_id, agent_id);
    }

    #[tokio::test]
    async fn distribute_creates_on_target_and_preserves_origin() {
        let test = test_app().await;
        let app = &test.router;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_a = register_agent_id(app).await;
        let agent_b = register_agent_at(app, &addr.ip().to_string(), addr.port()).await;

        let (_, source) =
            create_vi_template_http(app, &agent_a, Some("Add"), r"C:\x\Add.vi").await;

        let body = serde_json::json!({
            "target_agent_ids": [agent_b]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/vi-templates/{}/distribute", source.id),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let out: DistributeViTemplateResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].status, "created");
        assert_eq!(out.results[0].agent_id, agent_b);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/vi-templates?agent_id={agent_b}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<ViTemplateView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].agent_id, agent_b);
        assert_eq!(list[0].origin_agent_id, agent_a);
    }

    #[tokio::test]
    async fn distribute_updates_same_path_on_target() {
        let test = test_app().await;
        let app = &test.router;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_a = register_agent_id(app).await;
        let agent_b = register_agent_at(app, &addr.ip().to_string(), addr.port()).await;

        let (_, source) =
            create_vi_template_http(app, &agent_a, Some("FromA"), r"C:\x\Add.vi").await;
        let (_, local_b) =
            create_vi_template_http(app, &agent_b, Some("LocalB"), r"C:\x\Add.vi").await;
        assert_eq!(local_b.origin_agent_id, agent_b);

        let body = serde_json::json!({
            "target_agent_ids": [agent_b]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/vi-templates/{}/distribute", source.id),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let out: DistributeViTemplateResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out.results[0].status, "updated");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/vi-templates?agent_id={agent_b}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let list: Vec<ViTemplateView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, local_b.id);
        assert_eq!(list[0].origin_agent_id, agent_a);
        assert_eq!(list[0].name, "FromA");
    }

    #[tokio::test]
    async fn distribute_skips_source_agent() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let (_, source) =
            create_vi_template_http(app, &agent_id, Some("Add"), r"C:\x\Add.vi").await;

        let body = serde_json::json!({
            "target_agent_ids": [agent_id]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/vi-templates/{}/distribute", source.id),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let out: DistributeViTemplateResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].status, "skipped");
        assert_eq!(out.results[0].error.as_deref(), Some("source agent"));
    }

    #[tokio::test]
    async fn distribute_partial_failure_unknown_agent() {
        let test = test_app().await;
        let app = &test.router;
        let (addr, _mock) = start_mock_agent_labview().await;
        let agent_a = register_agent_id(app).await;
        let agent_b = register_agent_at(app, &addr.ip().to_string(), addr.port()).await;
        let unknown_id = "00000000-0000-0000-0000-000000000099";

        let (_, source) =
            create_vi_template_http(app, &agent_a, Some("Add"), r"C:\x\Add.vi").await;

        let body = serde_json::json!({
            "target_agent_ids": [agent_b, unknown_id]
        });
        let resp = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/api/vi-templates/{}/distribute", source.id),
                &body,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let out: DistributeViTemplateResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(out.results.len(), 2);

        let by_agent: std::collections::HashMap<_, _> = out
            .results
            .iter()
            .map(|r| (r.agent_id.as_str(), r))
            .collect();
        assert_eq!(by_agent[agent_b.as_str()].status, "created");
        assert_eq!(by_agent[unknown_id].status, "error");
        assert_eq!(
            by_agent[unknown_id].error.as_deref(),
            Some("agent not found")
        );
    }
}
