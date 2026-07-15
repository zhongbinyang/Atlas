# Scheduler + Windows Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust workspace with a scheduling center (`:26630`, SQLite, WebUI) and a Windows Agent (`:26631`, WebUI) that registers by hostname/IP, exposes CPU/memory, and runs template or ad-hoc shell tasks serially under center-driven dispatch.

**Architecture:** Cargo workspace (`common`, `scheduler`, `agent`). Both services are Axum monoliths serving REST + embedded static UI. The center upserts agents, polls `GET /api/status`, enqueues tasks, pushes `POST /api/tasks` to agents, and polls results. Agents execute one task at a time via `cmd`/`powershell`.

**Tech Stack:** Rust 2021, Axum, Tokio, Serde, SQLx (SQLite), reqwest, sysinfo, uuid, chrono, tower-http, toml

**Spec:** `docs/superpowers/specs/2026-07-15-scheduler-agent-design.md`

## Global Constraints

- Scheduler bind default `0.0.0.0:26630`; Agent default `0.0.0.0:26631`
- No auth / no TLS (trusted intranet only)
- Agent platform target: Windows (executor tests assume Windows)
- One task slot per agent; busy → HTTP 409; center keeps task `queued`
- Task status machine: `queued` → `dispatched` → `running` → `succeeded` | `failed` | `timeout`
- Default task timeout `300` seconds; default shell `cmd`
- Status poll interval `5s`; task result poll interval `1s`
- Config: env vars primary; optional `config.toml`; hardcoded defaults as fallback
- UI language: Chinese
- YAGNI: no metric history, no multi-agent workflows, no Linux agent

---

## File Structure

```text
Cargo.toml
crates/common/Cargo.toml
crates/common/src/lib.rs
crates/common/src/types.rs
crates/common/src/error.rs
crates/agent/Cargo.toml
crates/agent/src/main.rs
crates/agent/src/config.rs
crates/agent/src/metrics.rs
crates/agent/src/executor.rs
crates/agent/src/task_slot.rs
crates/agent/src/api.rs
crates/agent/src/register.rs
crates/agent/src/web.rs
crates/agent/static/index.html
crates/agent/static/app.js
crates/agent/static/style.css
crates/scheduler/Cargo.toml
crates/scheduler/src/main.rs
crates/scheduler/src/config.rs
crates/scheduler/src/db.rs
crates/scheduler/src/store.rs
crates/scheduler/src/api.rs
crates/scheduler/src/poller.rs
crates/scheduler/src/dispatcher.rs
crates/scheduler/src/web.rs
crates/scheduler/migrations/001_init.sql
crates/scheduler/static/index.html
crates/scheduler/static/app.js
crates/scheduler/static/style.css
README.md
```

| Path | Responsibility |
|------|----------------|
| `crates/common` | Shared DTOs, enums, `ErrorBody` |
| `crates/agent/.../metrics.rs` | CPU/memory via sysinfo |
| `crates/agent/.../executor.rs` | Spawn cmd/powershell, timeout, capture output |
| `crates/agent/.../task_slot.rs` | Single-slot busy gate + recent task map |
| `crates/agent/.../api.rs` | Agent REST handlers |
| `crates/agent/.../register.rs` | POST register to center |
| `crates/scheduler/.../store.rs` | SQLite CRUD for agents/templates/tasks |
| `crates/scheduler/.../poller.rs` | Periodic status pull → online/offline + metrics |
| `crates/scheduler/.../dispatcher.rs` | Dispatch queued tasks + recover results |
| `*/static/*` | Embedded Chinese WebUI |

---

### Task 1: Workspace + `common` types

**Files:**
- Create: `Cargo.toml`
- Create: `crates/common/Cargo.toml`
- Create: `crates/common/src/lib.rs`
- Create: `crates/common/src/types.rs`
- Create: `crates/common/src/error.rs`
- Create: `crates/agent/Cargo.toml` (stub package only)
- Create: `crates/scheduler/Cargo.toml` (stub package only)
- Create: `crates/agent/src/main.rs` (stub `fn main() {}`)
- Create: `crates/scheduler/src/main.rs` (stub `fn main() {}`)
- Test: `crates/common/src/types.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: nothing
- Produces: `TaskStatus`, `ShellKind`, `AgentStatus`, `RegisterAgentRequest`, `AgentStatusResponse`, `CreateAgentTaskRequest`, `AgentTaskView`, `ErrorBody`

- [ ] **Step 1: Write failing tests for status JSON**

Create workspace root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/common", "crates/agent", "crates/scheduler"]
```

