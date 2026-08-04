# Sequence Run Grouped Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show persisted sequence groups as visually distinct, state-aware sections in every channel detail screen while retaining step timing, original order, and polling stability.

**Architecture:** Keep the backend execution/result schema unchanged. Extend the frontend detail projection to join the complete queue—including `template_source: "group"` headers—with result-backed step rows, then render native disclosure sections whose group state is derived from their member steps. Preserve group and step disclosure state across the existing 250 ms rerender loop.

**Tech Stack:** Static browser JavaScript, HTML/CSS, Node `node:test`, Rust static UI tests.

## Global Constraints

- Group membership is implicit: a group owns following steps until the next group header.
- Group headers never count as executable steps and never receive artificial step results or timing.
- The synthetic `未分组步骤` section is rendered only when root-level steps exist and is not counted as a named group.
- Group aggregate state follows the approved `disabled / running / fail / pass / skipped / pending` rules.
- Active and failed groups force open; otherwise persisted `collapsed` supplies the initial state and user disclosure changes survive polling.
- No backend schema, endpoint, queue mutation, nested groups, or group-level timing changes.

---

### Task 1: Project the complete queue into grouped detail sections

**Files:**
- Modify: `crates/agent/static/app.js` near `buildSequenceChannelDetailModel`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Produces: `buildSequenceDetailSections(queue, detailSteps) -> Array<SequenceDetailSection>`.
- Produces: `buildSequenceGroupSummary(section) -> { state, completed, total, passed, failed, skipped, open }`.
- Extends: `buildSequenceChannelDetailModel(channel, queue)` with `sections` and `namedGroupCount` while retaining its flat `steps` list.
- Consumes later: Task 2 renders `model.sections` and each section's `summary`.

- [ ] **Step 1: Add a failing original-order group projection test**

```javascript
test('channel detail projects persisted groups without counting headers as steps', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceDetailSections'), context);

  const sections = context.buildSequenceDetailSections([
    { position: 0, name: 'Root' },
    { position: 1, template_source: 'group', name: '校准', note: '连接仪表', enabled: true, collapsed: true },
    { position: 2, name: 'Zero' },
    { position: 3, name: 'Measure' },
    { position: 4, template_source: 'group', name: '收尾', enabled: false, collapsed: false },
    { position: 5, name: 'Reset' },
  ], [
    { position: 0, name: 'Root', status: 'pending' },
    { position: 2, name: 'Zero', status: 'pass' },
    { position: 3, name: 'Measure', status: 'running' },
    { position: 5, name: 'Reset', status: 'skipped' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(sections.map((section) => ({
    kind: section.kind,
    title: section.title,
    positions: section.steps.map((step) => step.position),
  })))), [
    { kind: 'ungrouped', title: '未分组步骤', positions: [0] },
    { kind: 'group', title: '校准', positions: [2, 3] },
    { kind: 'group', title: '收尾', positions: [5] },
  ]);
});
```

- [ ] **Step 2: Run the focused Node test and verify RED**

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: FAIL with `missing buildSequenceDetailSections in app.js`.

- [ ] **Step 3: Implement the minimal ordered section projection**

Add a pure helper that creates an ungrouped section on demand, creates a new named section for every group header (including empty groups), and attaches only non-group detail steps by persisted position:

```javascript
function buildSequenceDetailSections(queue, detailSteps) {
  const stepByPosition = {};
  (detailSteps || []).forEach(function (step) { stepByPosition[step.position] = step; });
  const sections = [];
  let current = null;
  (queue || []).forEach(function (item, index) {
    const position = item && item.position != null ? item.position : index;
    if (item && item.template_source === 'group') {
      current = {
        key: 'group-' + position,
        kind: 'group',
        title: item.name || '未命名组',
        note: item.note || '',
        enabled: item.enabled !== false,
        collapsed: !!item.collapsed,
        steps: [],
      };
      sections.push(current);
      return;
    }
    if (!current) {
      current = { key: 'ungrouped', kind: 'ungrouped', title: '未分组步骤', enabled: true, collapsed: false, steps: [] };
      sections.push(current);
    }
    if (stepByPosition[position]) current.steps.push(stepByPosition[position]);
  });
  return sections;
}
```

- [ ] **Step 4: Add failing aggregate-state tests**

Test disabled, running, failed, complete-pass, all-skipped, and incomplete groups with literal expectations:

