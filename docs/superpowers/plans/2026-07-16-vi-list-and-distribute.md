# VI List and Cross-Agent Distribute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent shows its registered VI templates and can trial-run one; center shows origin vs bound agent clearly and can distribute (copy/upsert) a template to other agents without using the task queue.

**Architecture:** Extend `vi_templates` with `origin_agent_id` and `UNIQUE(agent_id, vi_path)`. Center gains filtered list + `POST .../distribute` (upsert per target; CLI paths from target labview config). Agent adds a thin proxy to list its templates from the center and WebUI to pick/run. No VI→tasks dispatch.

**Tech Stack:** Existing Axum / SQLx / Tokio / static WebUI; no new crates.

**Spec:** `docs/superpowers/specs/2026-07-16-vi-list-and-distribute-design.md`

## Global Constraints

- Distribute = copy/upsert templates only; never enqueue `tasks` for VI
- `origin_agent_id` set on first create; never changed on distribute or same-path overwrite
- Same `(agent_id, vi_path)` → overwrite business fields; keep `origin_agent_id`
- Default `vi_path` copied; optional single override for all targets in one distribute call
- On distribute create/update: `cli_path`/`getinfo_path` from **target** Agent `GET /api/labview/config`
- Agent list = only templates where `agent_id` = self (`resolve_agent_id`)
- Paths normalized with `normalize_fs_path` before write/lookup
- Chinese WebUI; reuse existing industrial tokens / modal patterns
- Do not sync `.vi` files between machines

---

## File Structure

```text
crates/scheduler/migrations/004_vi_origin_and_unique.sql   # NEW
crates/scheduler/src/db.rs                                 # include 004
crates/scheduler/src/store.rs                              # origin, upsert, filter, names
crates/scheduler/src/vi_distribute.rs                      # NEW — distribute loop helpers
crates/scheduler/src/api.rs                                # views, query, upsert create, distribute route
crates/scheduler/src/main.rs                               # mod vi_distribute
crates/scheduler/static/index.html                         # columns + distribute modal
crates/scheduler/static/app.js                             # render + distribute UI
crates/agent/src/register.rs                               # list_vi_templates_for_agent
crates/agent/src/api.rs                                    # GET /api/labview/registered-templates
crates/agent/static/index.html                             # registered list section
crates/agent/static/app.js                                 # fetch list + trial/load
README.md                                                  # short note if needed
```

| Path | Responsibility |
|------|----------------|
| `004_*.sql` | `origin_agent_id` + unique index + backfill |
| `store.rs` | Persistence: upsert, list filter, join names |
| `vi_distribute.rs` | Per-target upsert + config fetch orchestration helpers |
| scheduler API | HTTP contracts from spec §5.1 |
| Agent register + API | Center list proxy for self |
| static UIs | Operator-facing list / distribute / trial |

---

### Task 1: Migration + store (origin, unique, upsert, filter)

**Files:**
- Create: `crates/scheduler/migrations/004_vi_origin_and_unique.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs` (`ViTemplate`, `ViTemplateRow`, CRUD)
- Test: `crates/scheduler/src/store.rs` (existing `store::tests` module)

**Interfaces:**
- Consumes: existing `Store`, `ViTemplate` shape without origin
- Produces:
  - `ViTemplate.origin_agent_id: String`
  - `pub async fn upsert_vi_template(&self, name: &str, agent_id: &str, origin_agent_id: &str, vi_path: &str, cli_path: &str, getinfo_path: &str, inputs: &Value, show_front_panel: bool, timeout_secs: Option<i64>) -> Result<(ViTemplate, bool /*created*/), sqlx::Error>`
    - On conflict `(agent_id, vi_path)`: UPDATE `name`, `cli_path`, `getinfo_path`, `inputs_json`, `show_front_panel`, `timeout_secs` only; **do not** change `origin_agent_id` or `id` or `created_at`; return `(row, false)`
    - On insert: set `origin_agent_id` from arg; return `(row, true)`
  - Replace `create_vi_template` callers to use `upsert_vi_template` **or** keep `create_vi_template` as a thin wrapper that calls upsert with `origin_agent_id = agent_id` for inserts-only semantics via upsert
  - `pub async fn list_vi_templates(&self, agent_id: Option<&str>) -> Result<Vec<ViTemplate>, sqlx::Error>`
  - `pub async fn list_vi_templates_enriched(&self, agent_id: Option<&str>) -> Result<Vec<ViTemplateEnriched>, sqlx::Error>` where:

