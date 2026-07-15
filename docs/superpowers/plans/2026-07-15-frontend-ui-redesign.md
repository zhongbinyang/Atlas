# Frontend UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the scheduler and Agent embedded WebUIs around shared industrial design tokens and an Agent-first (机台 / 作业) shell, without changing REST APIs or scheduling behavior.

**Architecture:** Keep Axum `ServeDir` static delivery. Rewrite `crates/*/static/style.css` with identical `:root` tokens; restructure `scheduler/static/index.html` into top-bar tabs + show/hide views; restyle modals and Agent status hero. Extend `app.js` only for view switching, status-dot markup, and offline action disable — all existing fetch/poll endpoints stay the same.

**Tech Stack:** Vanilla HTML/CSS/JS already in tree; optional Google Fonts CDN for IBM Plex Sans; Cargo integration test that asserts token parity between the two CSS files.

**Spec:** `docs/superpowers/specs/2026-07-15-frontend-ui-redesign-design.md`

## Global Constraints

- No Vite/React/Vue; no hash router — JS show/hide only
- No REST / dispatcher / poller / screenshot archive / files proxy changes
- Chinese UI copy; brand strings: 「调度中心」「产线 Agent」
- Tokens (authoritative): `--bg #e8eef3`, `--surface #f4f7fa`, `--panel #ffffff`, `--border #c5d0db`, `--text #1a2332`, `--muted #5a6b7d`, `--accent #0b3d91`, `--ok #1f8a4c`, `--busy #c47a00`, `--err #c0392b`, `--radius 4px`
- Motion only: view fade 120–180ms, status-dot color transition, modal enter; no glow/pulse/counters
- Offline Agent: disable 截图 / 文件 (历史可保留只读列表或一并禁用截图相关——**截图与文件必禁用**；历史按钮 offline 时可禁用)
- Non-txt/gif: still no preview/download buttons (do not regress `renderFiles`)
- Narrow viewport: header wraps; tables `overflow-x: auto`

---

## File Structure

```text
crates/scheduler/static/index.html   # shell: 机台 | 作业 + modals
crates/scheduler/static/style.css    # tokens + components + motion
crates/scheduler/static/app.js       # views, status dots, offline disable
crates/agent/static/index.html       # status hero markup
crates/agent/static/style.css        # same :root tokens + hero
crates/agent/static/app.js           # bind hero metric nodes + busy class
crates/scheduler/tests/static_tokens.rs  # NEW — token parity test
README.md                            # one-line UI note after finish
```

| Path | Responsibility |
|------|----------------|
| `scheduler/static/*` | Center shell, jobs view, polished modals |
| `agent/static/*` | Hero metrics + task table |
| `static_tokens.rs` | Fail CI/local if token blocks diverge |

---

### Task 1: Shared tokens + Cargo parity test

**Files:**
- Modify: `crates/scheduler/static/style.css` (replace `:root`/base; keep modal layout hooks working — full rewrite OK if class names preserved)
- Modify: `crates/agent/static/style.css` (same `:root` block; base body styles)
- Create: `crates/scheduler/tests/static_tokens.rs`
- Test: `cargo test -p scheduler --test static_tokens`

**Interfaces:**
- Consumes: spec §5 token table
- Produces: identical `:root { ... }` in both CSS files; test helper `extract_root_vars(css: &str) -> BTreeMap<String, String>`

- [ ] **Step 1: Write failing token parity test**

Create `crates/scheduler/tests/static_tokens.rs`:

```rust
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn extract_root_vars(css: &str) -> BTreeMap<String, String> {
    let start = css.find(":root").expect("missing :root");
    let rest = &css[start..];
    let open = rest.find('{').expect("missing { after :root");
    let close = rest.find('}').expect("missing } after :root");
    let body = &rest[open + 1..close];
    let mut map = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim().trim_end_matches(';');
        if line.is_empty() || !line.starts_with("--") {
            continue;
        }
        let mut parts = line.splitn(2, ':');
        let key = parts.next().unwrap().trim().to_string();
        let val = parts.next().expect("var value").trim().to_string();
        map.insert(key, val);
    }
    map
}

#[test]
fn scheduler_and_agent_share_design_tokens() {
    let sched = fs::read_to_string(manifest_dir().join("static/style.css")).unwrap();
    let agent_css = fs::read_to_string(
        manifest_dir()
            .join("../agent/static/style.css"),
    )
    .unwrap();
    let a = extract_root_vars(&sched);
    let b = extract_root_vars(&agent_css);
    assert_eq!(a, b, "design tokens must match between scheduler and agent");

    let expected = [
        ("--bg", "#e8eef3"),
        ("--surface", "#f4f7fa"),
        ("--panel", "#ffffff"),
        ("--border", "#c5d0db"),
        ("--text", "#1a2332"),
        ("--muted", "#5a6b7d"),
        ("--accent", "#0b3d91"),
        ("--ok", "#1f8a4c"),
        ("--busy", "#c47a00"),
        ("--err", "#c0392b"),
        ("--radius", "4px"),
    ];
    for (k, v) in expected {
        assert_eq!(a.get(k).map(String::as_str), Some(v), "token {k}");
    }
}
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cargo test -p scheduler --test static_tokens -- --nocapture`

