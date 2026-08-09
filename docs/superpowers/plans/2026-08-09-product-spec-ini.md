# Product Spec INI Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import legacy `*_Spec.ini` files as center-managed Spec templates and let sequence steps reference a template + full section name (e.g. `FMT_HT`) so runtime Pass/Fail uses VI output keys that match INI metric names.

**Architecture:** Parse INI once into `spec_json` stored in scheduler `spec_templates`; extend `vi_run_queue_items` with optional template reference fields; at run time Agent resolves section → `LimitRule[]`, merges with hand `limits_json` (hand wins), then uses existing `limits.rs` judge. Follow patterns from `agent_config_templates` (migration, store, scheduler API, Agent proxy, React page).

**Tech Stack:** Rust (`common`, `scheduler`, `agent` crates), PostgreSQL/sqlx, Axum, React + Ant Design (scheduler/agent frontends), Vitest (TS), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-08-09-product-spec-ini-design.md`

## Global Constraints

- Section names are **full INI headers** (`FMT_HT`, `DMI_RT`); do not split into suite + corner.
- VI `output` field names **equal** INI metric base names (`TX_AP`, not `TX_AP_UL`).
- INI keys **without** `_UL` / `_LL` suffix are **ignored in v1** (e.g. `Max_Ber_Curve`).
- `inf` / `-inf` / `+inf` / `infinity` (case-insensitive) → unbounded side (`null` in JSON, `None` at runtime).
- Hand-edited step `limits_json` **overrides** template-generated limits for the same `output`.
- Timestamp columns use **TEXT RFC3339** (not `TIMESTAMPTZ`) — match `sequence_templates` / `agent_config_templates`.
- Do **not** store Spec INI in device/calibration profiles.
- Generated limits omit `unit`; hand limits may still set `unit`.
- If both `min` and `max` resolve to unbounded for a metric, **omit** that rule from generated set.

---

## File map

| File | Responsibility |
|------|----------------|
| `crates/common/src/spec_ini.rs` | Parse INI text → `SpecDocument` JSON; bound token parsing |
| `crates/common/src/lib.rs` | `pub mod spec_ini;` + re-exports |
| `crates/agent/src/expand.rs` | `expand_limit_number` accepts `inf` tokens |
| `crates/agent/src/limits.rs` | Tests for inf + one-sided bounds (logic already supports one-sided) |
| `crates/agent/src/spec_resolve.rs` | Merge template section + hand limits → `Vec<LimitRule>` |
| `crates/agent/src/labview_sequence.rs` | Call resolver before `judge_limits_with_vars` |
| `crates/agent/src/register.rs` | HTTP helpers: list/get spec templates from center |
| `crates/agent/src/api.rs` | Proxy routes `/api/spec-templates` |
| `crates/scheduler/migrations/026_spec_templates.sql` | `spec_templates` table |
| `crates/scheduler/migrations/027_vi_run_queue_spec_fields.sql` | Queue step spec columns |
| `crates/scheduler/src/db.rs` | Register migrations 026–027 |
| `crates/scheduler/src/store.rs` | CRUD + queue field persistence |
| `crates/scheduler/src/api.rs` | `/api/spec-templates` + queue view fields |
| `frontend/agent/src/utils/specIni.ts` | TS parser mirror + tests (upload preview) |
| `frontend/agent/src/utils/specResolve.ts` | Client-side preview of resolved limits (optional P2) |
| `frontend/scheduler/src/pages/SpecsPage.tsx` | Center Spec template management |
| `frontend/scheduler/src/App.tsx` | Route `#/specs` |
| `frontend/scheduler/src/components/AppShell.tsx` | Nav link |
| `frontend/scheduler/src/api/schedulerApi.ts` | API client methods |
| `frontend/scheduler/src/api/types.ts` | `SpecTemplate` types |
| `frontend/agent/src/pages/sequence/SequenceEditTab.tsx` | Step spec template fields |
| `frontend/agent/src/api/agentApi.ts` | Agent proxy client |
| `frontend/agent/src/api/types.ts` | Queue step types |
| `docs/api.md` | Document new endpoints and step fields |