```rust
pub struct ViTemplateEnriched {
    pub template: ViTemplate,
    pub agent_name: Option<String>,
    pub origin_agent_name: Option<String>,
}
```

  Prefer a SQL `LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN agents o ON o.id = t.origin_agent_id`.

- [ ] **Step 1: Write failing store tests**

Add to `store::tests` (reuse existing temp DB / `Store::new` helpers already in file):

```rust
#[tokio::test]
async fn vi_template_origin_defaults_to_agent_on_create() {
    // upsert with origin_agent_id = agent_id
    // assert got.origin_agent_id == agent_id
}

#[tokio::test]
async fn vi_template_upsert_same_path_keeps_origin() {
    // create on agent A with origin A
    // upsert same vi_path on agent A with a *different* origin_agent_id argument (B)
    // assert origin still A; name/inputs updated; created==false
}

#[tokio::test]
async fn vi_template_list_filters_by_agent() {
    // two agents, one template each; list Some(a) returns only a's
}

#[tokio::test]
async fn vi_template_unique_agent_path() {
    // two upserts same agent+path → single row in list
}
```

- [ ] **Step 2: Run tests — expect FAIL** (missing column / methods)

Run: `cargo test -p scheduler store::tests::vi_template_ -- --nocapture`  
Expected: compile errors or failures about `origin_agent_id` / `upsert_vi_template`.

- [ ] **Step 3: Add migration + wire db**

`004_vi_origin_and_unique.sql`:

```sql
ALTER TABLE vi_templates ADD COLUMN origin_agent_id TEXT;
UPDATE vi_templates SET origin_agent_id = agent_id WHERE origin_agent_id IS NULL OR origin_agent_id = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_templates_agent_vi_path ON vi_templates(agent_id, vi_path);
```

In `db.rs`, append `include_str!("../migrations/004_vi_origin_and_unique.sql")` to the migration list.

Note: SQLite `ALTER ADD COLUMN` fails if re-run on a DB that already has the column. Current migrator re-runs full SQL every connect — **`CREATE UNIQUE INDEX IF NOT EXISTS` is fine**, but bare `ALTER TABLE ... ADD COLUMN` will error on second boot.

**Required approach for this codebase's re-run style:** make `004` idempotent, matching how other migrations use `IF NOT EXISTS`. Use a pattern that no-ops when column exists, e.g. run ALTER inside a statement that ignores duplicate-column errors from Rust, **or** change `db.rs` to execute 004 with “ignore duplicate column” handling.

Implement in `db.rs` (preferred, explicit):

```rust
async fn apply_migration(pool: &SqlitePool, sql: &str) -> Result<(), sqlx::Error> {
    match sqlx::raw_sql(sql).execute(pool).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("duplicate column name") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}
```

Use `apply_migration` for all migrations **or** only for 004; keep 001–003 as today if they are fully idempotent (`CREATE TABLE IF NOT EXISTS`).

- [ ] **Step 4: Implement store changes**

- Extend `ViTemplate` / `ViTemplateRow` / `into_vi_template` with `origin_agent_id`.
- Update all SELECT/INSERT/RETURNING lists to include `origin_agent_id`.
- Implement `upsert_vi_template` with SQLite:

```sql
INSERT INTO vi_templates (
  id, name, agent_id, origin_agent_id, vi_path, cli_path, getinfo_path,
  inputs_json, show_front_panel, timeout_secs, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(agent_id, vi_path) DO UPDATE SET
  name = excluded.name,
  cli_path = excluded.cli_path,
  getinfo_path = excluded.getinfo_path,
  inputs_json = excluded.inputs_json,
  show_front_panel = excluded.show_front_panel,
  timeout_secs = excluded.timeout_secs
RETURNING ...
```

