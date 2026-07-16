# Center UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the scheduler WebUI to an Agent card home, in-center Agent detail, and a registered-functions page (no center VI register form; no Shell jobs UI), while aligning Agent CSS tokens only.

**Architecture:** Keep Axum-served static SPA-style pages. Add hash routing (`#/machines`, `#/agents/{id}`, `#/functions`) in `crates/scheduler/static/app.js`. Strip Shell「作业」and center VI workbench/register from HTML/JS. Reuse existing modals (screenshot, shot history, files, distribute) from Agent detail / functions views. Agent `style.css` stays token-locked with scheduler via `static_tokens` test.

**Tech Stack:** Existing static HTML/CSS/JS; no new frontend framework; Chrome DevTools optional for manual smoke.

## Global Constraints

- No new backend APIs — use existing `/api/agents`, `/api/vi-templates`, screenshot/files/history endpoints
- Hash routes only: `#/` or `#/machines`, `#/agents/{id}`, `#/functions`
- Center UI must not expose Shell templates/tasks or center-side VI register / inspect / trial-run workbench
- Functions page: list + filter + rename + distribute + delete only
- Agent detail: status overview + screenshot / shot-history / files (not VI list)
- Agent WebUI: layout/IA unchanged; `:root` design tokens must continue to match scheduler (`crates/scheduler/tests/static_tokens.rs`)
- Prefer keeping existing token hex values unless both CSS files + `static_tokens` expected list are updated together
- Chinese UI copy; distribute warning「分发后源机将不再持有该模板」unchanged
- Spec: `docs/superpowers/specs/2026-07-16-center-ui-redesign-design.md`

---

## File Structure

```text
crates/scheduler/static/index.html   # Nav + three views + keep modals; remove jobs + VI workbench/register
crates/scheduler/static/app.js       # Hash router; cards; detail; functions; delete jobs/VI-register JS
crates/scheduler/static/style.css    # Card grid, detail layout, motion; token sync
crates/agent/static/style.css        # :root tokens must match scheduler (skin only)
crates/scheduler/tests/static_tokens.rs  # Update expected hex only if tokens change
README.md                            # WebUI IA description + checklist
```

Do **not** split `app.js` into modules unless a task becomes unblockable — existing pattern is one file.

---

### Task 1: HTML shell + hash router (remove jobs / VI workbench)

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Test: manual `node --check crates/scheduler/static/app.js`; open `http://127.0.0.1:26630/#/machines`

**Interfaces:**
- Consumes: existing modal markup ids (`shot-modal`, `shot-history-modal`, `files-modal`, `file-preview-modal`, `vi-distribute-modal`)
- Produces:
  - Nav buttons: `#nav-machines` (`data-route="machines"`), `#nav-functions` (`data-route="functions"`) — **no** jobs/vi tabs
  - Views: `#view-machines`, `#view-agent-detail` (hidden by default), `#view-functions`
  - `function parseRoute(): { name: 'machines'|'agent'|'functions', agentId?: string }`
  - `function applyRoute(route): void` — show/hide views, set tab active, call loaders
  - `window.addEventListener('hashchange', ...)` + initial `applyRoute(parseRoute())`

- [ ] **Step 1: Rewrite topbar + main views in `index.html`**

Replace topbar nav with only 机台 / 已注册功能. Replace `#view-machines` table with:

```html
<div id="view-machines" class="view view-active">
  <section id="agents-section">
    <h2 class="view-title">机台</h2>
    <div id="agents-grid" class="agent-grid" aria-live="polite"></div>
    <p id="agents-empty" class="empty" hidden>暂无机台</p>
  </section>
</div>
```

Add detail view skeleton:

```html
<div id="view-agent-detail" class="view" hidden>
  <section id="agent-detail-section">
    <div class="detail-toolbar">
      <button type="button" id="agent-detail-back" class="btn-sm">返回机台</button>
      <h2 id="agent-detail-name" class="view-title">—</h2>
    </div>
    <div id="agent-detail-status" class="agent-status-bar"></div>
    <div id="agent-detail-actions" class="detail-actions"></div>
    <!-- inline panels optional; modals may remain global -->
  </section>
</div>
```

