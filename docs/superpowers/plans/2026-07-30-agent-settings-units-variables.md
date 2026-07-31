# Agent Settings (Units & Variables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-agent units + variables on the center; Agent 配置 tab; Spec unit select; `/Var` picker and runtime expand.

**Architecture:** `agent_settings` table + center GET/PUT; Agent proxies `/api/settings` and expands `/Name` before VI/delay/REST/sequence Spec use; UI config page + Spec unit dropdown + slash picker.

**Tech Stack:** Postgres/sqlx, Axum, Agent static HTML/JS, Rust expand helper.

## Global Constraints

- Center storage keyed by `agent_id` (cascade delete with agents).
- Embed `/VarName`; expand at Agent run time only; persist literals with `/Name`.
- `unit` is list select only (no variable expand on unit).
- Variable name: `^[A-Za-z_][A-Za-z0-9_]*$`.

---

### Task 1: Migration + center store/API

**Files:**
- Create: `crates/scheduler/migrations/017_agent_settings.sql`
- Modify: `crates/scheduler/src/db.rs` (include migration)
- Modify: `crates/scheduler/src/store.rs` (get/upsert settings)
- Modify: `crates/scheduler/src/api.rs` (routes + handlers + tests)

```sql
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  units_json TEXT NOT NULL DEFAULT '[]',
  variables_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
```

Store returns `{ units: Vec<String>, variables: Vec<{name,value}> }`; missing row → empty lists. PUT upserts.

Routes: `GET|PUT /api/agents/{id}/settings`

- [ ] Implement + test round-trip / validation 400 / unknown agent 404

---

### Task 2: Agent expand module + `/api/settings` proxy

**Files:**
- Create: `crates/agent/src/expand.rs` — `expand_str`, `expand_json_value`, `ExpandError::Undefined(name)`
- Create helpers in `register.rs` for center GET/PUT settings
- Modify: `api.rs` — `GET|PUT /api/settings`; call expand before delay/rest/vi run and when building sequence step inputs + limit min/max strings

Expand boundary: `/Name` then EOF or non `[A-Za-z0-9_]`.

- [ ] Unit tests for expand
- [ ] Wire proxy + expand into run paths

---

### Task 3: Config page + Spec unit select + `/` picker

**Files:**
- Modify: `index.html`, `app.js`, `style.css`, `static_ui.rs`, `README.md`

- Tab **配置**: units list + variables table + Save
- Spec unit: select from cached settings units + custom
- `attachVarPicker(inputEl)` on value fields

- [ ] static_ui asserts for config tab / settings hooks
- [ ] README note

---

## Spec coverage

| Spec | Task |
|------|------|
| agent_settings table | 1 |
| Center/Agent settings API | 1–2 |
| 配置 tab | 3 |
| Spec unit dropdown | 3 |
| `/` picker | 3 |
| Runtime expand | 2 |

## Execution

Inline in this session after plan save.
