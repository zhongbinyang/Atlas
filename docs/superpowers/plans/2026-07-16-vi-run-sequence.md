# Agent VI Run Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Agent「序列」page with dual lists (registered → selected), persist each Agent’s ordered queue on the scheduler, and run the queue server-side in order stopping on first failure.

**Architecture:** New SQLite table `vi_run_queue_items` on the center; GET/PUT replace-all API per agent. Agent proxies queue I/O and implements `POST /api/labview/run-sequence` that acquires the same `TaskSlot` busy flag as shell tasks, then calls existing LabVIEW run helpers per step. Agent WebUI gets a second view with drag-and-drop + up/down reorder and auto-save.

**Tech Stack:** Existing Axum / SQLx / Tokio / static WebUI; HTML5 drag-and-drop; no new crates.

**Spec:** `docs/superpowers/specs/2026-07-16-vi-run-sequence-design.md`

## Global Constraints

- Stop on first LabVIEW step failure; later steps do not run
- Queue persisted on scheduler; one queue per `agent_id`
- Only templates belonging to that agent may be queued
- Same `vi_template_id` may appear multiple times (each row has its own queue `id`)
- PUT is whole-list replace; order = array index
- Delete VI template cascades queue rows (explicit store delete — do not rely on SQLite FK alone; project does not enable `PRAGMA foreign_keys`)
- `run-sequence` uses TaskSlot busy mutual exclusion with shell tasks (409 if busy)
- Empty queue → 400; success or mid-stop → HTTP 200 with `stopped` / `steps`
- No center WebUI for queues; no `tasks` enqueue; no per-step input editing
- Chinese WebUI; reuse industrial tokens
- Auto PUT after add/remove/reorder on Agent sequence page

---

## File Structure

```text
crates/scheduler/migrations/005_vi_run_queue.sql     # NEW
crates/scheduler/src/db.rs                           # include 005
crates/scheduler/src/store.rs                        # queue CRUD + cascade
crates/scheduler/src/api.rs                          # GET/PUT routes + views
crates/agent/src/task_slot.rs                        # try_acquire / release
crates/agent/src/register.rs                         # center queue GET/PUT helpers
crates/agent/src/labview_sequence.rs                 # NEW — run-sequence orchestration
crates/agent/src/api.rs                              # routes: run-queue, run-sequence
crates/agent/src/main.rs                             # mod labview_sequence
crates/agent/static/index.html                       # nav + sequence page markup
crates/agent/static/app.js                           # dual list + DnD + execute
crates/agent/static/style.css                        # sequence layout
README.md
```

| Path | Responsibility |
|------|----------------|
| `005_*.sql` | Schema |
| `store.rs` | Persist / replace / list / cascade |
| scheduler `api.rs` | HTTP for queue |
| `task_slot.rs` | Shared busy acquire/release |
| `labview_sequence.rs` | Ordered run + stop-on-fail |
| Agent static | Sequence page UX |

---

### Task 1: Migration + store (queue CRUD + cascade)

**Files:**
- Create: `crates/scheduler/migrations/005_vi_run_queue.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs`
- Test: `crates/scheduler/src/store.rs` (`store::tests`)

**Interfaces:**
- Consumes: existing `Store`, `ViTemplate`, agent helpers
- Produces:

```rust
pub struct ViRunQueueItem {
    pub id: String,
    pub agent_id: String,
    pub vi_template_id: String,
    pub position: i64,
    pub created_at: String,
    // joined for list:
    pub template_name: String,
    pub vi_path: String,
}

pub async fn list_vi_run_queue(&self, agent_id: &str) -> Result<Vec<ViRunQueueItem>, sqlx::Error>;

/// Replace entire queue for agent. Validates each template belongs to agent_id.
/// Returns Ok(items) or Err(QueueReplaceError::BadTemplate | Db(...)).
pub async fn replace_vi_run_queue(
    &self,
    agent_id: &str,
    template_ids: &[String],
) -> Result<Vec<ViRunQueueItem>, QueueReplaceError>;

pub enum QueueReplaceError {
    AgentNotFound,
    BadTemplate { vi_template_id: String },
    Db(sqlx::Error),
}
```