Move **only** the templates list/filter/table (not VI workbench/register form) into `#view-functions`. Delete entire `#view-jobs` and VI workbench/register markup (`#vi-workbench-section`, `#vi-agent`, `#vi-register-btn`, inputs table for register, etc.). Keep distribute + shot/files modals at bottom.

- [ ] **Step 2: Add router helpers at top of `app.js` (after globals)**

```javascript
function parseRoute() {
  const raw = (location.hash || '#/machines').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'agents' && parts[1]) {
    return { name: 'agent', agentId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'functions') return { name: 'functions' };
  return { name: 'machines' };
}

function setHash(path) {
  const next = '#/' + path.replace(/^\//, '');
  if (location.hash === next) applyRoute(parseRoute());
  else location.hash = next;
}

function showView(id) {
  ['view-machines', 'view-agent-detail', 'view-functions'].forEach((vid) => {
    const el = document.getElementById(vid);
    if (!el) return;
    const on = vid === id;
    el.hidden = !on;
    el.classList.toggle('view-active', on);
  });
  document.getElementById('nav-machines')?.classList.toggle('active', id === 'view-machines' || id === 'view-agent-detail');
  document.getElementById('nav-functions')?.classList.toggle('active', id === 'view-functions');
}
```

Wire `hashchange`, nav clicks (`setHash('machines')` / `setHash('functions')`), `#agent-detail-back` → `setHash('machines')`. Stub `applyRoute` to call `showView` only for now.

- [ ] **Step 3: Delete Shell jobs + center VI register JS**

Remove (or stop referencing) from `app.js`: `templates`, `tasks`, `selectedTaskId`, `fetchTemplates`, `fetchTasks`, `template-form` / `task-form` handlers, `renderTemplates`, `renderTasks`, task detail, all `vi-inspect` / `vi-run` / `vi-register` / `vi-agent` / `defaultViNameFromPath` center-workbench code. Keep: agents fetch, VI templates list/rename/distribute/delete, screenshot/files/history helpers.

Fix any leftover `getElementById` that targets removed nodes (guard or delete).

- [ ] **Step 4: Syntax check**

Run: `node --check crates/scheduler/static/app.js`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/static/index.html crates/scheduler/static/app.js
git commit -m "feat(scheduler-ui): hash shell without jobs or VI register"
```

---

### Task 2: Agent cards + detail view

**Files:**
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css` (card + status bar styles)
- Test: browser smoke on `#/machines` and `#/agents/{id}`

**Interfaces:**
- Consumes: `GET /api/agents` → array of `{ id, name, ip, port, status, cpu_percent, memory_percent, busy, last_seen_at }`
- Produces:
  - `function renderAgents(): void` — fill `#agents-grid` with cards; toggle `#agents-empty`
  - `function renderAgentDetail(agentId: string): void` — fill status + action buttons
  - Card click → `setHash('agents/' + encodeURIComponent(id))`
  - `applyRoute`: machines → `fetchAgents`; agent → ensure agents loaded then `renderAgentDetail`; missing id → `setHash('machines')`

- [ ] **Step 1: Implement card renderer**

```javascript
function renderAgents() {
  const grid = document.getElementById('agents-grid');
  const empty = document.getElementById('agents-empty');
  if (!grid) return;
  grid.innerHTML = '';
  if (!agents.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const a of agents) {
    const kind = agentStatusKind(a);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'agent-card' + (kind === 'offline' ? ' agent-card-offline' : '');
    card.innerHTML =
      '<div class="agent-card-title">' + escapeHtml(a.name) + '</div>' +
      '<div class="agent-card-meta mono">' + escapeHtml(a.ip + ':' + a.port) + '</div>' +
      '<div class="agent-card-status"><span class="dot ' + kind + '"></span>' +
      escapeHtml(statusLabel(a)) + '</div>' +
      '<div class="agent-card-metrics">' +
      '<span>CPU ' + escapeHtml(String(a.cpu_percent.toFixed(1))) + '%</span>' +
      '<span>内存 ' + escapeHtml(String(a.memory_percent.toFixed(1))) + '%</span>' +
      '</div>';
    card.addEventListener('click', () => setHash('agents/' + encodeURIComponent(a.id)));
    grid.appendChild(card);
  }
}

function statusLabel(a) {
  if (a.status === 'offline') return '离线';
  return a.busy ? '在线·忙碌' : '在线·空闲';
}
```