Expected: FAIL (`missing :root` and/or wrong token values).

- [ ] **Step 3: Write token `:root` into both CSS files**

Place this block at the **top** of both `crates/scheduler/static/style.css` and `crates/agent/static/style.css` (after any comments). Keep the rest of each file compiling later tasks; for this step at minimum `:root` + body using vars is enough — you may replace entire files in Task 1 with a complete stylesheet that still styles existing classes (`header`, `section`, `table`, `.modal`, `.btn-sm`, `.status-online`, etc.) so the live UI does not break mid-plan.

Shared `:root` (must be byte-identical in both files):

```css
:root {
  --bg: #e8eef3;
  --surface: #f4f7fa;
  --panel: #ffffff;
  --border: #c5d0db;
  --text: #1a2332;
  --muted: #5a6b7d;
  --accent: #0b3d91;
  --ok: #1f8a4c;
  --busy: #c47a00;
  --err: #c0392b;
  --radius: 4px;
  --font: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-brand: "IBM Plex Sans Condensed", "IBM Plex Sans", "Segoe UI", sans-serif;
  --font-mono: ui-monospace, Consolas, monospace;
}
```

Apply body:

```css
* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  line-height: 1.5;
}
```

Preserve / restyle existing scheduler classes used by `app.js` and HTML (`section`, `table`, `.modal`, `.modal-backdrop`, `.modal-panel`, `.modal-panel-wide`, `.modal-header`, `.modal-body`, `.btn-sm`, `.btn-danger`, `.form-grid`, `.msg`, `.ok`, `.err`, `.empty`, `.status-online`, `.status-offline`, `.status-busy`, `.files-crumb`, `.output-block`, `#shot-img`, etc.) so Task 2 can focus on structure. Agent file similarly keep `#hostname`…`#uptime` styling until Task 5.

Recommended: finish a complete `scheduler` stylesheet in Task 1 that already includes shell/tab/modal/motion rules listed in Tasks 2–4, then copy the exact `:root` into agent and a thinner agent base. The parity test only cares about `:root` vars.

- [ ] **Step 4: Run test — expect PASS**

Run: `cargo test -p scheduler --test static_tokens`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/static/style.css crates/agent/static/style.css crates/scheduler/tests/static_tokens.rs
git commit -m "feat(ui): add shared design tokens and parity test"
```

---

### Task 2: Scheduler shell — 机台 / 作业 views

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css` (tab / view / topbar if not done in Task 1)

**Interfaces:**
- Consumes: existing element ids (`agents-body`, `template-form`, modals, …) — **do not rename ids that `app.js` already binds**
- Produces: `showView(name: 'machines' | 'jobs')`; default `'machines'`; nav buttons `#nav-machines`, `#nav-jobs`; wrappers `#view-machines`, `#view-jobs`

- [ ] **Step 1: Restructure `index.html` shell**

Replace `<body>` content structure (keep all modal blocks and form/field **ids**). Target skeleton:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
...
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <h1 class="brand">调度中心</h1>
      <nav class="view-tabs" aria-label="主分区">
        <button type="button" id="nav-machines" class="tab active" data-view="machines">机台</button>
        <button type="button" id="nav-jobs" class="tab" data-view="jobs">作业</button>
      </nav>
    </div>
    <button id="refresh-btn" type="button" class="btn-primary">刷新</button>
  </header>

  <main class="page">
    <div id="view-machines" class="view view-active">
      <section id="agents-section">
        <h2>机台</h2>
        <!-- existing agents table; tbody#agents-body unchanged -->
      </section>
    </div>

    <div id="view-jobs" class="view" hidden>
      <section id="templates-section">...</section>
      <section id="tasks-section">...</section>
      <section id="task-detail-section" hidden>...</section>
    </div>
  </main>

  <!-- all existing modals unchanged structurally -->
  <script src="/app.js"></script>