- Update `delete_vi_template` to first `DELETE FROM vi_run_queue_items WHERE vi_template_id = ?` then delete template.

- [ ] **Step 1: Write failing store tests**

```rust
#[tokio::test]
async fn vi_run_queue_replace_and_list_order() {
    // create agent + two templates; replace with [b, a, b]; list positions 0,1,2 and ids match
}

#[tokio::test]
async fn vi_run_queue_rejects_foreign_template() {
    // template on agent B; replace on agent A → BadTemplate
}

#[tokio::test]
async fn delete_vi_template_cascades_queue_rows() {
    // queue refs template; delete template; list queue empty; template gone
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p scheduler store::tests::vi_run_queue_ -- --nocapture`  
Expected: compile/link errors or missing methods.

- [ ] **Step 3: Migration + db wire**

`005_vi_run_queue.sql`:

```sql
CREATE TABLE IF NOT EXISTS vi_run_queue_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  vi_template_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(vi_template_id) REFERENCES vi_templates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_run_queue_agent_pos
  ON vi_run_queue_items(agent_id, position);
```

In `db.rs`, after 004:

```rust
sqlx::raw_sql(include_str!("../migrations/005_vi_run_queue.sql"))
    .execute(&pool)
    .await?;
```

(Use `IF NOT EXISTS` so reconnect is safe without `apply_migration`.)

- [ ] **Step 4: Implement store**

`replace_vi_run_queue` algorithm (transaction):

1. `get_agent(agent_id)` — none → `AgentNotFound`.
2. For each `template_id`, `get_vi_template`; must exist and `t.agent_id == agent_id` else `BadTemplate`.
3. `DELETE FROM vi_run_queue_items WHERE agent_id = ?`.
4. Insert rows with new UUIDs, `position = 0..n-1`, `created_at = now`.
5. Return `list_vi_run_queue(agent_id)` (JOIN templates for name/path).

`list_vi_run_queue`:

```sql
SELECT q.id, q.agent_id, q.vi_template_id, q.position, q.created_at,
       t.name AS template_name, t.vi_path
FROM vi_run_queue_items q
JOIN vi_templates t ON t.id = q.vi_template_id
WHERE q.agent_id = ?
ORDER BY q.position ASC
```

- [ ] **Step 5: Tests PASS + commit**

Run: `cargo test -p scheduler store::tests::vi_run_queue_ store::tests::vi_template_crud -- --nocapture`  
Expected: PASS (cascade covered).

```bash
git add crates/scheduler/migrations/005_vi_run_queue.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): vi_run_queue_items table and store"
```

---

### Task 2: Scheduler HTTP GET/PUT queue

**Files:**
- Modify: `crates/scheduler/src/api.rs`
- Test: `crates/scheduler/src/api.rs` (`api::tests`)

**Interfaces:**
- Consumes: `Store::list_vi_run_queue`, `replace_vi_run_queue`
- Produces:

```rust
#[derive(Serialize)]
pub struct ViRunQueueItemView {
    pub id: String,
    pub vi_template_id: String,
    pub position: i64,
    pub name: String,
    pub vi_path: String,
}

#[derive(Deserialize)]
pub struct ReplaceViRunQueueRequest {
    pub items: Vec<ReplaceViRunQueueItem>,
}
#[derive(Deserialize)]
pub struct ReplaceViRunQueueItem {
    pub vi_template_id: String,
}

// GET/PUT /api/agents/{id}/vi-run-queue
// GET → 200 { "items": [ ViRunQueueItemView, ... ] }  OR bare array — pick object wrapper:
// Spec list shape: use { "items": [...] } for both GET and PUT response for symmetry.
```

Map errors: `AgentNotFound` → 404; `BadTemplate` → 400 with message; Db → 500.

- [ ] **Step 1: Failing API tests**