Reuse existing `agentStatusKind` / `dot` CSS classes where possible.

- [ ] **Step 2: Implement detail renderer + actions**

```javascript
function renderAgentDetail(agentId) {
  const a = agents.find((x) => x.id === agentId);
  if (!a) {
    setHash('machines');
    return;
  }
  document.getElementById('agent-detail-name').textContent = a.name;
  const bar = document.getElementById('agent-detail-status');
  const seen = a.last_seen_at ? escapeHtml(a.last_seen_at) : '—';
  bar.innerHTML =
    '<div><span class="label">状态</span><div><span class="dot ' + agentStatusKind(a) + '"></span> ' +
    escapeHtml(statusLabel(a)) + '</div></div>' +
    '<div><span class="label">地址</span><div class="mono">' + escapeHtml(a.ip + ':' + a.port) + '</div></div>' +
    '<div><span class="label">CPU</span><div class="mono">' + escapeHtml(a.cpu_percent.toFixed(1)) + '%</div></div>' +
    '<div><span class="label">内存</span><div class="mono">' + escapeHtml(a.memory_percent.toFixed(1)) + '%</div></div>' +
    '<div><span class="label">忙碌</span><div>' + (a.busy ? '是' : '否') + '</div></div>' +
    '<div><span class="label">最近见面</span><div class="mono">' + seen + '</div></div>';
  const actions = document.getElementById('agent-detail-actions');
  actions.innerHTML =
    '<button type="button" class="btn-primary" id="detail-shot">截图</button>' +
    '<button type="button" class="btn-sm" id="detail-history">历史</button>' +
    '<button type="button" class="btn-sm" id="detail-files">文件</button>';
  document.getElementById('detail-shot').onclick = () => captureScreenshot(a.id);
  document.getElementById('detail-history').onclick = () => openHistory(a.id);
  document.getElementById('detail-files').onclick = () => openFiles(a.id);
}
```

Wire to **existing** `captureScreenshot` / `openHistory` / `openFiles` (keep current function names; rename call sites only if needed). Remove per-row action buttons from old table renderer (already replaced by cards).

- [ ] **Step 3: Finish `applyRoute` + refresh**

```javascript
async function applyRoute(route) {
  if (route.name === 'functions') {
    showView('view-functions');
    await fetchViTemplates();
    return;
  }
  if (route.name === 'agent') {
    showView('view-agent-detail');
    if (!agents.length) await fetchAgents();
    renderAgentDetail(route.agentId);
    return;
  }
  showView('view-machines');
  await fetchAgents();
}

async function refreshCurrent() {
  await applyRoute(parseRoute());
}
```

`#refresh-btn` → `refreshCurrent`. Polling (if any) should refresh agents list without leaving the current route; on agent detail, re-`renderAgentDetail` after `fetchAgents`.

- [ ] **Step 4: CSS for grid/cards/status**

Add to `style.css` (keep `:root` tokens unchanged unless intentionally changing both sides):

```css
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}
.agent-card {
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.agent-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(26, 35, 50, 0.08);
}
.agent-card-offline { opacity: 0.72; }
```

- [ ] **Step 5: Manual smoke**

With scheduler + agent running: open `#/machines`, see cards; click → `#/agents/...`; 返回机台; 截图/历史/文件 still open modals.

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/static/app.js crates/scheduler/static/style.css
git commit -m "feat(scheduler-ui): agent cards and in-center detail"
```

---

### Task 3: Registered functions view (no register form)

**Files:**
- Modify: `crates/scheduler/static/index.html` (ensure `#view-functions` markup)
- Modify: `crates/scheduler/static/app.js`
- Test: browser — filter, rename, distribute, delete

