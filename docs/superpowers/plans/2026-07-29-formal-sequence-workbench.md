# Formal Sequence Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Agent「执行顺序」into a formal optical-module test workbench: per-step enable/skip, breakpoint-before, numeric limits (Pass/Fail), fail policy, and optional SN/工单 on run.

**Architecture:** Extend center `vi_run_queue_items` with step metadata; agent runner judges limits after each step and applies fail_policy; optional SN from request body or step outputs (`SN`/`sn`); breakpoint via in-memory run session + continue/abort while holding the busy slot.

**Tech Stack:** PostgreSQL, sqlx, Axum, Tokio, vanilla JS (agent static UI)

**Spec:** `docs/superpowers/specs/2026-07-29-formal-sequence-workbench-design.md`

## Global Constraints

- SN is **optional** (never 400 solely for missing SN); step outputs may set `SN`/`sn`
- Limits live on **queue steps**, not templates
- Fail default: **stop**; phase 1 policies: `stop` | `continue` only
- Breakpoint pauses **before** the step; may land as second PR within this phase
- No Spec library, no persistent `test_runs`, no `ask` fail policy
- Migration number: **010** (after `009_vi_template_kind.sql`)
- Prefer additive columns + serde defaults so old clients still work

---

## File map

| File | Responsibility |
|------|----------------|
| `crates/scheduler/migrations/010_vi_run_queue_step_meta.sql` | ADD columns to `vi_run_queue_items` |
| `crates/scheduler/src/db.rs` | Wire migration 010 |
| `crates/scheduler/src/store.rs` | Persist/list new step fields; `replace_vi_run_queue` takes step structs |
| `crates/scheduler/src/api.rs` | Queue view + PUT body fields |
| `crates/agent/src/limits.rs` | **New** pure limit judge + SN extract |
| `crates/agent/src/labview_sequence.rs` | Skip / limits / fail_policy / overall / SN context |
| `crates/agent/src/sequence_session.rs` | **New** breakpoint session (Task 6) |
| `crates/agent/src/api.rs` | Run body, continue/abort routes, session wiring |
| `crates/agent/src/lib.rs` or `main.rs` modules | Register new modules |
| `crates/agent/static/index.html` | Workbench columns + run bar |
| `crates/agent/static/app.js` | Persist meta, Spec editor, run UX |
| `crates/agent/static/styles.css` (if present) | Minimal workbench styles |
| `README.md` | Short note on sequence step meta / SN |

---

### Task 1: Limit judge (pure unit)

**Files:**
- Create: `crates/agent/src/limits.rs`
- Modify: `crates/agent/src/lib.rs` (or `main.rs` module tree) — `mod limits;`
- Test: unit tests inside `limits.rs`

**Interfaces:**
- Produces:
  - `pub struct LimitRule { pub output: String, pub min: Option<f64>, pub max: Option<f64>, pub unit: Option<String> }`
  - `pub enum StepJudge { Ok, Pass, Fail { message: String }, Error { message: String } }`
  - `pub fn judge_limits(limits: &[LimitRule], outputs: &serde_json::Value) -> StepJudge`
  - `pub fn extract_sn_from_outputs(outputs: &serde_json::Value) -> Option<String>`
  - `pub fn parse_limits_json(raw: &str) -> Result<Vec<LimitRule>, String>` (empty/`[]` → ok empty)

