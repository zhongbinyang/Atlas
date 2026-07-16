# LabVIEW VI Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators inspect LabVIEW VIs via `labview-runner-cli`, edit input defaults, trial-run, register bound `vi_templates` on the scheduler, and dispatch runs through the existing task queue — from both Agent and center WebUIs (center proxies to Agents).

**Architecture:** Agent owns CLI spawn (`inspect`/`run`) behind `/api/labview/*`. Scheduler adds `vi_templates` SQLite table + CRUD/dispatch, and POST-proxies LabVIEW calls to Agents. WebUIs use absolute-path text fields and editable inputs tables. Dispatch builds a `cmd` command line from template snapshots (`cli_path`, `getinfo_path`, `vi_path`, inputs).

**Tech Stack:** Existing Axum/Tokio/serde/SQLx workspace; `std::process::Command`; no new crates required beyond what exists.

**Spec:** `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`

## Global Constraints

- LabVIEW / CLI only on Agent machines; center never runs LabVIEW locally
- Defaults: `AGENT_LABVIEW_CLI` = `C:\labview-runner-cli\labview-runner-cli.exe`; `AGENT_LABVIEW_GETINFO_VI` = `C:\labview-runner-cli\getinfo.vi`
- Independent `vi_templates` table (not shell `task_templates`)
- Templates bind `agent_id`; dispatch always uses that agent
- Register snapshots `cli_path` + `getinfo_path`
- `inputs_json` stores full inputs array (`name`/`className`/`value`)
- VI path: absolute path text (no browser file-path API)
- Chinese WebUI; reuse industrial tokens
- CLI contract: stdout success JSON; stderr error JSON; exit codes 0,2,3,4,5,6,7 per test06 README
- Dispatch: `shell=cmd`, enqueue existing `tasks`
- Browser never talks to Agent `:26631` for center-driven LabVIEW (proxy only)

---

## File Structure

```text
crates/agent/src/config.rs              # labview_cli, labview_getinfo
crates/agent/src/labview.rs             # NEW — args, spawn, exit map, inputs→CLI object
crates/agent/src/api.rs                 # /api/labview/*
crates/agent/src/main.rs                # mod + AppState
crates/scheduler/migrations/003_vi_templates.sql
crates/scheduler/src/db.rs              # run migration
crates/scheduler/src/store.rs           # vi_templates CRUD
crates/scheduler/src/labview_cmd.rs     # NEW — build dispatch command line
crates/scheduler/src/api.rs             # proxy POST + vi-templates + dispatch
crates/agent/static/{index.html,app.js,style.css}
crates/scheduler/static/{index.html,app.js,style.css}
README.md
```

| Path | Responsibility |
|------|----------------|
| `agent/labview.rs` | Pure helpers + `Command` spawn |
| `agent` API | HTTP mapping |
| `003_vi_templates.sql` | Schema |
| `labview_cmd.rs` | Deterministic cmd string for dispatch |
| scheduler API | Proxy + CRUD + enqueue |
| static UIs | Operator flows |

---

### Task 1: Agent LabVIEW config + CLI helpers (pure + spawn)

**Files:**
- Modify: `crates/agent/src/config.rs`
- Create: `crates/agent/src/labview.rs`
- Modify: `crates/agent/src/main.rs` (`mod labview`)
- Test: `crates/agent/src/labview.rs`, `crates/agent/src/config.rs`

**Interfaces:**
- Consumes: env vars above
- Produces:
  - `AgentConfig.labview_cli: PathBuf`, `labview_getinfo: PathBuf`
  - `pub struct LabviewParam { name: String, class_name: String /* serde rename className */, value: serde_json::Value }`
  - `pub fn inputs_to_cli_object(inputs: &[LabviewParam]) -> serde_json::Map<String, Value>`
  - `pub fn build_inspect_args(getinfo: &Path, vi: &Path) -> Vec<String>`
  - `pub fn build_run_args(getinfo: &Path, vi: &Path, input_json: &str, show_fp: bool, timeout: Option<u64>) -> Vec<String>`
  - `pub enum LabviewError { MissingTool, MissingVi, Cli { exit_code: i32, stderr_json: Option<Value>, stderr_raw: String }, Io(String) }`
  - `pub fn map_status(err: &LabviewError) -> StatusCode` — MissingTool/MissingVi→404/400; exit 2→400; 3→404; 4|5→502; 6|7→502; else 500
  - `pub async fn run_cli(cli: &Path, args: &[String]) -> Result<(Value /*stdout json*/), LabviewError>` — sync spawn in `spawn_blocking` or tokio::process

