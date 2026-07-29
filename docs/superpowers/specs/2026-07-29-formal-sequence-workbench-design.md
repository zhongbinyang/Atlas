# Design: Formal optical-module sequence workbench (phase 1)

Date: 2026-07-29  
Status: draft for user review

## Goal

Upgrade Agent「执行顺序」from a simple ordered template list into a **formal test workbench** suitable for optical-module testing: per-step limits (spec), Pass/Fail after each step, skip, breakpoint-before-step, and a required serial/job number on each run.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| What is “spec” | Numeric limits / Pass·Fail criteria (not a separate product-spec library) |
| When to judge | **After each step** |
| Where limits live | **On the sequence step** (not on the shared function template) |
| Run control | **Edit-time**: enable/skip checkbox + breakpoint (pause **before** that step) |
| Architecture | **Route A**: extend `vi_run_queue_items` (+ run request metadata); defer full Test Run entity |
| Fail default | **Stop** the sequence |
| SN / 工单 | **Required** before start |

## Non-goals (phase 1)

- Independent product Spec library matched by model number
- Runtime debugger (pause/skip mid-step on the fly beyond pre-set breakpoint / continue)
- Full persistent Test Run / batch archive entity (phase 2)
- Operator prompt steps, auto-retry loops, temperature cycling
- Role-based lock of recipes
- CSV/report export UI (API may return enough JSON for a later export)

## Current baseline

- Left: center templates (labview + delay)
- Right: ordered queue persisted via `GET/PUT /api/agents/{id}/vi-run-queue`
- Run: `POST /api/labview/run-sequence` — serial, stop on LabVIEW/CLI error, shared busy slot
- Queue item today: template reference + position only

## Architecture (phase 1)

### Components

1. **Queue step model (center DB + API)** — stores edit-time step options and limits  
2. **Sequence runner (agent)** — executes enabled steps, respects breakpoints, judges limits, applies fail policy  
3. **Workbench UI (agent sequence page)** — workbench table + run bar (SN, start/continue/abort, live status)

### Data flow

```
Edit queue (PUT) → center stores step meta
Operator enters SN → Start
Agent loads queue → for each enabled step:
  if breakpoint before step → wait for Continue
  run template (VI / delay)
  if limits → judge outputs → Pass/Fail/Error
  if Fail/Error and policy=stop → halt
Return step results + overall result (+ SN)
```

## Data model

### Extend `vi_run_queue_items` (or JSON side-car column)

Prefer additive columns (defaults keep old clients working):

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | true | false = skip |
| `breakpoint` | bool | false | pause **before** this step |
| `fail_policy` | text | `stop` | `stop` \| `continue` (phase 1; no `ask` UI yet) |
| `limits_json` | text/json | `[]` | per-step limit rules |
| `note` | text | `''` | optional operator note (optional in UI) |

Existing: `id`, `agent_id`, `vi_template_id`, `position`, `created_at`.

### `limits_json` shape

```json
[
  {
    "output": "Power_dBm",
    "min": -5.0,
    "max": 3.0,
    "unit": "dBm"
  }
]
```

Rules:

- Empty array / missing → **no judgment** (step result = Ok if execution succeeded)
- Value extracted from step `outputs` (or top-level result JSON) by `output` key (dot-path optional later; phase 1 = top-level key only)
- Pass if `min <= value <= max` (inclusive); either bound may be null (= open)
- Missing / non-numeric value → **Error** (not Fail), then apply fail_policy
- Delay steps: typically no limits; allowed but unusual

### API

**Queue list/replace** — include new fields on each item; PUT accepts them. Backward compatible defaults.

**Run sequence** — request body (new; today may be empty POST):

```json
{
  "sn": "SN123456",
  "work_order": null
}
```

- `sn` required (non-empty trim); else 400  
- `work_order` optional string  

Response (extended):

