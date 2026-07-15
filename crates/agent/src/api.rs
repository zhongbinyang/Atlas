use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, Request, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{
    AgentStatusResponse, CreateAgentTaskRequest, ErrorBody, RegisterAgentRequest,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::files::{self, EntryKind, FilesError};
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
    pub files_root: Option<PathBuf>,
}

#[derive(Deserialize)]
struct FilesQuery {
    path: Option<String>,
    download: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct FilesListResponse {
    path: String,
    entries: Vec<FileEntryJson>,
}

#[derive(Serialize, Deserialize)]
struct FileEntryJson {
    name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ext: Option<String>,
}

fn files_error_status(e: FilesError) -> (StatusCode, String) {
    match e {
        FilesError::NotConfigured | FilesError::RootMissing => {
            (StatusCode::SERVICE_UNAVAILABLE, "files not configured".into())
        }
        FilesError::BadPath | FilesError::NotDir => {
            (StatusCode::BAD_REQUEST, "invalid path".into())
        }
        FilesError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
        FilesError::ForbiddenExt => (StatusCode::FORBIDDEN, "forbidden extension".into()),
        FilesError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "file too large".into()),
        FilesError::Io(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
    }
}

fn entry_to_json(e: files::FileEntry) -> FileEntryJson {
    match e.kind {
        EntryKind::Dir => FileEntryJson {
            name: e.name,
            kind: "dir".into(),
            size: None,
            ext: None,
        },
        EntryKind::File => FileEntryJson {
            name: e.name,
            kind: "file".into(),
            size: e.size,
            ext: Some(e.ext.unwrap_or_default()),
        },
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/status", get(status))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{id}", get(get_task))
        .route("/api/screenshot", get(screenshot))
        .route("/api/register-now", post(register_now))
        .route("/api/files", get(list_files))
        .route("/api/files/content", get(files_content))
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
    if req.timeout_secs == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "timeout_secs must be greater than 0".into(),
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

async fn screenshot() -> impl IntoResponse {
    match tokio::task::spawn_blocking(crate::capture::capture_primary_png).await {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "image/png")],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("capture join: {e}"),
            }),
        )
            .into_response(),
    }
}

async fn list_files(
    State(s): State<AppState>,
    Query(q): Query<FilesQuery>,
) -> impl IntoResponse {
    let Some(root) = s.files_root.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: "files not configured".into(),
            }),
        )
            .into_response();
    };
    let rel = q.path.as_deref().unwrap_or("");
    match files::list_dir(root, rel) {
        Ok((path, entries)) => (
            StatusCode::OK,
            Json(FilesListResponse {
                path,
                entries: entries.into_iter().map(entry_to_json).collect(),
            }),
        )
            .into_response(),
        Err(e) => {
            let (status, error) = files_error_status(e);
            (status, Json(ErrorBody { error })).into_response()
        }
    }
}

async fn files_content(
    State(s): State<AppState>,
    Query(q): Query<FilesQuery>,
) -> impl IntoResponse {
    let Some(root) = s.files_root.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorBody {
                error: "files not configured".into(),
            }),
        )
            .into_response();
    };
    let rel = q.path.as_deref().unwrap_or("");
    let download = q.download.as_deref() == Some("1");
    match files::read_file(root, rel) {
        Ok((filename, content_type, bytes)) => {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                content_type.parse().expect("content-type"),
            );
            if download {
                headers.insert(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{filename}\"")
                        .parse()
                        .expect("content-disposition"),
                );
            }
            (StatusCode::OK, headers, bytes).into_response()
        }
        Err(e) => {
            let (status, error) = files_error_status(e);
            (status, Json(ErrorBody { error })).into_response()
        }
    }
}

async fn register_now(State(s): State<AppState>) -> impl IntoResponse {
    let body = RegisterAgentRequest {
        name: s.hostname.clone(),
        ip: s.ip.clone(),
        port: s.port,
    };
    let client = crate::register::http_client();
    match crate::register::register_with_center(&client, &s.center_url, &body).await {
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
            files_root: None,
        }
    }

    fn test_state_with_files(root: PathBuf) -> AppState {
        AppState {
            files_root: Some(root),
            ..test_state()
        }
    }

    #[tokio::test]
    async fn list_files_and_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("EyeDiagram/35")).unwrap();
        std::fs::write(dir.path().join("Log.txt"), b"hello").unwrap();
        std::fs::write(dir.path().join("EyeDiagram/35/CH1.gif"), b"GIF89a").unwrap();

        let app = router(test_state_with_files(dir.path().to_path_buf()));

        let req = Request::builder()
            .uri("/api/files")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: FilesListResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(body.entries.iter().any(|e| e.name == "Log.txt" && e.kind == "file"));
        assert!(body
            .entries
            .iter()
            .any(|e| e.name == "EyeDiagram" && e.kind == "dir"));

        let req = Request::builder()
            .uri("/api/files/content?path=Log.txt")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"hello");

        let req = Request::builder()
            .uri("/api/files/content?path=EyeDiagram/35/CH1.gif")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"GIF89a");

        let req = Request::builder()
            .uri("/api/files/content?path=../x")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_files_not_configured() {
        let app = router(test_state());
        let req = Request::builder()
            .uri("/api/files")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
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