- [ ] **Step 1: Extend config with defaults**

```rust
pub labview_cli: std::path::PathBuf,
pub labview_getinfo: std::path::PathBuf,
// load_from_env:
labview_cli: std::env::var("AGENT_LABVIEW_CLI")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(r"C:\labview-runner-cli\labview-runner-cli.exe")),
labview_getinfo: std::env::var("AGENT_LABVIEW_GETINFO_VI")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(r"C:\labview-runner-cli\getinfo.vi")),
```

Add config test: with env cleared of overrides, defaults match the two paths above (use `ENV_TEST_LOCK`).

- [ ] **Step 2: Write failing tests for arg builders + inputs map**

```rust
#[test]
fn build_inspect_args_order() {
    let args = build_inspect_args(
        Path::new(r"C:\labview-runner-cli\getinfo.vi"),
        Path::new(r"C:\x\Add.vi"),
    );
    assert_eq!(
        args,
        vec![
            "--action".into(), "inspect".into(),
            "--getinfo".into(), r"C:\labview-runner-cli\getinfo.vi".into(),
            "--vi".into(), r"C:\x\Add.vi".into(),
        ]
    );
}

#[test]
fn inputs_to_cli_object_uses_names() {
    let inputs = vec![LabviewParam {
        name: "a".into(),
        class_name: "Digital".into(),
        value: serde_json::json!(3.0),
    }];
    let m = inputs_to_cli_object(&inputs);
    assert_eq!(m.get("a"), Some(&serde_json::json!(3.0)));
}

#[test]
fn build_run_args_includes_input_and_optional_flags() {
    let args = build_run_args(
        Path::new(r"C:\g.vi"),
        Path::new(r"C:\t.vi"),
        r#"{"a":1}"#,
        true,
        Some(30),
    );
    assert!(args.windows(2).any(|w| w[0] == "--input" && w[1] == r#"{"a":1}"#));
    assert!(args.iter().any(|a| a == "--show-front-panel"));
    assert!(args.windows(2).any(|w| w[0] == "--timeout" && w[1] == "30"));
}
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `cargo test -p agent labview:: -- --nocapture`  
Expected: FAIL (module/functions missing).

- [ ] **Step 4: Implement `labview.rs` helpers + `run_cli`**

`run_cli`:
1. If `!cli.exists()` → `MissingTool`
2. `Command::new(cli).args(args).output()`
3. If success: parse stdout as JSON `Value` (trim)
4. If fail: try parse stderr as JSON; return `LabviewError::Cli { exit_code, stderr_json, stderr_raw }`

Also: before inspect/run, if `!vi_path.exists()` → `MissingVi` (caller or helper `ensure_vi`).

- [ ] **Step 5: Run tests — expect PASS**

Run: `cargo test -p agent labview::`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/config.rs crates/agent/src/labview.rs crates/agent/src/main.rs
git commit -m "feat(agent): LabVIEW CLI helpers and config defaults"
```

---

### Task 2: Agent HTTP API `/api/labview/*`

