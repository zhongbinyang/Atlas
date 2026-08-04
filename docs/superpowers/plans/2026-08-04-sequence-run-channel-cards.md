# Sequence Run Channel Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build persistent one-card-per-channel sequence overview, a dedicated channel detail screen, and Agent-recorded channel/step elapsed times.

**Architecture:** Add backward-compatible timing fields to sequence results and progress snapshots, then render overview and detail projections from the existing queue and multi-channel progress state. Replace the rejected matrix/operator-inspector UI rather than layering another mode over it.

**Tech Stack:** Rust, Tokio, serde, static HTML/CSS, browser JavaScript, Node `node:test`, Rust unit/static UI tests.

## Global Constraints

- Cards exist before execution and remain in stable channel-index order.
- Each channel has exactly one overview card; steps are shown only in the channel detail screen.
- Remove the existing channel matrix, operator/engineer switch, exception filter, bottom inspector, and full matrix report.
- Agent timing includes resource wait plus execution and is expressed as integer milliseconds.
- Do not change sequence request payloads, cancellation, resource locking, templates, or the sequence editor.

---

### Task 1: Record terminal step and channel elapsed time

**Files:**
- Modify: `crates/agent/src/labview_sequence.rs`
- Modify: `crates/agent/src/channel_run.rs`

**Interfaces:**
- Produces: `SequenceStepResult.elapsed_ms: u64` and `SequenceResponse.elapsed_ms: u64`.
- Consumes: existing `run_sequence_from_with_opts` execution branches.

- [x] **Step 1: Add failing Rust assertions** to the existing success, failure, and skipped sequence tests:

```rust
assert!(response.steps[0].elapsed_ms >= 20);
assert_eq!(skipped.steps[0].elapsed_ms, 0);
assert!(response.elapsed_ms >= response.steps[0].elapsed_ms);
```

- [x] **Step 2: Run `cargo test -p agent labview_sequence::tests`** and verify compilation/assertion failure because timing fields do not exist.
- [x] **Step 3: Add serde-compatible timing fields** and measure the sequence plus every enabled step with `std::time::Instant`; populate all success, error, lock-error, aborted, and skipped constructors.
- [x] **Step 4: Add `elapsed_ms: 0` to the channel-worker panic fallback** and run `cargo test -p agent labview_sequence::tests channel_run::tests` until green.

### Task 2: Expose live channel and current-step timing

**Files:**
- Modify: `crates/agent/src/sequence_session.rs`
- Test: module tests in `crates/agent/src/sequence_session.rs`

**Interfaces:**
- Produces: serialized `ChannelProgressSnapshot.elapsed_ms` and `current_step_elapsed_ms`.
- Consumes: begin/current/steps/overall/finish lifecycle methods.

- [x] **Step 1: Add a failing async test** that begins a channel, starts a step, waits, snapshots, and verifies live timers:

```rust
slot.begin_channels(1, &[(0, "CH0".into())]).await;
slot.set_channel_current_if(1, 0, 0, "step".into()).await;
tokio::time::sleep(Duration::from_millis(20)).await;
let live = slot.snapshot().await.channels.remove(0);
assert!(live.elapsed_ms >= 20);
assert!(live.current_step_elapsed_ms.unwrap() >= 20);
```

- [x] **Step 2: Run `cargo test -p agent sequence_session::tests`** and verify failure because snapshot timing is absent.
- [x] **Step 3: Track internal `Instant` values in skipped serde fields**, refresh elapsed values in `snapshot`, finalize current-step timing when steps publish, and preserve final channel elapsed time when overall/finish is set.
- [x] **Step 4: Extend the test to finish the channel and verify final `elapsed_ms` remains stable while `current_step_elapsed_ms` becomes `None`; rerun the module tests.**

