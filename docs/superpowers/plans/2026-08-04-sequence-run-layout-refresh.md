# Sequence Run Layout Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the Agent sequence-run page into an operator-first layout and remove SN/work-order controls from the current frontend.

**Architecture:** Keep the existing vanilla HTML/CSS/JavaScript and multi-channel APIs. Add presentation-only DOM structure and small rendering helpers; the server request model remains backward compatible while this WebUI stops sending SN/work-order fields.

**Tech Stack:** Rust static-contract tests, vanilla HTML, CSS, JavaScript, Cargo.

## Global Constraints

- Modify only Agent sequence-run UI files, its static-contract test, and related documentation.
- Preserve the untracked screenshot and unrelated worktree contents.
- Keep `POST /api/sequence/run` compatible; do not remove backend SN/work-order fields.
- Preserve matrix cell navigation, channel tabs, abort, multi-channel selection, and raw JSON details.
- Use existing CSS tokens and no external dependencies.

---

### Task 1: Lock the operator-first layout contract

**Files:**
- Modify: `crates/agent/tests/static_ui.rs`
- Test: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: static `INDEX`, `STYLE`, and `APP` strings.
- Produces: regression contract `sequence_run_page_uses_operator_first_layout`.

- [x] **Step 1: Write the failing static UI test**

Add assertions that `seq-sn` and `seq-work-order` are absent, the JavaScript does not build `payload.sn` or `payload.work_order`, and the new DOM exposes `seq-run-status-card`, `seq-run-meta`, `seq-run-report-open`, `seq-run-bar-selection`, and `seq-run-bar-actions`. Assert CSS provides sticky matrix edge columns and a responsive grouped run bar.

- [x] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p agent --test static_ui sequence_run_page_uses_operator_first_layout -- --nocapture`
Expected: FAIL because the current page still contains SN/work-order and lacks the new layout elements.

- [x] **Step 3: Keep the failing test unchanged for Task 2**

The production change that makes it pass must be removal of the old controls/payload wiring and addition of the new layout contract.

---

### Task 2: Implement summary, matrix, report, and run-bar layout

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/style.css`
- Modify: `crates/agent/static/app.js`
- Test: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: `seqSelected`, `seqChannelProgress`, `seqActiveTemplateId`, existing run/progress APIs.
- Produces: `formatSequenceOverall(overall) -> string`, `findFirstSequenceIssue() -> {channel_index, position}|null`, `syncSeqRunSummary(data)`, and `setSeqReportVisibilityForResult(data)`.

- [x] **Step 1: Replace the run-page HTML structure**

Create a `seq-run-status-card` containing a prominent status label, `seq-run-meta`, queue/template summary, and a hidden `seq-run-report-open` button. Keep matrix and report IDs unchanged. Replace SN/work-order labels with grouped `seq-run-bar-selection` and `seq-run-bar-actions` wrappers around channel selection, overall status, start, and abort.

- [x] **Step 2: Add the minimal layout CSS**

Style the compact summary card, reduce nested report borders, constrain/truncate matrix headers, make first and last matrix columns sticky, assign practical report column widths, and make the grouped fixed bar wrap safely. Remove obsolete SN/work-order input rules and update the mobile breakpoint for the new wrappers.

- [x] **Step 3: Add status and report-visibility helpers**

Map raw overall values to Chinese labels, update both summary and bottom status, prefix matrix headings with two-digit step numbers, and localize matrix/report overall text. Keep the report closed during progress and after all-pass results; expose the open-report button. For fail/error/aborted results, select the first issue and open the report.

- [x] **Step 4: Remove frontend SN/work-order wiring**

Delete control disabling, response-to-input synchronization, and request payload construction for `sn` and `work_order`. Continue sending `sequence_template_id` and `channel_indexes` exactly as before.

- [x] **Step 5: Run the focused static test and verify GREEN**

Run: `cargo test -p agent --test static_ui sequence_run_page_uses_operator_first_layout -- --nocapture`
Expected: PASS.

- [x] **Step 6: Run Agent frontend regression tests**

Run: `cargo test -p agent --test static_ui`
Expected: 13 tests pass, including mobile layout assertions updated for the new run bar.

Run: `node --test crates/agent/tests/workbench_runtime.test.js crates/agent/tests/workbench_app_behavior.test.js`
Expected: all JavaScript tests pass.

- [x] **Step 7: Run the full Agent test suite**

Run: `cargo test -p agent`
Expected: all Agent tests pass; existing compiler warnings may remain but no test failures.

---

## Self-review

- Spec coverage: SN/work-order removal, summary hierarchy, matrix layout, conditional report visibility, and run-bar grouping are covered.
- Placeholder scan: no TBD/TODO or deferred core behavior.
- Interface consistency: all existing API/DOM IDs needed by execution remain; only `seq-sn` and `seq-work-order` are intentionally removed.
