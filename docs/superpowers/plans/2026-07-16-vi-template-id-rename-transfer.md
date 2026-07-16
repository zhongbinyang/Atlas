# VI Template ID Rename & Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple registrations of the same VI path (distinct ids/names/inputs), rename templates by id on Agent and center, and change distribute to transfer the same id to one target agent (move, not copy).

**Architecture:** Drop `(agent_id, vi_path)` unique index. Register always INSERTs with required `name`. Add `PATCH /api/vi-templates/{id}` and Agent proxy. Replace path-based `upsert_vi_template_distribute` with `transfer_vi_template` that UPDATEs `agent_id` (keeps id/origin), refreshes target CLI paths, and deletes queue rows referencing that template id. Center distribute UI becomes single-target.

**Tech Stack:** Existing Axum / SQLx / static WebUI; no new crates.

**Spec:** `docs/superpowers/specs/2026-07-16-vi-template-id-rename-transfer-design.md`

## Global Constraints

- Uniqueness is template `id` only (global PK); same path may exist many times per agent
- Register always INSERT; `name` required (non-empty after trim)
- PATCH by id for `name` and optionally `inputs` / `show_front_panel` / `timeout_secs`; do not change `id`, `agent_id`, `origin_agent_id`, `vi_path` via PATCH
- Distribute = transfer same id to exactly one `target_agent_id`; source agent loses the row; not a multi-copy
- On transfer: clear `vi_run_queue_items` where `vi_template_id = id`; do not auto-enqueue on target
- `origin_agent_id` unchanged on transfer
- Target cli/getinfo from target labview config; optional `vi_path` override on transfer
- Chinese WebUI on Agent + center; warn that distribute moves ownership

---

## File Structure

```text
crates/scheduler/migrations/006_vi_drop_path_unique.sql   # NEW — DROP INDEX
crates/scheduler/src/db.rs
crates/scheduler/src/store.rs                             # insert-only create, patch, transfer
crates/scheduler/src/vi_distribute.rs                     # rewrite to single-target transfer
crates/scheduler/src/api.rs                               # PATCH route; create name required; distribute body
crates/scheduler/static/{index.html,app.js}               # rename + single-select distribute
crates/agent/src/register.rs                              # patch helper
crates/agent/src/api.rs                                   # PATCH proxy; register requires name
crates/agent/static/{index.html,app.js}                   # name field + rename
README.md
```

---

### Task 1: Migration + store (drop path unique, insert, patch, transfer)

**Files:**
- Create: `crates/scheduler/migrations/006_vi_drop_path_unique.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs`
- Test: `crates/scheduler/src/store.rs`

**Interfaces:**
- Consumes: existing `ViTemplate`, queue delete helpers
- Produces:

```rust
/// Always INSERT. No path-based upsert.
pub async fn insert_vi_template(
    &self,
    name: &str,
    agent_id: &str,
    origin_agent_id: &str,
    vi_path: &str,
    cli_path: &str,
    getinfo_path: &str,
    inputs: &serde_json::Value,
    show_front_panel: bool,
    timeout_secs: Option<i64>,
) -> Result<ViTemplate, sqlx::Error>;

pub struct ViTemplatePatch {
    pub name: Option<String>,
    pub inputs: Option<serde_json::Value>,
    pub show_front_panel: Option<bool>,
    pub timeout_secs: Option<Option<i64>>, // None=omit, Some(None)=clear, Some(Some(n))=set
}

pub async fn patch_vi_template(
    &self,
    id: &str,
    patch: ViTemplatePatch,
) -> Result<Option<ViTemplate>, sqlx::Error>;

pub enum TransferError {
    NotFound,
    AgentNotFound,
    SameAgent,
    Db(sqlx::Error),
}

/// Move template row to target_agent_id; keep id & origin_agent_id.
/// Updates cli/getinfo/optional vi_path; deletes queue rows for this template id.
pub async fn transfer_vi_template(
    &self,
    id: &str,
    target_agent_id: &str,
    cli_path: &str,
    getinfo_path: &str,
    vi_path: Option<&str>, // None = keep existing
) -> Result<ViTemplate, TransferError>;
```

- Remove or stop using `upsert_vi_template` / `upsert_vi_template_distribute` path-conflict logic. Keep thin wrappers calling `insert_vi_template` if needed for compile during migration of callers.
- `create_vi_template` → call `insert_vi_template` with `origin_agent_id = agent_id`.

Migration SQL:

```sql
DROP INDEX IF EXISTS idx_vi_templates_agent_vi_path;
```

Wire in `db.rs` after 005 (raw_sql IF NOT EXISTS style — DROP INDEX IF EXISTS is idempotent).

- [ ] **Step 1: Failing tests**

```rust
#[tokio::test]
async fn insert_allows_same_path_twice() {
    // two inserts same agent+path different names → two ids
}

#[tokio::test]
async fn patch_renames_template() { /* patch name; get reflects */ }

#[tokio::test]
async fn transfer_moves_id_and_clears_queue() {
    // template on A; queue item on A; transfer to B;
    // id same; agent_id B; A's queue empty for that id; A's list no longer has it
}

#[tokio::test]
async fn transfer_to_self_errors() { /* SameAgent */ }
```

Rewrite/remove obsolete tests: `vi_template_upsert_same_path_keeps_origin`, `vi_template_distribute_upsert_sets_origin_on_conflict`, unique-path tests.

- [ ] **Step 2: Run FAIL → implement → PASS**

- [ ] **Step 3: Commit**

```bash
git add crates/scheduler/migrations/006_vi_drop_path_unique.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): insert/patch/transfer vi_templates by id"
```

---

### Task 2: Scheduler API — required name, PATCH, single-target distribute

