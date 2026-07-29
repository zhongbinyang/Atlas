# ATLAS Frontend Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh scheduler and agent WebUI to ATLAS fiber-instrument branding: shared tokens, Space Grotesk brand mark, status-rail layout on Agent, card/chrome polish on center — without changing APIs or routes.

**Architecture:** Keep Axum-served static HTML/CSS/JS. Sync identical `:root` blocks in both `style.css` files; update `static_tokens.rs` expected hex. Brand chrome + accent rail in both `index.html`. Agent replaces `.hero` with `.status-rail` keeping the same element ids (`hostname`, `ip`, `uptime`, `metric-cpu`, `metric-memory`, `metric-busy`) so `fetchStatus` stays minimal. Center card renderer adds status-kind class for left accent bar.

**Tech Stack:** Existing static WebUI; Google Fonts (Space Grotesk + IBM Plex Sans/Mono); no new crates.

## Global Constraints

- Product name: **ATLAS 光模块测试监控系统**
- Visual: fiber instrument panel — cool steel bg, laser-teal accent `#0a6e7a`, radius `3px`
- No purple / cream-serif / broadsheet defaults; no large glow / rounded-full pills
- Routes unchanged: center `#/machines` `#/agents/{id}` `#/functions`; Agent VI / 序列
- No API changes; distribute remains copy semantics
- Both `:root` maps must stay equal (`crates/scheduler/tests/static_tokens.rs`)
- Chinese UI copy; ATLAS brand must be hero-level in topbar
- Respect `prefers-reduced-motion`
- Spec: `docs/superpowers/specs/2026-07-29-atlas-frontend-refresh-design.md`

---

## File Structure

```text
crates/scheduler/static/index.html   # ATLAS brand chrome + title
crates/scheduler/static/style.css    # tokens, grid bg, topbar rail, cards, status-rail
crates/scheduler/static/app.js       # card status-kind class; status-rail class on detail bar
crates/agent/static/index.html       # ATLAS brand; hero → status-rail (keep ids)
crates/agent/static/style.css        # same :root + agent layout polish (compact file OK)
crates/agent/static/app.js           # only if busy class names need status-rail tweaks
crates/scheduler/tests/static_tokens.rs
README.md                            # ATLAS product name + fiber shell note
```

---

### Task 1: Shared design tokens + font links + static_tokens

**Files:**
- Modify: `crates/scheduler/static/style.css` (`:root` only first)
- Modify: `crates/agent/static/style.css` (`:root` must match byte-for-byte on keys)
- Modify: `crates/scheduler/static/index.html` (font `<link>`)
- Modify: `crates/agent/static/index.html` (font `<link>`)
- Modify: `crates/scheduler/tests/static_tokens.rs`
- Test: `cargo test -p scheduler --test static_tokens`

**Interfaces:**
- Produces identical `:root` keys used by later tasks:
  `--bg #dce4ec`, `--surface #eef3f7`, `--panel #f7fafc`, `--border #b7c4d0`,
  `--text #15202b`, `--muted #5c6b7a`, `--accent #0a6e7a`,
  `--ok #1a7f4b`, `--busy #b86a00`, `--err #b33a2b`, `--radius 3px`,
  `--font`, `--font-brand`, `--font-mono`

- [ ] **Step 1: Update `static_tokens.rs` expected values (fail until CSS matches)**

Replace the `expected` array with:

```rust
    let expected = [
        ("--bg", "#dce4ec"),
        ("--surface", "#eef3f7"),
        ("--panel", "#f7fafc"),
        ("--border", "#b7c4d0"),
        ("--text", "#15202b"),
        ("--muted", "#5c6b7a"),
        ("--accent", "#0a6e7a"),
        ("--ok", "#1a7f4b"),
        ("--busy", "#b86a00"),
        ("--err", "#b33a2b"),
        ("--radius", "3px"),
    ];
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cargo test -p scheduler --test static_tokens`
Expected: FAIL on token value mismatches (or equality with agent if only one side updated)

