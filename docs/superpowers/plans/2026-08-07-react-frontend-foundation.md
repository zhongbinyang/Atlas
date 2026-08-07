# React Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold two independent Vite + React + TS + Ant Design + ECharts apps, shared-nothing, with build sync into `crates/*/static/`, Axum SPA fallback, and empty ATLAS shells ready for page migration.

**Architecture:** `frontend/scheduler` and `frontend/agent` are separate npm packages. Dev uses Vite proxy to existing Rust APIs. Production build copies hashed assets into each crate’s `static/`. Vanilla UI stays until later migration plans cut over.

**Tech Stack:** Vite 5, React 18, TypeScript 5, Ant Design 5, echarts 5, react-router-dom 6 (HashRouter), vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-react-antd-echarts-frontend-design.md`

**Follow-up plans (do not implement pages here):**
- `docs/superpowers/plans/2026-08-07-react-scheduler-ui.md`
- `docs/superpowers/plans/2026-08-07-react-agent-ui.md`

## Global Constraints

- Two independent frontends under `frontend/scheduler` and `frontend/agent` — no shared source packages
- Ant Design default theme + `zh_CN`; topbar shows **ATLAS** brand + Chinese subtitle
- ECharts: dependency + thin `Chart` wrapper only; no chart pages in this plan
- Hash routing only; no History mode
- Do not change REST APIs
- Do not run npm from `build.rs`
- Do not delete vanilla `crates/*/static/*` in this plan (cutover is in later plans)
- Chinese UI copy
- Spec path above is authoritative

---

## File Structure

```text
frontend/scheduler/
  package.json
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  index.html
  public/favicon.svg          # copy from crates/scheduler/static/favicon.svg
  src/main.tsx
  src/App.tsx
  src/vite-env.d.ts
  src/api/client.ts
  src/api/client.test.ts
  src/components/Chart.tsx
  src/components/AppShell.tsx
  src/pages/PlaceholderPage.tsx
frontend/agent/               # mirror of scheduler (different title/proxy/port)
scripts/build-frontend.ps1
crates/scheduler/src/web.rs   # SPA not_found → index.html
crates/agent/src/web.rs       # same
README.md                     # frontend dev/build notes
```

---

### Task 1: Scaffold `frontend/scheduler` Vite app

**Files:**
- Create: `frontend/scheduler/package.json`
- Create: `frontend/scheduler/vite.config.ts`
- Create: `frontend/scheduler/tsconfig.json`
- Create: `frontend/scheduler/tsconfig.node.json`
- Create: `frontend/scheduler/index.html`
- Create: `frontend/scheduler/src/vite-env.d.ts`
- Create: `frontend/scheduler/src/main.tsx`
- Create: `frontend/scheduler/public/favicon.svg` (copy bytes from `crates/scheduler/static/favicon.svg`)

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `preview`, `test`
- Produces: Vite proxy `/api` → `http://127.0.0.1:26630`
- Produces: `outDir: dist`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "atlas-scheduler-ui",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "antd": "^5.22.0",
    "echarts": "^5.5.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "~5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Write `vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:26630',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler"
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: Write `index.html` + `src/vite-env.d.ts` + minimal `main.tsx`**

`index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ATLAS — 测试机台编排</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

`src/main.tsx` (temporary until Task 3):

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div>ATLAS scheduler scaffold</div>
  </React.StrictMode>,
);
```

Copy `crates/scheduler/static/favicon.svg` → `frontend/scheduler/public/favicon.svg`.

- [ ] **Step 6: Install and verify build**

Run:

```powershell
cd frontend/scheduler
npm install
npm run build
```

Expected: `dist/index.html` and hashed assets under `dist/assets/`.

- [ ] **Step 7: Commit**

```bash
git add frontend/scheduler
git commit -m "chore: scaffold scheduler Vite React app"
```

---

### Task 2: Scaffold `frontend/agent` Vite app

**Files:**
- Create: mirror of Task 1 under `frontend/agent/` with these differences:
  - `package.json` name: `atlas-agent-ui`
  - Vite `server.port`: `5174`
  - Proxy `/api` → `http://127.0.0.1:26631`
  - `index.html` title: `ATLAS — 测试机台`
  - favicon from `crates/agent/static/favicon.svg`

**Interfaces:**
- Produces: same script surface as scheduler app
- Produces: independent `node_modules` (no workspace)

- [ ] **Step 1: Create the agent tree** by copying scheduler scaffold and applying the differences above (same dependency versions).

- [ ] **Step 2: Install and build**

```powershell
cd frontend/agent
npm install
npm run build
```

Expected: `frontend/agent/dist/index.html` exists.

- [ ] **Step 3: Commit**

```bash
git add frontend/agent
git commit -m "chore: scaffold agent Vite React app"
```

---

### Task 3: Shared-pattern shells — `apiClient`, `Chart`, `AppShell`, HashRouter

Implement **identically shaped** modules in both apps (copy-paste allowed; do not create a shared package). Paths below are for scheduler; repeat under `frontend/agent/` with subtitle `测试机台` and agent menu items from the spec.

**Files (scheduler):**
- Create: `frontend/scheduler/src/api/client.ts`
- Create: `frontend/scheduler/src/api/client.test.ts`
- Create: `frontend/scheduler/src/components/Chart.tsx`
- Create: `frontend/scheduler/src/components/AppShell.tsx`
- Create: `frontend/scheduler/src/pages/PlaceholderPage.tsx`
- Create: `frontend/scheduler/src/App.tsx`
- Modify: `frontend/scheduler/src/main.tsx`
- Mirror all under `frontend/agent/`

**Interfaces:**
- Produces `apiRequest<T>(path, init?): Promise<T>`
- Produces `ApiError` with `status: number` and `message: string`
- Produces `Chart({ option, style? })`
- Produces scheduler routes: `/machines`, `/agents/:id`, `/functions`, `/sequences`, `/units`
- Produces agent routes: `/vi`, `/general`, `/api`, `/sequence`, `/settings`

- [ ] **Step 1: Write failing `client.test.ts` (scheduler)**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, ApiError } from './client';

describe('apiRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns JSON on ok', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(apiRequest<{ ok: boolean }>('/api/health')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError with body text on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(apiRequest('/api/x')).rejects.toMatchObject({
      status: 500,
      message: 'boom',
    });
    await expect(apiRequest('/api/x')).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```powershell
cd frontend/scheduler
npm test
```

Expected: FAIL — cannot resolve `./client` or `ApiError` missing.

- [ ] **Step 3: Implement `client.ts`**

```ts
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!resp.ok) {
    const text = (await resp.text()).trim() || resp.statusText || `HTTP ${resp.status}`;
    throw new ApiError(resp.status, text);
  }
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
```

- [ ] **Step 4: Re-run tests — expect PASS**

```powershell
cd frontend/scheduler
npm test
```

- [ ] **Step 5: Implement `Chart.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

type Props = {
  option: EChartsOption;
  style?: React.CSSProperties;
};

export function Chart({ option, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  return <div ref={ref} style={{ width: '100%', height: 320, ...style }} />;
}
```

- [ ] **Step 6: Implement shell + placeholders + App (scheduler)**

`PlaceholderPage.tsx`:

```tsx
import { Typography } from 'antd';

export function PlaceholderPage({ title }: { title: string }) {
  return <Typography.Title level={3}>{title}</Typography.Title>;
}
```

`AppShell.tsx` (scheduler):

```tsx
import { Layout, Menu, Typography } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Content } = Layout;

const items = [
  { key: '/machines', label: <Link to="/machines">机台</Link> },
  { key: '/functions', label: <Link to="/functions">已注册功能</Link> },
  { key: '/sequences', label: <Link to="/sequences">序列模板</Link> },
  { key: '/units', label: <Link to="/units">单位</Link> },
];

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key ?? '/machines';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{ color: '#fff', cursor: 'pointer', lineHeight: 1.2 }}
          onClick={() => navigate('/machines')}
        >
          <Typography.Text strong style={{ color: '#fff', fontSize: 18 }}>
            ATLAS
          </Typography.Text>
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>测试机台编排</div>
        </div>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={items}
          style={{ flex: 1, minWidth: 0 }}
        />
      </Header>
      <Content style={{ padding: 24 }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
```

`App.tsx` (scheduler):

```tsx
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/machines" element={<PlaceholderPage title="机台" />} />
              <Route path="/agents/:id" element={<PlaceholderPage title="机台详情" />} />
              <Route path="/functions" element={<PlaceholderPage title="已注册功能" />} />
              <Route path="/sequences" element={<PlaceholderPage title="序列模板" />} />
              <Route path="/units" element={<PlaceholderPage title="单位" />} />
              <Route path="*" element={<Navigate to="/machines" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
```

`main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import 'antd/dist/reset.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 7: Agent mirror**

Same `client.ts` / `Chart.tsx` / tests. `AppShell` menu:

- VI → `/vi`
- 通用 → `/general`
- REST → `/api`
- 序列 → `/sequence`
- 配置 → `/settings`

Subtitle: `测试机台`. Right side of header: empty placeholder slots for future Popover + 重新注册 (buttons can be disabled stubs labeled correctly).

`App.tsx` routes for those five paths; default Navigate to `/vi`.

- [ ] **Step 8: Build both apps**

```powershell
cd frontend/scheduler; npm test; npm run build
cd ../agent; npm test; npm run build
```

Expected: tests pass; both `dist/` refresh.

- [ ] **Step 9: Commit**

```bash
git add frontend/scheduler frontend/agent
git commit -m "feat: add Ant Design shells, apiClient, and Chart stub"
```

---

### Task 4: `scripts/build-frontend.ps1` + Axum SPA fallback

**Files:**
- Create: `scripts/build-frontend.ps1`
- Modify: `crates/scheduler/src/web.rs`
- Modify: `crates/agent/src/web.rs`
- Modify: `README.md` (add frontend section; do not remove existing content)

**Interfaces:**
- Produces script that builds both apps and syncs `dist/*` → `crates/*/static/` **only when explicitly run** (migration plans own the final cutover; this plan may sync to verify plumbing once, then restore vanilla OR leave a note that sync is for cutover)
- For this foundation plan: script must work; **do not leave production static replaced** unless you immediately restore from git — prefer verifying sync into a temp folder first, then test sync against static and `git checkout -- crates/*/static` to restore vanilla until migration cutover

**Recommended script behavior:** sync to `crates/*/static` (destructive). Operators run it only at cutover. In this task, run against a dry-run copy first.

- [ ] **Step 1: Write `scripts/build-frontend.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Build-And-Sync([string]$AppName, [string]$CrateName) {
  $app = Join-Path $root "frontend/$AppName"
  $static = Join-Path $root "crates/$CrateName/static"
  Push-Location $app
  try {
    npm run build
  } finally {
    Pop-Location
  }
  $dist = Join-Path $app 'dist'
  if (-not (Test-Path $dist)) { throw "missing dist for $AppName" }

  Get-ChildItem $static -Force | Where-Object {
    $_.Name -ne 'favicon.svg'
  } | Remove-Item -Recurse -Force

  Copy-Item -Path (Join-Path $dist '*') -Destination $static -Recurse -Force

  $favSrc = Join-Path $app 'public/favicon.svg'
  if (Test-Path $favSrc) {
    Copy-Item $favSrc (Join-Path $static 'favicon.svg') -Force
  }
}