```javascript
const context = {};
vm.createContext(context);
vm.runInContext(functionSource('buildSequenceGroupSummary'), context);
const summary = context.buildSequenceGroupSummary;

assert.equal(summary({ enabled: false, steps: [{ status: 'skipped' }] }).state, 'disabled');
assert.equal(summary({ enabled: true, collapsed: true, steps: [{ status: 'running' }] }).state, 'running');
assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'error' }] }).state, 'fail');
assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'skipped' }] }).state, 'pass');
assert.equal(summary({ enabled: true, steps: [{ status: 'skipped' }] }).state, 'skipped');
assert.equal(summary({ enabled: true, steps: [{ status: 'pass' }, { status: 'pending' }] }).state, 'pending');
```

Expected: FAIL with `missing buildSequenceGroupSummary in app.js`.

- [ ] **Step 5: Implement group aggregation and extend the detail model**

`buildSequenceGroupSummary` must count terminal member steps, force `open: true` for `running` and `fail`, otherwise set `open: !section.collapsed`. Change `buildSequenceChannelDetailModel` to ignore group headers while building `steps`, call `buildSequenceDetailSections(sourceQueue, detailSteps)`, attach a `summary` to each section, and return:

```javascript
{
  // existing channel fields
  steps: detailSteps,
  sections: sections,
  namedGroupCount: sections.filter((section) => section.kind === 'group').length,
}
```

Callers and behavior tests must pass the complete `seqSelected` queue to the detail model; card totals continue to use `sequenceRunQueueItems()`.

- [ ] **Step 6: Run Node tests and commit the projection**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: all tests PASS.

```bash
git add crates/agent/static/app.js crates/agent/tests/workbench_app_behavior.test.js
git commit -m "feat: project grouped sequence detail"
```

### Task 2: Render group sections with clear visual hierarchy

**Files:**
- Modify: `crates/agent/static/app.js` near `renderSeqChannelDetail`
- Modify: `crates/agent/static/style.css` near `.seq-channel-detail-steps`
- Test: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: `model.sections`, `section.summary`, and existing step rendering fields from Task 1.
- Produces: `appendSequenceDetailStep(parent, step, model)` and group DOM identified by `data-group-key` and `data-state`.

- [ ] **Step 1: Add a failing static UI contract for grouped detail**

Extend `sequence_run_page_uses_persistent_channel_cards_and_detail_view` to require:

```rust
assert!(
    APP.contains("buildSequenceDetailSections")
        && APP.contains("buildSequenceGroupSummary")
        && APP.contains("appendSequenceDetailStep")
        && STYLE.contains(".seq-channel-group {")
        && STYLE.contains(".seq-channel-group-body {")
        && STYLE.contains(".seq-channel-group-guide {")
        && STYLE.contains(".seq-channel-group[data-state=\"running\"]"),
    "channel detail must render state-aware grouped sections"
);
```

- [ ] **Step 2: Run the static UI test and verify RED**

Run: `cargo test -p agent --test static_ui sequence_run_page_uses_persistent_channel_cards_and_detail_view`

Expected: FAIL because the group renderer/styles are absent.

- [ ] **Step 3: Extract the existing step-row renderer without changing behavior**

Move the current per-step `<details>` creation from `renderSeqChannelDetail` into:

```javascript
function appendSequenceDetailStep(parent, step, model) {
  // Existing summary, metrics, configured input, complete output,
  // raw step JSON, log location, status, and elapsed-time rendering.
  parent.appendChild(row);
  return row;
}
```

The helper must keep `data-position`, step `data-state`, active/failed auto-open behavior, and escaped metric cell output.

- [ ] **Step 4: Render native disclosure sections**

For every `model.sections` entry, append:

```html
<details class="seq-channel-group" data-group-key="group-1" data-state="running" open>
  <summary class="seq-channel-group-summary">
    <span class="seq-channel-group-marker">组</span>
    <span class="seq-channel-group-heading">
      <strong>校准</strong>
      <span class="seq-channel-group-note">连接仪表</span>
    </span>
    <span class="seq-channel-group-status">执行中</span>
    <span class="seq-channel-group-counts">1 / 2 · 通过 1 · 失败 0 · 跳过 0</span>
  </summary>
  <div class="seq-channel-group-body">
    <span class="seq-channel-group-guide" aria-hidden="true"></span>
    <!-- existing step rows -->
  </div>
</details>
```