**Files:**
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/main.rs` (wire paths into `AppState`)
- Test: `crates/agent/src/api.rs` (axum oneshot + fake CLI)

**Interfaces:**
- Consumes: Task 1 helpers + `AppState { labview_cli, labview_getinfo, ... }`
- Produces: routes `GET /api/labview/config`, `POST /api/labview/inspect`, `POST /api/labview/run`

- [ ] **Step 1: Fake CLI script for tests**

On Windows tests, write a tiny `.cmd` or use `crates/agent/tests/fixtures/fake_labview_runner.ps1` that:
- if args contain `inspect`, print inspect JSON to stdout and exit 0
- if `run`, print run outputs JSON and exit 0

Or: unit-test handlers by injecting paths — simpler approach for this task: **integration-style test** that points `labview_cli` at a checked-in `tests/fixtures/fake-labview-runner.bat`:

```bat
@echo off
echo {"action":"inspect","inputs":[{"name":"a","className":"Digital","value":1.0}],"outputs":[]}
exit /b 0
```

For `run`, use a second bat or parse `%*` — keep one bat that always prints inspect shape for inspect tests; separate bat for run tests.

- [ ] **Step 2: Write failing API test**

```rust
#[tokio::test]
async fn labview_config_returns_paths() {
    // build app with known PathBufs
    let resp = app.oneshot(Request::get("/api/labview/config")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    // json cli_path / getinfo_path
}

#[tokio::test]
async fn labview_inspect_returns_cli_json() {
    // AppState.labview_cli = fixture bat; getinfo/vi = any existing temp files
    let body = serde_json::json!({ "vi_path": vi_path });
    // POST /api/labview/inspect → 200 + action inspect
}
```

Create empty temp files for `--getinfo` / `--vi` existence checks if `run_cli` validates them; fake bat ignores content.

- [ ] **Step 3: Implement handlers**

```rust
// GET config → { cli_path, getinfo_path } as strings
// POST inspect { vi_path } → run_cli(build_inspect_args(...)) → Json(value) or map_status
// POST run { vi_path, inputs: Vec<LabviewParam> | Value object, show_front_panel?, timeout_secs? }
//   → serialize inputs_to_cli_object → build_run_args → run_cli
```

Accept `inputs` as either array of params or a JSON object (if object, convert to Map for `--input` directly).

Error body: prefer `{ "error": { "kind", "message" } }` from stderr JSON when present; else `{ "error": "..." }` matching existing `ErrorBody` patterns in agent.

- [ ] **Step 4: Tests PASS**

Run: `cargo test -p agent -- labview_`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/api.rs crates/agent/src/main.rs crates/agent/tests/fixtures/
git commit -m "feat(agent): LabVIEW inspect/run/config HTTP API"
```

---

### Task 3: Migration + store for `vi_templates`

**Files:**
- Create: `crates/scheduler/migrations/003_vi_templates.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs`
- Test: store tests in `store.rs` or `api.rs` with TestApp

**Interfaces:**
- Produces:
  - `pub struct ViTemplate { id, name, agent_id, vi_path, cli_path, getinfo_path, inputs_json: String, show_front_panel: bool, timeout_secs: Option<i64>, created_at }`
  - `create_vi_template(...)`, `list_vi_templates()`, `get_vi_template(id)`, `delete_vi_template(id) -> bool`

- [ ] **Step 1: SQL migration**

```sql
CREATE TABLE IF NOT EXISTS vi_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  vi_path TEXT NOT NULL,
  cli_path TEXT NOT NULL,
  getinfo_path TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  show_front_panel INTEGER NOT NULL DEFAULT 0,
  timeout_secs INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
```

Wire in `db.rs` next to `002_screenshots.sql`.

- [ ] **Step 2: Failing store test**

Create agent row, `create_vi_template`, `list`/`get`/`delete`; assert fields round-trip; `show_front_panel` bool ↔ 0/1.

- [ ] **Step 3: Implement store methods**

Use `uuid` + `chrono` like other tables. `inputs_json` stored as text from `serde_json::to_string`.

- [ ] **Step 4: Tests PASS + commit**

```bash
git add crates/scheduler/migrations/003_vi_templates.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): add vi_templates table and store CRUD"
```

---

### Task 4: Command builder + dispatch + CRUD API

**Files:**
- Create: `crates/scheduler/src/labview_cmd.rs`
- Modify: `crates/scheduler/src/main.rs` (`mod labview_cmd`)
- Modify: `crates/scheduler/src/api.rs`
- Modify: `crates/scheduler/src/store.rs` (if create_task params needed — reuse existing)

**Interfaces:**
- Consumes: `ViTemplate`
- Produces:
  - `pub fn build_dispatch_command(t: &ViTemplate) -> Result<String, String>`
  - Routes: `GET/POST /api/vi-templates`, `GET/DELETE /api/vi-templates/{id}`, `POST /api/vi-templates/{id}/dispatch`

- [ ] **Step 1: Failing tests for `build_dispatch_command`**

```rust
#[test]
fn dispatch_command_quotes_paths_and_embeds_input() {
    let t = ViTemplate {
        cli_path: r"C:\labview-runner-cli\labview-runner-cli.exe".into(),
        getinfo_path: r"C:\labview-runner-cli\getinfo.vi".into(),
        vi_path: r"C:\x\Add.vi".into(),
        inputs_json: r#"[{"name":"a","className":"Digital","value":3.0}]"#.into(),
        show_front_panel: true,
        timeout_secs: Some(30),
        ..dummy()
    };
    let cmd = build_dispatch_command(&t).unwrap();
    assert!(cmd.contains(r#""C:\labview-runner-cli\labview-runner-cli.exe""#));
    assert!(cmd.contains("--action run"));
    assert!(cmd.contains("--show-front-panel"));
    assert!(cmd.contains("--timeout 30"));
    assert!(cmd.contains("--input "));
}
```

Escaping rule for cmd: wrap paths in double quotes; for `--input`, pass a compact JSON object string with internal `"` doubled for cmd (`"` → `""`) OR write JSON to a temp file — **prefer doubled quotes in-line** to avoid temp files:

```text
"...\labview-runner-cli.exe" --action run --getinfo "..." --vi "..." --input "{""a"":3.0}" --show-front-panel --timeout 30
```

Implement `fn cmd_escape_arg(s: &str) -> String` wrapping in `"` and doubling inner `"`.

- [ ] **Step 2: Implement builder — tests PASS**

- [ ] **Step 3: API handlers**

`POST /api/vi-templates`:
- Validate `agent_id` exists
- Require `vi_path`, `cli_path`, `getinfo_path`, `inputs` (array)
- `name` default: file stem of `vi_path`
- Persist; return JSON view

`POST .../dispatch`:
- Load template; `create_task` with `shell: cmd`, `command: build_dispatch_command`, `timeout_secs: template.timeout_secs.unwrap_or(300)`, `agent_id: template.agent_id`, `source: "vi_template"` (if source is free string) or `"template"` / `"ad_hoc"` — check existing source values; use `"ad_hoc"` or extend to `"vi_template"` if column is unconstrained TEXT (it is TEXT — use `"vi_template"`).

- [ ] **Step 4: Axum tests for create/list/delete/dispatch**

Assert dispatch creates task with expected command substring and correct `agent_id`.

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/src/labview_cmd.rs crates/scheduler/src/api.rs crates/scheduler/src/main.rs
git commit -m "feat(scheduler): vi_templates API and dispatch command builder"
```

---

### Task 5: Scheduler POST proxy for Agent LabVIEW

**Files:**
- Modify: `crates/scheduler/src/api.rs`

**Interfaces:**
- Produces: `POST /api/agents/{id}/labview/inspect`, `POST /api/agents/{id}/labview/run`
- Reuse agent lookup; **new** `proxy_agent_post(client, agent, path, body: Bytes/Value) -> Response`
- Unreachable → 503; unknown agent → 404; pass through status/body

- [ ] **Step 1: Failing tests with wiremock / local tiny axum agent**

Mirror existing file-proxy tests: spawn mock HTTP that accepts POST `/api/labview/inspect` and returns JSON; register agent pointing at mock; POST center proxy; assert body forwarded.

Also unreachable port → 503.

- [ ] **Step 2: Implement `proxy_agent_post` + routes**

```rust
.route("/api/agents/{id}/labview/inspect", post(proxy_labview_inspect))
.route("/api/agents/{id}/labview/run", post(proxy_labview_run))
```

Forward JSON body as-is.

- [ ] **Step 3: Tests PASS + commit**

```bash
git add crates/scheduler/src/api.rs
git commit -m "feat(scheduler): proxy LabVIEW inspect/run to agents"
```

---

### Task 6: Agent WebUI「VI」区块

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/style.css`

**Interfaces:**
- Consumes: Agent `/api/labview/*`, center `GET /api/agents` + `POST /api/vi-templates` via `AGENT` page knowing center URL — **Agent browser cannot call center if center is remote CORS** — Agent static is served from Agent origin.

**CORS issue:** Browser on `http://agent:26631` cannot POST to `http://center:26630` without CORS.

**Resolution (required):** Add Agent route `POST /api/labview/register-template` that:
1. Reads body (name, vi_path, inputs, flags)
2. Loads config snapshots
3. Resolves `agent_id` by calling center `GET /api/agents` and matching `name`+`ip`+`port` (from status/register info), or store id from last register response (extend register later if needed)
4. `POST {center}/api/vi-templates` server-side with reqwest

Implement this thin proxy in the same task as UI (or end of Task 2 if preferred — **do it here** if not done):

- Add `POST /api/labview/register-template` on Agent
- Test: mock center with wiremock returning agents list + 201 template

- [ ] **Step 1: Agent register-template API + test**

- [ ] **Step 2: HTML section**

After status/tasks, add section `#labview-section`:
- Read-only `#lv-cli`, `#lv-getinfo`
- Input `#lv-vi-path`
- Buttons: 查询参数 / 试跑 / 注册到中心
- Checkbox 前面板; number 超时
- Table `#lv-inputs-body`; pre `#lv-json-raw` optional
- Pre `#lv-run-out` for trial output
- Msg element

- [ ] **Step 3: JS**

```javascript
async function loadLabviewConfig() { /* GET /api/labview/config */ }
async function inspectVi() { /* POST inspect; fill table from inputs */ }
function collectInputsFromTable() { /* editable values */ }
async function runVi() { /* POST run */ }
async function registerViTemplate() { /* POST /api/labview/register-template */ }
```

On inspect success, render rows: name, className (readonly text), value (`input` or textarea for JSON scalars).

- [ ] **Step 4: Manual smoke** (if LabVIEW available) or fixture CLI path via env

- [ ] **Step 5: Commit**

```bash
git add crates/agent/static crates/agent/src/api.rs
git commit -m "feat(agent): LabVIEW VI WebUI and register-template proxy"
```

---

### Task 7: Scheduler WebUI「VI」分区

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css`

**Interfaces:**
- Add third top tab **「VI」** next to 机台/作业 (`showView('vi')`) OR nest under 作业 — **use top tab「VI」** for clarity.

- [ ] **Step 1: Shell**

`#view-vi` containing:
- Agent `<select>` (online agents)
- VI path, options, inspect/run/register (call `/api/agents/{id}/labview/*` and `POST /api/vi-templates` with `cli_path`/`getinfo_path` from a prior `GET` — center needs Agent config: either embed in inspect response or add `GET /api/agents/{id}/labview/config` proxy)

**Add** `GET /api/agents/{id}/labview/config` proxy in this task (one route) forwarding to Agent `GET /api/labview/config`.

- [ ] **Step 2: Templates table**

`GET /api/vi-templates` → rows with 试跑 / 下发 / 删除  
试跑: `POST /api/agents/{agent_id}/labview/run` with template fields  
下发: `POST /api/vi-templates/{id}/dispatch` then toast + optional switch to 作业

- [ ] **Step 3: Wire `showView` for `vi`**

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static crates/scheduler/src/api.rs
git commit -m "feat(scheduler): VI templates WebUI and config proxy"
```

---

### Task 8: README + acceptance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document env vars and VI workflow** (Chinese), link to labview-runner-cli prerequisite

- [ ] **Step 2: Run automated tests**

```bash
cargo test -p agent
cargo test -p scheduler
```

Expected: all PASS (LabVIEW hardware tests none, or `#[ignore]`).

- [ ] **Step 3: Acceptance checklist** (manual when LabVIEW present)

1. Agent: inspect Add.vi → edit → trial run → register  
2. Center: list shows template bound to agent  
3. Center: proxy inspect another path; dispatch task succeeds  
4. Override `AGENT_LABVIEW_*` → config reflects paths  

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document LabVIEW VI templates feature"
```

---

## Self-Review (plan vs spec)

| Spec | Task |
|------|------|
| Agent config defaults + env | Task 1 |
| inspect/run/config API | Task 2 |
| `vi_templates` + cli_path snapshot | Task 3–4 |
| dispatch → tasks cmd | Task 4 |
| Center proxy inspect/run | Task 5 |
| Center config proxy | Task 7 |
| Agent UI + register without CORS | Task 6 |
| Center UI tab | Task 7 |
| README | Task 8 |
| No center-local LabVIEW | Global Constraints |

No intentional TBD placeholders. `register-template` on Agent resolves CORS for center writes.