- [ ] **Step 1: Write failing tests** in `limits.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_limits_ok() {
        assert!(matches!(judge_limits(&[], &json!({"Power_dBm": 0.0})), StepJudge::Ok));
    }

    #[test]
    fn inclusive_pass() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: Some(3.0),
            unit: Some("dBm".into()),
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": -5.0})),
            StepJudge::Pass
        ));
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": 3.0})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn out_of_range_fail() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: Some(3.0),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"Power_dBm": 4.0})),
            StepJudge::Fail { .. }
        ));
    }

    #[test]
    fn missing_value_error() {
        let limits = vec![LimitRule {
            output: "Power_dBm".into(),
            min: Some(-5.0),
            max: None,
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({})),
            StepJudge::Error { .. }
        ));
    }

    #[test]
    fn open_bound_null_min() {
        let limits = vec![LimitRule {
            output: "x".into(),
            min: None,
            max: Some(10.0),
            unit: None,
        }];
        assert!(matches!(
            judge_limits(&limits, &json!({"x": -100.0})),
            StepJudge::Pass
        ));
    }

    #[test]
    fn extract_sn_prefers_SN_then_sn() {
        assert_eq!(
            extract_sn_from_outputs(&json!({"SN": "A1"})).as_deref(),
            Some("A1")
        );
        assert_eq!(
            extract_sn_from_outputs(&json!({"sn": "b2"})).as_deref(),
            Some("b2")
        );
        assert_eq!(extract_sn_from_outputs(&json!({})), None);
    }

    #[test]
    fn multi_limit_all_must_pass() {
        let limits = vec![
            LimitRule { output: "a".into(), min: Some(0.0), max: Some(1.0), unit: None },
            LimitRule { output: "b".into(), min: Some(0.0), max: Some(1.0), unit: None },
        ];
        assert!(matches!(
            judge_limits(&limits, &json!({"a": 0.5, "b": 2.0})),
            StepJudge::Fail { .. }
        ));
    }
}
```

- [ ] **Step 2: Run tests — expect FAIL** (module/types missing)

```bash
cargo test -p agent --lib limits::
```

Expected: compile error or missing `limits` module.

- [ ] **Step 3: Implement `limits.rs`**

Rules (from spec):
- Empty limits → `Ok`
- Read numeric from top-level object key only; also accept integer JSON
- Prefer looking under `outputs` object if present, else top-level of result Value
- Inclusive `min`/`max`; null bound = open
- Missing / non-numeric → `Error`
- All limits must Pass; first Fail/Error short-circuits
- Non-empty limits that all pass → `Pass` (not `Ok`)
- `extract_sn_from_outputs`: check `SN` then `sn` (string or number→string); trim; empty → None

```rust
fn lookup_number(outputs: &Value, key: &str) -> Result<f64, String> {
    let root = outputs.get("outputs").unwrap_or(outputs);
    let v = root.get(key).ok_or_else(|| format!("missing output `{key}`"))?;
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
        .ok_or_else(|| format!("output `{key}` is not numeric"))
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cargo test -p agent --lib limits::
```

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/limits.rs crates/agent/src/lib.rs crates/agent/src/main.rs
git commit -m "feat(agent): add numeric limit judge for sequence steps"
```

---

### Task 2: Migration + store persistence

**Files:**
- Create: `crates/scheduler/migrations/010_vi_run_queue_step_meta.sql`
- Modify: `crates/scheduler/src/db.rs` (include 010 via `apply_migration`)
- Modify: `crates/scheduler/src/store.rs` (`ViRunQueueItem`, `ViRunQueueItemRow`, `list_vi_run_queue`, `replace_vi_run_queue`)

**Interfaces:**
- Produces store type for replace:

```rust
#[derive(Debug, Clone)]
pub struct ViRunQueueReplaceItem {
    pub vi_template_id: i64,
    pub enabled: bool,
    pub breakpoint: bool,
    pub fail_policy: String, // "stop" | "continue"
    pub limits_json: String, // JSON array text
    pub note: String,
}
```

- Change signature:

```rust
pub async fn replace_vi_run_queue(
    &self,
    agent_id: &str,
    items: &[ViRunQueueReplaceItem],
) -> Result<Vec<ViRunQueueItem>, QueueReplaceError>
```

- Extend `ViRunQueueItem` with: `enabled: bool`, `breakpoint: bool`, `fail_policy: String`, `limits_json: String`, `note: String`

- [ ] **Step 1: Write migration SQL**

```sql
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS breakpoint BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS fail_policy TEXT NOT NULL DEFAULT 'stop';
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS limits_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
```

Wire in `db.rs` after 009:

```rust
apply_migration(
    pool,
    include_str!("../migrations/010_vi_run_queue_step_meta.sql"),
)
.await?;
```

- [ ] **Step 2: Write failing store test** (extend `store.rs` tests module)

```rust
#[tokio::test]
async fn vi_run_queue_persists_step_meta() {
    let store = /* same harness as vi_run_queue_replace_and_list_order */;
    // create agent + template as existing tests do
    let items = vec![ViRunQueueReplaceItem {
        vi_template_id: tpl.id,
        enabled: false,
        breakpoint: true,
        fail_policy: "continue".into(),
        limits_json: r#"[{"output":"Power_dBm","min":-5.0,"max":3.0,"unit":"dBm"}]"#.into(),
        note: "ch1".into(),
    }];
    let listed = store.replace_vi_run_queue(&agent.id, &items).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].enabled);
    assert!(listed[0].breakpoint);
    assert_eq!(listed[0].fail_policy, "continue");
    assert!(listed[0].limits_json.contains("Power_dBm"));
    assert_eq!(listed[0].note, "ch1");
}
```

Also update existing callers of `replace_vi_run_queue(&id, &[tpl_id])` to pass `ViRunQueueReplaceItem` with defaults (`enabled: true`, `breakpoint: false`, `fail_policy: "stop"`, `limits_json: "[]"`, `note: ""`).

- [ ] **Step 3: Run store test — expect FAIL** until columns/fields exist

```bash
cargo test -p scheduler --lib vi_run_queue_persists_step_meta
```

- [ ] **Step 4: Implement store SELECT/INSERT**

`list_vi_run_queue` SELECT add: `q.enabled, q.breakpoint, q.fail_policy, q.limits_json, q.note`

INSERT:

```sql
INSERT INTO vi_run_queue_items
  (id, agent_id, vi_template_id, position, created_at,
   enabled, breakpoint, fail_policy, limits_json, note)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