---

### Task 1: Shared Spec INI parser (`common`)

**Files:**
- Create: `crates/common/src/spec_ini.rs`
- Modify: `crates/common/src/lib.rs`
- Test: inline `#[cfg(test)]` in `spec_ini.rs`

**Interfaces:**
- Produces:
  - `pub struct SpecBound { pub min: Option<f64>, pub max: Option<f64> }`
  - `pub struct SpecDocument { pub version: u32, pub sections: HashMap<String, HashMap<String, SpecBound>> }`
  - `pub struct SpecParseResult { pub document: SpecDocument, pub warnings: Vec<String> }`
  - `pub fn parse_spec_ini(text: &str) -> Result<SpecParseResult, String>`
  - `pub fn spec_document_to_json(doc: &SpecDocument) -> serde_json::Value`
  - `pub fn parse_bound_token(raw: &str) -> Option<f64>` — `None` means unbounded (`inf`)

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn parses_ul_ll_pairs() {
    let ini = r#"
[FMT_HT]
TX_AP_UL = 4.0
TX_AP_LL = -2
"#;
    let r = parse_spec_ini(ini).unwrap();
    let sec = r.document.sections.get("FMT_HT").unwrap();
    let tx = sec.get("TX_AP").unwrap();
    assert_eq!(tx.min, Some(-2.0));
    assert_eq!(tx.max, Some(4.0));
}

#[test]
fn inf_is_unbounded() {
    let ini = "[S]\nJitterRMS_UL = inf\nJitterRMS_LL = -inf\n";
    let sec = parse_spec_ini(ini).unwrap().document.sections.get("S").unwrap();
    let j = sec.get("JitterRMS").unwrap();
    assert_eq!(j.min, None);
    assert_eq!(j.max, None);
}

#[test]
fn ignores_standalone_keys() {
    let ini = "[S]\nMax_Ber_Curve=6\nTX_AP_UL=1\nTX_AP_LL=0\n";
    let sec = parse_spec_ini(ini).unwrap().document.sections.get("S").unwrap();
    assert!(!sec.contains_key("Max_Ber_Curve"));
    assert!(sec.contains_key("TX_AP"));
}

#[test]
fn scientific_notation() {
    let ini = "[S]\nQk_Csen_BER_UL = 8E-5\nQk_Csen_BER_LL = 1E-5\n";
    let sec = parse_spec_ini(ini).unwrap().document.sections.get("S").unwrap();
    let q = sec.get("Qk_Csen_BER").unwrap();
    assert!((q.max.unwrap() - 8e-5).abs() < 1e-10);
}
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cargo test -p common spec_ini -- --nocapture`

- [ ] **Step 3: Implement `spec_ini.rs`**

Key parsing loop (simplified):

```rust
fn parse_bound_token(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("+inf") || t.eq_ignore_ascii_case("infinity") {
        return None;
    }
    if t.eq_ignore_ascii_case("-inf") || t.eq_ignore_ascii_case("-infinity") {
        return None;
    }
    t.parse::<f64>().ok()
}