SQLite `ON CONFLICT(agent_id, vi_path)` requires the unique index from Step 3.

Detect created vs updated: before upsert `SELECT id FROM vi_templates WHERE agent_id=? AND vi_path=?`, or compare `changes()` / check if id matched pre-existing.

- Change `list_vi_templates` to take `Option<&str>` filter.
- Add `list_vi_templates_enriched`.
- Keep `get_vi_template` / `delete_vi_template` working with new column in SELECT.

- [ ] **Step 5: Run store tests — expect PASS**

Run: `cargo test -p scheduler store::tests::vi_template_ -- --nocapture`  
Expected: all PASS (update any older CRUD tests to assert `origin_agent_id`).

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/migrations/004_vi_origin_and_unique.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): vi_templates origin_agent_id and upsert"
```

---

### Task 2: Scheduler API — list filter, upsert create, distribute

**Files:**
- Create: `crates/scheduler/src/vi_distribute.rs`
- Modify: `crates/scheduler/src/main.rs` (`mod vi_distribute`)
- Modify: `crates/scheduler/src/api.rs` (`ViTemplateView`, list/create handlers, new route + types)
- Test: `crates/scheduler/src/api.rs` (`api::tests`), `crates/scheduler/src/vi_distribute.rs`

**Interfaces:**
- Consumes: `Store::upsert_vi_template`, `list_vi_templates_enriched`, `get_vi_template`, `get_agent`; existing `proxy` helpers / `labview_client` for target config
- Produces:
  - `ViTemplateView` adds: `origin_agent_id: String`, `agent_name: String`, `origin_agent_name: String` (missing agent → `"未知"` or first 8 of id — pick **`"未知"`** when name missing)
  - `ListViTemplatesQuery { agent_id: Option<String> }`
  - `DistributeViTemplateRequest { target_agent_ids: Vec<String>, vi_path: Option<String> }`
  - `DistributeResultItem { agent_id, status: String /* created|updated|error|skipped */, template_id: Option<String>, error: Option<String> }`
  - `DistributeViTemplateResponse { results: Vec<DistributeResultItem> }`
  - Route: `POST /api/vi-templates/{id}/distribute`
  - `pub async fn distribute_template(store, labview_client, source: &ViTemplate, targets: &[String], vi_path_override: Option<&str>) -> Vec<DistributeResultItem>` in `vi_distribute.rs`

- [ ] **Step 1: Write failing API / unit tests**

```rust
#[tokio::test]
async fn list_vi_templates_filter_by_agent_query() { /* create two; GET ?agent_id= */ }

#[tokio::test]
async fn create_vi_template_upsert_keeps_origin() {
    // POST same agent+path twice with different name; origin unchanged; second returns 200 or 201 — choose:
    // Spec: overwrite. Use 200 for update, 201 for create. Assert status + body.origin_agent_id stable.
}

#[tokio::test]
async fn distribute_creates_on_target_and_preserves_origin() {
    // agent A template; distribute to B; B row origin_agent_id == A's origin; agent_id == B
}

#[tokio::test]
async fn distribute_updates_same_path_on_target() {
    // B already has same vi_path with origin B; distribute from A → still origin B (target's existing origin per spec: "origin_agent_id 始终等于源模板的 origin_agent_id")
    // IMPORTANT: Spec §4 says on distribute, origin becomes **source template's origin_agent_id**.
    // That conflicts with "overwrite keeps origin" for *register* upsert.
    // For distribute UPDATE path: SET origin? Spec: "origin_agent_id 始终等于源模板的 origin_agent_id".
    // Implement distribute update to **also set origin_agent_id = source.origin_agent_id** via a dedicated store method `upsert_vi_template_from_distribute` that updates origin to source origin,
    // OR always UPDATE origin on distribute conflict.
    // Register upsert must NOT change origin.
    // Test this explicitly.
}

#[tokio::test]
async fn distribute_skips_source_agent() { /* status skipped */ }

