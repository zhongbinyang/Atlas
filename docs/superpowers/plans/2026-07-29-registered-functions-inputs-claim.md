# Registered Functions Inputs + Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show inputs JSON with hover popover on center/agent registered lists; make center functions read-only; let Agent browse all center templates and copy (claim) onto the local station.

**Architecture:** Reuse center `GET /api/vi-templates` and `POST /api/vi-templates/{id}/distribute` (copy semantics). Agent adds thin proxy routes. UI-only changes for inputs column + remove center actions.

**Tech Stack:** Rust (axum/reqwest), static HTML/CSS/JS

## Global Constraints

- Claim = copy; source agent keeps original template.
- Do not remove center distribute/PATCH/DELETE HTTP APIs.
- No auth changes.
- Sequence page left list stays local-only.

---

## File map

| File | Responsibility |
|------|----------------|
| `crates/agent/src/register.rs` | HTTP helpers: list all templates, distribute/claim |
| `crates/agent/src/api.rs` | Routes + tests for all-templates / claim |
| `crates/agent/static/{index.html,app.js,style.css}` | Local + center-all tables, inputs popover, claim button |
| `crates/scheduler/static/{index.html,app.js,style.css}` | Read-only functions table + inputs popover |
| `README.md` | Brief note on center read-only + Agent claim |

---

### Task 1: Agent proxy APIs (all-templates + claim)

**Files:**
- Modify: `crates/agent/src/register.rs`
- Modify: `crates/agent/src/api.rs`

- [ ] **Step 1: Failing tests** in `api.rs` tests module:
  - `all_templates_proxies_center_list` — mock center `GET /api/vi-templates` returns array; Agent `GET /api/labview/all-templates` returns same.
  - `claim_posts_distribute_with_local_agent_id` — mock center agents list + distribute; Agent `POST /api/labview/templates/{id}/claim` sends `{ target_agent_id: <local> }`.

- [ ] **Step 2: Run tests — expect fail**

- [ ] **Step 3: Implement** `list_all_vi_templates` and `distribute_vi_template` in `register.rs`; wire routes in `api.rs` using `resolve_agent_id_for_proxy`.

- [ ] **Step 4: Run tests — expect pass**

- [ ] **Step 5: Commit** `feat(agent): proxy all-templates and claim copy APIs`

---

### Task 2: Shared inputs-cell UI helpers (Agent + Center static)

**Files:**
- Modify: `crates/agent/static/{app.js,style.css,index.html}`
- Modify: `crates/scheduler/static/{app.js,style.css,index.html}`

- [ ] **Step 1:** Add CSS `.inputs-cell`, `.inputs-summary`, `.inputs-popover` (fixed/absolute, max-height 40vh, overflow auto, mono pre).

- [ ] **Step 2:** JS helpers `formatInputsSummary`, `formatInputsPretty`, `attachInputsHover(cell, inputs)`.

- [ ] **Step 3:** Center `#/functions` + Agent local registered table: add 入参 column; update colspan empty rows.

- [ ] **Step 4:** Manual smoke or quick DOM check via existing pages if running.

- [ ] **Step 5: Commit** `feat(ui): show registered inputs with hover popover`

---

### Task 3: Center functions read-only

**Files:**
- Modify: `crates/scheduler/static/{index.html,app.js}`
- Optionally leave distribute modal HTML unused or remove dead modal code if only used by functions.

- [ ] **Step 1:** Remove 操作 column from thead/tbody render; delete rename/distribute/delete button handlers from `renderViTemplates`.

- [ ] **Step 2:** Remove or leave unused distribute modal wiring if nothing else opens it — clean up dead listeners.

- [ ] **Step 3: Commit** `fix(scheduler-ui): make functions view read-only`

---

### Task 4: Agent center-all section + claim button

**Files:**
- Modify: `crates/agent/static/{index.html,app.js,style.css}`

- [ ] **Step 1:** HTML section「中心全部功能」with table columns: 名称、当前机台、来源、VI 路径、入参、操作.

- [ ] **Step 2:** `fetchAllCenterTemplates` + `renderAllCenterTemplates(localId, templates)`:
  - if `t.agent_id === localId` → text「已在本机」
  - else → button「加到本机」→ `POST /api/labview/templates/{id}/claim` → refresh both lists

- [ ] **Step 3:** Resolve local agent id: from registered list items' `agent_id`, or add lightweight `/api/...` if needed. Prefer: after fetch local templates, use first item's `agent_id`; if empty local list, fetch `all-templates` and match by hostname from status — simplest path: Agent already knows identity via register; expose `GET /api/labview/self` only if required. **Preferred:** claim endpoint uses server-side agent id; UI compares `t.agent_id` to `agent_id` field on any local template OR fetch all and also `GET /api/status` — check existing status payload for id.

- [ ] **Step 4:** If no local agent id in UI, add `GET /api/labview/agent-id` that returns `{ agent_id }` from `resolve_agent_id_for_proxy` (small addition under Task 1 if needed).

- [ ] **Step 5: Commit** `feat(agent-ui): browse center templates and claim copies`

---

### Task 5: README + verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Document center read-only functions; Agent claim-from-center; inputs hover.

- [ ] **Step 2:** `cargo test -p agent -p scheduler`

- [ ] **Step 3: Commit** `docs: note functions read-only and agent claim`

---

## Manual acceptance

1. Register VI with inputs → both UIs show summary + hover JSON.  
2. Center functions: no action buttons.  
3. Agent center-all: claim copy → new local id; source still listed on center under original agent.  
4. Already-local rows show「已在本机」.