```rust
#[tokio::test]
async fn vi_run_queue_put_get_round_trip() { /* register agent, create templates, PUT, GET order */ }

#[tokio::test]
async fn vi_run_queue_put_rejects_other_agents_template() { /* 400 */ }

#[tokio::test]
async fn vi_run_queue_unknown_agent_404() { /* GET/PUT */ }
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p scheduler api::tests::vi_run_queue_ -- --nocapture`  
Expected: FAIL (route missing).

- [ ] **Step 3: Implement routes + handlers**

Wire next to other `/api/agents/{id}/...` routes:

```rust
.route(
    "/api/agents/{id}/vi-run-queue",
    get(get_vi_run_queue).put(put_vi_run_queue),
)
```

- [ ] **Step 4: PASS + commit**

```bash
git add crates/scheduler/src/api.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): VI run-queue GET/PUT API"
```

---

### Task 3: TaskSlot acquire + Agent queue proxy + run-sequence

**Files:**
- Modify: `crates/agent/src/task_slot.rs`
- Modify: `crates/agent/src/register.rs`
- Create: `crates/agent/src/labview_sequence.rs`
- Modify: `crates/agent/src/api.rs`, `crates/agent/src/main.rs`
- Test: `task_slot.rs`, `api.rs`, `labview_sequence.rs` as appropriate

**Interfaces:**
- Consumes: center queue API; `labview::{build_run_args, run_cli, ...}`; `resolve_agent_id`; template fields via center queue JOIN (name/path) — **for run**, Agent must load full template inputs. Options:
  - **A (recommended):** center GET queue already returns enough? Spec only returns name/path — **insufficient for run**. Extend center GET item with `inputs`, `show_front_panel`, `timeout_secs` (from JOIN) so Agent need not re-fetch each template. **Do this in Task 2 if not already — if Task 2 shipped name/path only, extend view in this task.**
  - Or Agent GETs `/api/vi-templates/{id}` per step — no such single-get used from agent today; prefer enriching queue GET.

**Extend `ViRunQueueItem` / view (if needed in this task or amend Task 2):** include `inputs: Value`, `show_front_panel: bool`, `timeout_secs: Option<i64>` from template row.

```rust
// task_slot.rs
pub async fn try_acquire(&self) -> Result<(), &'static str>; // Err("busy")
pub async fn release(&self);
```

```rust
// register.rs
pub async fn get_vi_run_queue(...) -> Result<(StatusCode, Value), String>;
pub async fn put_vi_run_queue(..., body: &Value) -> Result<(StatusCode, Value), String>;
```

```rust
// labview_sequence.rs
pub struct SequenceStepResult { /* match spec JSON fields */ }
pub struct SequenceResponse { pub stopped: bool, pub failed_at: Option<usize>, pub steps: Vec<SequenceStepResult> }

pub async fn run_sequence(
    cli: &Path,
    getinfo: &Path,
    items: &[QueueItemForRun], // template fields needed for run
) -> SequenceResponse;
```

`run_sequence` loops: build args → `run_cli` → on Ok push ok step; on Err push fail, set `stopped=true`, `failed_at=i`, break.

Agent handlers:

- `GET/PUT /api/labview/run-queue` — resolve id → center (same error mapping as registered-templates).
- `POST /api/labview/run-sequence`:
  1. `try_acquire` → 409 if busy
  2. GET center queue (or use in-memory after GET)
  3. if items empty → `release` + 400
  4. `run_sequence(...)`
  5. `release`
  6. 200 JSON

Use `scopeguard`? Prefer explicit `release` in all paths (including early return) — or RAII drop guard in a small struct.

- [ ] **Step 1: Failing tests**

```rust
#[tokio::test]
async fn try_acquire_rejects_second() { /* acquire twice → busy */ }

#[tokio::test]
async fn labview_run_sequence_stops_on_second_failure() {
    // Prefer unit-test run_sequence with a test double OR mock CLI;
    // If CLI hard to mock: unit-test pure loop by injecting a Fn step runner.
}
```