#[tokio::test]
async fn distribute_partial_failure_unknown_agent() { /* one good one bad; HTTP 200 */ }
```

Clarify store split (implement in this task if not done in Task 1):

- `upsert_vi_template(..., origin_on_insert_only: true)` — conflict: never touch origin (register)
- `upsert_vi_template_distribute(..., origin_agent_id: &str)` — conflict: **set** `origin_agent_id = excluded.origin_agent_id` (source origin), plus other business fields

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cargo test -p scheduler api::tests::distribute_ -- --nocapture`  
Expected: FAIL / missing route.

- [ ] **Step 3: Implement `vi_distribute.rs` + API**

`distribute_template` algorithm:

1. Resolve final `vi_path` = normalize(override) or `source.vi_path`.
2. For each `target_id` in `target_agent_ids`:
   - If `target_id == source.agent_id` → `skipped` / `"source agent"`.
   - If `get_agent(target_id)` is None → `error` / `"agent not found"`.
   - GET `http://{ip}:{port}/api/labview/config` via `labview_client` (same base URL style as existing proxy). On failure → `error`.
   - Parse `cli_path`, `getinfo_path` from JSON.
   - `upsert_vi_template_distribute(...)` with `origin_agent_id = source.origin_agent_id`, name/inputs/flags from source.
   - Push `created` or `updated` with `template_id`.

Wire route next to existing vi-templates routes. Update `ViTemplateView::try_from` **or** build views only from `ViTemplateEnriched` in list/get handlers so names are populated. For `get` by id, enrich single row (join or two agent lookups).

Create handler: call register-style upsert (origin on insert only); return **201** if created, **200** if updated.

List handler: read `Query<ListViTemplatesQuery>`, call enriched list.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cargo test -p scheduler api::tests::list_vi_templates_ filter_by_agent_query api::tests::create_vi_template_upsert_keeps_origin api::tests::distribute_ -- --nocapture`  
Also: `cargo test -p scheduler vi_distribute:: -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/src/vi_distribute.rs crates/scheduler/src/main.rs crates/scheduler/src/api.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): VI template distribute API and list filter"
```

---

### Task 3: Center WebUI — origin/agent columns + distribute panel

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css` (only if modal needs spacing; reuse `#shot-modal` patterns)
- Test: manual + optional `crates/scheduler/tests/static_tokens.rs` if new class tokens required by existing test

**Interfaces:**
- Consumes: `GET /api/vi-templates`, `POST /api/vi-templates/{id}/distribute`, `GET /api/agents`
- Produces: UI only

- [ ] **Step 1: Update table header**

In `index.html` VI templates `<thead>`:

| 名称 | 当前机台 | 来源机台 | VI 路径 | 超时 | 操作 |

Empty row `colspan="6"`.

Add distribute modal markup (clone shot-modal structure):

- id `vi-distribute-modal`
- checkboxes container `#vi-distribute-agents`
- optional path input `#vi-distribute-path`
- results `<pre id="vi-distribute-results">`
- buttons 确认分发 / 取消

- [ ] **Step 2: Render + actions in `app.js`**

Update `renderViTemplates`:

- Show `t.agent_name || t.agent_id.slice(0,8)`, `t.origin_agent_name || …`
- Buttons: 试跑, **分发**, 删除
- `openDistributeModal(t)`: list agents except `t.agent_id`; checkboxes; clear path; show modal
- `submitDistribute()`: POST body `{ target_agent_ids: [...checked], vi_path: path || null }`; show `results` JSON or friendly lines; `fetchViTemplates()` on completion

Optional filter `<select id="vi-templates-agent-filter">` bound to `?agent_id=` — include if cheap; otherwise skip (YAGNI OK per spec “可选”).

- [ ] **Step 3: Manual smoke**

Run scheduler, open VI tab: columns visible; open 分发; cancel works.

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static/index.html crates/scheduler/static/app.js crates/scheduler/static/style.css
git commit -m "feat(scheduler-ui): VI origin columns and distribute modal"
```

---

### Task 4: Agent registered list API + WebUI trial

**Files:**
- Modify: `crates/agent/src/register.rs`
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/app.js`
- Test: `crates/agent/src/api.rs` / `register.rs` tests (mock center like existing `labview_register_template_proxies_to_center`)

