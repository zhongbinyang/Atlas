# Task 3 Report: Shared-pattern shells

## Status

Implemented shared-pattern shell modules in both `frontend/scheduler` and `frontend/agent` with no shared source package.

## Files Added or Updated

- `frontend/scheduler/src/api/client.test.ts`
- `frontend/scheduler/src/api/client.ts`
- `frontend/scheduler/src/components/Chart.tsx`
- `frontend/scheduler/src/components/AppShell.tsx`
- `frontend/scheduler/src/pages/PlaceholderPage.tsx`
- `frontend/scheduler/src/App.tsx`
- `frontend/scheduler/src/main.tsx`
- `frontend/agent/src/api/client.test.ts`
- `frontend/agent/src/api/client.ts`
- `frontend/agent/src/components/Chart.tsx`
- `frontend/agent/src/components/AppShell.tsx`
- `frontend/agent/src/pages/PlaceholderPage.tsx`
- `frontend/agent/src/App.tsx`
- `frontend/agent/src/main.tsx`

## TDD Evidence

### RED

Scheduler:

```text
> atlas-scheduler-ui@0.0.0 test
> vitest run

FAIL  src/api/client.test.ts [ src/api/client.test.ts ]
Error: Failed to load url ./client (resolved id: ./client) in C:/Users/zhong/test05/.worktrees/react-frontend/frontend/scheduler/src/api/client.test.ts. Does the file exist?
Test Files  1 failed (1)
Tests  no tests
```

Agent:

```text
> atlas-agent-ui@0.0.0 test
> vitest run

FAIL  src/api/client.test.ts [ src/api/client.test.ts ]
Error: Failed to load url ./client (resolved id: ./client) in C:/Users/zhong/test05/.worktrees/react-frontend/frontend/agent/src/api/client.test.ts. Does the file exist?
Test Files  1 failed (1)
Tests  no tests
```

### GREEN

Scheduler:

```text
> atlas-scheduler-ui@0.0.0 test
> vitest run

✓ src/api/client.test.ts (2 tests) 4ms
Test Files  1 passed (1)
Tests  2 passed (2)
```

Agent:

```text
> atlas-agent-ui@0.0.0 test
> vitest run

✓ src/api/client.test.ts (2 tests) 5ms
Test Files  1 passed (1)
Tests  2 passed (2)
```

## Implementation Notes

- `apiRequest<T>(path, init?)` and `ApiError` are implemented in both apps with identical shape.
- `apiRequest` reads failure text using `resp.clone().text()` so the brief's test can assert against two calls that reuse the same mocked `Response` instance.
- `Chart` is an ECharts stub that initializes, sets options, resizes on window resize, and disposes on cleanup.
- Scheduler uses `HashRouter` routes `/machines`, `/agents/:id`, `/functions`, `/sequences`, and `/units`, defaulting to `/machines`.
- Agent uses `HashRouter` routes `/vi`, `/general`, `/api`, `/sequence`, and `/settings`, defaulting to `/vi`.
- Both apps use Ant Design `ConfigProvider` with `zh_CN` and import `antd/dist/reset.css`.
- No REST APIs were changed.
- Vanilla static files were not deleted.

## Verification

Scheduler:

```text
> atlas-scheduler-ui@0.0.0 test
✓ src/api/client.test.ts (2 tests) 9ms

> atlas-scheduler-ui@0.0.0 build
✓ built in 2.41s
```

Agent:

```text
> atlas-agent-ui@0.0.0 test
✓ src/api/client.test.ts (2 tests) 5ms

> atlas-agent-ui@0.0.0 build
✓ built in 2.36s
```

## Concerns

- The task brief text is mojibaked; labels were preserved from the brief rather than re-decoded.
- Both builds emit Vite's chunk-size warning because Ant Design and ECharts are bundled into the app entry chunk.
