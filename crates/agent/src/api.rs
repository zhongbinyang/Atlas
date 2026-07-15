use axum::{
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{
    AgentStatusResponse, CreateAgentTaskRequest, ErrorBody, RegisterAgentRequest,
};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::metrics::MetricsSampler;
use crate::task_slot::TaskSlot;

#[derive(Clone)]
pub struct AppState {
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub started: Instant,
    pub slot: Arc<TaskSlot>,
    pub metrics: Arc<Mutex<MetricsSampler>>,
    pub center_url: String,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/status", get(status))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{id}", get(get_task))
        .route("/api/register-now", post(register_now))
        .with_state(state)
}

async fn status(State(s): State<AppState>) -> Json<AgentStatusResponse> {
    let mut m = s.metrics.lock().await;
    let (cpu, mem) = m.cpu_and_memory();
    Json(AgentStatusResponse {
        hostname: s.hostname.clone(),
        ip: s.ip.clone(),
        cpu_percent: cpu,
        memory_percent: mem,
        busy: s.slot.is_busy().await,
        uptime_secs: s.started.elapsed().as_secs(),
    })
}

async fn create_task(
    State(s): State<AppState>,
    Json(req): Json<CreateAgentTaskRequest>,
) -> impl IntoResponse {
    if req.command.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "command is required".into(),
            }),
        )
            .into_response();
    }
    match s.slot.submit(req).await {
        Ok(view) => (StatusCode::CREATED, Json(view)).into_response(),
        Err("busy") => (
            StatusCode::CONFLICT,
            Json(ErrorBody {
                error: "agent is busy".into(),
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: "unknown".into(),
            }),
        )
            .into_response(),
    }
}

async fn list_tasks(State(s): State<AppState>) -> Json<Vec<common::AgentTaskView>> {
    Json(s.slot.list().await)
}

async fn get_task(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match s.slot.get(&id).await {
        Some(t) => (StatusCode::OK, Json(t)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "task not found".into(),
            }),
        )
            .into_response(),
    }
}

async fn register_now(State(s): State<AppState>) -> impl IntoResponse {
    let body = RegisterAgentRequest {
        name: s.hostname.clone(),
        ip: s.ip.clone(),
        port: s.port,
    };
    let _ = body;
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use common::ShellKind;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            hostname: "test-host".into(),
            ip: "127.0.0.1".into(),
            port: 8080,
            started: Instant::now(),
            slot: TaskSlot::new(),
            metrics: Arc::new(Mutex::new(MetricsSampler::new())),
            center_url: "http://localhost:3000".into(),
        }
    }

    #[tokio::test]
    async fn post_task_conflict_when_busy() {
        let app = router(test_state());
        let payload = CreateAgentTaskRequest {
            shell: ShellKind::Cmd,
            command: "ping -n 5 127.0.0.1".into(),
            workdir: None,
            timeout_secs: 30,
        };
        let body = serde_json::to_vec(&payload).unwrap();

        let req = Request::builder()
            .method("POST")
            .uri("/api/tasks")
            .header("content-type", "application/json")
            .body(Body::from(body.clone()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let req = Request::builder()
            .method("POST")
            .uri("/api/tasks")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);

        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let err: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(err.error, "agent is busy");
    }
}