Use `未分组` rather than `组` for the synthetic marker. Empty groups show `该组暂无步骤`. Disabled groups display `已禁用`; no color-only meaning is allowed.

- [ ] **Step 5: Add the group visual system and mobile rules**

Implement lightweight section styling:

- `.seq-channel-group`: one-pixel border, compact radius, no nested heavy shadow;
- `.seq-channel-group-summary`: responsive grid with tinted background and pointer cursor;
- status-specific four-pixel left rail for running/fail/pass/disabled;
- `.seq-channel-group-body`: relative container with restrained padding;
- `.seq-channel-group-guide`: vertical hierarchy line behind member steps;
- `.seq-channel-group-note`: muted, ellipsized secondary text;
- mobile summary metadata wraps below the title and group-body indentation shrinks.

- [ ] **Step 6: Update the channel detail header group summary**

Change `seq-channel-detail-counts` copy to:

```javascript
model.namedGroupCount + ' 个组 · ' + cardModel.total + ' 个步骤 · 通过 ' + cardModel.passed +
' · 失败 ' + cardModel.failed + ' · 跳过 ' + cardModel.skipped
```

- [ ] **Step 7: Run focused UI tests and commit rendering**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Run: `cargo test -p agent --test static_ui`

Expected: all tests PASS.

```bash
git add crates/agent/static/app.js crates/agent/static/style.css crates/agent/tests/static_ui.rs
git commit -m "feat: render grouped channel detail"
```

### Task 3: Preserve group interaction state during live polling

**Files:**
- Modify: `crates/agent/static/app.js` inside `renderSeqChannelDetail`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: group DOM `data-group-key`, `section.summary.open`, existing active-step scroll behavior.
- Produces: `resolveSequenceGroupOpen(initialOpen, preservedOpen, forceOpen) -> boolean` for polling-safe group rerenders.

- [ ] **Step 1: Add a failing pure disclosure-state preference test**

Introduce and test `resolveSequenceGroupOpen(summaryOpen, preservedOpen, forceOpen)`:

```javascript
assert.equal(resolveSequenceGroupOpen(false, null, false), false);
assert.equal(resolveSequenceGroupOpen(true, false, false), false);
assert.equal(resolveSequenceGroupOpen(false, false, true), true);
assert.equal(resolveSequenceGroupOpen(false, true, false), true);
```

Expected: FAIL with `missing resolveSequenceGroupOpen in app.js`.

- [ ] **Step 2: Implement disclosure precedence**

```javascript
function resolveSequenceGroupOpen(initialOpen, preservedOpen, forceOpen) {
  if (forceOpen) return true;
  return preservedOpen == null ? !!initialOpen : !!preservedOpen;
}
```

Before clearing the detail host, capture every group `open` value keyed by `data-group-key`, every open step keyed by `data-position`, and whether focus is on a group summary or step summary. Apply `resolveSequenceGroupOpen` while rebuilding. Restore focus to the matching summary after rendering.

- [ ] **Step 3: Verify active-group behavior**

Set `forceOpen` when a section summary state is `running` or `fail`. Retain the existing one-time active-step scroll keyed by `data-current-position`; do not scroll merely because another group is manually opened.

- [ ] **Step 4: Update documentation**

Update README sequence-run results wording to mention named group sections, aggregate group status, and polling-stable disclosure. Do not describe group editing from the run page.

- [ ] **Step 5: Run complete verification**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Run: `cargo test --workspace`

Run: `git diff --check`

Expected: all commands exit 0; existing compiler warnings may remain but no test failure is allowed.

- [ ] **Step 6: Request independent review and fix findings**

Review against `docs/superpowers/specs/2026-08-04-sequence-run-grouped-detail-design.md`, focusing on group membership by persisted position, status aggregation, disclosure preservation, accessibility, and responsive hierarchy. Fix every Critical/Important finding with a regression test.

- [ ] **Step 7: Commit the completed grouped detail**

```bash
git add README.md crates/agent/static/app.js crates/agent/static/style.css crates/agent/tests/static_ui.rs crates/agent/tests/workbench_app_behavior.test.js docs/superpowers/plans/2026-08-04-sequence-run-grouped-detail.md
git commit -m "feat: add groups to channel run detail"
```
