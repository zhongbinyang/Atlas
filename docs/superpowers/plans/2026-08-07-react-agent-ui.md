# React Agent UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agent WebUI with feature-parity React pages under `frontend/agent`, then cut over `crates/agent/static/` to the Vite build.

**Architecture:** Independent from scheduler sources. Hash routes `#/vi|#/general|#/api|#/sequence|#/settings`. Sequence uses page Tabs 编排|运行. Port behavior from `crates/agent/static/app.js` + `workbench-runtime.js` against `docs/api.md`.

**Tech Stack:** Same as foundation.

**Depends on:** Foundation plan complete. Scheduler plan may be in progress or done; do not share code with `frontend/scheduler`.

**Spec:** `docs/superpowers/specs/2026-08-07-react-antd-echarts-frontend-design.md`

## Global Constraints

- No REST API changes
- Chinese UI; ATLAS + 副标「测试机台」
- Ant Design default theme + `zh_CN`
- Topbar: Menu + 机台信息 `Popover` +「重新注册」
- Sequence: single `#/sequence` with Tabs **编排** (default) | **运行**
- Poll `GET /api/status` for machine popover (interval match current app — typically a few seconds; pause when hidden)
- Manual page regression required; no mandatory E2E
- Rewrite/remove `crates/agent/tests/static_ui.rs` vanilla assertions at cutover

---

## File Structure

```text
frontend/agent/src/
  api/types.ts
  api/agentApi.ts
  components/MachineInfoPopover.tsx
  components/AppShell.tsx          # add popover + register
  pages/ViPage.tsx
  pages/GeneralPage.tsx
  pages/RestPage.tsx
  pages/SequencePage.tsx
  pages/sequence/SequenceEditTab.tsx
  pages/sequence/SequenceRunTab.tsx
  pages/SettingsPage.tsx
  App.tsx
crates/agent/static/               # cutover
crates/agent/tests/static_ui.rs    # rewrite
```

---

### Task 1: `agentApi` + shell chrome (status popover, register)

**Files:**
- Create: `frontend/agent/src/api/types.ts`
- Create: `frontend/agent/src/api/agentApi.ts`
- Create: `frontend/agent/src/components/MachineInfoPopover.tsx`
- Modify: `frontend/agent/src/components/AppShell.tsx`
- Create: `frontend/agent/src/api/client.test.ts` if missing from foundation mirror

**Interfaces:**
- Produces `agentApi` methods used by later tasks (add incrementally is OK; define the ones below now):

```ts
export const agentApi = {
  status: () => apiRequest<AgentStatus>('/api/status'),
  registerNow: () => apiRequest<unknown>('/api/register-now', { method: 'POST' }),
  forceRelease: () => apiRequest<unknown>('/api/slot/force-release', { method: 'POST' }),
  labviewConfig: () => apiRequest<LabviewConfig>('/api/labview/config'),
  labviewInspect: (body: unknown) =>
    apiRequest<unknown>('/api/labview/inspect', { method: 'POST', body: JSON.stringify(body) }),
  labviewRun: (body: unknown) =>
    apiRequest<unknown>('/api/labview/run', { method: 'POST', body: JSON.stringify(body) }),
  labviewRegisterTemplate: (body: unknown) =>
    apiRequest<unknown>('/api/labview/register-template', { method: 'POST', body: JSON.stringify(body) }),
  labviewAllTemplates: () => apiRequest<unknown[]>('/api/labview/all-templates'),
  delayRun: (body: unknown) =>
    apiRequest<unknown>('/api/general/delay/run', { method: 'POST', body: JSON.stringify(body) }),
  delayRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/delay/register-template', { method: 'POST', body: JSON.stringify(body) }),
  versionRun: () => apiRequest<unknown>('/api/general/version/run', { method: 'POST' }),
  versionRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/version/register-template', { method: 'POST', body: JSON.stringify(body) }),
  restRun: (body: unknown) =>
    apiRequest<unknown>('/api/general/rest/run', { method: 'POST', body: JSON.stringify(body) }),
  restRegister: (body: unknown) =>
    apiRequest<unknown>('/api/general/rest/register-template', { method: 'POST', body: JSON.stringify(body) }),
  restTemplates: () => apiRequest<unknown[]>('/api/general/rest/templates'),
  generalAllTemplates: () => apiRequest<unknown[]>('/api/general/all-templates'),
  getSettings: () => apiRequest<unknown>('/api/settings'),
  putSettings: (body: unknown) =>
    apiRequest<unknown>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  // confirm method verb against app.js before implementing putSettings
  getUnits: () => apiRequest<unknown>('/api/units'),
  getChannels: () => apiRequest<unknown>('/api/channels'),
  putChannels: (body: unknown) =>
    apiRequest<unknown>('/api/channels', { method: 'PUT', body: JSON.stringify(body) }),
  getRunQueue: () => apiRequest<unknown>('/api/sequence/run-queue'),
  putRunQueue: (body: unknown) =>
    apiRequest<unknown>('/api/sequence/run-queue', { method: 'PUT', body: JSON.stringify(body) }),
  listSequenceTemplates: () => apiRequest<unknown[]>('/api/sequence-templates'),
  saveSequenceTemplate: (body: unknown) =>
    apiRequest<unknown>('/api/sequence-templates', { method: 'POST', body: JSON.stringify(body) }),
  loadSequenceTemplate: (id: string | number) =>
    apiRequest<unknown>(`/api/sequence-templates/${encodeURIComponent(String(id))}/load`, { method: 'POST' }),
  sequenceRun: (body: unknown) =>
    apiRequest<unknown>('/api/sequence/run', { method: 'POST', body: JSON.stringify(body) }),
  sequenceProgress: () => apiRequest<unknown>('/api/sequence/run/progress'),
  sequenceAbort: () => apiRequest<unknown>('/api/sequence/run/abort', { method: 'POST' }),
  sequenceAbortChannel: (index: number) =>
    apiRequest<unknown>(`/api/sequence/run/channels/${index}/abort`, { method: 'POST' }),
};
```