### Task 3: Replace the run page shell with persistent channel cards

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/style.css`
- Modify: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Produces DOM hosts `seq-channel-overview`, `seq-channel-cards`, `seq-channel-detail`, `seq-channel-detail-steps`, and detail navigation controls.
- Retains IDs `seq-channel-pick`, `seq-overall`, `seq-run-btn`, and `seq-abort-btn`.

- [x] **Step 1: Rewrite the static UI contract** to require the overview/detail hosts and reject `seq-progress-matrix`, `seq-operator-view`, `seq-engineer-view`, and `seq-step-inspector`.
- [x] **Step 2: Run `cargo test -p agent --test static_ui`** and verify failure against the rejected layout.
- [x] **Step 3: Replace the rejected result markup** with a channel overview grid and hidden channel detail screen; keep controls in normal document flow.
- [x] **Step 4: Replace matrix/inspector CSS** with equal-height responsive channel cards, progress bars, detail summary, current-step panel, and scroll-contained step table.
- [x] **Step 5: Rerun the static UI test until green.**

### Task 4: Render card state and navigate to channel detail

**Files:**
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Produces: `formatSequenceElapsed(ms)`, `buildSequenceChannelCardModel(channel, queue)`, `renderSeqChannelCards()`, `openSeqChannelDetail(channelIndex)`, and `closeSeqChannelDetail()`.
- Consumes: `seqChannelProgress`, `seqSelected`, enabled/selected channels, and the existing progress poll.

- [x] **Step 1: Add failing Node tests** with literal expectations:

```javascript
assert.equal(formatSequenceElapsed(1326), '00:01.326');
assert.deepEqual(buildSequenceChannelCardModel(pendingChannel, queue), {
  state: 'idle', currentName: '等待运行', completed: 0, total: 11,
  passed: 0, failed: 0, skipped: 0, elapsedMs: 0, currentElapsedMs: null
});
```

- [x] **Step 2: Run `node --test crates/agent/tests/workbench_app_behavior.test.js`** and verify missing helper failures.
- [x] **Step 3: Implement stable pending/running/final card models**, render one clickable card per displayed channel, and preserve focused cards across poll refreshes.
- [x] **Step 4: Implement overview/detail navigation** without changing the browser endpoint; clicking a card sets the active channel and renders detail immediately, including before execution.
- [x] **Step 5: Rerun the Node behavior test until green.**

### Task 5: Render the channel step history and timing

**Files:**
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Produces: `buildSequenceChannelDetailModel(channel, queue)` and `renderSeqChannelDetail()`.
- Consumes: step `elapsed_ms`, channel `elapsed_ms`, and `current_step_elapsed_ms` from Tasks 1–2.

- [x] **Step 1: Add a failing behavior test** asserting pending queue rows exist before execution and completed rows preserve status and elapsed milliseconds.
- [x] **Step 2: Add timing fields to `channelProgressFromEnvelope` and `multiEnvelopeToProgress`, then build detail rows by joining queue positions with channel steps.**
- [x] **Step 3: Render detail header, current-step panel, counts, total elapsed time, original-order step rows, and expandable measured/input/output/raw/log content.**
- [x] **Step 4: Keep the active step visible during polling without reordering or stealing focus; run all Node tests.**

### Task 6: Log timing, remove rejected code, and verify

**Files:**
- Modify: `crates/agent/src/api.rs`
- Modify: `README.md`
- Modify: `crates/agent/static/app.js`

**Interfaces:**
- Consumes: timing fields and new overview/detail UI.
- Produces: timing fields in `sequence_runs` JSON and documentation matching the shipped interface.

- [x] **Step 1: Add `elapsed_ms` to channel and step log JSON**, then update README sequence-run wording.
- [x] **Step 2: Remove obsolete matrix/report/operator/engineer/inspector functions, listeners, state, and CSS selectors; retain shared formatting helpers used by detail rows.**
- [x] **Step 3: Run `node --check crates/agent/static/app.js` and `node --test crates/agent/tests/*.test.js`.**
- [x] **Step 4: Run `cargo test --workspace`, `git diff --check`, and inspect `git status --short`.**
- [x] **Step 5: Request independent code review, fix Critical/Important findings with regression tests, and repeat the full verification commands.**