- [ ] **Step 3: Replace both `:root` blocks**

In **both** `crates/scheduler/static/style.css` and `crates/agent/static/style.css`, set the first `:root { ... }` to exactly:

```css
:root {
  --bg: #dce4ec;
  --surface: #eef3f7;
  --panel: #f7fafc;
  --border: #b7c4d0;
  --text: #15202b;
  --muted: #5c6b7a;
  --accent: #0a6e7a;
  --ok: #1a7f4b;
  --busy: #b86a00;
  --err: #b33a2b;
  --radius: 3px;
  --font: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-brand: "Space Grotesk", "IBM Plex Sans", sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
```

Note: `extract_root_vars` only parses the **first** `:root` block until its first `}`. Do not put nested braces inside `:root`. Extra tokens after these keys are allowed only if added to **both** files and to `expected` (prefer keep the list above only).

- [ ] **Step 4: Update font links in both `index.html`**

Replace the Google Fonts link with:

```html
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 5: Run test — expect PASS**

Run: `cargo test -p scheduler --test static_tokens`
Expected: `scheduler_and_agent_share_design_tokens` PASS

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/static/style.css crates/agent/static/style.css \
  crates/scheduler/static/index.html crates/agent/static/index.html \
  crates/scheduler/tests/static_tokens.rs
git commit -m "style: ATLAS fiber-instrument design tokens"
```

---

### Task 2: Center brand chrome + cards + status-rail styles

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/style.css`
- Modify: `crates/scheduler/static/app.js` (`renderAgents`, `renderAgentDetail`)
- Test: `node --check crates/scheduler/static/app.js`; visual smoke if server up

**Interfaces:**
- Consumes: tokens from Task 1
- Produces:
  - Topbar markup: `.brand-mark` accent rail + `.brand` ATLAS + `.brand-sub`
  - Cards: class `agent-card agent-card-{ok|busy|offline}` for left accent bar
  - Detail bar: `id="agent-detail-status"` with class `status-rail`

- [ ] **Step 1: Rewrite center topbar + title in `index.html`**

```html
  <title>ATLAS — 光模块测试监控</title>
  ...
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <div class="brand-block">
        <h1 class="brand">ATLAS</h1>
        <p class="brand-sub">光模块测试监控</p>
      </div>
      <nav class="view-tabs" aria-label="主分区">
        <button type="button" id="nav-machines" class="tab active" data-route="machines">机台</button>
        <button type="button" id="nav-functions" class="tab" data-route="functions">已注册功能</button>
      </nav>
    </div>
    <button id="refresh-btn" type="button" class="btn-primary">刷新</button>
  </header>
```

Also set `#agent-detail-status` class to `status-rail` in HTML (or set via JS each render — prefer HTML: `class="status-rail"`).

- [ ] **Step 2: Add chrome CSS after `:root` / body**

```css
body {
  background-color: var(--bg);
  background-image:
    linear-gradient(180deg, #e8eef4 0%, var(--bg) 28%),
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 23px,
      rgba(21, 32, 43, 0.035) 23px,
      rgba(21, 32, 43, 0.035) 24px
    ),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 23px,
      rgba(21, 32, 43, 0.035) 23px,
      rgba(21, 32, 43, 0.035) 24px
    );
}

.brand-mark {
  width: 4px;
  height: 2.25rem;
  border-radius: 1px;
  background: var(--accent);
  flex-shrink: 0;
  animation: markPulse 2.4s ease-in-out infinite;
}

@keyframes markPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@media (prefers-reduced-motion: reduce) {
  .brand-mark { animation: none; }
  .view-active { animation: none; }
  .agent-card { transition: none; }
}

.brand-block { display: flex; flex-direction: column; gap: 0.05rem; }
.brand {
  font-family: var(--font-brand);
  font-weight: 700;
  letter-spacing: 0.04em;
  font-size: 1.5rem;
  color: var(--text);
  margin: 0;
  line-height: 1.1;
}
.brand-sub {
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
  font-weight: 500;
}

.agent-card {
  border-left: 3px solid var(--border);
}
.agent-card-ok { border-left-color: var(--ok); }
.agent-card-busy { border-left-color: var(--busy); }
.agent-card-offline { border-left-color: var(--muted); opacity: 0.72; }

.status-rail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
  gap: 0.75rem 1rem;
  padding: 0.85rem 1rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 1rem;
}
.status-rail .label {
  display: block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 0.2rem;
}
```