</body>
```

Notes:
- Move `#templates-section`, `#tasks-section`, `#task-detail-section` inside `#view-jobs`.
- Keep every `id` currently referenced in `app.js`.

- [ ] **Step 2: Add `showView` + wire tabs in `app.js`**

Near bottom (before `refreshAll` / init), add:

```javascript
function showView(name) {
  const machines = document.getElementById('view-machines');
  const jobs = document.getElementById('view-jobs');
  const navM = document.getElementById('nav-machines');
  const navJ = document.getElementById('nav-jobs');
  const isMachines = name === 'machines';
  machines.hidden = !isMachines;
  jobs.hidden = isMachines;
  machines.classList.toggle('view-active', isMachines);
  jobs.classList.toggle('view-active', !isMachines);
  navM.classList.toggle('active', isMachines);
  navJ.classList.toggle('active', !isMachines);
}

document.getElementById('nav-machines').addEventListener('click', () => showView('machines'));
document.getElementById('nav-jobs').addEventListener('click', () => showView('jobs'));
showView('machines');
```

CSS for fade (if not already):

```css
.view-active {
  animation: view-fade 150ms ease-out;
}
@keyframes view-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.tab.active {
  background: var(--accent);
  color: #fff;
}
.brand {
  font-family: var(--font-brand);
  font-weight: 700;
  color: var(--accent);
  font-size: 1.35rem;
  margin: 0;
}
```

- [ ] **Step 3: Manual smoke**

Run: `cargo run -p scheduler` (separate terminal if agent already running).

Open `http://127.0.0.1:26630/`.

Expected:
- Default view shows Agent table only (not templates).
- Click 「作业」 reveals templates + tasks; 「机台」 returns.
- Refresh still reloads data.

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static/index.html crates/scheduler/static/app.js crates/scheduler/static/style.css
git commit -m "feat(scheduler): Agent-first shell with 机台/作业 tabs"
```

---

### Task 3: Scheduler machine row polish (status dots + offline disable)

**Files:**
- Modify: `crates/scheduler/static/app.js` (`statusClass`, `renderAgents`)
- Modify: `crates/scheduler/static/style.css` (`.status-dot`, `.mono`)

**Interfaces:**
- Consumes: agent DTO fields `status`, `busy`, `id`, `name`, `ip`, `port`, `cpu_percent`, `memory_percent`
- Produces: HTML with `<span class="status-dot status-…">`; buttons `disabled` when `status === 'offline'`

- [ ] **Step 1: Replace `renderAgents` row markup**

Update `renderAgents` in `crates/scheduler/static/app.js` to:

```javascript
function agentStatusKind(a) {
  if (a.status === 'offline') return 'offline';
  if (a.busy) return 'busy';
  return 'ok';
}

