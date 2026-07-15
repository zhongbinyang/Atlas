# Scheduler + Agent

Rust workspace for a central **scheduler** (port **26630**) and Windows **agent** nodes (port **26631**). The scheduler stores agents, task templates, and tasks in SQLite, polls agent health, and dispatches shell commands. Both services expose Chinese WebUIs and REST APIs.

## Security warning

**No authentication.** All HTTP APIs and WebUIs are open. Deploy only on a trusted intranet or behind your own network controls. Do not expose these ports to the public internet.

## Platform

| Component  | Platform |
|------------|----------|
| Scheduler  | Cross-platform (tested on Windows) |
| Agent      | **Windows only** — executes tasks via `cmd` / `powershell` |

## Ports

| Service   | Default port | WebUI / API base |
|-----------|--------------|------------------|
| Scheduler | 26630        | `http://127.0.0.1:26630` |
| Agent     | 26631        | `http://127.0.0.1:26631` |

## Environment variables

### Scheduler

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_BIND` | `0.0.0.0` | Listen address |
| `SCHEDULER_PORT` | `26630` | Listen port |
| `SCHEDULER_DATABASE_URL` | `sqlite:data/scheduler.db` | SQLite connection string |
| `SCHEDULER_POLL_STATUS_INTERVAL_SECS` | `5` | Agent status poll interval |
| `SCHEDULER_POLL_TASK_INTERVAL_SECS` | `1` | Task dispatch / result poll interval |

Optional: set `RUST_LOG=info` (or `debug`) for tracing output.

### Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_CENTER_URL` | *(required)* | Scheduler base URL, e.g. `http://127.0.0.1:26630` |
| `AGENT_BIND` | `0.0.0.0` | Listen address |
| `AGENT_PORT` | `26631` | Listen port |
| `AGENT_ADVERTISE_IP` | auto-detect | IP registered with scheduler |
| `AGENT_HOSTNAME` | OS hostname | Computer name registered with scheduler |

## Run

Build once:

```powershell
cargo build --release
```

**Terminal A — scheduler:**

```powershell
$env:SCHEDULER_DATABASE_URL = "sqlite:data/scheduler.db"
cargo run -p scheduler
```

Open `http://127.0.0.1:26630` for the scheduler WebUI.

**Terminal B — agent (Windows):**

```powershell
$env:AGENT_CENTER_URL = "http://127.0.0.1:26630"
cargo run -p agent
```

Open `http://127.0.0.1:26631` for the agent WebUI.

## Dispatch behavior

The scheduler dispatches **at most one queued task per agent per tick**. Queued tasks are ordered **FIFO** (`created_at ASC`). While an agent is busy, additional tasks stay `queued` until the current task finishes (agent returns HTTP 409 if a second task is submitted directly).

**Agent restart during execution:** If an agent restarts while a task is `dispatched` or `running`, the scheduler’s recovery logic may not find the in-flight task on the agent (e.g. HTTP 404 or other non-success). The center task is requeued and may run again after redispatch. Treat long or side-effecting commands accordingly.

## Manual E2E checklist

1. **Scheduler starts** on `:26630`; `GET http://127.0.0.1:26630/` returns the WebUI (200).
2. **Agent registers** — within ~5 s, `GET http://127.0.0.1:26630/api/agents` shows the agent `online` with CPU and memory percentages.
3. **Create a task template** via WebUI or `POST /api/templates`.
4. **Task from template** — create a task for the agent from that template; status eventually becomes `succeeded`.
5. **Ad-hoc task** — submit `cmd` / `echo ok`; status becomes `succeeded`.
6. **Queued while busy** — start a long-running command (e.g. `ping -n 8 127.0.0.1`), immediately submit a second short task; second task stays `queued` until the first completes, then succeeds.

## Tests

```powershell
cargo test --workspace
```

## Workspace layout

```
crates/
  common/     Shared types and API models
  scheduler/  Center service + WebUI
  agent/      Windows executor node + WebUI
```