```

Normalize `fail_policy` on write: only allow `stop`|`continue`; anything else → `stop`.

- [ ] **Step 5: Run all queue store tests — PASS**

```bash
cargo test -p scheduler --lib vi_run_queue
```

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/migrations/010_vi_run_queue_step_meta.sql crates/scheduler/src/db.rs crates/scheduler/src/store.rs
git commit -m "feat(scheduler): persist sequence step enable/breakpoint/limits"
```

---

### Task 3: Center queue API round-trip

**Files:**
- Modify: `crates/scheduler/src/api.rs` (`ViRunQueueItemView`, `ReplaceViRunQueueItem`, `put_vi_run_queue`, `vi_run_queue_item_view`)
- Modify existing API tests around `vi_run_queue_put_get_round_trip`

**Interfaces:**
- View adds:

```rust
pub enabled: bool,
pub breakpoint: bool,
pub fail_policy: String,
pub limits: serde_json::Value, // parsed array
pub note: String,
```

- PUT item:

```rust
#[derive(Debug, Deserialize)]
pub struct ReplaceViRunQueueItem {
    pub vi_template_id: i64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub breakpoint: bool,
    #[serde(default = "default_fail_stop")]
    pub fail_policy: String,
    #[serde(default = "default_empty_array")]
    pub limits: serde_json::Value,
    #[serde(default)]
    pub note: String,
}
```

`put_vi_run_queue` maps each item → `ViRunQueueReplaceItem` with `limits_json = serde_json::to_string(&item.limits)`.

- [ ] **Step 1: Extend API test** `vi_run_queue_put_get_round_trip` to PUT:

```json
{
  "items": [{
    "vi_template_id": <id>,
    "enabled": false,
    "breakpoint": true,
    "fail_policy": "continue",
    "limits": [{"output":"x","min":0,"max":1}],
    "note": "n1"
  }]
}
```

Assert GET/PUT response returns same fields. Keep a second assert that PUT with only `{ "vi_template_id": id }` still works (defaults).

- [ ] **Step 2: Run — FAIL / compile errors**

```bash
cargo test -p scheduler --lib vi_run_queue_put_get_round_trip
```

- [ ] **Step 3: Implement view + PUT mapping**

- [ ] **Step 4: Run API queue tests — PASS**