Update existing `.agent-status-bar` rules to alias or replace with `.status-rail` (remove duplicate if both exist).

Update `.tab.active` / `.btn-primary` to use teal accent (already via `var(--accent)`).

- [ ] **Step 3: Card class + detail rail in `app.js`**

In `renderAgents`:

```javascript
    card.className =
      'agent-card agent-card-' + kind +
      (kind === 'offline' ? ' agent-card-offline' : '');
```

(If `agent-card-offline` is redundant with `agent-card-offline` kind class, keep one: prefer `agent-card-${kind}` only and style `.agent-card-offline` for opacity.)

In `renderAgentDetail`, ensure:

```javascript
  const bar = document.getElementById('agent-detail-status');
  bar.className = 'status-rail';
```

Keep the same innerHTML field structure.

- [ ] **Step 4: Syntax check**

Run: `node --check crates/scheduler/static/app.js`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/static/index.html crates/scheduler/static/style.css crates/scheduler/static/app.js
git commit -m "feat(scheduler-ui): ATLAS brand chrome and instrument cards"
```

---

### Task 3: Agent brand + status-rail layout

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/style.css`
- Modify: `crates/agent/static/app.js` (busy class only if needed)
- Test: `node --check crates/agent/static/app.js`

**Interfaces:**
- Consumes: shared tokens + `.brand-mark` / `.status-rail` patterns from Task 1–2 (duplicate CSS into agent `style.css`; do **not** add a shared file this round)
- Produces: Agent topbar ATLAS; `#status-section` as `.status-rail` with **same ids**:
  `hostname`, `ip`, `uptime`, `metric-cpu`, `metric-memory`, `metric-busy`, `register-msg`

- [ ] **Step 1: Replace Agent header + status HTML**

```html
  <title>ATLAS — 测试机台</title>
  ...
  <header class="topbar">
    <div class="topbar-left">
      <span class="brand-mark" aria-hidden="true"></span>
      <div class="brand-block">
        <h1 class="brand">ATLAS</h1>
        <p class="brand-sub">测试机台</p>
      </div>
      <nav class="page-tabs">
        <button type="button" class="tab active" data-page="workbench">VI</button>
        <button type="button" class="tab" data-page="sequence">序列</button>
      </nav>
    </div>
    <button id="register-btn" type="button" class="btn-primary">重新注册</button>
  </header>

  <main class="page">
    <section id="status-section" class="status-rail">
      <div>
        <span class="label">主机名</span>
        <div id="hostname" class="mono">—</div>
      </div>
      <div>
        <span class="label">IP</span>
        <div id="ip" class="mono">—</div>
      </div>
      <div>
        <span class="label">运行时间</span>
        <div id="uptime">—</div>
      </div>
      <div>
        <span class="label">CPU</span>
        <div id="metric-cpu" class="mono">—</div>
      </div>
      <div>
        <span class="label">内存</span>
        <div id="metric-memory" class="mono">—</div>
      </div>
      <div>
        <span class="label">忙碌</span>
        <div id="metric-busy">—</div>
      </div>
      <p id="register-msg" class="msg status-rail-msg" hidden></p>
    </section>
```

Remove old `.hero` / `.metrics` / `.metric` wrappers. Keep `#tasks-section` and workbench/sequence as-is functionally.

