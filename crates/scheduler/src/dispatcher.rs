use chrono::Utc;

use common::{AgentTaskView, CreateAgentTaskRequest, ShellKind, TaskStatus};

use crate::store::{Store, Task, TaskUpdate};

fn parse_shell(shell: &str) -> ShellKind {
    match shell.to_ascii_lowercase().as_str() {
        "powershell" => ShellKind::Powershell,
        _ => ShellKind::Cmd,
    }
}

fn status_to_str(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Dispatched => "dispatched",
        TaskStatus::Running => "running",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Timeout => "timeout",
    }
}

fn agent_base_url(ip: &str, port: u16) -> String {
    format!("http://{ip}:{port}")
}

async fn recover_in_flight(store: &Store, client: &reqwest::Client, task: &Task) -> Result<(), String> {
    let agent_task_id = match &task.agent_task_id {
        Some(id) => id.clone(),
        None => return Ok(()),
    };
    let agent = match store.get_agent(&task.agent_id).await.map_err(|e| e.to_string())? {
        Some(a) => a,
        None => return Ok(()),
    };

    let url = format!(
        "{}/api/tasks/{}",
        agent_base_url(&agent.ip, agent.port),
        agent_task_id
    );
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("recover task {}: GET failed: {e}", task.id);
            requeue_task(store, &task.id, &agent.id).await?;
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        tracing::warn!(
            "recover task {}: GET returned {}",
            task.id,
            resp.status()
        );
        if resp.status().as_u16() == 404 {
            requeue_task(store, &task.id, &agent.id).await?;
        }
        return Ok(());
    }

    let view = resp
        .json::<AgentTaskView>()
        .await
        .map_err(|e| format!("decode agent task view: {e}"))?;
    apply_agent_view(store, task, &view).await
}