**Files:**
- Modify: `crates/scheduler/src/vi_distribute.rs`
- Modify: `crates/scheduler/src/api.rs`
- Test: `api::tests`, `vi_distribute` tests

**Interfaces:**

```rust
// CreateViTemplateRequest.name: String (required) — or Option but validate required

#[derive(Deserialize)]
pub struct PatchViTemplateRequest {
    pub name: Option<String>,
    pub inputs: Option<serde_json::Value>,
    pub show_front_panel: Option<bool>,
    pub timeout_secs: Option<Option<i64>>,
}

#[derive(Deserialize)]
pub struct DistributeViTemplateRequest {
    pub target_agent_id: String,
    pub vi_path: Option<String>,
}
// Remove target_agent_ids: Vec
```

- `POST create`: validate name non-empty; call `insert_vi_template`; always 201.
- `PATCH /api/vi-templates/{id}`: validate at least one field; name if present non-empty; 404 if missing.
- `distribute_template` → rewrite to single target:

```rust
pub async fn transfer_template(
    store: &Store,
    labview_client: &reqwest::Client,
    source: &ViTemplate,
    target_agent_id: &str,
    vi_path_override: Option<&str>,
) -> Result<ViTemplate, TransferApiError>;
```

HTTP distribute: 200 with body `{ "id", "agent_id", ... }` template view **or** keep `{ "results": [ one item ] }` for less UI churn — **prefer single object** `ViTemplateView` with 200; UI will adapt in Task 4.

Errors: source 404; target 404; same agent 400; config fail 502.

- [ ] **Step 1: API tests**

```rust
#[tokio::test]
async fn create_same_path_twice_two_ids() { ... }

#[tokio::test]
async fn create_requires_name() { /* 400 */ }

#[tokio::test]
async fn patch_vi_template_renames() { ... }

#[tokio::test]
async fn distribute_transfers_same_id_to_target() {
    // after transfer, GET list?agent_id=A empty of that id; B has same id
}

#[tokio::test]
async fn distribute_to_self_400() { ... }
```

Delete/replace tests that expect path upsert / multi-target `results[]` created|updated.

- [ ] **Step 2: Implement + PASS + commit**

```bash
git add crates/scheduler/src/api.rs crates/scheduler/src/vi_distribute.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): PATCH vi template and transfer distribute"
```

---

### Task 3: Agent register name + PATCH proxy

**Files:**
- Modify: `crates/agent/src/register.rs`
- Modify: `crates/agent/src/api.rs`
- Test: agent api tests

**Interfaces:**

```rust
// LabviewRegisterTemplateRequest.name: String (required)
pub async fn patch_vi_template(client, center_url, id, body: &Value) -> Result<(StatusCode, Value), String>;
// Route: PATCH /api/labview/templates/{id}
```

- Register handler: if name missing/empty → 400 before center call.
- PATCH: resolve agent id; optionally GET template from center list/filter and ensure `agent_id` matches self (if center has no get-by-id ownership check, forward PATCH and let center succeed; **recommended:** center PATCH allows any id; Agent UI only shows own templates — still OK). Spec: 推荐仅本机可改 — implement Agent-side check by fetching `GET .../vi-templates?agent_id=self` and ensuring id is in list before PATCH, or add center query. Simplest: forward PATCH unconditionally (center has no agent auth). Document YAGNI on auth.

- [ ] **Step 1: Tests** — register without name → 400; patch proxies to center (wiremock).

- [ ] **Step 2: Implement + commit**

```bash
git add crates/agent/src/api.rs crates/agent/src/register.rs
git commit -m "feat(agent): require register name and PATCH template proxy"
```

---

### Task 4: Agent + center WebUI

**Files:**
- Modify: `crates/agent/static/index.html`, `app.js`
- Modify: `crates/scheduler/static/index.html`, `app.js`

**Agent UI:**
- Add `#lv-name` input near VI path; default stem from path on inspect/blur; required on register.
- Registered list:「重命名」→ `prompt` or small inline → `PATCH /api/labview/templates/{id}` with `{ name }`; refresh lists (registered + sequence).

**Center UI:**
- Register form: name required (if center can register).
- Template row:「重命名」→ PATCH `/api/vi-templates/{id}`.
- Distribute modal: replace checkboxes with **radio** (or single `<select>`); body `{ target_agent_id, vi_path }`; show message「分发后源机将不再持有该模板」; handle single template response (not `results[]` array) — update `submitDistribute` accordingly.

- [ ] **Step 1: Implement UI**
- [ ] **Step 2: Manual smoke notes in report**
- [ ] **Step 3: Commit**

```bash
git add crates/agent/static crates/scheduler/static
git commit -m "feat(ui): VI template rename and single-target transfer distribute"
```

---

### Task 5: README + test sweep

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Document: same path multiple registrations; rename; distribute = move by id to one agent.
- [ ] **Step 2:** `cargo test -p scheduler -p agent` all PASS.
- [ ] **Step 3:** Commit `docs: note VI template rename and id transfer`

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Drop path unique index | Task 1 |
| Insert-only register + required name | Task 1–2 |
| PATCH rename/inputs | Task 2–4 |
| Transfer distribute same id | Task 1–2, 4 |
| Clear queue on transfer | Task 1 |
| Single target UI | Task 4 |
| Agent name + rename | Task 3–4 |
| README | Task 5 |

## Consistency notes

- Distribute response shape: plan chooses **single `ViTemplateView`** (200); update center JS in Task 4 — do not leave old `results[]` multi-status UI.
- Remove dead `upsert_vi_template_distribute` after transfer lands to avoid accidental path upserts.
- Existing distribute tests that create a row on B then distribute same path from A expecting update of B's **different id** are invalid under new semantics — replace with transfer tests.