```bash
cargo test -p scheduler --lib vi_run_queue
```

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/src/api.rs
git commit -m "feat(scheduler): expose sequence step meta on vi-run-queue API"
```

---

### Task 4: Agent sequence runner (skip / limits / fail / SN)

**Files:**
- Modify: `crates/agent/src/labview_sequence.rs`
- Uses: `crate::limits::{judge_limits, extract_sn_from_outputs, LimitRule, StepJudge, parse_limits_json}`

**Interfaces:**
- Extend `QueueItemForRun`:

```rust
pub enabled: bool,
pub breakpoint: bool, // ignored until Task 6; still parsed
pub fail_policy: String,
pub limits: Vec<LimitRule>,
```

- Extend `SequenceStepResult`:

```rust
pub status: String, // "pass"|"fail"|"error"|"skipped"|"ok"
pub measured: Option<Value>,
pub limits: Option<Value>,
// keep ok: bool for backward compat (ok == status in {pass,ok,skipped})
```

- Extend `SequenceResponse`:

```rust
pub sn: Option<String>,
pub work_order: Option<String>,
pub overall: String, // pass|fail|error|aborted
// stopped, failed_at, steps remain
```

- New entry:

```rust
pub struct SequenceRunOpts {
    pub sn: Option<String>,
    pub work_order: Option<String>,
}

pub async fn run_sequence_with_opts<F, Fut>(
    items: &[QueueItemForRun],
    opts: SequenceRunOpts,
    mut run_one: F,
) -> SequenceResponse
```

Algorithm per item index `i`:
1. If `!enabled` → push `status=skipped`, `ok=true`, continue (do not call run_one)
2. Call `run_one`
3. On Err → `status=error`, apply fail_policy (`stop` → break with overall later; `continue` → keep going)
4. On Ok(result):
   - Update `sn` from `extract_sn_from_outputs(&result)` if Some (last write wins)
   - `judge_limits`; map to status; set `measured` from judged keys if useful (or whole outputs object)
   - On Fail/Error + fail_policy stop → break
5. Compute `overall`: any Fail → `fail`; else any Error → `error`; else `pass` (no abort yet)
6. `stopped` true if halted early due to fail/error stop

Update `queue_items_for_run` to parse new fields with defaults: `enabled=true`, `breakpoint=false`, `fail_policy=stop`, `limits=[]` (from JSON array or `limits_json` string if center ever double-encodes — prefer `limits` array from API view).

Keep `run_sequence(...)` as thin wrapper calling `run_sequence_with_opts` with empty opts for older call sites, **or** update call site in Task 5 only.

- [ ] **Step 1: Failing tests** in `labview_sequence.rs`:

```rust
#[tokio::test]
async fn skips_disabled_steps() { /* enabled false → skipped, run_one not called for it */ }

#[tokio::test]
async fn fail_policy_stop_halts_on_limit_fail() { /* mock returns out-of-range; next step not run */ }

#[tokio::test]
async fn fail_policy_continue_runs_next() { /* ... */ }

#[tokio::test]
async fn sn_from_step_output_when_opts_empty() {
    // run_one returns {"SN":"DUT1"}; opts.sn=None → resp.sn == Some("DUT1")
}

#[tokio::test]
async fn missing_sn_still_runs() {
    // opts.sn=None, no SN in outputs → resp.sn None, overall pass if steps ok
}

#[tokio::test]
async fn empty_limits_status_ok() { /* status "ok" */ }
```

Update `sample_item` helper with new fields defaults.

- [ ] **Step 2: Run — FAIL**

```bash
cargo test -p agent --lib labview_sequence::
```

- [ ] **Step 3: Implement runner changes**

- [ ] **Step 4: Run — PASS** (including old stop-on-execution-error tests; treat execution Err as `error` + stop unless fail_policy continue)

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/labview_sequence.rs
git commit -m "feat(agent): judge limits, skip, fail_policy, and optional SN in sequences"
```

---

### Task 5: Agent run-sequence HTTP body + response

**Files:**
- Modify: `crates/agent/src/api.rs` (`labview_run_sequence`)
- Modify tests: `labview_run_sequence_empty_queue_400`, add optional-body smoke if feasible

