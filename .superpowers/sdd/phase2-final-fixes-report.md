# Phase 2 final review fixes report

Date: 2026-07-30
Branch: `codex/phase1-frontend-reliability`
Starting HEAD: `0fa4e28`
Implementation commit: `212a06f` (`fix(frontend): resolve phase 2 final review findings`)

## Outcome

All five actionable findings in `phase2-final-fixes-brief.md` were implemented
with test-first RED → GREEN cycles. The withdrawn telemetry finding was not
changed. Authentication, HTTP paths/methods/payloads/status codes, General and
Sequence workbench behavior, dependencies, and offline assets were not changed.

## Fix 1 — Scheduler nested dialog focus restoration

### RED

Tests were added before production changes.

- `node --test --test-name-pattern='restores a nested child trigger' crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: after child close the parent was still hidden
    (`true !== false`).
- `node --test --test-name-pattern='reopening the same dialog' crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: the pager button replaced the original external restore
    target.
- `node --test --test-name-pattern='uses its fallback' crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: a disconnected target was focused instead of the
    controller fallback.
- `cargo test -p scheduler --test static_tokens scheduler_static_ui_uses_offline_assets_and_accessible_feedback -- --exact`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: file preview/history did not declare the controller
    parent flow.

During the first whole-file Node run, an existing asynchronous confirm test
did not settle because the enhanced test DOM made controls descendants of a
hidden dialog but did not model the real DOM's `querySelector` lookup for
confirm/cancel controls. The test double was corrected to model those selectors;
no production behavior was changed to accommodate the test double.

### GREEN

- `node --test --test-name-pattern='restores a nested child trigger|reopening the same dialog|uses its fallback' crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 0, 3 passed / 0 failed.
- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - Fix-1 checkpoint: exit 0, 35 passed / 0 failed.
- `cargo test -p scheduler --test static_tokens`
  - Result: exit 0, 4 passed / 0 failed.

### Files

- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/static/app.js`
- `crates/scheduler/tests/dashboard_runtime.test.js`
- `crates/scheduler/tests/static_tokens.rs`

### Result

The controller now keeps a parent stack, suspends rather than closes an explicit
parent, restores the child trigger when resuming the parent, preserves the
root restore target when reopening the same dialog, validates connection,
visibility through ancestors, and enabled state, and uses a stable active-tab
fallback. Screenshot history and file preview now use explicit controller
parents rather than rebuilding their parent dialogs. Escape, Tab/Shift+Tab,
async confirm, replacement cleanup, and one-visible-modal behavior remain
covered by the Scheduler Node suite.

## Fix 2 — Agent VI runtime, stages, and messages

### RED

- `node --test crates/agent/tests/workbench_runtime.test.js`
  - Initial result: exit 1, 8 passed / 2 failed.
  - Expected failures: `ready_to_run` without `runResult` marked Run complete;
    entering a valid Name after a successful Run did not transition to
    `ready_to_register`.
- `node --test --test-name-pattern='inspection unlocks' crates/agent/tests/workbench_runtime.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: a directly registered VI marked optional Run complete.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - Initial result: exit 1, 3 passed / 2 failed.
  - Expected failures: `lvStageMessage` and `lvStageStatusText` did not exist.
- `cargo test -p agent --test static_ui vi_runtime_loads_before_the_application_and_has_mobile_layout_rules -- --exact`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: no visible per-stage status text existed.
- Initial static-text consistency refinement:
  - `node --test --test-name-pattern='visible status text' crates/agent/tests/workbench_app_behavior.test.js`
    returned 0 passed / 1 failed because all five initial labels said
    `待处理`, including the current Path stage.
  - The matching exact Rust test also returned 0 passed / 1 failed.

### GREEN

- `node --test crates/agent/tests/workbench_runtime.test.js`
  - Fix-2 checkpoint: exit 0, 10 passed / 0 failed.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - Fix-2 checkpoint: exit 0, 5 passed / 0 failed.
- `cargo test -p agent --test static_ui`
  - Result: exit 0, 7 passed / 0 failed.
- Initial static-text consistency refinement:
  - Node exact test: exit 0, 1 passed / 0 failed.
  - Rust exact test: exit 0, 1 passed / 0 failed.

### Files

- `crates/agent/static/workbench-runtime.js`
- `crates/agent/static/app.js`
- `crates/agent/static/index.html`
- `crates/agent/static/style.css`
- `crates/agent/tests/workbench_runtime.test.js`
- `crates/agent/tests/workbench_app_behavior.test.js`
- `crates/agent/tests/static_ui.rs`

### Result

Run is current when inspection has succeeded but no run exists. When a valid
Name enables direct registration without a run, Run is visibly `可选`, Naming
is complete, and Register is current. A successful Run without a valid Name
shows Run complete and Naming current. Entering and clearing Name moves
bidirectionally between `ready_to_run` and `ready_to_register` while retaining
the successful `runResult`. Direct Register after Inspect remains allowed and
its registered stage display still marks Run optional. Visible status copy now
distinguishes not run, run awaiting Name, and ready to register, and every stage
shows `当前`, `可选`, `完成`, or `待处理`.