- [ ] **Step 2: Port brand + status-rail CSS into agent `style.css`**

Copy the Task 2 chrome rules (`.brand-mark`, `@keyframes markPulse`, reduced-motion, `.brand-block`, `.brand`, `.brand-sub`, `.status-rail`, `.status-rail .label`, body grid background). Remove or leave unused `.hero` / `.metric` rules (prefer delete dead hero rules to avoid confusion).

Tighten `.lv-config` to a horizontal compact strip if trivial:

```css
.lv-config {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 1.5rem;
  padding: 0.65rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.75rem;
}
```

- [ ] **Step 3: Adjust `fetchStatus` busy classes**

```javascript
  busyEl.className = data.busy ? 'is-busy' : 'is-idle';
```

Ensure CSS still styles `.is-busy` / `.is-idle` under `#metric-busy` (reuse existing color rules; point selectors at `#metric-busy.is-busy` if needed).

- [ ] **Step 4: Syntax check**

Run: `node --check crates/agent/static/app.js`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add crates/agent/static/index.html crates/agent/static/style.css crates/agent/static/app.js
git commit -m "feat(agent-ui): ATLAS brand and compact status rail"
```

---

### Task 4: README + full test sweep + visual checklist

**Files:**
- Modify: `README.md`
- Test: `cargo test -p scheduler -p agent`

**Interfaces:**
- Produces: README product name ATLAS; WebUI shell described as fiber-instrument tokens

- [ ] **Step 1: Update README intro + WebUI shell paragraph**

Title / opening:

```markdown
# ATLAS 光模块测试监控系统

Rust 工作区：**ATLAS 中心**（端口 **26630**）与 Windows **测试机台 Agent**（端口 **26631**）。中心用 SQLite 保存机台、VI 模板与任务，轮询 Agent 状态。两端均提供中文 WebUI 与 REST API。

WebUI 采用「光纤仪表面板」壳层（冷钢灰 + 激光青强调，Space Grotesk 品牌字）：中心 hash 路由 **机台卡片** / **机台详情** / **已注册功能**；Agent 为紧凑状态条 + VI / 序列工作台。两端共享 CSS 设计令牌（`static_tokens` 锁定 `:root`）。
```

Update WebUI 入口 table labels that say「调度中心 WebUI」→「ATLAS 中心 WebUI」where it is product-facing (keep crate names `scheduler` / `agent` in tree section).

- [ ] **Step 2: Full tests**

```bash
cargo test -p scheduler -p agent
```

Expected: all PASS (including `static_tokens`)

- [ ] **Step 3: Manual smoke checklist (record in commit body or report)**

- [ ] Center: ATLAS + 副标 visible; cards have left accent; click → detail status-rail
- [ ] Center: `#/functions` table/filter still works
- [ ] Agent: ATLAS + status-rail; VI register/trial; 序列 page loads
- [ ] `prefers-reduced-motion`: no mark pulse (DevTools emulation optional)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: brand README as ATLAS fiber-instrument UI"
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Shared fiber tokens + fonts | Task 1 |
| ATLAS brand center + accent rail | Task 2 |
| Center cards / detail status-rail | Task 2 |
| Agent ATLAS + status-rail (vs hero) | Task 3 |
| VI/序列 visual polish, no API change | Task 3 |
| static_tokens + README | Task 1, 4 |
| reduced-motion | Task 2–3 |

## Consistency notes

- Keep Agent status **element ids** stable to avoid large `app.js` rewrites.
- Duplicate chrome CSS into agent rather than new shared static file (YAGNI for this plan).
- `extract_root_vars` stops at first `}` in `:root` — keep `:root` flat.

## Self-review (plan author)

1. **Spec coverage:** All success criteria mapped.  
2. **Placeholders:** None.  
3. **IDs:** `hostname` / `metric-*` / `agent-detail-status` consistent across tasks.