function renderAgents() {
  const tbody = document.getElementById('agents-body');
  tbody.innerHTML = '';
  if (agents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无 Agent</td></tr>';
    return;
  }
  for (const a of agents) {
    const row = document.createElement('tr');
    const kind = agentStatusKind(a);
    const label =
      kind === 'offline' ? '离线' : kind === 'busy' ? '在线 · 执行中' : '在线 · 空闲';
    const offline = kind === 'offline';
    const dis = offline ? ' disabled' : '';
    row.innerHTML =
      '<td class="mono">' + escapeHtml(a.name) + '</td>' +
      '<td class="mono">' + escapeHtml(a.ip) + ':' + a.port + '</td>' +
      '<td><span class="status-dot status-' + kind + '"></span>' + label + '</td>' +
      '<td class="mono">' + a.cpu_percent.toFixed(1) + '%</td>' +
      '<td class="mono">' + a.memory_percent.toFixed(1) + '%</td>' +
      '<td>' + (a.busy ? '是' : '否') + '</td>' +
      '<td class="row-actions">' +
        '<button type="button" class="btn-sm btn-shot" data-id="' + escapeHtml(a.id) + '"' + dis + '>截图</button>' +
        '<button type="button" class="btn-sm btn-history" data-id="' + escapeHtml(a.id) + '"' + dis + '>历史</button>' +
        '<button type="button" class="btn-sm btn-files" data-id="' + escapeHtml(a.id) + '"' + dis + '>文件</button>' +
      '</td>';
    if (!offline) {
      row.querySelector('.btn-shot').addEventListener('click', () => takeScreenshot(a.id));
      row.querySelector('.btn-history').addEventListener('click', () => openHistory(a.id));
      row.querySelector('.btn-files').addEventListener('click', () => openFiles(a.id));
    }
    tbody.appendChild(row);
  }
}
```

CSS:

```css
.mono { font-family: var(--font-mono); font-size: 0.85em; }
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
  transition: background-color 160ms ease;
}
.status-dot.status-ok { background: var(--ok); }
.status-dot.status-busy { background: var(--busy); }
.status-dot.status-offline { background: var(--err); }
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
```

Keep `statusClass()` if still used elsewhere; otherwise leave unused or delete only if unused after grep.

- [ ] **Step 2: Smoke offline disable**

With an offline agent (or temporarily force `status: 'offline'` in browser console on a cloned render), confirm 截图/历史/文件 are `disabled`.

Online agent: buttons still open modals; non-txt/gif rows still have no preview/download (open 文件 on a known tree).

- [ ] **Step 3: Commit**

```bash
git add crates/scheduler/static/app.js crates/scheduler/static/style.css
git commit -m "feat(scheduler): status dots and disable actions when offline"
```

---

### Task 4: Modal motion + jobs detail polish

**Files:**
- Modify: `crates/scheduler/static/style.css`
- Modify: `crates/scheduler/static/app.js` only if needed for `showTaskDetail` scroll-into-view

**Interfaces:**
- Consumes: existing `.modal[hidden]` pattern and `openShotModal` / etc.
- Produces: CSS enter animation when `.modal:not([hidden])`; optional `task-detail-section.scrollIntoView({ behavior: 'smooth', block: 'nearest' })` after render

- [ ] **Step 1: Modal animation CSS**

Ensure these rules exist (merge with Task 1 stylesheet):

```css
.modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal[hidden] { display: none !important; }
.modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(26, 35, 50, 0.45);
  animation: fade-in 150ms ease-out;
}
.modal-panel {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-width: min(920px, 94vw);
  max-height: 90vh;
  overflow: auto;
  animation: modal-up 160ms ease-out;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: Task detail stays in jobs view**

In `showTaskDetail` / after `renderTaskDetail`, add:

```javascript
document.getElementById('task-detail-section').hidden = false;
document.getElementById('task-detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
```

(Only if not already un-hiding; match existing function body.)

Verify clicking a task row while on 「作业」 expands detail below without leaving the view.

- [ ] **Step 3: Manual modal smoke**

Open 截图 / 历史 / 文件 / 预览 — panel fades up; backdrop click still closes (existing listeners).

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static/style.css crates/scheduler/static/app.js
git commit -m "feat(scheduler): modal motion and jobs task detail focus"
```

---

### Task 5: Agent status hero

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/style.css`
- Modify: `crates/agent/static/app.js`

**Interfaces:**
- Consumes: `GET /api/status` JSON (`hostname`, `ip`, `cpu_percent`, `memory_percent`, `busy`, `uptime_secs`); `POST /api/register-now`
- Produces: hero elements `#metric-cpu`, `#metric-memory`, `#metric-busy`, plus keep hostname/ip/uptime; `register-btn` in topbar

- [ ] **Step 1: Rewrite Agent `index.html` body**

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
...
<body>
  <header class="topbar">
    <h1 class="brand">产线 Agent</h1>
    <button id="register-btn" type="button" class="btn-primary">重新注册</button>
  </header>

  <main class="page">
    <section id="status-section" class="hero">
      <div class="hero-meta">
        <div>
          <div class="label">主机名</div>
          <div id="hostname" class="mono">—</div>
        </div>
        <div>
          <div class="label">IP</div>
          <div id="ip" class="mono">—</div>
        </div>
        <div>
          <div class="label">运行时间</div>
          <div id="uptime">—</div>
        </div>
      </div>
      <div class="metrics">
        <div class="metric">
          <div class="label">CPU</div>
          <div id="metric-cpu" class="metric-value mono">—</div>
        </div>
        <div class="metric">
          <div class="label">内存</div>
          <div id="metric-memory" class="metric-value mono">—</div>
        </div>
        <div class="metric">
          <div class="label">忙碌</div>
          <div id="metric-busy" class="metric-busy">—</div>
        </div>
      </div>
      <!-- keep hidden nodes if needed for compatibility: optional remove old dl -->
      <p id="register-msg" class="msg" hidden></p>
    </section>

    <section id="tasks-section">
      <h2>近期任务</h2>
      <!-- same table #tasks-body -->
    </section>
  </main>
  <script src="/app.js"></script>
</body>
```

If removing `#cpu` / `#memory` / `#busy`, update `fetchStatus` accordingly (Step 2).

- [ ] **Step 2: Update `fetchStatus` in `app.js`**

```javascript
async function fetchStatus() {
  const resp = await fetch('/api/status');
  if (!resp.ok) return;
  const data = await resp.json();
  document.getElementById('hostname').textContent = data.hostname;
  document.getElementById('ip').textContent = data.ip;
  document.getElementById('metric-cpu').textContent = data.cpu_percent.toFixed(1) + '%';
  document.getElementById('metric-memory').textContent = data.memory_percent.toFixed(1) + '%';
  const busyEl = document.getElementById('metric-busy');
  busyEl.textContent = data.busy ? '● 执行中' : '● 空闲';
  busyEl.className = 'metric-busy ' + (data.busy ? 'is-busy' : 'is-idle');
  document.getElementById('uptime').textContent = formatUptime(data.uptime_secs);
}
```

Agent CSS hero (ensure `:root` still matches Task 1):

```css
.hero-meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 1rem;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}
.metric {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
}
.metric-value {
  font-size: 1.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.label {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.metric-busy.is-idle { color: var(--ok); font-weight: 600; }
.metric-busy.is-busy { color: var(--busy); font-weight: 600; }
.brand { font-family: var(--font-brand); color: var(--accent); }
.btn-primary {
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
}
@media (max-width: 640px) {
  .metrics, .hero-meta { grid-template-columns: 1fr; }
  .topbar { flex-wrap: wrap; gap: 0.75rem; }
}
```

- [ ] **Step 3: Smoke Agent UI**

Run: `cargo run -p agent` → open `http://127.0.0.1:26631/`.

Expected: large CPU/memory; busy color; 重新注册 in topbar; tasks table polls; `cargo test -p scheduler --test static_tokens` still PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/agent/static/index.html crates/agent/static/style.css crates/agent/static/app.js
git commit -m "feat(agent): industrial status hero dashboard"
```

---

### Task 6: Responsive polish, README, acceptance

**Files:**
- Modify: `crates/scheduler/static/style.css` (header wrap, `.table-scroll`)
- Modify: `crates/scheduler/static/index.html` (wrap tables in `<div class="table-scroll">` if needed)
- Modify: `README.md` (one short sentence under WebUI / 功能)

**Interfaces:**
- Consumes: completed UI
- Produces: README note; acceptance checked against spec §9

- [ ] **Step 1: Narrow layout CSS**

```css
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.table-scroll { overflow-x: auto; }
.page { padding: 1rem 1.25rem 2rem; }
@media (max-width: 640px) {
  .view-tabs { width: 100%; }
}
```

Wrap wide tables (agents, tasks, files modal table) with `div.table-scroll` in HTML where horizontal overflow can clip.

- [ ] **Step 2: README one-liner**

In `README.md` near WebUI description, add something equivalent to:

```markdown
WebUI 采用「产线工控清爽」壳层：调度中心默认「机台」视图，「作业」含模板与任务；两端共享同一套 CSS 设计令牌。
```

- [ ] **Step 3: Full acceptance checklist**

Run both services; verify:

1. Center defaults to 机台; brand 「调度中心」 dominant.
2. 作业 has templates + tasks + detail expand.
3. Screenshot / history / files modals work; non-txt/gif no action buttons.
4. Offline agent: 截图/历史/文件 disabled.
5. Agent hero metrics + 重新注册; tasks list updates.
6. `cargo test -p scheduler --test static_tokens` PASS.
7. Resize browser ~375px width: usable (no clipped primary actions).
8. No Rust API files changed in the feature commits (optional sanity: `git diff origin/master -- '*.rs'` should only show `static_tokens.rs` if that is the only Rust add).

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static/style.css crates/scheduler/static/index.html crates/agent/static/style.css README.md
git commit -m "docs: note industrial WebUI shell; polish narrow layout"
```

---

## Self-Review (plan vs spec)

| Spec section | Task |
|--------------|------|
| §3 static tokens both crates | Task 1 |
| §4.1 机台/作业 IA | Task 2 |
| §4.2 Agent hero | Task 5 |
| §5 token values + C keep `#e8eef3` | Task 1 expected list |
| §6 status dots, offline disable, modals, refresh | Tasks 2–4 |
| §7 motion | Tasks 2 + 4 |
| §8 file layout (already split html/css/js) | all tasks |
| §9 acceptance | Task 6 |
| §2 no API / no SPA | Global Constraints |
| README optional after impl | Task 6 |

No intentional placeholders remain. Element ids used by existing handlers are preserved. Token test uses the same key set as the spec table.