async fn requeue_task(store: &Store, task_id: &str, agent_id: &str) -> Result<(), String> {
    store
        .update_task(
            task_id,
            TaskUpdate {
                status: Some("queued".into()),
                agent_task_id: Some(None),
                ..TaskUpdate::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    store
        .mark_agent_offline(agent_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn apply_agent_view(
    store: &Store,
    task: &Task,
    view: &AgentTaskView,
) -> Result<(), String> {
    let status = status_to_str(view.status);
    let now = Utc::now().to_rfc3339();

    let mut update = TaskUpdate {
        status: Some(status.into()),
        exit_code: Some(view.exit_code),
        stdout: Some(view.stdout.clone()),
        stderr: Some(view.stderr.clone()),
        ..TaskUpdate::default()
    };

    match view.status {
        TaskStatus::Running => {
            if task.started_at.is_none() {
                update.started_at = Some(Some(now));
            }
        }
        TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Timeout => {
            if task.started_at.is_none() {
                update.started_at = Some(Some(now.clone()));
            }
            update.finished_at = Some(Some(now));
        }
        _ => {}
    }

    store
        .update_task(&task.id, update)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn dispatch_queued(store: &Store, client: &reqwest::Client, task: &Task) -> Result<(), String> {
    let agent = match store.get_agent(&task.agent_id).await.map_err(|e| e.to_string())? {
        Some(a) => a,
        None => return Ok(()),
    };

    if agent.status != "online" || agent.busy {
        return Ok(());
    }

    let body = CreateAgentTaskRequest {
        shell: parse_shell(&task.shell),
        command: task.command.clone(),
        workdir: task.workdir.clone(),
        timeout_secs: task.timeout_secs.max(0) as u64,
    };

    let url = format!("{}/api/tasks", agent_base_url(&agent.ip, agent.port));
    let resp = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("dispatch task {}: POST failed: {e}", task.id);
            requeue_task(store, &task.id, &agent.id).await?;
            return Ok(());
        }
    };

    match resp.status().as_u16() {
        201 => {
            let view = resp
                .json::<AgentTaskView>()
                .await
                .map_err(|e| format!("decode create task response: {e}"))?;
            store
                .update_task(
                    &task.id,
                    TaskUpdate {
                        status: Some("dispatched".into()),
                        agent_task_id: Some(Some(view.id)),
                        ..TaskUpdate::default()
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        409 => {
            // Agent busy — leave queued for retry.
        }
        _ => {
            tracing::warn!(
                "dispatch task {}: POST returned {}",
                task.id,
                resp.status()
            );
            requeue_task(store, &task.id, &agent.id).await?;
        }
    }

    Ok(())
}

pub async fn dispatcher_tick(store: &Store, client: &reqwest::Client) -> Result<(), String> {
    let tasks = store.list_tasks().await.map_err(|e| e.to_string())?;

    for task in tasks
        .iter()
        .filter(|t| (t.status == "dispatched" || t.status == "running") && t.agent_task_id.is_some())
    {
        if let Err(e) = recover_in_flight(store, client, task).await {
            tracing::warn!("recover task {}: {e}", task.id);
        }
    }

    let tasks = store.list_tasks().await.map_err(|e| e.to_string())?;
    for task in tasks.iter().filter(|t| t.status == "queued") {
        if let Err(e) = dispatch_queued(store, client, task).await {
            tracing::warn!("dispatch task {}: {e}", task.id);
        }
    }

    Ok(())
}

pub async fn run_dispatcher(store: Store, client: reqwest::Client, interval_secs: u64) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        if let Err(e) = dispatcher_tick(&store, &client).await {
            tracing::error!("dispatcher: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Path, State},
        http::StatusCode,
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;

    use crate::store::{CreateTaskParams, Store};

    #[derive(Clone)]
    struct MockAgentState {
        reject_post: Arc<AtomicBool>,
        created_at: Arc<Mutex<Option<Instant>>>,
        task_id: String,
    }

    async fn mock_create_task(
        State(state): State<MockAgentState>,
        Json(_req): Json<CreateAgentTaskRequest>,
    ) -> impl IntoResponse {
        if state.reject_post.load(Ordering::SeqCst) {
            return (
                StatusCode::CONFLICT,
                Json(common::ErrorBody {
                    error: "agent is busy".into(),
                }),
            )
                .into_response();
        }

        *state.created_at.lock().await = Some(Instant::now());
        (
            StatusCode::CREATED,
            Json(AgentTaskView {
                id: state.task_id.clone(),
                status: TaskStatus::Running,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            }),
        )
            .into_response()
    }

    async fn mock_get_task(
        State(state): State<MockAgentState>,
        Path(_id): Path<String>,
    ) -> impl IntoResponse {
        let created = state.created_at.lock().await;
        let elapsed = created
            .as_ref()
            .map(|t| t.elapsed())
            .unwrap_or(Duration::from_millis(200));

        if elapsed < Duration::from_millis(100) {
            return (
                StatusCode::OK,
                Json(AgentTaskView {
                    id: state.task_id.clone(),
                    status: TaskStatus::Running,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                }),
            )
                .into_response();
        }

        (
            StatusCode::OK,
            Json(AgentTaskView {
                id: state.task_id.clone(),
                status: TaskStatus::Succeeded,
                exit_code: Some(0),
                stdout: "ok".into(),
                stderr: String::new(),
            }),
        )
            .into_response()
    }

    async fn start_mock_agent(reject_post: bool) -> (String, u16, tokio::task::JoinHandle<()>) {
        let state = MockAgentState {
            reject_post: Arc::new(AtomicBool::new(reject_post)),
            created_at: Arc::new(Mutex::new(None)),
            task_id: "agent-task-1".into(),
        };
        let app = Router::new()
            .route("/api/tasks", post(mock_create_task))
            .route("/api/tasks/{id}", get(mock_get_task))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (addr.ip().to_string(), addr.port(), handle)
    }

    async fn test_store() -> Store {
        let dir = tempfile::tempdir().unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").display());
        let pool = crate::db::connect(&url).await.unwrap();
        Store::new(pool)
    }

    async fn seed_online_agent(store: &Store, ip: &str, port: u16) -> crate::store::Agent {
        let agent = store.upsert_agent("mock", ip, port).await.unwrap();
        store
            .update_agent_metrics(&agent.id, "online", 0.0, 0.0, false)
            .await
            .unwrap();
        store.get_agent(&agent.id).await.unwrap().unwrap()
    }

    async fn unused_local_port() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    #[tokio::test]
    async fn dispatcher_tick_success_path_reaches_succeeded() {
        let store = test_store().await;
        let client = reqwest::Client::new();
        let (ip, port, _handle) = start_mock_agent(false).await;
        let agent = seed_online_agent(&store, &ip, port).await;
        let task = store
            .create_task(CreateTaskParams {
                agent_id: agent.id,
                source: "ad_hoc".into(),
                template_id: None,
                shell: "cmd".into(),
                command: "echo ok".into(),
                workdir: None,
                timeout_secs: 300,
            })
            .await
            .unwrap();

        dispatcher_tick(&store, &client).await.unwrap();
        let dispatched = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(dispatched.status, "dispatched");
        assert_eq!(dispatched.agent_task_id.as_deref(), Some("agent-task-1"));

        dispatcher_tick(&store, &client).await.unwrap();
        let running = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(running.status, "running");

        tokio::time::sleep(Duration::from_millis(150)).await;
        dispatcher_tick(&store, &client).await.unwrap();
        let finished = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(finished.status, "succeeded");
        assert_eq!(finished.exit_code, Some(0));
        assert_eq!(finished.stdout, "ok");
        assert!(finished.finished_at.is_some());
    }

    #[tokio::test]
    async fn dispatcher_tick_409_keeps_task_queued() {
        let store = test_store().await;
        let client = reqwest::Client::new();
        let (ip, port, _handle) = start_mock_agent(true).await;
        let agent = seed_online_agent(&store, &ip, port).await;
        let task = store
            .create_task(CreateTaskParams {
                agent_id: agent.id,
                source: "ad_hoc".into(),
                template_id: None,
                shell: "cmd".into(),
                command: "echo ok".into(),
                workdir: None,
                timeout_secs: 300,
            })
            .await
            .unwrap();

        dispatcher_tick(&store, &client).await.unwrap();
        let got = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(got.status, "queued");
        assert!(got.agent_task_id.is_none());
    }

    #[tokio::test]
    async fn dispatcher_tick_network_error_requeues_task() {
        let store = test_store().await;
        let client = reqwest::Client::new();
        let port = unused_local_port().await;
        let agent = seed_online_agent(&store, "127.0.0.1", port).await;
        let task = store
            .create_task(CreateTaskParams {
                agent_id: agent.id,
                source: "ad_hoc".into(),
                template_id: None,
                shell: "cmd".into(),
                command: "echo ok".into(),
                workdir: None,
                timeout_secs: 300,
            })
            .await
            .unwrap();

        dispatcher_tick(&store, &client).await.unwrap();
        let got = store.get_task(&task.id).await.unwrap().unwrap();
        assert_eq!(got.status, "queued");
        assert!(got.agent_task_id.is_none());
    }
}