// For _UL/_LL keys: update SpecBound on metric base name
// Skip keys not ending with _UL or _LL
// Error if file has zero sections after parse
```

Export from `lib.rs`:

```rust
pub mod spec_ini;
pub use spec_ini::{parse_spec_ini, SpecBound, SpecDocument, SpecParseResult, spec_document_to_json};
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cargo test -p common spec_ini -- --nocapture`

- [ ] **Step 5: Commit**

```bash
git add crates/common/src/spec_ini.rs crates/common/src/lib.rs
git commit -m "feat(common): add Spec INI parser for product limit files"
```

---

### Task 2: `limits.rs` / `expand.rs` — support `inf` tokens

**Files:**
- Modify: `crates/agent/src/expand.rs` (`expand_limit_number`)
- Modify: `crates/agent/src/limits.rs` (tests only unless `check_range` needs both-None skip)

**Interfaces:**
- Consumes: none
- Produces: `expand_limit_number` returns `Ok(None)` for `inf` / `-inf` strings

- [ ] **Step 1: Write failing tests in `expand.rs`**

```rust
#[test]
fn expand_limit_inf_tokens() {
    let vars = HashMap::new();
    assert_eq!(expand_limit_number(&json!("inf"), &vars).unwrap(), None);
    assert_eq!(expand_limit_number(&json!("-inf"), &vars).unwrap(), None);
    assert_eq!(expand_limit_number(&json!("8E-5"), &vars).unwrap(), Some(8e-5));
}
```

Add in `limits.rs`:

```rust
#[test]
fn range_only_max_passes() {
    let limits = vec![LimitRule {
        output: "TX_AP".into(),
        op: None,
        min: None,
        max: Some(json!(4.0)),
        expect: None,
        unit: None,
    }];
    assert!(matches!(judge_limits(&limits, &json!({"TX_AP": 3.0})), StepJudge::Pass));
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p agent expand_limit_inf -- --nocapture`

- [ ] **Step 3: Update `expand_limit_number`**

```rust
let t = expanded.trim();
if t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("+inf") || t.eq_ignore_ascii_case("infinity") {
    return Ok(None);
}
if t.eq_ignore_ascii_case("-inf") || t.eq_ignore_ascii_case("-infinity") {
    return Ok(None);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cargo test -p agent expand_limit limits:: -- --nocapture`

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/expand.rs crates/agent/src/limits.rs
git commit -m "feat(agent): treat inf tokens as unbounded Spec limits"
```

---

### Task 3: TypeScript parser mirror (upload preview)

**Files:**
- Create: `frontend/agent/src/utils/specIni.ts`
- Create: `frontend/agent/src/utils/specIni.test.ts`

**Interfaces:**
- Produces: `parseSpecIni(text: string): { version: 1; sections: Record<string, Record<string, { min: number | null; max: number | null }>> }; warnings: string[] }`

- [ ] **Step 1: Write failing Vitest tests** (mirror Rust cases from Task 1)

- [ ] **Step 2: Run — expect FAIL**

Run: `cd frontend/agent && npm test -- --run src/utils/specIni.test.ts`

- [ ] **Step 3: Implement `specIni.ts`** (same rules as Rust; share test fixture strings)

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add frontend/agent/src/utils/specIni.ts frontend/agent/src/utils/specIni.test.ts
git commit -m "feat(agent-ui): add Spec INI parser for upload preview"
```

---

### Task 4: Scheduler DB — `spec_templates` table + store

**Files:**
- Create: `crates/scheduler/migrations/026_spec_templates.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs`

**Interfaces:**
- Produces:
  - `Store::create_spec_template(name, product_pn, note, source_filename, spec_json, created_by_agent_id) -> Result<SpecTemplate>`
  - `Store::list_spec_templates() -> Result<Vec<SpecTemplateSummary>>`
  - `Store::get_spec_template(id) -> Result<Option<SpecTemplate>>`
  - `Store::delete_spec_template(id) -> Result<bool>`

- [ ] **Step 1: Write migration `026_spec_templates.sql`**

```sql
CREATE TABLE IF NOT EXISTS spec_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  product_pn TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_filename TEXT NOT NULL DEFAULT '',
  spec_json JSONB NOT NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spec_templates_updated
  ON spec_templates (updated_at DESC, id DESC);
```

Register in `db.rs` after migration 025.

- [ ] **Step 2: Write failing store test**

```rust
#[tokio::test]
async fn spec_template_crud_roundtrip() {
    let store = test_store().await;
    let agent = store.upsert_agent("spec-uploader", "10.0.0.1", 26631).await.unwrap();
    let spec_json = r#"{"version":1,"sections":{"FMT_HT":{"TX_AP":{"min":-2,"max":4}}}}"#;
    let created = store
        .create_spec_template("fmt-spec", "", "", "Tunn_FMT_Spec.ini", spec_json, Some(&agent.id))
        .await
        .unwrap();
    let got = store.get_spec_template(created.id).await.unwrap().unwrap();
    assert_eq!(got.name, "fmt-spec");
    let listed = store.list_spec_templates().await.unwrap();
    assert!(listed.iter().any(|t| t.id == created.id));
}
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cargo test -p scheduler spec_template_crud -- --nocapture`

- [ ] **Step 4: Implement store structs + methods** (mirror `AgentConfigTemplate` patterns; `created_at`/`updated_at` as `Utc::now().to_rfc3339()` strings)

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/migrations/026_spec_templates.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): persist product Spec templates"
```

---

### Task 5: Scheduler API — `/api/spec-templates`

**Files:**
- Modify: `crates/scheduler/src/api.rs`
- Modify: `docs/api.md`

**Interfaces:**
- Consumes: `common::parse_spec_ini` for `POST` body `{ "ini_text", "name?", "product_pn?", "note?", "source_filename?", "created_by_agent_id?" }`
- Produces: JSON list item `{ id, name, product_pn, source_filename, section_count, created_by_agent_name?, updated_at }`

- [ ] **Step 1: Add route handlers** (list, create with parse, get, delete)

Create handler sketch:

```rust
async fn create_spec_template(State(s): State<AppState>, Json(req): Json<CreateSpecTemplateRequest>) -> impl IntoResponse {
    let parsed = match parse_spec_ini(&req.ini_text) {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(ErrorBody { error: e })).into_response(),
    };
    if parsed.document.sections.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(ErrorBody { error: "no sections".into() })).into_response();
    }
    let spec_json = spec_document_to_json(&parsed.document).to_string();
    // store.create_spec_template(...)
}
```

- [ ] **Step 2: Manual API test**

```powershell
# After cargo run -p scheduler
curl.exe -s -X POST http://127.0.0.1:26630/api/spec-templates -H "Content-Type: application/json" --data-binary "@.tmp/spec-upload.json"
```

`.tmp/spec-upload.json`:

```json
{"name":"AS0805 Spec","ini_text":"[FMT_HT]\nTX_AP_UL=4\nTX_AP_LL=-2\n","source_filename":"Tunn_FMT_Spec.ini"}
```

Expected: `201` with `id` and `section_count: 1`.

- [ ] **Step 3: Update `docs/api.md`** with endpoints table

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/src/api.rs docs/api.md
git commit -m "feat(scheduler): add Spec template REST API"
```

---

### Task 6: Agent proxy — `/api/spec-templates`

**Files:**
- Modify: `crates/agent/src/register.rs`
- Modify: `crates/agent/src/api.rs`

**Interfaces:**
- Produces: `list_spec_templates`, `get_spec_template`, `create_spec_template` HTTP helpers (mirror config templates)

- [ ] **Step 1: Add register helpers** forwarding to `{center_url}/api/spec-templates`

- [ ] **Step 2: Add Agent routes** `GET/POST /api/spec-templates`, `GET/DELETE /api/spec-templates/{id}`

- [ ] **Step 3: `cargo test -p agent` + manual curl via Agent port 26631**

- [ ] **Step 4: Commit**

```bash
git add crates/agent/src/register.rs crates/agent/src/api.rs
git commit -m "feat(agent): proxy Spec template API to center"
```

---

### Task 7: Center UI — Spec 模板 page

**Files:**
- Create: `frontend/scheduler/src/pages/SpecsPage.tsx`
- Modify: `frontend/scheduler/src/App.tsx`
- Modify: `frontend/scheduler/src/components/AppShell.tsx`
- Modify: `frontend/scheduler/src/api/schedulerApi.ts`
- Modify: `frontend/scheduler/src/api/types.ts`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/spec-templates`
- Uses: copy upload/preview pattern from `ConfigsPage.tsx` + `parseSpecIni` imported from agent utils OR duplicate thin wrapper in scheduler (prefer **copy parser to `frontend/scheduler/src/utils/specIni.ts`** re-exporting same logic to avoid cross-package import)

- [ ] **Step 1: Add API types + `listSpecTemplates`, `createSpecTemplate`, `deleteSpecTemplate`, `getSpecTemplate`**

- [ ] **Step 2: Build `SpecsPage`**
  - Upload `.ini` → client parse preview (sections + metric counts)
  - Modal confirm → POST `ini_text`
  - Table: ID, name, product_pn, source file, sections, updated_at
  - Row actions: 查看 (detail modal with section/metric table), 删除

- [ ] **Step 3: Add nav「Spec 模板」** route `#/specs`

- [ ] **Step 4: Build + sync static**

Run: `.\scripts\build-frontend.ps1`

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduler/src frontend/scheduler/static crates/scheduler/static
git commit -m "feat(scheduler-ui): add Spec template management page"
```

---

### Task 8: Queue schema — spec fields on `vi_run_queue_items`

**Files:**
- Create: `crates/scheduler/migrations/027_vi_run_queue_spec_fields.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs` (`ViRunQueueItem`, `ViRunQueueReplaceItem`, list/replace SQL)
- Modify: `crates/scheduler/src/api.rs` (queue PUT/GET views)

**Interfaces:**
- Produces step fields:
  - `spec_template_id: Option<i64>`
  - `spec_section: String` (default `""`)
  - `spec_metrics_json: String` (default `"[]"`)

- [ ] **Step 1: Migration**

```sql
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_template_id BIGINT REFERENCES spec_templates(id) ON DELETE SET NULL;
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_section TEXT NOT NULL DEFAULT '';
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_metrics_json TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 2: Extend structs + SQL** in store (all `list_vi_run_queue` / `replace_vi_run_queue` / sequence template copy paths)

- [ ] **Step 3: API view** — expose as `spec_template_id`, `spec_section`, `spec_metrics` (parsed array on GET; accept array on PUT)

- [ ] **Step 4: Store test** — replace queue item with spec fields roundtrip

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/migrations/027_vi_run_queue_spec_fields.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs crates/scheduler/src/api.rs
git commit -m "feat(scheduler): persist spec template reference on queue steps"
```

---

### Task 9: Agent runtime resolver

**Files:**
- Create: `crates/agent/src/spec_resolve.rs`
- Modify: `crates/agent/src/main.rs` (`mod spec_resolve;`)
- Modify: `crates/agent/src/labview_sequence.rs`
- Modify: `crates/agent/src/register.rs` (fetch spec template JSON from center)

**Interfaces:**
- Consumes: `SpecDocument` JSON, `LimitRule`, `expand_str`, `parse_limits_json`
- Produces:

```rust
pub fn resolve_step_limits(
    hand_limits: &[LimitRule],
    spec_template_json: Option<&str>,
    spec_section: &str,
    spec_metrics_json: &str,
    vars: &HashMap<String, String>,
) -> Result<Vec<LimitRule>, String>;
```

Algorithm (from spec): expand section → load metrics → generate rules (skip if both bounds None) → hand overrides by `output`.

- [ ] **Step 1: Write failing unit tests in `spec_resolve.rs`**

Cases: merge override, missing section error, empty metrics = all keys, both-unbounded metric omitted.

- [ ] **Step 2: Implement resolver**

```rust
pub fn spec_bound_to_limit_rule(output: &str, bound: &SpecBound) -> Option<LimitRule> {
    if bound.min.is_none() && bound.max.is_none() {
        return None;
    }
    Some(LimitRule {
        output: output.to_string(),
        op: None,
        min: bound.min.map(serde_json::Value::from),
        max: bound.max.map(serde_json::Value::from),
        expect: None,
        unit: None,
    })
}
```

- [ ] **Step 3: Integrate in `labview_sequence.rs`**

Before `judge_limits_with_vars`, if step has `spec_template_id`:
- Fetch template once per run (cache `HashMap<i64, SpecDocument>` in run state)
- Call `resolve_step_limits`

Extend `QueueItemForRun` (or equivalent) with `spec_template_id`, `spec_section`, `spec_metrics_json`.

- [ ] **Step 4: Run agent tests**

Run: `cargo test -p agent spec_resolve -- --nocapture`

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/spec_resolve.rs crates/agent/src/main.rs crates/agent/src/labview_sequence.rs crates/agent/src/register.rs
git commit -m "feat(agent): resolve Spec template limits at sequence run time"
```

---

### Task 10: Agent sequence UI — step Spec template binding

**Files:**
- Modify: `frontend/agent/src/api/types.ts`
- Modify: `frontend/agent/src/api/agentApi.ts`
- Modify: `frontend/agent/src/pages/sequence/SequenceEditTab.tsx`
- Modify: `frontend/agent/src/pages/sequence/sequenceDetailModels.ts` (if step model lives there)

**Interfaces:**
- Consumes: `listSpecTemplates()` via Agent proxy
- Persists: `spec_template_id`, `spec_section`, `spec_metrics` on queue PUT

- [ ] **Step 1: Extend step type + API mapping**

- [ ] **Step 2: In step detail drawer add:**
  - Select「Spec 模板」(nullable)
  - Input「Section」(`FMT_HT` or `${SpecSection}`) with variable picker
  - Optional multi-select「指标」(empty = 全部)
  - Keep existing limits JSON editor; helper text: 手填 limits 覆盖模板同名字段

- [ ] **Step 3: Spec column summary** — `模板#12·FMT_HT·18项` / `手填 3项` / `未设置`

- [ ] **Step 4: Build agent static + manual smoke**

- [ ] **Step 5: Commit**

```bash
git add frontend/agent/src frontend/agent/static crates/agent/static
git commit -m "feat(agent-ui): bind sequence steps to Spec templates"
```

---

### Task 11: P3 — variable-driven section + channel overlay

**Files:**
- Modify: `crates/agent/src/spec_resolve.rs` (already uses `expand_str` on section)
- Modify: `crates/agent/src/channel_run.rs` or multi-channel var merge (if `SpecSection` should be overridable per channel)
- Modify: `frontend/agent/src/pages/sequence/SequenceEditTab.tsx` (document `${SpecSection}` in help)
- Optional: `sequence_templates` default columns (defer if YAGNI)

- [ ] **Step 1: Test `resolve_step_limits` with `spec_section = "${Corner}"` and vars**

- [ ] **Step 2: Ensure channel overlay merges `SpecSection` into effective vars** (same as other overlay keys — verify in `channel_run` / config resolution path from `2026-08-05-multi-channel-station-configuration`)

- [ ] **Step 3: Manual test** — set variable `SpecSection=FMT_HT`, run CH0 with overlay `SpecSection=FMT_RT`, confirm different limits applied

- [ ] **Step 4: Commit**

```bash
git add crates/agent/src/spec_resolve.rs crates/agent/src/channel_run.rs
git commit -m "feat(agent): support variable Spec section per channel"
```

---

### Task 12: Documentation + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-product-spec-ini-design.md` — `Status: approved / implemented`
- Modify: `docs/api.md` — queue step fields + spec templates section
- Modify: `README.md` — one line under features if appropriate

- [ ] **Step 1: Update docs**

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: document product Spec INI templates"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| P0 parser + inf | 1, 2, 3 |
| P1 center library + API + UI | 4, 5, 6, 7 |
| P2 queue fields + resolver + step UI | 8, 9, 10 |
| P3 variable section + channel | 11 |
| Full section names | 1, 10 |
| Ignore non UL/LL keys | 1, 3 |
| Hand overrides template | 9 |
| TEXT timestamps | 4 |
| Error handling table | 9 |
| No device profile misuse | Global constraints |

**Placeholder scan:** none.

**Type consistency:** `SpecBound`, `SpecDocument`, `resolve_step_limits`, queue fields aligned across tasks 8–10.

---

## Suggested commit order / PR slicing

| PR | Tasks | Shippable alone? |
|----|-------|------------------|
| 1 | 1–3 | Yes (parser + inf, no UI) |
| 2 | 4–7 | Yes (center library end-to-end) |
| 3 | 8–10 | Yes (runtime + Agent UI) |
| 4 | 11–12 | Yes (enhancement + docs) |