No HTTP fields or payload construction changed.

## Fix 3 — Dynamic parameter accessible names

### RED

- `node --test --test-name-pattern='accessible names' crates/agent/tests/workbench_app_behavior.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: the scalar input had no associated
    `<label for="lv-input-0">speed</label>`; the textarea assertion was reached
    after the same implementation change.

### GREEN

- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - Fix-3 checkpoint: exit 0, 5 passed / 0 failed.

### Files

- `crates/agent/static/app.js`
- `crates/agent/tests/workbench_app_behavior.test.js`

### Result

Each generated input/textarea receives a stable render-index ID and the visible
parameter-name cell contains the matching `<label for>`. Existing `name`,
`data-name`, `data-class`, parsing, and request payload behavior remain intact.
Both scalar input and structured textarea accessible names are asserted.

## Fix 4 — Toast hover/focus pause composition

### RED

- `node --test --test-name-pattern='mouseleave does not resume' crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: mouseleave scheduled a 4000 ms timer while focus remained
    inside the Toast.

### GREEN

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - Result: exit 0, 36 passed / 0 failed.

### Files

- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/tests/dashboard_runtime.test.js`

### Result

Hover and focus are tracked independently. Auto-close is scheduled only when
neither state is active.

## Fix 5 — Request-period input and template-load locking

### RED

- `node --test crates/agent/tests/workbench_runtime.test.js`
  - Result: exit 1, 9 passed / 3 failed.
  - Expected failures: Inspect did not set `inputsDisabled`; re-inspection left
    old parameter rows editable; not every busy action exposed the common input
    lock in the template-load regression loop.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - Result: exit 1, 5 passed / 1 failed.
  - Expected failure: the Center VI load-button synchronizer did not exist.

### GREEN

- `node --test crates/agent/tests/workbench_runtime.test.js`
  - Result: exit 0, 12 passed / 0 failed.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - Result: exit 0, 6 passed / 0 failed.

### Files

- `crates/agent/static/workbench-runtime.js`
- `crates/agent/static/app.js`
- `crates/agent/tests/workbench_runtime.test.js`
- `crates/agent/tests/workbench_app_behavior.test.js`

### Result

`inputsDisabled` now equals the common VI busy condition for Inspect, Run, and
Register. Existing parameter controls and Center VI load buttons synchronize to
that lock. Buttons rendered while busy start disabled, and the load action also
rejects a race with an explicit busy message without changing editor state.

## Final verification

All commands were rerun fresh after the final code change.

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - 36 passed / 0 failed.
- `cargo test -p scheduler --test static_tokens`
  - 4 passed / 0 failed.
- `node --test crates/agent/tests/workbench_runtime.test.js`
  - 12 passed / 0 failed.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - 6 passed / 0 failed.
- `cargo test -p agent --test static_ui`
  - 7 passed / 0 failed.
- `cargo test --workspace`
  - 140 passed / 0 failed across 65 Agent unit, 7 Agent static UI,
    2 Common unit, 62 Scheduler unit, and 4 Scheduler static-token tests;
    doc tests contained 0 tests.
- `node --check crates/scheduler/static/dashboard-runtime.js`
- `node --check crates/scheduler/static/app.js`
- `node --check crates/agent/static/workbench-runtime.js`
- `node --check crates/agent/static/app.js`
  - All four syntax checks exited 0 with no output.
- `git diff --check`
  - Exit 0; only Git's configured LF→CRLF working-copy notices were printed.

## Self-review

- Confirmed the Scheduler telemetry classification implementation was untouched:
  online and busy remain orthogonal as required by the withdrawn finding.
- Confirmed no authentication code, routes, HTTP methods, request/response
  fields, or status codes changed.
- Confirmed the Agent application changes are confined to the VI workbench
  sections; no General or Sequence behavior was changed.
- Confirmed no dependencies, frameworks, or public assets were added.
- Confirmed existing async confirmation, Escape, focus trap, onClose cleanup,
  replacement, refresh, keyed reconciliation, and offline/static UI tests pass.
- Confirmed production changes have direct regression coverage and each new
  behavior test was observed failing for the intended old behavior before its
  implementation.

## Concerns

No known functional blockers or unresolved review findings.

`cargo test --workspace` still prints pre-existing compiler warnings (unused
imports/dead code and one non-snake-case test name). They are outside this
frontend-fix scope and do not affect the 140/140 passing result. Git also prints
the repository's configured LF→CRLF working-copy notices; `git diff --check`
itself exits successfully.

---

# Phase 2 final re-review follow-up

Date: 2026-07-30
Starting HEAD: `37a601c`
Implementation commit: `1b417ec` (`fix(frontend): address phase 2 final re-review`)

The four findings from the final re-review were applied as a single follow-up
wave with independent RED → GREEN evidence. Direct Register after Inspect
remains compatible and no telemetry, HTTP, General, or Sequence behavior was
changed.

## Re-review finding 1 — Invalid child trigger stays in the parent

### RED

- `node --test --test-name-pattern='keeps fallback focus inside|preserves same-dialog pagination' crates/scheduler/tests/dashboard_runtime.test.js`
  - Combined initial result: exit 1, 0 passed / 2 failed.
  - The child-trigger test failed because the configured global fallback was
    focused instead of the first valid control in the restored parent.
  - The same-dialog test failed because reopening immediately focused the first
    control instead of retaining the valid pager focus.
  - The child test loops over disconnected, disabled, and ancestor-hidden
    triggers and failed on the first disconnected case in the old code.

### GREEN

- The same targeted command returned exit 0, 2 passed / 0 failed.

### Files and result

- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/tests/dashboard_runtime.test.js`