Build-And-Sync -AppName 'scheduler' -CrateName 'scheduler'
Build-And-Sync -AppName 'agent' -CrateName 'agent'
Write-Host 'Frontend build synced to crates/*/static'
```

- [ ] **Step 2: Update scheduler `web.rs` SPA fallback**

```rust
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    let index = concat!(env!("CARGO_MANIFEST_DIR"), "/static/index.html");
    Router::new().fallback_service(
        ServeDir::new(dir).not_found_service(ServeFile::new(index)),
    )
}
```

- [ ] **Step 3: Update agent `web.rs` SPA fallback** (keep Cache-Control layer)

```rust
use axum::http::{header, HeaderValue};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

pub fn static_router() -> Router {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    let index = concat!(env!("CARGO_MANIFEST_DIR"), "/static/index.html");
    let no_cache = HeaderValue::from_static("no-cache, must-revalidate");
    Router::new()
        .fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index)))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            no_cache,
        ))
}
```

- [ ] **Step 4: Verify Rust still compiles**

```powershell
cargo check -p scheduler -p agent
```

Expected: success.

- [ ] **Step 5: Dry-run sync safely**

```powershell
# Optional verification without destroying vanilla UI:
Copy-Item -Recurse frontend/scheduler/dist .tmp/scheduler-dist-check
# Confirm index.html present, then remove .tmp check folder
Remove-Item -Recurse -Force .tmp/scheduler-dist-check
```

Do **not** run `build-frontend.ps1` against live `static/` until scheduler/agent migration cutover tasks.

- [ ] **Step 6: README section**

Add after the WebUI paragraph in `README.md`:

```markdown
## 前端开发（React）

源码在 `frontend/scheduler` 与 `frontend/agent`（互相独立，技术栈均为 Vite + React + TypeScript + Ant Design + ECharts）。

```powershell
cd frontend/scheduler
npm install
npm run dev    # http://127.0.0.1:5173 ，代理 /api → 26630

cd frontend/agent
npm install
npm run dev    # http://127.0.0.1:5174 ，代理 /api → 26631
```

发布前构建并同步到 Rust 静态目录：

```powershell
.\scripts\build-frontend.ps1
cargo build -p scheduler
cargo build -p agent
```
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-frontend.ps1 crates/scheduler/src/web.rs crates/agent/src/web.rs README.md
git commit -m "chore: add frontend build script and SPA static fallback"
```

---

## Foundation Done Criteria

1. Both apps `npm test` and `npm run build` succeed.
2. Hash shells show ATLAS + menus with placeholder pages under Vite.
3. `apiRequest` / `Chart` exist in both apps.
4. `scripts/build-frontend.ps1` exists; vanilla `crates/*/static` still present.
5. Axum SPA fallback compiles.
6. Next: execute `2026-08-07-react-scheduler-ui.md`.
