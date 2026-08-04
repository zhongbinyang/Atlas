# Sequence Channel Card Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated per-channel run action to every sequence channel card and keep desktop cards at a compact, bounded width instead of stretching across the page.

**Architecture:** Reuse the existing `/api/sequence/run` flow by extracting payload construction into a pure helper and allowing `runSequence` to receive an explicit one-channel override. Render a native run button inside each persistent card, isolate its events from the card detail action, and turn the card host into a left-aligned bounded CSS grid with a one-column mobile fallback.

**Tech Stack:** Static browser JavaScript, HTML/CSS, Node `node:test`, Rust static UI tests.

## Global Constraints

- `运行此通道` sends exactly one `channel_index` and never changes the top channel checkboxes.
- The top `开始运行` action retains its current selected-channel behavior.
- Card and top run actions share the existing polling, abort, result, busy-error, and control-lock flow.
- A card run click or keyboard activation must not open channel detail.
- All run actions are disabled while `seqRunning` is true or when there are no executable queue steps.
- Desktop cards use left-aligned tracks between 20rem and 24rem; one card never expands across the page.
- At the existing 640px mobile breakpoint, cards use one full-width column.
- No backend endpoint, request schema, result schema, queue persistence, or concurrent-run changes.

---

### Task 1: Reuse the run flow for an isolated card channel

**Files:**
- Modify: `crates/agent/static/app.js` near `renderSeqChannelCards`, `setSeqControlsDisabled`, and `runSequence`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Produces: `buildSequenceRunPayload(templateId, selectedChannelIndexes, explicitChannelIndexes) -> Object`.
- Extends: `runSequence(explicitChannelIndexes?) -> Promise<void>`.
- Adds: `.seq-channel-card-run` native buttons rendered by `renderSeqChannelCards`.
- Consumes later: Task 2 styles `.seq-channel-card-actions`, `.seq-channel-card-run`, and `.seq-channel-card-detail`.

- [ ] **Step 1: Add failing payload tests**

Add a Node behavior test that extracts `buildSequenceRunPayload` and uses literal expectations:

```javascript
test('sequence run payload isolates an explicit card channel without changing top selection', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);

  const selected = [0, 1];
  const explicit = [3];
  const cardPayload = context.buildSequenceRunPayload(12, selected, explicit);
  const topPayload = context.buildSequenceRunPayload(12, selected, null);

  assert.deepEqual(JSON.parse(JSON.stringify(cardPayload)), {
    sequence_template_id: 12,
    channel_indexes: [3],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(topPayload)), {
    sequence_template_id: 12,
    channel_indexes: [0, 1],
  });
  assert.deepEqual(selected, [0, 1]);
  assert.deepEqual(explicit, [3]);
});

test('sequence run payload omits channel indexes when top selection means all enabled', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequenceRunPayload'), context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.buildSequenceRunPayload(null, null, null))),
    {}
  );
});
```

- [ ] **Step 2: Run the focused Node test and verify RED**

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: FAIL with `missing buildSequenceRunPayload in app.js`.

- [ ] **Step 3: Implement the pure payload helper**

Add beside the existing channel-selection helper:

```javascript
function buildSequenceRunPayload(templateId, selectedChannelIndexes, explicitChannelIndexes) {
  const channelIndexes = Array.isArray(explicitChannelIndexes)
    ? explicitChannelIndexes.slice()
    : selectedChannelIndexes;
  const payload = {};
  if (templateId != null) payload.sequence_template_id = templateId;
  if (Array.isArray(channelIndexes)) payload.channel_indexes = channelIndexes.slice();
  return payload;
}
```

- [ ] **Step 4: Route top and card actions through the shared run function**

Change the run entry point to accept an explicit override and reject queues without executable steps:

```javascript
async function runSequence(explicitChannelIndexes) {
  if (seqRunning || !sequenceRunQueueItems().length) return;
  const selectedChannelIndexes = selectedChannelIndexesForRun();
  const channelIndexes = Array.isArray(explicitChannelIndexes)
    ? explicitChannelIndexes.slice()
    : selectedChannelIndexes;
  if (Array.isArray(channelIndexes) && channelIndexes.length === 0) {
    showSeqMsg('请至少选择一个通道', false);
    return;
  }
  // Keep the existing setup, polling, fetch, response, catch, and finally flow.
  const payload = buildSequenceRunPayload(
    seqActiveTemplateId,
    selectedChannelIndexes,
    explicitChannelIndexes
  );
}
```

Do not duplicate the fetch lifecycle. Replace the top listener with a zero-argument wrapper so the browser event is not treated as the override:

```javascript
document.getElementById('seq-run-btn').addEventListener('click', function () {
  runSequence();
});
```

- [ ] **Step 5: Render the card action row and isolate its events**

Replace the passive card affordance with an action row. Keep the whole-card click behavior and add an explicit detail action:

```javascript
const actions = document.createElement('div');
actions.className = 'seq-channel-card-actions';

const runButton = document.createElement('button');
runButton.type = 'button';
runButton.className = 'btn-primary seq-channel-card-run';
runButton.textContent = '运行此通道';
runButton.setAttribute('aria-label', '运行 ' + channelName + ' 通道');
runButton.disabled = seqRunning || !sequenceRunQueueItems().length;
runButton.addEventListener('click', function (event) {
  event.stopPropagation();
  runSequence([channel.channel_index]);
});

const detailButton = document.createElement('button');
detailButton.type = 'button';
detailButton.className = 'btn-link seq-channel-card-detail';
detailButton.textContent = '查看详情 →';
detailButton.addEventListener('click', function (event) {
  event.stopPropagation();
  openSeqChannelDetail(channel.channel_index);
});
```

Use one `channelName` variable for the title and accessible label. In the card keydown handler, return unless `event.target === card` before handling Enter/Space. Add both buttons to `actions`, then append `actions` to the card.

- [ ] **Step 6: Include card run buttons in the global control lock**

In `setSeqControlsDisabled`, update existing rendered card buttons:

```javascript
if (runBtn) runBtn.disabled = disabled || !sequenceRunQueueItems().length;
document.querySelectorAll('#seq-channel-cards .seq-channel-card-run').forEach(function (button) {
  button.disabled = disabled || !sequenceRunQueueItems().length;
});
```

Replace the earlier `runBtn.disabled` assignment rather than adding a second one. Do not disable `.seq-channel-card-detail`; detail remains available while a run is active.

- [ ] **Step 7: Run behavior verification and commit**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: syntax passes and all Node behavior tests pass.

```bash
git add crates/agent/static/app.js crates/agent/tests/workbench_app_behavior.test.js
git commit -m "feat: run sequence from a channel card"
```

---

### Task 2: Bound card width and polish the action layout

**Files:**
- Modify: `crates/agent/static/style.css` near `.seq-channel-cards` and the 640px media query
- Modify: `crates/agent/static/index.html` inside `#seq-channel-overview`
- Test: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: Task 1 classes `.seq-channel-card-actions`, `.seq-channel-card-run`, and `.seq-channel-card-detail`.
- Produces: a left-aligned desktop grid with bounded tracks and a one-column mobile layout.

- [ ] **Step 1: Add a failing static UI contract**

Extend `sequence_run_page_uses_persistent_channel_cards_and_detail_view` with literals that fail if the grid display, width bound, run action, or mobile rule disappears:

```rust
assert!(
    APP.contains("seq-channel-card-run")
        && APP.contains("运行此通道")
        && APP.contains("event.stopPropagation()")
        && STYLE.contains(".seq-channel-cards {\n  display: grid;")
        && STYLE.contains("repeat(auto-fill, minmax(20rem, 24rem))")
        && STYLE.contains("justify-content: start;")
        && STYLE.contains(".seq-channel-card-actions")
        && STYLE.contains(".seq-channel-card-detail"),
    "channel cards need isolated run/detail actions and bounded desktop tracks"
);

let mobile = STYLE
    .split("@media (max-width: 640px) {")
    .nth(1)
    .expect("sequence UI needs the existing mobile breakpoint");
assert!(
    mobile.contains(".seq-channel-cards {\n    grid-template-columns: 1fr;"),
    "channel cards must become one full-width column on mobile"
);
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -p agent --test static_ui sequence_run_page_uses_persistent_channel_cards_and_detail_view`

Expected: FAIL with `channel cards need isolated run/detail actions and bounded desktop tracks`.

- [ ] **Step 3: Implement the bounded desktop grid**

Replace the current incomplete card-container rule with:

```css
.seq-channel-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(20rem, 24rem));
  justify-content: start;
  align-items: stretch;
  gap: 0.9rem;
}
```

Keep the existing mobile rule:

```css
.seq-channel-cards {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 4: Style the card actions without removing current information**

Add:

```css
.seq-channel-card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: auto;
  padding-top: 1rem;
}

.seq-channel-card-run {
  min-height: 2.25rem;
  padding-inline: 0.9rem;
}

.seq-channel-card-detail {
  color: var(--accent);
  font-size: 0.82rem;
  font-weight: 650;
}
```

Remove the obsolete `.seq-channel-card-affordance` rule. Preserve the existing header, current-step panel, progress bar, counts, elapsed time, status borders, hover state, and focus-visible treatment.

- [ ] **Step 5: Update operator-facing guidance**

Change the overview hint to:

```html
<p class="muted-hint">每个通道对应一张卡片；可单独运行，也可查看完整运行详情。</p>
```

- [ ] **Step 6: Run full verification**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Run: `cargo test -p agent --test static_ui`

Run: `cargo test --workspace`

Run: `git diff --check`

Expected: all commands exit 0; existing compiler warnings may remain, but no test failure is allowed.

- [ ] **Step 7: Commit the completed card controls and layout**

```bash
git add crates/agent/static/style.css crates/agent/static/index.html crates/agent/tests/static_ui.rs
git commit -m "style: compact sequence channel cards"
```

Finally review the complete range against `docs/superpowers/specs/2026-08-04-sequence-channel-card-run-design.md`, focusing on event isolation, disabled-state recovery, keyboard behavior, bounded track sizing, and mobile layout. Fix every Critical or Important finding with a regression test.