Define `AgentStatus` fields from current status JSON usage in `app.js` (`hostname`, `ip`, `uptime`, cpu/memory/busy fields — copy exact property names from `fetchStatus`).

- [ ] **Step 1: Implement types + `agentApi.ts`** with methods above; fix HTTP verbs by reading the corresponding `fetch` calls in `app.js` (must match).

- [ ] **Step 2: `MachineInfoPopover.tsx`**

- Button/trigger「机台信息」
- Poll `agentApi.status` while open or always at shell level (match current always-on status refresh)
- Show hostname, IP, uptime, CPU, memory, busy
- If busy actions shown in current UI:「强制空闲」→ confirm → `forceRelease`

- [ ] **Step 3: Wire into `AppShell`**

- Right side: `<MachineInfoPopover />` + Button「重新注册」→ `registerNow` → `message.success/error`

- [ ] **Step 4: Manual check on Vite `:5174` with `cargo run -p agent`**

- [ ] **Step 5: Commit**

```bash
git add frontend/agent/src
git commit -m "feat(agent-ui): status popover, register, and API module"
```

---

### Task 2: VI page

**Files:**
- Create: `frontend/agent/src/pages/ViPage.tsx`
- Modify: `frontend/agent/src/App.tsx`

**Behavior source:** `app.js` LabVIEW section (inspect / run / register / all-templates list). Read `docs/api.md` §0.6.

- [ ] **Step 1: Implement `ViPage.tsx`**

Must include:
- Show CLI/getinfo from `labviewConfig` (read-only)
- VI path input; Inspect → editable inputs table (`name`/`className` read-only, `value` editable)
- Run options: 显示前面板, timeout seconds; Run → show outputs
- Register: display name required → `labviewRegisterTemplate`
- Center VI list from `labviewAllTemplates`: search; actions 试跑 / 重命名 / 加载到编辑区 if present in current UI (port exact actions from `app.js`, do not invent)
- Loading flags on inspect/run/register to prevent double submit
- Errors via `message.error` / `ApiError.message`

- [ ] **Step 2: Manual test inspect/run/register against a LabVIEW-capable agent (or mock error paths if LabVIEW absent)**

- [ ] **Step 3: Commit**

```bash
git add frontend/agent/src
git commit -m "feat(agent-ui): VI workbench page"
```

---

### Task 3: General (delay/version) + REST pages

**Files:**
- Create: `frontend/agent/src/pages/GeneralPage.tsx`
- Create: `frontend/agent/src/pages/RestPage.tsx`
- Modify: `frontend/agent/src/App.tsx`

- [ ] **Step 1: `GeneralPage.tsx`**

Port delay + version panels from `app.js`:
- Delay ms input → run → register
- Version run → register
- Center general templates list / actions as currently shown on「通用」page

- [ ] **Step 2: `RestPage.tsx`**

Port REST builder from `app.js`:
- Method, URL, headers, body, timeout, etc. (match current fields)
- Run → `restRun`; Register → `restRegister`
- Templates list via `restTemplates` / `generalAllTemplates` as used today

- [ ] **Step 3: Manual test**

- [ ] **Step 4: Commit**

```bash
git add frontend/agent/src
git commit -m "feat(agent-ui): general delay/version and REST pages"
```

---

### Task 4: Sequence page (edit + run tabs)

**Files:**
- Create: `frontend/agent/src/pages/SequencePage.tsx`
- Create: `frontend/agent/src/pages/sequence/SequenceEditTab.tsx`
- Create: `frontend/agent/src/pages/sequence/SequenceRunTab.tsx`
- Modify: `frontend/agent/src/App.tsx`