When a parent is restored, fallback resolution now checks the parent's first
valid control, then the parent dialog itself, and does not consult a global
fallback while any dialog remains open. The global fallback remains available
only after the root dialog closes.

## Re-review finding 2 — Same-dialog pagination focus

This finding shares the combined RED/GREEN command above.

The controller now retains `document.activeElement` when it is connected,
visible, enabled, and still inside the same dialog. If refreshed content removes
that element (`isConnected === false` in the regression), `focusFirst` runs and
focuses the first valid dialog control. Reopening still preserves the dialog's
original external close target.

## Re-review finding 3 — Failed re-run derives current readiness

### RED

- `node --test --test-name-pattern='failed re-run derives' crates/agent/tests/workbench_runtime.test.js`
  - Result: exit 1, 0 passed / 2 failed.
  - Clearing Name during a re-run restored stale `ready_to_register` instead of
    deriving `ready_to_run`.
  - Filling Name during a re-run restored stale `ready_to_run` instead of
    deriving `ready_to_register`.

### GREEN

- The same targeted command returned exit 0, 2 passed / 0 failed.

### Files and result

- `crates/agent/static/workbench-runtime.js`
- `crates/agent/tests/workbench_runtime.test.js`

For a failed Run with a retained prior `runResult`, `actionFailed('run')` now
derives readiness from the current Name: valid → `ready_to_register`, invalid →
`ready_to_run`. The old successful result is retained. Other failure actions
and a first Run failure without an old result still use their recorded return
state. Direct Register compatibility is unchanged.

## Re-review finding 4 — One live region and change-only text assignment

### RED

- `node --test --test-name-pattern='text synchronization only assigns' crates/agent/tests/workbench_app_behavior.test.js`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: `setTextIfChanged` did not exist.
- `cargo test -p agent --test static_ui vi_workbench_exposes_staged_and_accessible_controls -- --exact`
  - Result: exit 1, 0 passed / 1 failed.
  - Expected failure: both `lv-stage-status` and `lv-action-hint` were polite
    status regions.

### GREEN

- The targeted Node command returned exit 0, 1 passed / 0 failed. Its
  instrumented `textContent` setter recorded zero assignments for unchanged
  text and one assignment for changed text.
- The targeted Rust static command returned exit 0, 1 passed / 0 failed.

### Files and result

- `crates/agent/static/app.js`
- `crates/agent/static/index.html`
- `crates/agent/tests/workbench_app_behavior.test.js`
- `crates/agent/tests/static_ui.rs`

`lv-stage-status` remains the sole polite live region of the pair.
`lv-action-hint` is now an ordinary visible hint. Stage status, action hint, and
per-stage visible status labels use `setTextIfChanged`, so synchronization does
not reassign unchanged visible text.

## Re-review final verification

After the final code/test change, all requested commands were rerun fresh:

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - 38 passed / 0 failed.
- `cargo test -p scheduler --test static_tokens`
  - 4 passed / 0 failed.
- `node --test crates/agent/tests/workbench_runtime.test.js`
  - 14 passed / 0 failed.
- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - 7 passed / 0 failed.
- `cargo test -p agent --test static_ui`
  - 7 passed / 0 failed.
- `node --check crates/scheduler/static/dashboard-runtime.js`
- `node --check crates/scheduler/static/app.js`
- `node --check crates/agent/static/workbench-runtime.js`
- `node --check crates/agent/static/app.js`
  - All four syntax checks exited 0 with no output.
- `git diff --check`
  - Exit 0; only the repository's configured LF→CRLF notices were printed.

An earlier final-verification checkpoint returned Agent static 6 passed /
1 failed because one pre-existing static assertion still required direct
`.textContent =` assignment. That assertion contradicted this re-review's
change-only assignment requirement, so it was updated to assert
`setTextIfChanged`; the complete requested verification was then rerun and
produced the passing counts above.

Per the re-review instruction, `cargo test --workspace` was not rerun in this
follow-up wave; the controller will run it.

## Re-review self-review and concerns

- Scope is limited to the two Dialog focus rules, failed re-run state
  derivation, and VI status announcement behavior.
- Direct Register after Inspect remains covered and unchanged.
- No authentication, routes, methods, payload fields, response fields, status
  codes, telemetry classification, dependencies, General behavior, or Sequence
  behavior changed.
- Existing Escape, Tab/Shift+Tab, async confirm, dialog cleanup, Toast, runtime
  locking, and accessibility tests all remain green.
- No known functional concerns or unresolved re-review findings.
- Pre-existing Rust unused/dead-code warnings and Git LF→CRLF notices remain
  informational only.
