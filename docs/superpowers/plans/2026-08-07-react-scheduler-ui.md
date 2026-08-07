# React Scheduler UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scheduler (center) WebUI with feature-parity React pages under `frontend/scheduler`, then cut over `crates/scheduler/static/` to the Vite build.

**Architecture:** Build on the foundation shells (`AppShell`, `apiRequest`, HashRouter). Port pure telemetry helpers from `dashboard-runtime.js`, then implement Machines / AgentDetail / Functions / Sequences / Units. Cut over static assets and rewrite `static_tokens` tests last.

**Tech Stack:** Same as foundation. Behavior source of truth: current `crates/scheduler/static/app.js` + `dashboard-runtime.js` + `docs/api.md`.

**Depends on:** `docs/superpowers/plans/2026-08-07-react-frontend-foundation.md` completed.

**Spec:** `docs/superpowers/specs/2026-08-07-react-antd-echarts-frontend-design.md`

## Global Constraints

- No REST API changes
- Keep hash routes: `#/machines`, `#/agents/:id`, `#/functions`, `#/sequences`, `#/units`
- Ant Design default + `zh_CN`; ATLAS brand in shell
- Poll machines every **2 seconds** while on machines/detail routes; pause when `document.hidden`
- Chinese copy matching existing labels
- Do not modify `frontend/agent` in this plan
- Cut over scheduler static only after pages pass manual checks

---

## File Structure

```text
frontend/scheduler/src/
  api/types.ts
  api/schedulerApi.ts
  lib/agentTelemetry.ts
  lib/agentTelemetry.test.ts
  pages/MachinesPage.tsx
  pages/AgentDetailPage.tsx
  pages/FunctionsPage.tsx
  pages/SequencesPage.tsx
  pages/UnitsPage.tsx
  App.tsx                          # wire real pages
crates/scheduler/tests/static_ui.rs  # replace vanilla assertions (new file or rewrite static_tokens.rs)
crates/scheduler/tests/static_tokens.rs  # rewrite for React artifacts
crates/scheduler/static/           # cutover target
```

---

### Task 1: Port agent telemetry helpers + scheduler API module

**Files:**
- Create: `frontend/scheduler/src/lib/agentTelemetry.ts`
- Create: `frontend/scheduler/src/lib/agentTelemetry.test.ts`
- Create: `frontend/scheduler/src/api/types.ts`
- Create: `frontend/scheduler/src/api/schedulerApi.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Agent = {
    id: string;
    name: string;
    ip: string;
    port: number;
    status: string;
    busy: boolean;
    cpu_percent: number;
    memory_percent: number;
    last_seen_at: string;
  };
  export type TelemetryFilters = {
    query: string;
    status: 'all' | 'online' | 'busy' | 'offline';
    sort: 'name' | 'status' | 'cpu_desc' | 'memory_desc';
    abnormalOnly: boolean;
  };
  export function agentStatus(agent: Agent): 'offline' | 'busy' | 'online';
  export function getAgentTelemetry(agents: Agent[], filters: TelemetryFilters): {
    summary: { total: number; online: number; busy: number; offline: number };
    visibleAgents: Agent[];
  };
  export function formatAgentHeartbeat(value: string, now?: number | Date): string;
  ```
- Produces `schedulerApi.listAgents(): Promise<Agent[]>` etc.

- [ ] **Step 1: Write failing telemetry tests**

Port filter/sort cases from `getAgentTelemetry` behavior:

```ts
import { describe, expect, it } from 'vitest';
import { getAgentTelemetry, type Agent } from './agentTelemetry';

const agents: Agent[] = [
  { id: '1', name: 'B', ip: '10.0.0.2', port: 26631, status: 'online', busy: true, cpu_percent: 80, memory_percent: 10, last_seen_at: new Date().toISOString() },
  { id: '2', name: 'A', ip: '10.0.0.1', port: 26631, status: 'online', busy: false, cpu_percent: 10, memory_percent: 50, last_seen_at: new Date().toISOString() },
  { id: '3', name: 'C', ip: '10.0.0.3', port: 26631, status: 'offline', busy: false, cpu_percent: 0, memory_percent: 0, last_seen_at: new Date().toISOString() },
];

describe('getAgentTelemetry', () => {
  it('summarizes counts', () => {
    const { summary } = getAgentTelemetry(agents, { query: '', status: 'all', sort: 'name', abnormalOnly: false });
    expect(summary).toEqual({ total: 3, online: 2, busy: 1, offline: 1 });
  });

  it('filters busy and sorts by name', () => {
    const { visibleAgents } = getAgentTelemetry(agents, { query: '', status: 'busy', sort: 'name', abnormalOnly: false });
    expect(visibleAgents.map((a) => a.id)).toEqual(['1']);
  });

  it('status=online includes busy', () => {
    const { visibleAgents } = getAgentTelemetry(agents, { query: '', status: 'online', sort: 'name', abnormalOnly: false });
    expect(visibleAgents.map((a) => a.id).sort()).toEqual(['1', '2']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```powershell