**Interfaces:**
- Consumes: `GET /api/vi-templates?agent_id=`, `PATCH /api/vi-templates/{id}`, `POST .../distribute` with `{ target_agent_id, vi_path? }`, `DELETE /api/vi-templates/{id}`
- Produces: same UX as current templates table, living only under `#view-functions`; **no** create/register POST from center UI

- [ ] **Step 1: Confirm HTML for functions view**

Must include: `#vi-templates-agent-filter`, `#vi-templates-body`, `#vi-templates-msg`, distribute modal. Must **not** include register form fields (`#vi-name`, `#vi-register-btn`, inspect/run on center).

- [ ] **Step 2: Keep list/rename/distribute/delete; remove create path**

Ensure `fetchViTemplates` / `renderViTemplates` / rename / `openDistributeModal` / `submitDistribute` / delete still work. Delete any `POST /api/vi-templates` from center `app.js`. Update empty-state copy if it mentioned registration on center.

- [ ] **Step 3: Smoke**

From `#/functions`: filter by agent; rename; open distribute (radio + warning); cancel/submit against a test template if available.

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static/index.html crates/scheduler/static/app.js
git commit -m "feat(scheduler-ui): registered functions page without center register"
```

---

### Task 4: Token polish, Agent skin, README, test sweep

**Files:**
- Modify: `crates/scheduler/static/style.css`
- Modify: `crates/agent/static/style.css` (only `:root` + shared control tweaks needed for parity)
- Modify: `crates/scheduler/tests/static_tokens.rs` **only if** token values change
- Modify: `README.md`
- Test: `cargo test -p scheduler -p agent`

**Interfaces:**
- Produces: matching `:root` maps; README describes 机台卡片 / Agent 详情 / 已注册功能; checklist no longer requires center「作业」or center VI register

- [ ] **Step 1: Visual polish on center**

Add short view fade (`.view-active { animation: viewIn 0.18s ease; }`), detail toolbar spacing, functions table consistency. Do not introduce purple/cream/broadsheet looks.

- [ ] **Step 2: Sync Agent `:root`**

Copy scheduler `:root` block into agent `style.css` (or edit both identically). Run:

```bash
cargo test -p scheduler --test static_tokens
```

Expected: PASS (`scheduler_and_agent_share_design_tokens`)

If changing hex values, update the `expected` array in `static_tokens.rs` in the same commit.

- [ ] **Step 3: Update README**

Replace WebUI shell paragraph and「WebUI 入口」/ checklist items that mention中心「作业」、中心 VI 登记/试跑/下发. Document:

- 中心：`#/machines` 卡片 → `#/agents/{id}` 详情（截图/历史/文件）；`#/functions` 列表/重命名/分发/删除
- VI **注册**仅在 Agent
- Shell 任务 API 可仍存在，但中心 WebUI 不再提供作业界面

- [ ] **Step 4: Full test**

```bash
cargo test -p scheduler -p agent
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/static/style.css crates/agent/static/style.css crates/scheduler/tests/static_tokens.rs README.md
git commit -m "docs+style: align UI tokens and document center redesign"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Hash SPA; tabs 机台 / 已注册功能 | Task 1 |
| Agent cards home | Task 2 |
| In-center Agent detail (status + 截图/历史/文件) | Task 2 |
| Functions page without register form | Task 3 |
| Remove Shell jobs UI | Task 1 |
| Remove center VI workbench/register | Task 1–3 |
| Shared tokens; Agent skin only | Task 4 |
| README + tests | Task 4 |

## Consistency notes

- 「历史」= existing **截图历史** modal (`openHistory`), not Shell task history.
- Distribute remains **transfer** single-target; response is single `ViTemplateView`.
- Polling: do not navigate away on refresh; re-render current route.
- `static_tokens` locks `:root` equality — treat token edits as cross-crate.

---

## Self-review (plan author)

1. **Spec coverage:** All success criteria mapped to tasks 1–4.  
2. **Placeholders:** Cleared — detail status HTML is fully specified in Task 2.  
3. **Types:** Route shape `{ name, agentId? }` consistent across tasks.