Create `crates/common/Cargo.toml`:

```toml
[package]
name = "common"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Create stub `crates/agent` and `crates/scheduler` packages with empty `main` so workspace resolves.

In `crates/common/src/types.rs` temporarily only tests (will fail to compile until types exist) — actually put tests after minimal structs. Prefer: add test file content that expects serde roundtrip; implement types in step 3.

Write `crates/common/src/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Dispatched,
    Running,
    Succeeded,
    Failed,
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    Cmd,
    Powershell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOnlineStatus {
    Online,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterAgentRequest {
    pub name: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusResponse {
    pub hostname: String,
    pub ip: String,
    pub cpu_percent: f32,
    pub memory_percent: f32,
    pub busy: bool,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentTaskRequest {
    pub shell: ShellKind,
    pub command: String,
    pub workdir: Option<String>,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskView {
    pub id: String,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_serializes_snake_case() {
        let v = serde_json::to_string(&TaskStatus::Succeeded).unwrap();
        assert_eq!(v, "\"succeeded\"");
        let back: TaskStatus = serde_json::from_str(&v).unwrap();
        assert_eq!(back, TaskStatus::Succeeded);
    }

    #[test]
    fn register_request_roundtrip() {
        let req = RegisterAgentRequest {
            name: "LINE-01".into(),
            ip: "192.168.1.20".into(),
            port: 26631,
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: RegisterAgentRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.port, 26631);
        assert_eq!(back.name, "LINE-01");
    }
}
```

`crates/common/src/error.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
}
```

`crates/common/src/lib.rs`:

```rust
pub mod error;
pub mod types;

pub use error::ErrorBody;
pub use types::*;
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p common`

Expected: PASS (both tests)

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml crates/common crates/agent crates/scheduler
git commit -m "feat: scaffold workspace and common DTOs"
```

---

### Task 2: Agent config + metrics

**Files:**
- Create: `crates/agent/src/config.rs`
- Create: `crates/agent/src/metrics.rs`
- Modify: `crates/agent/Cargo.toml`
- Modify: `crates/agent/src/main.rs` (module declarations only for now)
- Test: `crates/agent/src/config.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: env vars `AGENT_CENTER_URL`, `AGENT_BIND`, `AGENT_PORT`, `AGENT_ADVERTISE_IP`, `AGENT_HOSTNAME`
- Produces: `AgentConfig::load() -> Result<AgentConfig, String>`, `collect_metrics(hostname, ip) -> AgentStatusResponse` (busy/uptime filled by caller later — metrics returns cpu/memory only via helper)

- [ ] **Step 1: Add deps and failing config test**

`crates/agent/Cargo.toml`:

```toml
[package]
name = "agent"
version = "0.1.0"
edition = "2021"

[dependencies]
common = { path = "../common" }
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
sysinfo = "0.33"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tower-http = { version = "0.6", features = ["fs", "trace"] }
toml = "0.8"
tracing = "0.1"
tracing-subscriber = "0.3"
hostname = "0.4"
local-ip-address = "0.6"
```

Write `crates/agent/src/config.rs` with test first expecting defaults/port parse:

```rust
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub bind: String,
    pub port: u16,
    pub center_url: String,
    pub advertise_ip: Option<String>,
    pub hostname: Option<String>,
}

impl AgentConfig {
    pub fn load_from_env() -> Result<Self, String> {
        let center_url = std::env::var("AGENT_CENTER_URL")
            .map_err(|_| "AGENT_CENTER_URL is required".to_string())?;
        let bind = std::env::var("AGENT_BIND").unwrap_or_else(|_| "0.0.0.0".into());
        let port = std::env::var("AGENT_PORT")
            .ok()
            .map(|s| s.parse::<u16>().map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(26631);
        let advertise_ip = std::env::var("AGENT_ADVERTISE_IP").ok();
        let hostname = std::env::var("AGENT_HOSTNAME").ok();
        Ok(Self {
            bind,
            port,
            center_url,
            advertise_ip,
            hostname,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_is_26631() {
        std::env::remove_var("AGENT_PORT");
        std::env::set_var("AGENT_CENTER_URL", "http://127.0.0.1:26630");
        let cfg = AgentConfig::load_from_env().unwrap();
        assert_eq!(cfg.port, 26631);
        std::env::remove_var("AGENT_CENTER_URL");
    }

    #[test]
    fn missing_center_url_errors() {
        std::env::remove_var("AGENT_CENTER_URL");
        assert!(AgentConfig::load_from_env().is_err());
    }
}
```

- [ ] **Step 2: Run config tests**

Run: `cargo test -p agent config::`

Expected: PASS

- [ ] **Step 3: Implement metrics**

`crates/agent/src/metrics.rs`:

```rust
use sysinfo::System;

pub struct MetricsSampler {
    sys: System,
}

impl MetricsSampler {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        Self { sys }
    }

    pub fn cpu_and_memory(&mut self) -> (f32, f32) {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        let cpu = self.sys.global_cpu_usage();
        let total = self.sys.total_memory() as f32;
        let used = self.sys.used_memory() as f32;
        let mem = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
        (cpu, mem)
    }
}
```

Note: first `global_cpu_usage` may be 0; caller should sample twice with a short sleep on status endpoint if needed (sleep 200ms then refresh again inside `cpu_and_memory` once).

Update `cpu_and_memory` to sleep and refresh twice for a usable reading:

```rust
pub fn cpu_and_memory(&mut self) -> (f32, f32) {
    self.sys.refresh_cpu_usage();
    std::thread::sleep(std::time::Duration::from_millis(200));
    self.sys.refresh_cpu_usage();
    self.sys.refresh_memory();
    let cpu = self.sys.global_cpu_usage();
    let total = self.sys.total_memory() as f32;
    let used = self.sys.used_memory() as f32;
    let mem = if total > 0.0 { (used / total) * 100.0 } else { 0.0 };
    (cpu, mem)
}
```

Wire modules in `main.rs` (still no server):

```rust
mod config;
mod metrics;

fn main() {
    println!("agent stub");
}
```

- [ ] **Step 4: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): add config and metrics sampler"
```

---

### Task 3: Agent executor (serial process runner)

**Files:**
- Create: `crates/agent/src/executor.rs`
- Modify: `crates/agent/src/main.rs`
- Test: `crates/agent/src/executor.rs` (`#[cfg(test)]`, Windows)

**Interfaces:**
- Consumes: `ShellKind`, command, workdir, timeout
- Produces: `ExecuteResult { status: TaskStatus, exit_code: Option<i32>, stdout, stderr }`

- [ ] **Step 1: Write failing executor tests**

```rust
use common::{ShellKind, TaskStatus};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug)]
pub struct ExecuteResult {
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run_command(
    shell: ShellKind,
    command: &str,
    workdir: Option<&str>,
    timeout_secs: u64,
) -> ExecuteResult {
    let mut cmd = match shell {
        ShellKind::Cmd => {
            let mut c = Command::new("cmd");
            c.args(["/C", command]);
            c
        }
        ShellKind::Powershell => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            c
        }
    };
    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecuteResult {
                status: TaskStatus::Failed,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("failed to spawn: {e}"),
            };
        }
    };

    match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let code = output.status.code();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let status = if output.status.success() {
                TaskStatus::Succeeded
            } else {
                TaskStatus::Failed
            };
            ExecuteResult {
                status,
                exit_code: code,
                stdout,
                stderr,
            }
        }
        Ok(Err(e)) => ExecuteResult {
            status: TaskStatus::Failed,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("wait error: {e}"),
        },
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            ExecuteResult {
                status: TaskStatus::Timeout,
                exit_code: None,
                stdout: String::new(),
                stderr: "timeout".into(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_succeeds() {
        let r = run_command(ShellKind::Cmd, "echo hello", None, 30).await;
        assert_eq!(r.status, TaskStatus::Succeeded);
        assert!(r.stdout.to_lowercase().contains("hello"));
    }

    #[tokio::test]
    async fn nonzero_fails() {
        let r = run_command(ShellKind::Cmd, "exit /B 7", None, 30).await;
        assert_eq!(r.status, TaskStatus::Failed);
        assert_eq!(r.exit_code, Some(7));
    }

    #[tokio::test]
    async fn timeout_kills() {
        let r = run_command(ShellKind::Cmd, "ping -n 10 127.0.0.1", None, 1).await;
        assert_eq!(r.status, TaskStatus::Timeout);
    }
}
```

Fix kill path: after timeout, `wait_with_output` consumed the future — keep `Child` and on timeout call `start_kill` then `wait`. Adjust implementation so `child` remains after timeout branch (use `tokio::select!` or kill before wait_with_output pattern). Prefer:

```rust
let join = child.wait_with_output();
match timeout(Duration::from_secs(timeout_secs), join).await {
    // ...
    Err(_) => {
        // Cannot kill after wait_with_output moved child — use:
    }
}
```

Correct pattern:

```rust
pub async fn run_command(...) -> ExecuteResult {
    // spawn child
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // ... OR simpler for v1:
    match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => { /* as above */ }
        Ok(Err(e)) => { /* failed */ }
        Err(_) => {
            // child was moved into wait_with_output — use killable wrapper:
            ExecuteResult { status: TaskStatus::Timeout, .. }
        }
    }
}
```

Use this killable implementation instead:

```rust
pub async fn run_command(
    shell: ShellKind,
    command: &str,
    workdir: Option<&str>,
    timeout_secs: u64,
) -> ExecuteResult {
    let mut cmd = match shell {
        ShellKind::Cmd => {
            let mut c = Command::new("cmd");
            c.args(["/C", command]);
            c
        }
        ShellKind::Powershell => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            c
        }
    };
    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }
    cmd.kill_on_drop(true);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecuteResult {
                status: TaskStatus::Failed,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("failed to spawn: {e}"),
            };
        }
    };

    match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let code = output.status.code();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let status = if output.status.success() {
                TaskStatus::Succeeded
            } else {
                TaskStatus::Failed
            };
            ExecuteResult { status, exit_code: code, stdout, stderr }
        }
        Ok(Err(e)) => ExecuteResult {
            status: TaskStatus::Failed,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("wait error: {e}"),
        },
        Err(_) => ExecuteResult {
            status: TaskStatus::Timeout,
            exit_code: None,
            stdout: String::new(),
            stderr: "timeout".into(),
        },
    }
}
```

(`kill_on_drop(true)` ensures timeout drop kills the child.)

- [ ] **Step 2: Run executor tests**

Run: `cargo test -p agent executor::`

Expected: PASS on Windows

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/executor.rs crates/agent/src/main.rs
git commit -m "feat(agent): add Windows command executor with timeout"
```

---

### Task 4: Agent task slot + REST API

**Files:**
- Create: `crates/agent/src/task_slot.rs`
- Create: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/main.rs`
- Test: `crates/agent/src/task_slot.rs`; API test via `axum::Router` + `oneshot` or `tokio::test` + `reqwest` against bound listener

**Interfaces:**
- Consumes: `CreateAgentTaskRequest`, executor, metrics
- Produces: routes: `GET /api/health`, `GET /api/status`, `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/{id}`

- [ ] **Step 1: Implement `TaskSlot` with unit tests**

```rust
use common::{AgentTaskView, CreateAgentTaskRequest, TaskStatus};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;
use crate::executor;

pub struct TaskSlot {
    inner: Mutex<Inner>,
}

struct Inner {
    busy: bool,
    tasks: HashMap<String, AgentTaskView>,
}

impl TaskSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                busy: false,
                tasks: HashMap::new(),
            }),
        })
    }

    pub async fn is_busy(&self) -> bool {
        self.inner.lock().await.busy
    }

    pub async fn list(&self) -> Vec<AgentTaskView> {
        self.inner.lock().await.tasks.values().cloned().collect()
    }

    pub async fn get(&self, id: &str) -> Option<AgentTaskView> {
        self.inner.lock().await.tasks.get(id).cloned()
    }

    /// Returns Err("busy") if slot occupied.
    pub async fn submit(self: &Arc<Self>, req: CreateAgentTaskRequest) -> Result<AgentTaskView, &'static str> {
        let id = Uuid::new_v4().to_string();
        {
            let mut g = self.inner.lock().await;
            if g.busy {
                return Err("busy");
            }
            g.busy = true;
            let view = AgentTaskView {
                id: id.clone(),
                status: TaskStatus::Running,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
            };
            g.tasks.insert(id.clone(), view.clone());
        }
        let slot = Arc::clone(self);
        let id2 = id.clone();
        tokio::spawn(async move {
            let result = executor::run_command(
                req.shell,
                &req.command,
                req.workdir.as_deref(),
                req.timeout_secs,
            )
            .await;
            let mut g = slot.inner.lock().await;
            if let Some(t) = g.tasks.get_mut(&id2) {
                t.status = result.status;
                t.exit_code = result.exit_code;
                t.stdout = result.stdout;
                t.stderr = result.stderr;
            }
            g.busy = false;
        });
        Ok(self.get(&id).await.unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::ShellKind;

    #[tokio::test]
    async fn rejects_second_while_busy() {
        let slot = TaskSlot::new();
        let req = CreateAgentTaskRequest {
            shell: ShellKind::Cmd,
            command: "ping -n 3 127.0.0.1".into(),
            workdir: None,
            timeout_secs: 30,
        };
        assert!(slot.submit(req.clone()).await.is_ok());
        let err = slot.submit(req).await.unwrap_err();
        assert_eq!(err, "busy");
    }
}
```

- [ ] **Step 2: Implement Axum `api.rs`**

```rust
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use common::{
    AgentStatusResponse, CreateAgentTaskRequest, ErrorBody, RegisterAgentRequest,
};
use std::sync::Arc;
use std::time::Instant;
use crate::metrics::MetricsSampler;
use crate::task_slot::TaskSlot;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub hostname: String,
    pub ip: String,
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
        port: 0, // overwritten in register helper — pass real port via state
    };
    let _ = body;
    // Delegate to register::register_with_center in Task 5; for now return 501 stub only if needed.
    // In this task, add `pub port: u16` to AppState and call register helper once Task 5 lands.
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}
```

Add `port: u16` to `AppState` before finishing Task 5. For Task 4 API test, skip `register-now` body details.

- [ ] **Step 3: Integration test — busy returns 409**

In `api.rs` or `tests/api.rs`:

```rust
#[tokio::test]
async fn post_task_conflict_when_busy() {
    // build AppState with TaskSlot, tower::ServiceExt::oneshot
    // first POST CreateAgentTaskRequest { command: "ping -n 5 127.0.0.1", ... }
    // second POST same → status 409
}
```

Use:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

// after building router:
let req = Request::builder()
    .method("POST")
    .uri("/api/tasks")
    .header("content-type", "application/json")
    .body(Body::from(serde_json::to_vec(&payload).unwrap()))
    .unwrap();
let resp = router.oneshot(req).await.unwrap();
```

Add `tower = "0.5"` and `http-body-util` if needed to `crates/agent/Cargo.toml` dev-dependencies:

```toml
[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p agent`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): add task slot and REST API"
```

---

### Task 5: Agent register client, WebUI, `main`

**Files:**
- Create: `crates/agent/src/register.rs`
- Create: `crates/agent/src/web.rs`
- Create: `crates/agent/static/index.html`
- Create: `crates/agent/static/app.js`
- Create: `crates/agent/static/style.css`
- Modify: `crates/agent/src/main.rs`
- Modify: `crates/agent/src/api.rs` (`register-now` real call)

**Interfaces:**
- Consumes: `AgentConfig`, `RegisterAgentRequest`
- Produces: running server; startup registration; Chinese UI

- [ ] **Step 1: Implement register helper**

```rust
use common::RegisterAgentRequest;

pub async fn register_with_center(
    client: &reqwest::Client,
    center_url: &str,
    req: &RegisterAgentRequest,
) -> Result<(), String> {
    let url = format!("{}/api/agents/register", center_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(req)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("register failed: {}", resp.status()));
    }
    Ok(())
}
```

- [ ] **Step 2: Wire `main.rs`**

```rust
mod api;
mod config;
mod executor;
mod metrics;
mod register;
mod task_slot;
mod web;

use api::AppState;
use config::AgentConfig;
use metrics::MetricsSampler;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use task_slot::TaskSlot;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cfg = AgentConfig::load_from_env().expect("config");
    let hostname = cfg
        .hostname
        .clone()
        .unwrap_or_else(|| hostname::get().unwrap().to_string_lossy().into_owned());
    let ip = cfg.advertise_ip.clone().unwrap_or_else(|| {
        local_ip_address::local_ip()
            .map(|i| i.to_string())
            .unwrap_or_else(|_| "127.0.0.1".into())
    });

    let state = AppState {
        hostname: hostname.clone(),
        ip: ip.clone(),
        port: cfg.port,
        started: Instant::now(),
        slot: TaskSlot::new(),
        metrics: Arc::new(Mutex::new(MetricsSampler::new())),
        center_url: cfg.center_url.clone(),
    };

    let client = reqwest::Client::new();
    let reg = common::RegisterAgentRequest {
        name: hostname,
        ip,
        port: cfg.port,
    };
    if let Err(e) = register::register_with_center(&client, &cfg.center_url, &reg).await {
        tracing::warn!("initial register failed: {e}");
    }

    let app = api::router(state).merge(web::static_router());
    let addr: SocketAddr = format!("{}:{}", cfg.bind, cfg.port).parse().unwrap();
    tracing::info!("agent listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

`web.rs` — serve `crates/agent/static` via `tower_http::services::ServeDir` mounted at `/`, with API routes taking precedence (merge order: API first then fallback, or nest static under `/` with `ServeDir`).

```rust
use axum::Router;
use tower_http::services::ServeDir;

pub fn static_router() -> Router {
    Router::new().fallback_service(ServeDir::new("crates/agent/static"))
}
```

For released binary, prefer `include_dir` / `rust-embed`. v1: resolve path relative to `CARGO_MANIFEST_DIR`:

```rust
pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    Router::new().fallback_service(ServeDir::new(dir))
}
```

- [ ] **Step 3: Minimal Chinese WebUI**

`static/index.html`: title「产线 Agent」; sections for status (CPU/内存/忙碌) and task table; button「重新注册」→ `POST /api/register-now`.

`static/app.js`: poll `GET /api/status` every 2s; poll `GET /api/tasks` every 2s; wire register button.

`static/style.css`: simple table layout, no purple gradient marketing look.

- [ ] **Step 4: Fix `register-now` handler** to call `register_with_center` using `AppState.port`.

- [ ] **Step 5: Manual smoke (agent alone)**

Run scheduler stub not required for status/tasks; for register expect warn if center down.

```bash
$env:AGENT_CENTER_URL="http://127.0.0.1:26630"
cargo run -p agent
```

curl: `Invoke-RestMethod http://127.0.0.1:26631/api/status`

Expected: JSON with cpu/memory fields

- [ ] **Step 6: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): wire server, registration, and WebUI"
```

---

### Task 6: Scheduler DB schema + store

**Files:**
- Create: `crates/scheduler/migrations/001_init.sql`
- Create: `crates/scheduler/src/db.rs`
- Create: `crates/scheduler/src/store.rs`
- Create: `crates/scheduler/src/config.rs`
- Modify: `crates/scheduler/Cargo.toml`
- Test: `crates/scheduler/src/store.rs`

**Interfaces:**
- Consumes: SQLite via SQLx
- Produces: `Store` methods: `upsert_agent`, `list_agents`, `get_agent`, `update_agent_status`, `create_template`, `list_templates`, `get_template`, `update_template`, `delete_template`, `create_task`, `list_tasks`, `get_task`, `update_task`

- [ ] **Step 1: Dependencies**

```toml
[package]
name = "scheduler"
version = "0.1.0"
edition = "2021"

[dependencies]
common = { path = "../common" }
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "chrono", "uuid"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tower-http = { version = "0.6", features = ["fs", "trace"] }
toml = "0.8"
tracing = "0.1"
tracing-subscriber = "0.3"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
tempfile = "3"
```

- [ ] **Step 2: Migration SQL**

`migrations/001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL NOT NULL DEFAULT 0,
  memory_percent REAL NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, ip, port)
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shell TEXT NOT NULL,
  command TEXT NOT NULL,
  workdir TEXT,
  timeout_secs INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  template_id TEXT,
  shell TEXT NOT NULL,
  command TEXT NOT NULL,
  workdir TEXT,
  timeout_secs INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  agent_task_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
```

- [ ] **Step 3: `db.rs` open + migrate**

```rust
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

pub async fn connect(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    // ensure parent dir for sqlite file
    if let Some(path) = database_url.strip_prefix("sqlite:") {
        let path = path.trim_start_matches("//");
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    let opts = SqliteConnectOptions::from_str(database_url)?.create_if_missing(true);
    let pool = SqlitePoolOptions::new().connect_with(opts).await?;
    let sql = include_str!("../migrations/001_init.sql");
    sqlx::raw_sql(sql).execute(&pool).await?;
    Ok(pool)
}
```

- [ ] **Step 4: Store upsert + tests with tempfile DB**

Implement `Store { pool }` with `upsert_agent(name, ip, port)` creating UUID on insert / updating on conflict.

Test:

```rust
#[tokio::test]
async fn upsert_agent_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}", dir.path().join("t.db").display());
    let pool = crate::db::connect(&url).await.unwrap();
    let store = Store::new(pool);
    let a = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
    let b = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
    assert_eq!(a.id, b.id);
}
```

Also test `create_task` starts as `queued` and `update_task` can set `succeeded`.

- [ ] **Step 5: Run tests**

Run: `cargo test -p scheduler store::`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): add SQLite schema and store"
```

---

### Task 7: Scheduler agent API + status poller

**Files:**
- Create: `crates/scheduler/src/api.rs` (agents + health first)
- Create: `crates/scheduler/src/poller.rs`
- Create: `crates/scheduler/src/config.rs` (if not done)
- Modify: `crates/scheduler/src/main.rs` (start poller)

**Interfaces:**
- Consumes: `RegisterAgentRequest`, Agent `GET /api/status`
- Produces: `POST /api/agents/register`, `GET /api/agents`, `GET /api/agents/{id}`, background poll every `poll_status_interval_secs`

- [ ] **Step 1: Config defaults**

```rust
pub struct SchedulerConfig {
    pub bind: String,
    pub port: u16,
    pub database_url: String,
    pub poll_status_interval_secs: u64,
    pub poll_task_interval_secs: u64,
}

impl SchedulerConfig {
    pub fn load() -> Self {
        Self {
            bind: std::env::var("SCHEDULER_BIND").unwrap_or_else(|_| "0.0.0.0".into()),
            port: std::env::var("SCHEDULER_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(26630),
            database_url: std::env::var("SCHEDULER_DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:data/scheduler.db".into()),
            poll_status_interval_secs: std::env::var("SCHEDULER_POLL_STATUS_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
            poll_task_interval_secs: std::env::var("SCHEDULER_POLL_TASK_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1),
        }
    }
}
```

- [ ] **Step 2: Register/list handlers**

Validate name/ip non-empty; port != 0; else 400 `ErrorBody`.

- [ ] **Step 3: Poller**

```rust
pub async fn run_status_poller(store: Store, client: reqwest::Client, interval_secs: u64) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    loop {
        ticker.tick().await;
        let agents = match store.list_agents().await {
            Ok(a) => a,
            Err(e) => {
                tracing::error!("list agents: {e}");
                continue;
            }
        };
        for agent in agents {
            let url = format!("http://{}:{}/api/status", agent.ip, agent.port);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(st) = resp.json::<common::AgentStatusResponse>().await {
                        let _ = store
                            .update_agent_metrics(
                                &agent.id,
                                "online",
                                st.cpu_percent,
                                st.memory_percent,
                                st.busy,
                            )
                            .await;
                    }
                }
                _ => {
                    let _ = store.mark_agent_offline(&agent.id).await;
                }
            }
        }
    }
}
```

Extend agents table usage: store `busy` — add column `busy INTEGER NOT NULL DEFAULT 0` in migration (update `001_init.sql` before first release). If migration already committed in Task 6, alter migration file only if DB not shipped yet (greenfield — edit `001_init.sql` to include `busy`).

- [ ] **Step 4: Test register upsert via HTTP oneshot**

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): agent registry API and status poller"
```

---

### Task 8: Scheduler templates + tasks CRUD API

**Files:**
- Modify: `crates/scheduler/src/api.rs`
- Modify: `crates/scheduler/src/store.rs`
- Test: API oneshot tests for template CRUD and task create (template + ad_hoc)

**Interfaces:**
- Produces: full template REST; `POST /api/tasks` accepting either `{ agent_id, template_id }` or `{ agent_id, shell, command, workdir?, timeout_secs? }`

- [ ] **Step 1: Write tests for create task from template**

Creating template then task should persist `source=template`, copy shell/command/workdir/timeout, status `queued`.

- [ ] **Step 2: Implement handlers**

Default `timeout_secs` to 300, `shell` to `cmd` for ad_hoc when omitted.

- [ ] **Step 3: Run `cargo test -p scheduler`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): templates and task creation APIs"
```

---

### Task 9: Dispatcher (dispatch + result recovery)

**Files:**
- Create: `crates/scheduler/src/dispatcher.rs`
- Modify: `crates/scheduler/src/main.rs`
- Test: `crates/scheduler/src/dispatcher.rs` with mock agent using a local Axum stub server

**Interfaces:**
- Consumes: queued tasks; Agent `POST /api/tasks`, `GET /api/tasks/{id}`
- Produces: status transitions per spec

- [ ] **Step 1: Write failing dispatcher integration test**

Spin up a tiny mock agent:

- `POST /api/tasks` → 201 `{ id, status: "running", ... }` first time; 409 if flag busy
- `GET /api/tasks/{id}` → after 100ms return `succeeded` with stdout

Run dispatcher one tick against in-memory/temp store; assert center task becomes `succeeded`.

Second test: mock returns 409; after tick task still `queued`.

- [ ] **Step 2: Implement dispatcher loop**

Every `poll_task_interval_secs`:

1. For each task in `queued`: load agent; if agent `online` and not `busy`, POST create task to agent; on 201 set `dispatched` + `agent_task_id`; on 409 leave queued; on network error leave/mark queued and optionally mark offline.
2. For each task in `dispatched`/`running` with `agent_task_id`: GET agent task; map status; on `running` set center `running` + `started_at`; on terminal copy fields.

```rust
pub async fn dispatcher_tick(store: &Store, client: &reqwest::Client) -> Result<(), String> {
    // 1) recover in-flight
    // 2) dispatch queued
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
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p scheduler dispatcher::`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): task dispatcher and result polling"
```

---

### Task 10: Scheduler WebUI + main wiring

**Files:**
- Create: `crates/scheduler/src/web.rs`
- Create: `crates/scheduler/static/index.html`
- Create: `crates/scheduler/static/app.js`
- Create: `crates/scheduler/static/style.css`
- Modify: `crates/scheduler/src/main.rs`

**Interfaces:**
- Produces: Chinese UI for agents, templates, tasks on `:26630`

- [ ] **Step 1: `main.rs` start**

Connect DB, build `Router` = api + static, spawn `run_status_poller` and `run_dispatcher`, bind `0.0.0.0:26630`.

- [ ] **Step 2: WebUI pages (single page with sections)**

- Agent 表：电脑名、IP、状态、CPU%、内存%、忙碌
- 模板：表单 + 列表（删除按钮）
- 任务：选择 agent、模板或临时命令、提交；列表点开详情显示 stdout/stderr

- [ ] **Step 3: Manual E2E**

Terminal A:

```bash
$env:SCHEDULER_DATABASE_URL="sqlite:data/scheduler.db"
cargo run -p scheduler
```

Terminal B:

```bash
$env:AGENT_CENTER_URL="http://127.0.0.1:26630"
cargo run -p agent
```

Checks:

1. `GET http://127.0.0.1:26630/api/agents` shows agent online with CPU/memory within ~5s
2. Create template via API or UI
3. Create task from template → eventually `succeeded`
4. Create ad-hoc `cmd` `echo ok` → `succeeded`
5. While long task running, second task stays `queued`

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler README.md
git commit -m "feat(scheduler): WebUI and process entrypoint"
```

---

### Task 11: README + workspace polish

**Files:**
- Create: `README.md`
- Modify: `.gitignore` (`/target`, `data/`, `.vscode` optional)

**Interfaces:** none

- [ ] **Step 1: Write README**

Cover: ports, env vars, run commands, intranet/no-auth warning, Windows-only agent, manual test checklist from Task 10.

- [ ] **Step 2: `.gitignore`**

```gitignore
/target
/data
**/*.db
```

- [ ] **Step 3: Full test suite**

Run: `cargo test --workspace`

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add runbook and gitignore for scheduler/agent"
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| Workspace common/scheduler/agent | 1 |
| Ports 26630 / 26631 | 2, 5, 7, 10 |
| SQLite agents/templates/tasks | 6 |
| Register by name+ip+port | 5, 7 |
| Status CPU/memory + busy | 2, 4, 7 |
| Center pulls status / offline | 7 |
| Template + ad-hoc tasks | 8 |
| Serial agent + 409 | 3, 4, 9 |
| Dispatch + result poll | 9 |
| Status machine | 6, 9 |
| Both WebUIs Chinese | 5, 10 |
| No auth | Global / all APIs |
| Env + defaults config | 2, 7 |
| Executor success/fail/timeout tests | 3 |
| Dispatcher mock tests | 9 |
| Manual E2E | 10, 11 |

**Gaps found during review:** `busy` column on agents must be in migration — called out in Task 7. Optional `config.toml` loading can be a thin addition in config modules during Tasks 2/7 if time permits; env-first satisfies spec minimum — add `load_toml_overrides` reading `config.toml` beside executable in Tasks 2 and 7 as last steps if not already done:

```rust
// optional: if Path::new("config.toml").exists() { merge keys }
```

Implement optional TOML in Task 11 if skipped earlier.

**Placeholder scan:** none intentional; dispatcher_tick body is specified by the two-phase algorithm in Task 9.

**Type consistency:** `TaskStatus`, `ShellKind`, `RegisterAgentRequest`, `AgentStatusResponse`, `CreateAgentTaskRequest`, `AgentTaskView`, `ErrorBody` defined in Task 1 and reused throughout.
