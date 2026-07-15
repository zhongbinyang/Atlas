use axum::{
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{ErrorBody, RegisterAgentRequest};
use serde::{Deserialize, Serialize};

use crate::store::{Agent, CreateTaskParams, Store, Task, TaskTemplate, UpdateTemplateParams};

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

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn test_app() -> Router {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        router(AppState {
            store: Store::new(pool),
        })
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

    #[tokio::test]
    async fn template_crud_via_http() {
        let app = test_app().await;

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
        let app = test_app().await;
        let agent_id = register_agent_id(&app).await;

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
        let app = test_app().await;
        let agent_id = register_agent_id(&app).await;

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
        let app = test_app().await;
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
        let app = test_app().await;
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
}
