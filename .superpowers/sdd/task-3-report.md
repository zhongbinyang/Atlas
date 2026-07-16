# Task 3 Report: Registered functions view (no register form)

**Status:** Done  
**Commit:** (see git log) — `feat(scheduler-ui): registered functions page without center register`  
**Worktree:** `C:\Users\zhong\test05\.worktrees\center-ui-redesign`  
**Branch:** `feature/center-ui-redesign`  
**Base:** `f220f50` (Tasks 1–2)

## Audit (Task 3 gates)

| Gate | Result |
|------|--------|
| `#view-functions`: filter + table + msg | Yes (`#vi-templates-agent-filter`, `#vi-templates-body`, `#vi-templates-msg`) |
| No register/inspect/run form on center | Yes — no `#vi-name`, `#vi-register-btn`, workbench markup |
| List / rename / distribute / delete | Yes — `fetchViTemplates`, `renderViTemplates`, `renameViTemplate`, `openDistributeModal`, `submitDistribute`, `deleteViTemplate` |
| No center `POST /api/vi-templates` (create) | Yes — only GET, PATCH, DELETE, and `POST .../distribute` |
| Distribute modal warning + single-target | Yes —「分发后源机将不再持有该模板」; radio `vi-distribute-target` |
| Hash route `#/functions` loads view | Yes — `applyRoute` → `showView('view-functions')` |

## Changes made

### `crates/scheduler/static/app.js`
- **`applyRoute` (functions):** call `fetchAgents()` before `fetchViTemplates()` so agent filter and distribute modal have targets when landing directly on `#/functions`.
- **Empty state:**「暂无 VI 模板」→「暂无已注册功能，请在机台端注册」(clarifies registration is agent-side, not center).

### `crates/scheduler/static/index.html`
- Static table placeholder empty copy aligned with JS empty state.

## Test

```text
node --check crates/scheduler/static/app.js
```
Exit 0.

Browser smoke (`#/functions`: filter, rename, distribute, delete) not run — services not assumed up.

## Self-review

- Task 1 already moved templates into `#view-functions` and removed workbench; this task verified wiring and closed the agents-not-loaded-on-functions gap.
- No leftover references to removed register/workbench DOM ids in `app.js`.
- Distribute POST body unchanged: `{ target_agent_id, vi_path? }`.

## Concerns

1. **Browser smoke deferred** — manually verify filter/rename/distribute/delete when scheduler is up.
2. **Poll on `#/functions`** — refreshes agents + templates each cycle via `applyRoute`; acceptable overhead for fresh distribute targets.
3. **Task 4** — token polish, Agent skin sync, README still pending.