Recommended: `labview_sequence.rs` takes a callback/`async fn` trait for one step so tests inject fail-on-N without real LabVIEW:

```rust
pub async fn run_sequence_with<F, Fut>(items: &[Item], mut run_one: F) -> SequenceResponse
where F: FnMut(&Item) -> Fut, Fut: Future<Output = Result<Value, String>>;
```

Production handler wraps `run_cli`.

Also HTTP test: mock center returns 2-item queue; mock/stub sequence — or test acquire 409 when slot busy via `submit` then `run-sequence`.

- [ ] **Step 2: FAIL then implement then PASS**

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/task_slot.rs crates/agent/src/register.rs crates/agent/src/labview_sequence.rs crates/agent/src/api.rs crates/agent/src/main.rs crates/scheduler/src/api.rs crates/scheduler/src/store.rs
git commit -m "feat(agent): run-queue proxy and stop-on-fail run-sequence"
```

---

### Task 4: Agent WebUI —「序列」page

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/style.css`

**Interfaces:**
- Consumes: `GET /api/labview/registered-templates`, `GET/PUT /api/labview/run-queue`, `POST /api/labview/run-sequence`

- [ ] **Step 1: Markup**

In `index.html` header, add tabs:

```html
<nav class="page-tabs">
  <button type="button" class="tab active" data-page="workbench">VI</button>
  <button type="button" class="tab" data-page="sequence">序列</button>
</nav>
```

Wrap existing LabVIEW + registered sections in `#page-workbench`. Add `#page-sequence` (hidden by default):

- Left table `#seq-registered-body` + add buttons
- Right list `#seq-selected-body` (draggable rows) + up/down/remove
- Button `#seq-run-btn`「按序执行」
- `#seq-msg`, `#seq-results`

- [ ] **Step 2: JS behavior**

- `showPage('workbench'|'sequence')`
- Load registered + queue on sequence show / refresh
- Add → append to local selected array → `saveQueue()` PUT `{ items: [{ vi_template_id }] }`
- Remove / moveUp / moveDown / drop reorder → `saveQueue()`; on PUT failure show msg and `loadQueue()` to resync
- Run: disable controls; POST run-sequence; render step statuses from response; re-enable

Drag-and-drop: HTML5 `draggable="true"` on selected rows; on drop reorder array and save. Always keep up/down buttons.

- [ ] **Step 3: Minimal CSS** for two-column sequence layout (reuse existing table/btn classes).

- [ ] **Step 4: Manual smoke + commit**

```bash
git add crates/agent/static/index.html crates/agent/static/app.js crates/agent/static/style.css
git commit -m "feat(agent-ui): VI sequence page with dual lists"
```

---

### Task 5: README + acceptance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document**

Short bullets under LabVIEW section:

1. Agent「序列」页：左已注册 → 右选定（可重复、拖拽/上下移）  
2. 队列存中心，每机一份；自动保存  
3. 「按序执行」服务端串行试跑，遇错停止；与 shell 任务互斥 busy  

- [ ] **Step 2: Automated check**

Run: `cargo test -p scheduler -p agent`  
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note Agent VI run-sequence page"
```

---

## Spec coverage (self-review)

| Spec item | Task |
|-----------|------|
| Table + cascade delete | Task 1 |
| Center GET/PUT | Task 2 (+ enrich inputs in Task 2 or 3) |
| Agent proxy + run-sequence + busy | Task 3 |
| Dual-list UI + DnD + auto PUT | Task 4 |
| README | Task 5 |
| Stop on fail / 200 with steps | Task 3 |
| No center UI / no tasks queue | Global |

## Consistency notes

- Queue GET must expose enough fields for run (`inputs`, `show_front_panel`, `timeout_secs`) — implement in Task 2 views or extend at start of Task 3 before sequence.
- Busy: add `try_acquire`/`release`; do not change single-shot `labview_run` busy behavior in this plan (pre-existing; only sequence + shell share the slot per spec).
- Cascade via explicit DELETE in `delete_vi_template`, not FK PRAGMA.