```json
{
  "sn": "...",
  "work_order": null,
  "overall": "pass" | "fail" | "error" | "aborted",
  "stopped": true,
  "failed_at": 2,
  "pause": null,
  "steps": [
    {
      "position": 0,
      "queue_item_id": "...",
      "template_id": 1,
      "name": "Add",
      "status": "pass" | "fail" | "error" | "skipped" | "ok",
      "measured": { "Power_dBm": -1.2 },
      "limits": [ ... ],
      "ok": true,
      "result": { },
      "error": null
    }
  ]
}
```

Notes:

- `status=ok` = executed successfully with **no** limits  
- `skipped` = `enabled=false`  
- Breakpoint pause needs a **session** or **interactive** protocol (see below)

### Breakpoint / continue protocol

Phase 1 options considered:

1. **Long-poll / SSE run session** (heavier)  
2. **Two-phase run with server-held state** (agent keeps run state until continue)  
3. **UI-simulated “run to breakpoint”** by only sending a truncated enabled set — insufficient for true pause-after-partial-run with live continue  

**Chosen:** agent holds an in-memory **run session** while busy:

- `POST /api/labview/run-sequence` starts; may return `202`/`200` with `pause: { before_position, message }` and partial `steps` when hitting a breakpoint  
- `POST /api/labview/run-sequence/continue` resumes same session  
- `POST /api/labview/run-sequence/abort` aborts  
- Session tied to busy slot; releasing slot clears session  
- Only one session per agent  

If implementation cost is too high for first slice, **MVP slice order** is allowed:

1. Queue fields + UI + skip + limits + fail stop + SN (no live breakpoint)  
2. Then breakpoint session  

Spec still requires breakpoint in phase 1 delivery; implementers may land it as the second PR within the same phase.

## UI (Agent 序列 · 执行顺序)

### Table columns

`#` | 启用 | 断点 | ID | 名称 | 类型 | 入参 | Spec | Fail策略 | 结果 | 实测 | 操作  

- **启用**: checkbox  
- **断点**: checkbox (pause before)  
- **Spec**: summary chip / “未设置”; click opens editor for limit rows  
- **Fail策略**: stop/continue (default stop)  
- **结果 / 实测**: filled during/after run  
- **操作**: up / down / remove; optional “运行到此” = set temporary end (disable later steps for one run) or set breakpoint on next — phase 1 can ship as “设断点于下一步” helper  

### Run bar

- SN (required), 工单 (optional)  
- 开始 / 继续 / 中止  
- Overall status + current step highlight  

### Left pane

Unchanged purpose (add templates). No limits on templates.

## Judgment & overall result

- Per step after successful execution: apply limits → Pass/Fail/Error  
- Execution failure (CLI/timeout) → Error, apply fail_policy  
- Skip → Skipped (does not fail overall by itself)  
- Overall:
  - any Fail or Error → `fail` or `error` (if any Error and no Fail → `error`; if any Fail → `fail`)  
  - user abort → `aborted`  
  - else `pass`  

## Testing

- Unit: limit judge (inclusive bounds, missing value → Error, empty limits → ok)  
- Store/API: queue round-trip of new fields; defaults for old payloads  
- Agent: skip steps not executed; fail_policy stop halts; SN required 400  
- Breakpoint: pause then continue completes remaining steps  
- UI smoke: edit limits, toggle skip/breakpoint, run with SN  

## Migration

- New migration altering `vi_run_queue_items` with defaults  
- Idempotent-friendly for existing rows  

## Phase 2 (out of scope now)

- Persistent `test_runs` / history UI on center  
- Product Spec library  
- Operator steps, retry, loops  
- Export reports, golden sample compare  
- `ask` fail policy with modal  

## Open implementation notes (non-blocking)

- Output key mapping assumes LabVIEW runner JSON uses stable names; document for VI authors  
- Multi-limit steps: **all** must Pass; first Fail/Error short-circuits judgment message  