**Interfaces:**

```rust
#[derive(Debug, Deserialize, Default)]
struct RunSequenceRequest {
    #[serde(default)]
    sn: Option<String>,
    #[serde(default)]
    work_order: Option<String>,
}

async fn labview_run_sequence(
    State(s): State<AppState>,
    body: Option<Json<RunSequenceRequest>>, // or Json with Default
) -> impl IntoResponse
```

Normalize: trim SN; empty string → None. Pass into `run_sequence_with_opts`.  
Empty POST body / no JSON must still work (optional body).

Do **not** return 400 for missing SN.

- [ ] **Step 1: Adjust handler + ensure empty queue / busy tests still pass**

```bash
cargo test -p agent --lib labview_run_sequence
```

- [ ] **Step 2: Commit**

```bash
git add crates/agent/src/api.rs
git commit -m "feat(agent): accept optional SN/work_order on run-sequence"
```

---

### Task 6: Breakpoint run session (continue / abort)

**Files:**
- Create: `crates/agent/src/sequence_session.rs`
- Modify: `crates/agent/src/api.rs` (AppState, routes, handlers)
- Modify: `crates/agent/src/labview_sequence.rs` if needed to support resume-from-index

**Interfaces:**

```rust
// sequence_session.rs
pub struct SequenceSession {
    pub items: Vec<QueueItemForRun>,
    pub next_index: usize,          // next item index to run
    pub steps_so_far: Vec<SequenceStepResult>,
    pub sn: Option<String>,
    pub work_order: Option<String>,
    pub abort: bool,
}

pub struct SequenceSessionSlot {
    inner: tokio::sync::Mutex<Option<SequenceSession>>,
}
```

Protocol:
1. `POST /api/labview/run-sequence` acquires busy slot; runs until **before** an enabled step with `breakpoint=true` (and not already completed), OR until finished.
2. On breakpoint: **keep slot acquired**; store session; return `200` with:

```json
{
  "overall": "pass",
  "stopped": false,
  "pause": { "before_position": <queue position>, "message": "breakpoint" },
  "steps": [ ... partial ... ],
  "sn": ...,
  "work_order": ...
}
```

3. `POST /api/labview/run-sequence/continue` resumes from `next_index` (skip re-checking breakpoint on that same step once resumed — clear breakpoint flag for that index in session or advance past pause). Spec: pause **before** step; continue executes that step then continues.
4. `POST /api/labview/run-sequence/abort` sets overall `aborted`, clears session, releases slot.
5. If run completes without pause: release slot, `pause: null`.
6. If continue/abort with no session → `409` or `400` with clear error.
7. Starting a new run while session paused → `409` busy (slot already held).

Implement resume by refactoring runner into `run_from(items, start_index, opts, prior_steps, run_one) -> SequenceResponse` that can return early with pause metadata:

```rust
pub struct SequenceResponse {
    ...
    pub pause: Option<SequencePause>,
}

pub struct SequencePause {
    pub before_position: usize,
    pub message: String,
}
```

When about to run enabled item at index `i` with `breakpoint && !resuming_this_step`, return pause **without** executing step `i`.

- [ ] **Step 1: Unit tests for pause/continue logic** using `run_sequence_with_opts` mock (no HTTP):

```rust
#[tokio::test]
async fn pauses_before_breakpoint_step() { ... }

#[tokio::test]
async fn continue_executes_breakpoint_step() { ... }
```

- [ ] **Step 2: Implement session + routes**

```rust
.route("/api/labview/run-sequence/continue", post(labview_run_sequence_continue))
.route("/api/labview/run-sequence/abort", post(labview_run_sequence_abort))
```

Add `sequence_session: Arc<SequenceSessionSlot>` to `AppState` construction sites (prod + tests).

- [ ] **Step 3: Run agent sequence + API tests**

```bash
cargo test -p agent --lib
```

- [ ] **Step 4: Commit**

```bash
git add crates/agent/src/sequence_session.rs crates/agent/src/labview_sequence.rs crates/agent/src/api.rs crates/agent/src/lib.rs
git commit -m "feat(agent): breakpoint pause with continue/abort session"
```