**Interfaces:**
- Consumes: `resolve_agent_id`, center `GET /api/vi-templates?agent_id=`
- Produces:
  - `pub async fn list_vi_templates_for_agent(client, center_url, agent_id: &str) -> Result<(StatusCode, Value), String>`
  - Agent route: `GET /api/labview/registered-templates` → resolve id → center list → forward status/body
  - WebUI: section「已注册功能」with 试跑 / 加载到编辑区

- [ ] **Step 1: Failing test for list proxy**

```rust
#[tokio::test]
async fn labview_registered_templates_filters_via_center() {
    // mock center GET /api/vi-templates?agent_id=agent-uuid-1 returns [{...}]
    // agent GET /api/labview/registered-templates → 200 + array
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p agent labview_registered_templates_filters_via_center -- --nocapture`  
Expected: FAIL (route missing).

- [ ] **Step 3: Implement register helper + route**

Mirror `register_vi_template` GET helper. Handler uses same `resolve_agent_id` error mapping as register-template (404 / 502).

- [ ] **Step 4: WebUI**

`index.html`: after LabVIEW workbench (or below register buttons), add:

```html
<section id="lv-registered-section">
  <h3>已注册功能</h3>
  <p id="lv-registered-msg" class="msg" hidden></p>
  <div class="table-scroll">
    <table>
      <thead><tr><th>名称</th><th>VI 路径</th><th>操作</th></tr></thead>
      <tbody id="lv-registered-body">...</tbody>
    </table>
  </div>
</section>
```

`app.js`:

- `fetchRegisteredTemplates()` on load and after successful register
- 试跑: `POST /api/labview/run` with template `vi_path`, `inputs`, `show_front_panel`, `timeout_secs`
- 加载到编辑区: set `#lv-vi-path`, rebuild inputs table from `t.inputs`, sync options

- [ ] **Step 5: Tests PASS + commit**

Run: `cargo test -p agent labview_registered_templates_filters_via_center -- --nocapture`  
Expected: PASS.

```bash
git add crates/agent/src/register.rs crates/agent/src/api.rs crates/agent/static/index.html crates/agent/static/app.js
git commit -m "feat(agent): list and trial registered VI templates"
```

---

### Task 5: README note + end-to-end acceptance

**Files:**
- Modify: `README.md` (brief VI list / distribute bullets under LabVIEW section if present; otherwise short subsection)

- [ ] **Step 1: Document operator flow**

Add 4–6 lines:

1. Agent: register VI → appears under「已注册功能」→ 试跑  
2. Center: VI 模板表显示当前机台 / 来源机台  
3. Center: 分发 → 多选机台 → 目标出现模板并可试跑  
4. Same path on target overwrites; origin follows distribute rules in spec

- [ ] **Step 2: Acceptance checklist (manual)**

- [ ] Fresh scheduler migration applies; restart twice without error (idempotent 004)
- [ ] Register from Agent A; center shows 当前=A 来源=A
- [ ] Distribute to B; B has row; 来源=A 当前=B; Agent B list shows it; trial run works if VI path exists on B
- [ ] Re-distribute / same path on B → updated, single row
- [ ] Filter `?agent_id=` / Agent list only self
- [ ] Unknown target in distribute → that item error, others ok

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note VI registered list and distribute"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `origin_agent_id` + backfill | Task 1 |
| `UNIQUE(agent_id, vi_path)` | Task 1 |
| Register overwrite keeps origin | Task 1–2 |
| List + `?agent_id=` + names | Task 2–3 |
| `POST .../distribute` + partial results | Task 2 |
| Target CLI from config | Task 2 |
| Skip source agent | Task 2 |
| Center UI columns + 分发 | Task 3 |
| Agent list + trial | Task 4 |
| No tasks queue / no file sync | Global + omitted from tasks |
| README / acceptance | Task 5 |

## Placeholder / consistency notes

- Register upsert vs distribute upsert differ on whether `origin_agent_id` is updated — two store methods required (called out in Task 2).
- HTTP: create → 201, update → 200; distribute always 200 with per-item status when source exists.
- Name fallback display: `"未知"` when join misses.