cd frontend/scheduler
npm test
```

- [ ] **Step 3: Implement `agentTelemetry.ts`** by porting `agentStatus`, `getAgentTelemetry`, `formatAgentHeartbeat` from `crates/scheduler/static/dashboard-runtime.js` (lines ~424–486) into TypeScript. Keep algorithm identical.

- [ ] **Step 4: Implement types + `schedulerApi.ts`**

```ts
import { apiRequest } from './client';
import type { Agent } from '../lib/agentTelemetry';

export type ViTemplate = {
  id: number | string;
  name: string;
  kind?: string;
  origin_agent_name?: string;
  vi_path?: string;
  timeout_secs?: number;
  inputs?: unknown;
};

export type GeneralTemplate = {
  id: number | string;
  name: string;
  kind?: string;
  origin_agent_name?: string;
  inputs?: unknown;
};

export type SequenceTemplate = {
  id: number | string;
  name: string;
  // keep extra fields as recorded by GET /api/sequence-templates
  [key: string]: unknown;
};

export type UnitRow = {
  symbol: string;
  description?: string;
  [key: string]: unknown;
};

export const schedulerApi = {
  listAgents: () => apiRequest<Agent[]>('/api/agents'),
  listViTemplates: (agentId?: string) =>
    apiRequest<ViTemplate[]>(
      '/api/vi-templates' + (agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''),
    ),
  listGeneralTemplates: (agentId?: string) =>
    apiRequest<GeneralTemplate[]>(
      '/api/general-templates' + (agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''),
    ),
  deleteViTemplate: (id: string | number) =>
    apiRequest<void>(`/api/vi-templates/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
  deleteGeneralTemplate: (id: string | number) =>
    apiRequest<void>(`/api/general-templates/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
  listSequenceTemplates: () => apiRequest<SequenceTemplate[]>('/api/sequence-templates'),
  deleteSequenceTemplate: (id: string | number) =>
    apiRequest<void>(`/api/sequence-templates/${encodeURIComponent(String(id))}`, { method: 'DELETE' }),
  listUnits: async () => {
    const data = await apiRequest<{ units?: UnitRow[] }>('/api/units');
    return Array.isArray(data.units) ? data.units : [];
  },
  saveUnits: (units: UnitRow[]) =>
    apiRequest<{ units?: UnitRow[] }>('/api/units', {
      method: 'PUT',
      body: JSON.stringify({ units }),
    }),
};
```

Units API shape matches current `app.js`: `GET` returns `{ units: [...] }`; `PUT` body `{ units: [...] }`.

- [ ] **Step 5: Tests PASS + commit**

```powershell
cd frontend/scheduler
npm test
```

```bash
git add frontend/scheduler/src
git commit -m "feat(scheduler-ui): port telemetry helpers and API module"
```

---

### Task 2: Machines page + Agent detail

**Files:**
- Create: `frontend/scheduler/src/pages/MachinesPage.tsx`
- Create: `frontend/scheduler/src/pages/AgentDetailPage.tsx`
- Modify: `frontend/scheduler/src/App.tsx`

**Interfaces:**
- Consumes: `schedulerApi.listAgents`, `getAgentTelemetry`, `formatAgentHeartbeat`
- Produces: navigable cards → `#/agents/:id`; back button → `#/machines`

- [ ] **Step 1: Implement `MachinesPage.tsx`**

Behavior checklist (parity with `app.js`):
- Load agents on mount; poll every 2000ms; stop when `document.hidden`
- Controls: search, status select (`all|online|busy|offline`), sort,「仅异常」checkbox
- Summary strip: 总数 / 在线 / 忙碌 / 离线 + last refresh time + auto-refresh label
- Grid of `Card` (or clickable card buttons): name, `ip:port`, status, CPU%, memory%
- Click → `navigate(`/agents/${id}`)`
- Empty states: 暂无机台 / 没有匹配机台
- Manual refresh via header is optional; page polling is enough (existing top Refresh can be added to `AppShell` calling a context later — for parity add a Refresh button in page toolbar that calls `load()`)

Use `App.useApp().message` for load errors.

- [ ] **Step 2: Implement `AgentDetailPage.tsx`**

- Read `:id` from `useParams`
- Load/poll agents same as machines; find agent by id; if missing → navigate to `/machines`
- Breadcrumb/button「返回机台」
- Descriptions / status rail fields: 状态、地址、CPU、内存、忙碌、最后心跳 (`formatAgentHeartbeat`)
- No screenshot/files UI in current vanilla center app — do not invent

- [ ] **Step 3: Wire routes in `App.tsx`** (replace placeholders)

- [ ] **Step 4: Manual test**

```powershell
# terminal A
cargo run -p scheduler
# terminal B
cd frontend/scheduler; npm run dev
```

Open `http://127.0.0.1:5173/#/machines`, verify poll/filter/detail/back.

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduler/src
git commit -m "feat(scheduler-ui): machines list and agent detail"
```

---

### Task 3: Functions + Sequences + Units pages

**Files:**
- Create: `frontend/scheduler/src/pages/FunctionsPage.tsx`
- Create: `frontend/scheduler/src/pages/SequencesPage.tsx`
- Create: `frontend/scheduler/src/pages/UnitsPage.tsx`
- Modify: `frontend/scheduler/src/App.tsx`

**Interfaces:**
- Consumes: `schedulerApi` delete/list/save methods
- Uses antd `Table`, `Tabs` or two tables, `Modal.confirm`, `Form`/`Input` for units

- [ ] **Step 1: `FunctionsPage.tsx`**

Parity with `renderViTemplates` / delete flows:
- Filters: optional agent_id + source (`labview` / `general` / all) matching current controls in `index.html`
- Load VI + general templates; tag `_source`
- Two sections/tables: VI / 通用
- Columns: ID, 来源, 名称, 类型, 来源机台, 配置摘要, inputs preview, 删除
- Delete → `Modal.confirm` with copy「相关序列队列中的引用也会清除。」→ DELETE endpoint → reload
- REST templates: if current center UI only shows VI+general, keep that; if REST appears under general kinds, show via `kind` column (do not invent a third API if unused)

- [ ] **Step 2: `SequencesPage.tsx`**

- `GET /api/sequence-templates` table
- Delete with confirm → `DELETE /api/sequence-templates/{id}`
- Columns: match current table in `index.html` / `app.js` `renderSequenceTemplates`

- [ ] **Step 3: `UnitsPage.tsx`**

- Load `GET /api/units`
- Editable symbol/description rows (antd Table + Input)
- Save button → same method/body as current `app.js` (`loadCenterUnitsPage` / save handler)
- Success/error via `message`

- [ ] **Step 4: Manual regression** against running scheduler + known DB data

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduler/src
git commit -m "feat(scheduler-ui): functions, sequences, and units pages"
```

---

### Task 4: Scheduler cutover + rewrite static tests + README touch

**Files:**
- Run: `scripts/build-frontend.ps1` (or scheduler-only sync if you temporarily edit script; prefer full script then restore agent static from git if agent not ready)
- Modify: `crates/scheduler/tests/static_tokens.rs` (replace vanilla token/DOM assertions)
- Delete or stop shipping: old `app.js`, `style.css`, `dashboard-runtime.js` via sync script cleanup
- Modify: `README.md` if center WebUI description still claims fiber CSS tokens as runtime

**Important:** If agent React is not cut over yet, either:
1. Temporarily sync only scheduler in the script for this task, **or**
2. Run full script then `git checkout -- crates/agent/static`

- [ ] **Step 1: Sync scheduler dist into `crates/scheduler/static`**

Ensure `index.html` from Vite references `/assets/...` and `favicon.svg` remains.

- [ ] **Step 2: Replace `static_tokens.rs` tests**

Remove shared `:root` token equality with agent CSS (no longer applicable). New tests:

```rust
#[test]
fn scheduler_static_serves_vite_index() {
    let index = fs::read_to_string(manifest_dir().join("static/index.html")).unwrap();
    assert!(index.contains(r#"id="root""#) || index.contains("id=root"));
    assert!(index.contains("/assets/") || index.contains("assets/"));
    assert!(manifest_dir().join("static/favicon.svg").is_file());
}

#[test]
fn scheduler_static_has_no_legacy_app_js() {
    assert!(!manifest_dir().join("static/app.js").is_file());
    assert!(!manifest_dir().join("static/dashboard-runtime.js").is_file());
}
```

Delete obsolete tests that parse `app.js` strings. Keep file name or rename to `static_ui.rs` — update Cargo test discovery accordingly (same `tests/*.rs` auto).

- [ ] **Step 3: Run tests**

```powershell
cargo test -p scheduler --test static_tokens
# or --test static_ui if renamed
cargo check -p scheduler
```

- [ ] **Step 4: Manual check** `http://127.0.0.1:26630/#/machines` via `cargo run -p scheduler`

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/static crates/scheduler/tests README.md scripts/build-frontend.ps1
git commit -m "feat(scheduler-ui): cut over static assets to React build"
```

---

## Scheduler Done Criteria

1. All five center routes work on Vite and on port 26630 after cutover.
2. Polling, filters, deletes, units save match prior behavior.
3. Legacy scheduler `app.js` / `style.css` / `dashboard-runtime.js` gone from `static/`.
4. Scheduler static tests pass.
5. Next: `2026-08-07-react-agent-ui.md`.