---

### Task 7: Agent UI workbench

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/styles.css` (or existing CSS file used by agent)

**UI requirements (spec):**

Table columns: `#` | 启用 | 断点 | ID | 名称 | 类型 | 入参 | Spec | Fail策略 | 结果 | 实测 | 操作

Run bar: optional SN, optional 工单, 开始 / 继续 / 中止, overall + resolved SN.

- [ ] **Step 1: HTML** — expand `<thead>` for seq-selected-table; add run bar inputs/buttons:

```html
<div class="seq-run-bar">
  <label>SN <input id="seq-sn" type="text" placeholder="可选；也可由步骤读入" /></label>
  <label>工单 <input id="seq-work-order" type="text" placeholder="可选" /></label>
  <button id="seq-run-btn" type="button" class="btn-primary">开始</button>
  <button id="seq-continue-btn" type="button" disabled>继续</button>
  <button id="seq-abort-btn" type="button" disabled>中止</button>
  <span id="seq-overall"></span>
</div>
```

Keep left pane purpose unchanged.

- [ ] **Step 2: `saveQueue` payload** include per-item:

```js
{
  vi_template_id: item.vi_template_id,
  enabled: item.enabled !== false,
  breakpoint: !!item.breakpoint,
  fail_policy: item.fail_policy === 'continue' ? 'continue' : 'stop',
  limits: Array.isArray(item.limits) ? item.limits : [],
  note: item.note || ''
}
```

- [ ] **Step 3: `renderSeqSelected`** — checkboxes for enabled/breakpoint; Fail策略 `<select>`; Spec cell shows `未设置` or `n 项` / summary; click opens simple prompt/modal to edit JSON rows (`output`,`min`,`max`,`unit`). Show `kind` column. After run, fill 结果/实测 from last `data.steps` matched by position.

- [ ] **Step 4: `runSequence`** — POST JSON `{ sn, work_order }`; if response has `pause`, enable 继续/中止; on complete update overall + SN display. Wire continue/abort endpoints.

- [ ] **Step 5: Manual smoke** (or note in commit): load page, toggle skip, set one limit, run without SN, confirm no 400.

- [ ] **Step 6: Commit**

```bash
git add crates/agent/static/index.html crates/agent/static/app.js crates/agent/static/styles.css
git commit -m "feat(agent-ui): formal sequence workbench columns and run bar"
```

---

### Task 8: README + spec status

**Files:**
- Modify: `README.md` (sequence / LabVIEW section — brief)
- Modify: `docs/superpowers/specs/2026-07-29-formal-sequence-workbench-design.md` — Status → `approved` / `implemented` when done

- [ ] **Step 1: README note**

- Queue steps store enable, breakpoint, fail_policy, limits
- Run-sequence accepts optional `sn` / `work_order`; steps may emit `SN`/`sn`
- Continue/abort endpoints for breakpoints

- [ ] **Step 2: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-29-formal-sequence-workbench-design.md
git commit -m "docs: document formal sequence workbench behavior"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Limits on sequence step | 2, 3, 7 |
| Judge after each step | 1, 4 |
| Enable/skip | 4, 7 |
| Breakpoint before + continue/abort | 6, 7 |
| Fail default stop; continue policy | 4, 7 |
| Optional SN + step SN resolution | 1, 4, 5, 7 |
| Extend `vi_run_queue_items` | 2 |
| No Spec library / no test_runs | out of scope (honored) |
| MVP order: core then breakpoint | Tasks 1–5 then 6–7 |

**Type consistency:** `ViRunQueueReplaceItem` (store) ↔ `ReplaceViRunQueueItem` (API) ↔ `saveQueue` JS ↔ `QueueItemForRun` (agent). Limits as JSON array in API/`limits`; stored as `limits_json` text.

**Placeholders:** none intentional; Task 7 Spec editor may be a small inline dialog — implement minimal row editor, not a deferred library.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-formal-sequence-workbench.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks

**2. Inline Execution** — execute tasks in this session with checkpoints

Which approach?