**Behavior source:** sequence sections in `app.js` (queue, templates, multi-channel run/progress/abort). Also `docs/api.md` §0.9–0.10 and multi-channel design specs under `docs/superpowers/specs/2026-08-04-*`.

- [ ] **Step 1: `SequencePage.tsx` shell**

```tsx
import { Tabs } from 'antd';
import { SequenceEditTab } from './sequence/SequenceEditTab';
import { SequenceRunTab } from './sequence/SequenceRunTab';

export function SequencePage() {
  return (
    <Tabs
      defaultActiveKey="edit"
      items={[
        { key: 'edit', label: '编排', children: <SequenceEditTab /> },
        { key: 'run', label: '运行', children: <SequenceRunTab /> },
      ]}
    />
  );
}
```

- [ ] **Step 2: `SequenceEditTab.tsx`**

Parity checklist:
- Left: center functions (`labviewAllTemplates` + `generalAllTemplates`) with search/filter
- Right: run queue from `getRunQueue` / local draft
- Add / remove / reorder (up/down; drag-and-drop optional if antd sortable used — up/down buttons minimum to match)
- Persist queue via `putRunQueue` with same payload shape as current `app.js`
- Save as sequence template / load template (`saveSequenceTemplate`, `loadSequenceTemplate`, `listSequenceTemplates`)

- [ ] **Step 3: `SequenceRunTab.tsx`**

Parity checklist:
- Channel cards / controls per current multi-channel UI
- Start run (`sequenceRun`), poll `sequenceProgress`, abort all / abort channel
- Show grouped results/progress consistent with current run page
- Switching to this tab from edit after start may be triggered by run actions (`navigate` not required if Tabs stay mounted — keep both mounted via Tabs default)

- [ ] **Step 4: Manual multi-channel regression** on a configured agent

- [ ] **Step 5: Commit**

```bash
git add frontend/agent/src
git commit -m "feat(agent-ui): sequence edit and run tabs"
```

---

### Task 5: Settings page

**Files:**
- Create: `frontend/agent/src/pages/SettingsPage.tsx`
- Modify: `frontend/agent/src/App.tsx`

**Behavior source:** settings / units / variables / channels / device profiles sections in `app.js` and specs `2026-07-30-agent-settings-units-variables-design.md`, `2026-08-05-multi-channel-station-configuration-design.md`, `2026-08-03-device-cfg-variables-import-design.md`.

- [ ] **Step 1: Implement settings sections present in current「配置」page**

Port all visible sub-panels (do not drop channels or variables). Use antd `Form`, `Table`, `Input`, `Button`. Save via existing agent APIs only.

- [ ] **Step 2: Manual test save/reload**

- [ ] **Step 3: Commit**

```bash
git add frontend/agent/src
git commit -m "feat(agent-ui): settings page"
```

---

### Task 6: Agent cutover + rewrite `static_ui` tests

**Files:**
- Sync via `scripts/build-frontend.ps1` (scheduler should already be React; both sync OK)
- Rewrite: `crates/agent/tests/static_ui.rs`
- Remove reliance on `include_str!` of old `app.js` / `style.css`

- [ ] **Step 1: Build + sync**

```powershell
.\scripts\build-frontend.ps1
```

- [ ] **Step 2: Replace agent static tests**

```rust
#[test]
fn agent_static_serves_vite_index() {
    let index = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("static/index.html"),
    )
    .unwrap();
    assert!(index.contains("root"));
    assert!(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/favicon.svg")
            .is_file()
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/app.js")
            .is_file()
    );
    assert!(
        !std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("static/workbench-runtime.js")
            .is_file()
    );
}
```

Delete obsolete CSS/JS string tests that no longer apply. Keep any pure Rust unit tests in other files untouched.

- [ ] **Step 3: Run**

```powershell
cargo test -p agent --test static_ui
cargo test -p scheduler --test static_tokens
```

- [ ] **Step 4: Manual smoke on `:26631`** — VI/通用/REST/序列/配置 + 重新注册

- [ ] **Step 5: README** — ensure WebUI blurb no longer requires fiber CSS token sync between crates

- [ ] **Step 6: Commit**

```bash
git add frontend/agent crates/agent/static crates/agent/tests README.md
git commit -m "feat(agent-ui): cut over static assets to React build"
```

---

## Agent Done Criteria

1. All Agent hash routes work on Vite and on port 26631 after cutover.
2. Register, VI/general/REST flows, sequence edit/run, settings match prior capabilities.
3. Legacy `app.js` / `style.css` / `workbench-runtime.js` removed from `crates/agent/static`.
4. Agent static tests pass; scheduler static still pass.
5. Spec success criteria in `2026-08-07-react-antd-echarts-frontend-design.md` satisfied.
