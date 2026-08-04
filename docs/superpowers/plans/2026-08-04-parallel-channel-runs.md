# Parallel Sequence Channel Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run different sequence channels concurrently, provide per-channel and global abort controls, and show the current/last step's group on every channel card.

**Architecture:** Refactor the agent admission slot and sequence progress/cancel state from one global sequence generation into generation-scoped channel entries. Each HTTP start request runs only newly admitted channels, one independently controlled worker per channel, while the existing `ResourceLockManager` continues to serialize only test items that claim the same resource. The browser treats progress as a keyed collection, merges concurrent responses by channel generation, and derives button/editor state from per-channel activity.

**Tech Stack:** Rust 2021, Axum 0.8, Tokio watch channels and spawned tasks, static browser JavaScript, HTML/CSS, Node `node:test`, Cargo tests.

## Global Constraints

- Different `channel_index` values start immediately and may execute concurrently.
- The same `channel_index` cannot have two live runs.
- `运行此通道` is disabled only for its own running/pending channel or an empty queue.
- `中止此通道` affects only its card; the top `中止` action aborts every running channel.
- Queue/template mutation stays disabled while any channel is running; channel selection remains usable so an idle channel can be added.
- Delay, REST, and version operations retain exclusive admission against sequence activity.
- `ResourceLockManager` remains the only test-item serialization mechanism across channels.
- Progress, result, cleanup, and cancellation writes are scoped by both `channel_index` and generation.
- The card shows `当前组` plus `当前步骤`; completed/failed/aborted cards retain the last executed step and group.
- No new dependency is added to `crates/agent/Cargo.toml`.

---

### Task 1: Make task admission channel-aware

**Files:**
- Modify: `crates/agent/src/task_slot.rs`
- Test: `crates/agent/src/task_slot.rs`

**Interfaces:**
- Preserves: `try_acquire(owner: &str) -> Result<u64, &'static str>` and `release(generation: u64) -> bool` for exclusive non-sequence work.
- Produces: `try_acquire_sequence(channel_index: usize) -> Result<u64, &'static str>`.
- Produces: `release_sequence(channel_index: usize, generation: u64) -> bool`.
- Produces: `force_release_all() -> Vec<TaskHold>` where `TaskHold` exposes `owner`, `channel_index`, and `generation`.
- Preserves: `is_busy()` and `owner()`; `owner()` returns `Some("sequence")` while one or more sequence holders exist.
- Temporarily preserves: `current_generation_if_busy` and `force_release_if` for exclusive holders so existing API call sites continue compiling until Task 4 migrates force release.

- [ ] **Step 1: Write failing admission tests**

Replace sequence use of the exclusive API in the task-slot tests and add literal behavior tests:

```rust
#[tokio::test]
async fn distinct_sequence_channels_share_admission_but_duplicates_do_not() {
    let slot = TaskSlot::new();
    let ch0 = slot.try_acquire_sequence(0).await.unwrap();
    let ch1 = slot.try_acquire_sequence(1).await.unwrap();

    assert_ne!(ch0, ch1);
    assert_eq!(slot.try_acquire_sequence(0).await.unwrap_err(), "channel busy");
    assert_eq!(slot.owner().await.as_deref(), Some("sequence"));
    assert!(slot.release_sequence(0, ch0).await);
    assert!(slot.is_busy().await);
    assert!(slot.release_sequence(1, ch1).await);
    assert!(!slot.is_busy().await);
}

#[tokio::test]
async fn exclusive_and_sequence_admission_exclude_each_other() {
    let slot = TaskSlot::new();
    let delay = slot.try_acquire("delay").await.unwrap();
    assert_eq!(slot.try_acquire_sequence(0).await.unwrap_err(), "busy");
    assert!(slot.release(delay).await);

    let ch0 = slot.try_acquire_sequence(0).await.unwrap();
    assert_eq!(slot.try_acquire("rest").await.unwrap_err(), "busy");
    assert!(slot.release_sequence(0, ch0).await);
}

#[tokio::test]
async fn stale_sequence_release_cannot_clear_a_newer_generation() {
    let slot = TaskSlot::new();
    let old = slot.try_acquire_sequence(3).await.unwrap();
    let released = slot.force_release_all().await;
    assert_eq!(released.len(), 1);
    let new = slot.try_acquire_sequence(3).await.unwrap();

    assert!(!slot.release_sequence(3, old).await);
    assert!(slot.is_busy().await);
    assert!(slot.release_sequence(3, new).await);
}
```

Production mutation caught: returning the global busy branch for a second, distinct channel makes the first test fail.

- [ ] **Step 2: Run the task-slot tests and verify RED**

Run: `cargo test -p agent task_slot::tests -- --nocapture`

Expected: compilation fails because `try_acquire_sequence`, `release_sequence`, and `force_release_all` do not exist.

- [ ] **Step 3: Implement the admission state**

Use one mutex so exclusive/sequence transitions are atomic:

```rust
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskHold {
    pub owner: String,
    pub channel_index: Option<usize>,
    pub generation: u64,
}

enum Holds {
    Idle,
    Exclusive { owner: String, generation: u64 },
    Sequence(HashMap<usize, u64>),
}

struct Inner {
    holds: Holds,
    next_generation: u64,
}
```

Implement `try_acquire_sequence` so `Idle` becomes a one-entry sequence map, `Sequence` accepts only a missing key, and `Exclusive` returns `"busy"`. Increment `next_generation` before every successful acquisition. Implement `release_sequence` with an exact channel/generation match and return to `Idle` only after the final entry is removed.

Keep `try_acquire` exclusive: it succeeds only in `Idle`. Change `force_release_all` to atomically replace `holds` with `Idle`, advance `next_generation`, and return every released hold. Do not use the task slot to serialize steps.

- [ ] **Step 4: Run focused and existing task-slot tests**

Run: `cargo test -p agent task_slot::tests -- --nocapture`

Expected: all task-slot tests pass, including exclusive stale-release coverage adapted to `force_release_all`.

- [ ] **Step 5: Commit the admission refactor**

```bash
git add crates/agent/src/task_slot.rs
git commit -m "refactor: admit concurrent sequence channels"
```

---

### Task 2: Store progress and cancellation per channel generation

**Files:**
- Modify: `crates/agent/src/sequence_session.rs`
- Test: `crates/agent/src/sequence_session.rs`

**Interfaces:**
- Extends serialized `ChannelProgressSnapshot` with `running: bool` and `generation: u64`.
- Keeps: `SequenceProgressSlot::begin_channels`, `set_channel_current_if`, `set_channel_steps_if`, `set_channel_overall_if`, `finish_channels`, and `snapshot`.
- Changes: every generation check applies to the addressed channel entry, not one global snapshot generation.
- Produces: `SequenceProgressSlot::clear_channel_if(channel_index, generation) -> bool`.
- Produces: `SequenceCancelRegistry::new() -> Arc<SequenceCancelRegistry>`.
- Produces: `install(channel_index, generation) -> Result<watch::Receiver<bool>, &'static str>`, `clear_if(channel_index, generation) -> bool`, `signal_channel(channel_index) -> bool`, and `signal_all() -> Vec<usize>`.
- Removes after migrating its tests: the global `SequenceProgressSnapshot.generation`, `SequenceProgressSlot::generation`, and global `clear_if`; there is no single sequence owner after this task.

- [ ] **Step 1: Write failing independent-progress tests**

Add tests with hand-derived channel state:

```rust
#[tokio::test]
async fn finishing_one_generation_keeps_another_channel_running() {
    let progress = SequenceProgressSlot::new();
    progress.begin_channels(11, &[(0, "CH0".into())]).await;
    progress.begin_channels(12, &[(1, "CH1".into())]).await;
    progress
        .finish_channels(11, &[(0, "CH0".into(), vec![], "pass".into())])
        .await;

    let snapshot = progress.snapshot().await;
    assert!(snapshot.running);
    assert_eq!(snapshot.channels.len(), 2);
    assert!(!snapshot.channels.iter().find(|c| c.channel_index == 0).unwrap().running);
    assert!(snapshot.channels.iter().find(|c| c.channel_index == 1).unwrap().running);
}

#[tokio::test]
async fn stale_channel_write_does_not_replace_newer_run() {
    let progress = SequenceProgressSlot::new();
    progress.begin_channels(20, &[(2, "old".into())]).await;
    progress.begin_channels(21, &[(2, "new".into())]).await;
    progress.begin_channels(20, &[(2, "late old begin".into())]).await;
    progress.set_channel_current_if(20, 2, 7, "stale".into()).await;

    let channel = progress.snapshot().await.channels.remove(0);
    assert_eq!(channel.generation, 21);
    assert_eq!(channel.name, "new");
    assert_eq!(channel.current_name, None);
}
```

Add cancellation isolation:

```rust
#[tokio::test]
async fn channel_cancel_and_global_cancel_signal_the_expected_receivers() {
    let registry = SequenceCancelRegistry::new();
    let rx0 = registry.install(0, 31).await.unwrap();
    let rx1 = registry.install(1, 32).await.unwrap();

    assert!(registry.signal_channel(0).await);
    assert!(*rx0.borrow());
    assert!(!*rx1.borrow());
    assert_eq!(registry.signal_all().await, vec![1]);
    assert!(*rx1.borrow());
}

#[tokio::test]
async fn stale_cancel_install_cannot_replace_a_newer_generation() {
    let registry = SequenceCancelRegistry::new();
    let new_rx = registry.install(4, 42).await.unwrap();
    assert_eq!(registry.install(4, 41).await.unwrap_err(), "stale generation");
    assert!(registry.signal_channel(4).await);
    assert!(*new_rx.borrow());
}
```

Production mutations caught: a global `running = false`, a global generation field, or broadcast from the channel-specific method fails these tests.

- [ ] **Step 2: Run sequence-session tests and verify RED**

Run: `cargo test -p agent sequence_session::tests -- --nocapture`

Expected: compilation fails on missing per-channel `running`, `generation`, and `SequenceCancelRegistry`.

- [ ] **Step 3: Refactor progress storage into keyed entries**

Store `HashMap<usize, ChannelProgressSnapshot>` inside `SequenceProgressSlot`. `begin_channels` inserts a channel only when no entry exists or the incoming generation is newer than or equal to the stored generation; a late older begin is a no-op. Initialize accepted entries with:

```rust
ChannelProgressSnapshot {
    channel_index: idx,
    name,
    running: true,
    generation,
    started_at: Some(Instant::now()),
    ..Default::default()
}
```

For `set_channel_current_if`, `set_channel_steps_if`, and `set_channel_overall_if`, mutate only when that entry's generation matches. `finish_channels` sets each matching entry's `running` to false, freezes elapsed time, clears current-step fields, and retains steps/overall. `snapshot` sorts channels by `channel_index`, computes envelope `running` with `channels.iter().any(|c| c.running)`, and fills the legacy flat fields from the first channel without making them authoritative.

- [ ] **Step 4: Implement the cancel registry**

Keep cancellation in the same lifecycle module:

```rust
#[derive(Clone)]
struct ActiveChannelCancel {
    generation: u64,
    tx: watch::Sender<bool>,
}

pub struct SequenceCancelRegistry {
    inner: Mutex<HashMap<usize, ActiveChannelCancel>>,
}
```

`install(channel_index, generation)` replaces only that channel entry and returns its receiver. It returns `Err("stale generation")` instead of replacing a newer entry; when replacing an older entry, signal the older sender before insertion. `clear_if` removes only an exact channel/generation pair. `signal_channel` sends only to the requested entry. `signal_all` sends to every unsignalled entry and returns sorted channel indexes so API responses and tests are deterministic.

- [ ] **Step 5: Verify session behavior and commit**

Run: `cargo test -p agent sequence_session::tests -- --nocapture`

Expected: all sequence-session tests pass.

```bash
git add crates/agent/src/sequence_session.rs
git commit -m "refactor: track sequence lifecycle per channel"
```

---

### Task 3: Let independent channel workers share progress and resource locks

**Files:**
- Modify: `crates/agent/src/channel_run.rs`
- Modify: `crates/agent/src/resource_lock.rs`
- Test: `crates/agent/src/channel_run.rs`
- Test: `crates/agent/src/labview_sequence.rs`
- Test: `crates/agent/src/resource_lock.rs`

**Interfaces:**
- Keeps: `ChannelRunRequest` with one `run_generation` and one cancel receiver; the API will invoke it once per admitted channel.
- Extends: `ChannelSequenceResponse` with `run_generation: u64`.
- Extends: `MultiChannelSequenceResponse` with `skipped_channel_indexes: Vec<usize>` using `#[serde(default, skip_serializing_if = "Vec::is_empty")]`; the runner initializes it to an empty vector and Task 4 fills it for mixed start requests.
- Requires: progress methods from Task 2 to merge `begin_channels` and finish only matching entries.
- Preserves: `SequenceRunOpts.progress_channel`, `progress_generation`, and shared `ResourceLockManager` step acquisition.

- [ ] **Step 1: Write a failing concurrent-run progress test**

Add a test that invokes two real orchestrator futures against the same progress and resource-lock objects:

```rust
#[tokio::test]
async fn independent_requests_keep_both_channel_progress_entries() {
    let progress = SequenceProgressSlot::new();
    let locks = ResourceLockManager::new();
    let req0 = request_for_channel(0, 40, progress.clone(), locks.clone());
    let req1 = request_for_channel(1, 41, progress.clone(), locks.clone());

    let (r0, r1) = tokio::join!(
        run_multi_channel_with(req0, |_item, _vars| async { Ok(json!({"sum": 20})) }),
        run_multi_channel_with(req1, |_item, _vars| async { Ok(json!({"sum": 20})) })
    );

    assert_eq!(r0.channels[0].run_generation, 40);
    assert_eq!(r1.channels[0].run_generation, 41);
    let snapshot = progress.snapshot().await;
    assert_eq!(snapshot.channels.len(), 2);
    assert!(snapshot.channels.iter().all(|channel| !channel.running));
}

fn request_for_channel(
    channel_index: usize,
    generation: u64,
    progress: Arc<SequenceProgressSlot>,
    resource_locks: Arc<ResourceLockManager>,
) -> ChannelRunRequest {
    let (_cancel_tx, cancel) = watch::channel(false);
    ChannelRunRequest {
        items: vec![QueueItemForRun {
            position: 0,
            queue_item_id: format!("q-{channel_index}"),
            template_id: "add".into(),
            name: "Add".into(),
            kind: "general".into(),
            vi_path: String::new(),
            inputs: json!({"a": 10, "b": 10}),
            show_front_panel: false,
            timeout_secs: None,
            enabled: true,
            breakpoint: false,
            fail_policy: "stop".into(),
            limits: vec![],
            resources: vec![],
        }],
        base_vars: HashMap::new(),
        channels: vec![ChannelSpec {
            channel_index,
            name: format!("CH{channel_index}"),
            overlay: json!({}),
        }],
        resource_locks,
        resource_timeout: Duration::from_secs(1),
        sn: None,
        work_order: None,
        progress,
        cancel,
        run_generation: generation,
    }
}
```

Import `HashMap`, `Arc`, `Duration`, `watch`, and `json` in the test module. The fixture calls the real orchestrator and replaces only the external LabVIEW invocation.

Production mutation caught: replacing progress on `begin_channels` or finishing the whole envelope causes one entry to disappear or both to stop early.

Add a resource-manager test that holds one named resource while acquiring a different one:

```rust
#[tokio::test]
async fn unrelated_resources_do_not_block_each_other() {
    let manager = ResourceLockManager::new();
    let _dca = manager
        .acquire(&["station.dca".into()], "ch-0", Duration::from_secs(1), None)
        .await
        .unwrap();

    let second = tokio::time::timeout(
        Duration::from_millis(50),
        manager.acquire(&["station.switch".into()], "ch-1", Duration::from_secs(1), None),
    )
    .await
    .expect("different resource must not wait");
    assert!(second.is_ok());
}
```

Production mutation caught: replacing named locks with one global test lock makes the timeout expire.

- [ ] **Step 2: Verify RED**

Run: `cargo test -p agent channel_run::tests::independent_requests_keep_both_channel_progress_entries -- --nocapture`

Expected: compilation fails because `ChannelSequenceResponse` lacks `run_generation`, or the assertion sees only one progress entry before Task 2 consumers are wired.

- [ ] **Step 3: Scope response and progress writes by generation**

Set the response field from the request generation:

```rust
ChannelSequenceResponse {
    channel_index: ch.channel_index,
    channel_name: ch.name,
    run_generation,
    response,
}
```

Add `run_generation` to every `ChannelSequenceResponse` constructor, including the worker-join error branch. Keep `begin_channels(run_generation, &channel_meta)` and `finish_channels(run_generation, &steps_for_progress)`, relying on Task 2's keyed semantics. Ensure `SequenceRunOpts` passes the same generation through every current/step/overall write. Preserve one shared `Arc<ResourceLockManager>` across independent requests.

- [ ] **Step 4: Verify cancellation and resource behavior**

Run: `cargo test -p agent channel_run::tests -- --nocapture`

Run: `cargo test -p agent resource_lock::tests -- --nocapture`

Run: `cargo test -p agent labview_sequence::tests::with_step_resources_serializes_concurrent_holders -- --nocapture`

Expected: concurrent progress, multi-channel aggregation, cancellation-between-steps, resource timeout, same-resource serialization, and empty-resource concurrency tests pass.

- [ ] **Step 5: Commit the worker changes**

```bash
git add crates/agent/src/channel_run.rs crates/agent/src/resource_lock.rs
git commit -m "feat: isolate sequence channel workers"
```

---

### Task 4: Expose concurrent start and channel/global abort APIs

**Files:**
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/main.rs`
- Test: `crates/agent/src/api.rs`

**Interfaces:**
- Changes `AppState.sequence_cancel` to `Arc<SequenceCancelRegistry>`.
- Adds route: `POST /api/sequence/run/channels/{channel_index}/abort`.
- Keeps routes: `POST /api/sequence/run`, `GET /api/sequence/run/progress`, and `POST /api/sequence/run/abort`.
- Consumes `MultiChannelSequenceResponse.skipped_channel_indexes` from Task 3.
- Consumes Task 1 admission and Task 2 progress/cancel registries.

Define these private API orchestration types:

```rust
struct AdmittedChannelRun {
    spec: ChannelSpec,
    generation: u64,
    cancel: watch::Receiver<bool>,
}

struct ChannelAdmission {
    started: Vec<AdmittedChannelRun>,
    skipped_channel_indexes: Vec<usize>,
}
```

Add the exact helper signature:

```rust
async fn admit_sequence_channels(
    state: &AppState,
    channels: Vec<ChannelSpec>,
) -> Result<ChannelAdmission, &'static str>
```

- [ ] **Step 1: Add failing HTTP cancellation tests**

Use real registries in `test_state()` and Axum `oneshot` requests:

```rust
#[tokio::test]
async fn channel_abort_signals_only_the_requested_channel() {
    let state = test_state();
    let rx0 = state.sequence_cancel.install(0, 51).await.unwrap();
    let rx1 = state.sequence_cancel.install(1, 52).await.unwrap();
    let app = router(state);

    let request = Request::builder()
        .method("POST")
        .uri("/api/sequence/run/channels/0/abort")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(*rx0.borrow());
    assert!(!*rx1.borrow());
}

#[tokio::test]
async fn global_abort_signals_every_running_channel() {
    let state = test_state();
    let rx0 = state.sequence_cancel.install(0, 61).await.unwrap();
    let rx1 = state.sequence_cancel.install(1, 62).await.unwrap();
    let app = router(state);

    let request = Request::builder()
        .method("POST")
        .uri("/api/sequence/run/abort")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(*rx0.borrow());
    assert!(*rx1.borrow());
}
```

Production mutation caught: routing channel abort to the global sender makes the first test fail.

- [ ] **Step 2: Add failing start-admission tests**

Extract a small async helper and test it without Center/LabVIEW mocks:

```rust
#[tokio::test]
async fn admission_starts_idle_channels_and_skips_only_duplicates() {
    let state = test_state();
    let existing = state.slot.try_acquire_sequence(0).await.unwrap();
    let admitted = admit_sequence_channels(&state, vec![
        ChannelSpec { channel_index: 0, name: "CH0".into(), overlay: serde_json::json!({}) },
        ChannelSpec { channel_index: 1, name: "CH1".into(), overlay: serde_json::json!({}) },
    ])
        .await
        .unwrap();

    assert_eq!(admitted.started.iter().map(|run| run.spec.channel_index).collect::<Vec<_>>(), vec![1]);
    assert_eq!(admitted.skipped_channel_indexes, vec![0]);
    assert!(state.slot.release_sequence(0, existing).await);
}
```

Use a literal `ChannelSpec` constructor in the test module. Add a second test asserting an exclusive `delay` hold returns the existing global busy conflict and admits no channels.

- [ ] **Step 3: Run focused API tests and verify RED**

Run: `cargo test -p agent api::tests::channel_abort_signals_only_the_requested_channel -- --nocapture`

Run: `cargo test -p agent api::tests::admission_starts_idle_channels_and_skips_only_duplicates -- --nocapture`

Expected: compilation fails on the new route/helper and registry-shaped `AppState`.

- [ ] **Step 4: Wire registries and routes**

Initialize state with:

```rust
sequence_progress: SequenceProgressSlot::new(),
sequence_cancel: SequenceCancelRegistry::new(),
```

Register the route before the general abort route:

```rust
.route(
    "/api/sequence/run/channels/{channel_index}/abort",
    post(labview_run_sequence_channel_abort),
)
```

Implement the channel handler with `Path(channel_index): Path<usize>` and `signal_channel`. Return `409` with `channel {index} is not running` when no sender exists. Implement global abort with `signal_all`; return `409` only when the returned list is empty, otherwise return `{ "ok": true, "aborting": [0, 1] }`.

- [ ] **Step 5: Refactor start into independently cleaned-up channel futures**

Keep queue/settings/channel loading before admission. Then call `admit_sequence_channels`, which uses `try_acquire_sequence` and installs one cancel receiver per admitted channel. If cancel installation rejects a stale generation, immediately call `release_sequence(channel_index, generation)` and do not start that worker. If every requested channel was skipped, return `409`; if an exclusive owner blocks admission, return the existing busy payload.

Spawn all workers before awaiting any handle, so the requests execute concurrently without adding a crate:

```rust
let mut workers = Vec::new();
let request_sn = sn.clone();
let request_work_order = work_order.clone();
for admitted in admitted.started {
    let state = s.clone();
    let items = items.clone();
    let base_vars = base_vars.clone();
    let channel_index = admitted.spec.channel_index;
    let generation = admitted.generation;
    let sn = request_sn.clone();
    let work_order = request_work_order.clone();
    let handle = tokio::spawn(async move {
        let response = run_multi_channel(
            &state.labview_cli,
            &state.labview_getinfo,
            ChannelRunRequest {
                items,
                base_vars,
                channels: vec![admitted.spec],
                resource_locks: state.resource_locks.clone(),
                resource_timeout: std::time::Duration::from_secs(300),
                sn,
                work_order,
                progress: state.sequence_progress.clone(),
                cancel: admitted.cancel,
                run_generation: generation,
            },
        )
        .await;
        state.sequence_cancel.clear_if(channel_index, generation).await;
        state.slot.release_sequence(channel_index, generation).await;
        response
    });
    workers.push((channel_index, generation, handle));
}
```

Iterate the already-spawned `workers` vector, await each handle, flatten its one channel response, sort by `channel_index`, aggregate overall, attach the literal skipped list, and log one request-level result. Because each tuple retains `channel_index` and `generation`, a join panic can mark only that channel `error`, clear its exact cancel entry, and release its exact admission generation.

- [ ] **Step 6: Update force-release sequencing**

`slot_force_release` must first call `sequence_cancel.signal_all()`, then clear only matching live progress entries, and finally call `slot.force_release_all()`. This preserves “cancel visible before admission free.” Update status/busy helpers to report `busy_reason = "sequence"` while the admission state contains sequence holders.

After all force-release call sites and tests use `force_release_all`, remove the temporary single-holder `current_generation_if_busy` and `force_release_if` compatibility methods from Task 1 if no exclusive call site still needs them.

- [ ] **Step 7: Verify all backend API behavior and commit**

Run: `cargo test -p agent api::tests -- --nocapture`

Run: `cargo test -p agent task_slot::tests -- --nocapture`

Run: `cargo test -p agent sequence_session::tests -- --nocapture`

Run: `cargo test -p agent channel_run::tests -- --nocapture`

Expected: all focused backend tests pass, including legacy Delay/REST conflicts, stale teardown, force release, optional body, and channel-unavailable errors.

```bash
git add crates/agent/src/api.rs crates/agent/src/main.rs
git commit -m "feat: run and abort sequence channels independently"
```

---

### Task 5: Derive current and final group information for cards

**Files:**
- Modify: `crates/agent/static/app.js` near `buildSequenceChannelCardModel`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Produces: `buildSequencePositionGroupMap(queue) -> Record<string, { name, enabled, header }>`.
- Extends card model with `currentGroupName`, `currentLabel`, `currentPosition`, and last-step retention.
- Consumes: queue `template_source === "group"`, `name`, `enabled`, and `position`.

- [ ] **Step 1: Add failing group-model tests**

Add tests using literal queue positions:

```javascript
test('channel card maps running and final steps to their named groups', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequencePositionGroupMap'), context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);

  const queue = [
    { position: 0, name: 'Boot' },
    { position: 1, template_source: 'group', name: '校准组', enabled: true },
    { position: 2, name: 'Measure' },
    { position: 3, template_source: 'group', name: '关闭组', enabled: false },
    { position: 4, name: 'Disabled step' },
  ];
  const running = context.buildSequenceChannelCardModel({
    running: true,
    current_position: 2,
    current_name: 'Measure',
    steps: [],
  }, queue);
  const finished = context.buildSequenceChannelCardModel({
    overall: 'pass',
    steps: [{ position: 2, name: 'Measure', status: 'pass' }],
  }, queue);

  assert.equal(running.currentGroupName, '校准组');
  assert.equal(running.currentLabel, '当前步骤 03');
  assert.equal(running.currentName, 'Measure');
  assert.equal(finished.currentGroupName, '校准组');
  assert.equal(finished.currentLabel, '最后步骤 03');
  assert.equal(finished.currentName, 'Measure');
});

test('channel card labels ungrouped and group-header progress without counting headers', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequencePositionGroupMap'), context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);

  const queue = [
    { position: 0, name: 'Boot' },
    { position: 1, template_source: 'group', name: '测试组' },
    { position: 2, name: 'Check' },
  ];
  const boot = context.buildSequenceChannelCardModel({ running: true, current_position: 0, current_name: 'Boot' }, queue);
  const header = context.buildSequenceChannelCardModel({ running: true, current_position: 1, current_name: '测试组' }, queue);

  assert.equal(boot.currentGroupName, '未分组');
  assert.equal(header.currentGroupName, '测试组');
  assert.equal(header.currentLabel, '当前状态');
  assert.equal(header.currentName, '准备下一步骤');
  assert.equal(header.currentPosition, null);
});

test('channel card keeps group context for waits, disabled-group history, and aborts', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('buildSequencePositionGroupMap'), context);
  vm.runInContext(functionSource('buildSequenceChannelCardModel'), context);

  const queue = [
    { position: 0, template_source: 'group', name: '运行组', enabled: true },
    { position: 1, name: 'Wait resource' },
    { position: 2, template_source: 'group', name: '已禁用组', enabled: false },
    { position: 3, name: 'Historical step' },
  ];
  const waiting = context.buildSequenceChannelCardModel({
    overall: 'waiting_resource',
    current_position: 1,
    current_name: 'Wait resource',
    steps: [],
  }, queue);
  const aborted = context.buildSequenceChannelCardModel({
    overall: 'aborted',
    steps: [{ position: 3, name: 'Historical step', status: 'aborted' }],
  }, queue);

  assert.equal(waiting.currentGroupName, '运行组');
  assert.equal(waiting.currentName, 'Wait resource');
  assert.equal(aborted.currentGroupName, '已禁用组');
  assert.equal(aborted.currentLabel, '最后步骤 04');
  assert.equal(aborted.currentName, 'Historical step');
});
```

Production mutation caught: carrying the wrong preceding header or dropping final-step retention changes literal group/label values.

- [ ] **Step 2: Run Node tests and verify RED**

Run: `node --test --test-name-pattern="channel card maps|channel card labels|channel card keeps group" crates/agent/tests/workbench_app_behavior.test.js`

Expected: FAIL because `buildSequencePositionGroupMap` is missing and the card model lacks group fields.

- [ ] **Step 3: Implement the position/group projection**

Add before the card-model function:

```javascript
function buildSequencePositionGroupMap(queue) {
  const map = {};
  let current = { name: '未分组', enabled: true, header: false };
  (Array.isArray(queue) ? queue : []).forEach(function (item, index) {
    item = item || {};
    const position = item.position != null ? item.position : index;
    if (item.template_source === 'group') {
      current = { name: item.name || '未命名组', enabled: item.enabled !== false, header: true };
      map[position] = current;
      return;
    }
    map[position] = { name: current.name, enabled: current.enabled, header: false };
  });
  return map;
}
```

In `buildSequenceChannelCardModel`, use the live `current_position` while running. For a terminal state, choose the last result step with a terminal status and a queue-known position. If the position is a header, expose its group name with `currentPosition: null`, `currentLabel: "当前状态"`, and `currentName: "准备下一步骤"`. If no run data exists, return `currentGroupName: "—"`, `currentLabel: "当前状态"`, and `currentName: "等待运行"`. Do not count group headers in totals.

- [ ] **Step 4: Run all card/detail behavior tests and commit**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: all Node tests pass, including existing group-detail and synthetic CH0 tests.

```bash
git add crates/agent/static/app.js crates/agent/tests/workbench_app_behavior.test.js
git commit -m "feat: show sequence group context on channel cards"
```

---

### Task 6: Merge concurrent channel progress and derive control state

**Files:**
- Modify: `crates/agent/static/app.js` near global sequence state, `channelProgressFromEnvelope`, polling, `runSequence`, and abort handlers
- Test: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Adds state maps: `seqPendingChannelStarts` and `seqPendingChannelAborts`, plus boolean `seqExclusiveBusy` for non-sequence slot owners.
- Produces: `mergeSequenceChannels(current, incoming) -> Array` using `channel_index` and `generation`.
- Produces: `isSequenceChannelRunning(channelIndex)` from backend progress only.
- Produces: `isSequenceChannelActive(channelIndex)` from backend progress plus pending starts.
- Produces: `anySequenceChannelRunning()` and `anySequenceChannelActivity()`.
- Produces: `clearSequenceChannelResults(channelIndexes)` and `sequenceOverallFromChannels(channels)`.
- Produces: `shouldPollSequenceProgress(channels, pendingStarts) -> boolean`.
- Produces: `syncSeqControlsState()` and `reconcileSequenceProgressPoll()`.
- Produces: `refreshSequenceProgress() -> Promise<void>` for initial/page-reload recovery.
- Adds: `abortSequenceChannel(channelIndex) -> Promise<void>`.
- Changes: `runSequence` filters to idle requested channels and no longer exits merely because another channel is running.

- [ ] **Step 1: Add failing merge and control-state tests**

```javascript
test('sequence progress merge preserves unrelated channels and rejects stale generations', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('mergeSequenceChannels'), context);

  const merged = context.mergeSequenceChannels(
    [
      { channel_index: 0, generation: 9, running: true, name: 'CH0' },
      { channel_index: 1, generation: 4, running: false, name: 'CH1 old' },
    ],
    [
      { channel_index: 1, generation: 5, running: true, name: 'CH1 new' },
      { channel_index: 0, generation: 8, running: false, name: 'CH0 stale' },
    ]
  );

  assert.deepEqual(JSON.parse(JSON.stringify(merged)), [
    { channel_index: 0, generation: 9, running: true, name: 'CH0' },
    { channel_index: 1, generation: 5, running: true, name: 'CH1 new' },
  ]);
});

test('channel activity distinguishes backend running from locally pending starts', () => {
  const context = {
    seqChannelProgress: [{ channel_index: 0, running: true }],
    seqPendingChannelStarts: { 1: true },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('isSequenceChannelRunning'), context);
  vm.runInContext(functionSource('isSequenceChannelActive'), context);
  vm.runInContext(functionSource('anySequenceChannelRunning'), context);
  vm.runInContext(functionSource('anySequenceChannelActivity'), context);

  assert.equal(context.isSequenceChannelRunning(0), true);
  assert.equal(context.isSequenceChannelRunning(1), false);
  assert.equal(context.isSequenceChannelRunning(2), false);
  assert.equal(context.isSequenceChannelActive(0), true);
  assert.equal(context.isSequenceChannelActive(1), true);
  assert.equal(context.isSequenceChannelActive(2), false);
  assert.equal(context.anySequenceChannelRunning(), true);
  assert.equal(context.anySequenceChannelActivity(), true);
});
```

Production mutations caught: whole-array replacement drops CH0; ignoring generation accepts `CH0 stale`; ignoring pending state permits a double click.

Add literal aggregate and poll-lifecycle assertions:

```javascript
test('sequence aggregate and polling stay active until the final channel stops', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(functionSource('sequenceOverallFromChannels'), context);
  vm.runInContext(functionSource('shouldPollSequenceProgress'), context);

  assert.equal(context.sequenceOverallFromChannels([
    { running: false, overall: 'pass' },
    { running: true, overall: null },
  ]), 'running');
  assert.equal(context.sequenceOverallFromChannels([
    { running: false, overall: 'pass' },
    { running: false, overall: 'fail' },
  ]), 'fail');
  assert.equal(context.shouldPollSequenceProgress(
    [{ channel_index: 0, running: false }],
    { 1: true }
  ), true);
  assert.equal(context.shouldPollSequenceProgress(
    [{ channel_index: 0, running: false }],
    {}
  ), false);
});
```

`shouldPollSequenceProgress(channels, pendingStarts)` is a pure helper consumed by `reconcileSequenceProgressPoll`.

- [ ] **Step 2: Add failing request and abort behavior tests**

Extend the existing `runSequence` VM test so `seqChannelProgress` contains running CH0, call `runSequence([1])`, and assert one fetch body with `channel_indexes: [1]`. Assert `runSequence([0])` performs no fetch and reports the duplicate.

Add a real fetch-boundary test:

```javascript
test('card abort posts only its channel while top abort uses the global endpoint', async () => {
  const paths = [];
  const context = {
    seqPendingChannelAborts: {},
    isSequenceChannelRunning(index) { return index === 2; },
    fetch: async function (path) {
      paths.push(path);
      return { ok: true, json: async function () { return { ok: true }; } };
    },
    showSeqMsg() {},
    syncSeqControlsState() {},
    reconcileSequenceProgressPoll() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource('abortSequenceChannel'), context);
  vm.runInContext(functionSource('abortSequence'), context);

  await context.abortSequenceChannel(2);
  await context.abortSequence();
  assert.deepEqual(paths, [
    '/api/sequence/run/channels/2/abort',
    '/api/sequence/run/abort',
  ]);
});

test('sequence busy status restores progress instead of globally locking channel cards', () => {
  let refreshes = 0;
  const context = {
    seqExclusiveBusy: false,
    isSequencePageVisible() { return true; },
    refreshSequenceProgress() { refreshes += 1; },
    syncSeqControlsState() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource('syncSequenceBusyFromStatus'), context);

  context.syncSequenceBusyFromStatus({ busy: true, busy_reason: 'sequence' });
  assert.equal(context.seqExclusiveBusy, false);
  assert.equal(refreshes, 1);

  context.syncSequenceBusyFromStatus({ busy: true, busy_reason: 'delay' });
  assert.equal(context.seqExclusiveBusy, true);
});
```

- [ ] **Step 3: Run focused Node tests and verify RED**

Run: `node --test --test-name-pattern="sequence progress merge|channel activity|sequence aggregate|card abort|sequence busy status|explicit card channel" crates/agent/tests/workbench_app_behavior.test.js`

Expected: FAIL on missing merge/activity/abort helpers and the current global `seqRunning` guard.

- [ ] **Step 4: Implement keyed merge and explicit per-channel running state**

Map incoming channels by numeric `channel_index`. Replace an existing entry only when the incoming generation is absent, the existing generation is absent, or `incoming.generation >= existing.generation`. Return a channel-index-sorted array. Change `channelProgressFromEnvelope` to use `running: !!ch.running`; retain the legacy envelope fallback only for old flat responses.

When normalizing a completed POST response, map `ChannelSequenceResponse.run_generation` to the same frontend `generation` field used by progress snapshots before merging.

`applyMultiChannelProgress` must call:

```javascript
seqChannelProgress = mergeSequenceChannels(
  seqChannelProgress,
  channelProgressFromEnvelope(prog, seqRunUsesSyntheticChannel)
);
```

Do not clear unrelated channel entries when one request starts, fails, or completes. `clearSequenceChannelResults(channelIndexes)` filters only matching indexes out of `seqChannelProgress`, leaving sibling live/final entries intact. `sequenceOverallFromChannels` returns `running` when any channel runs, otherwise `fail` when any terminal channel failed/errored/aborted/stopped, otherwise `pass` when at least one terminal channel passed, otherwise no overall. Use that aggregate for the top status after every merge rather than one request envelope's overall.

- [ ] **Step 5: Replace global request locking with derived controls**

`syncSeqControlsState()` derives:

```javascript
const queueEmpty = !sequenceRunQueueItems().length;
const anyRunning = anySequenceChannelRunning();
const anyActivity = anySequenceChannelActivity();
seqRunning = anyActivity;
```

For each card, disable `.seq-channel-card-run` only when `queueEmpty || isSequenceChannelActive(index)`. Disable `.seq-channel-card-abort` unless the backend entry for that exact channel is running, and also disable it while that channel's abort request is pending. Keep the top start enabled when at least one selected channel is inactive. Keep the top abort enabled when `anyRunning`. Disable queue/template mutation controls with `anyActivity`, but do not disable `#seq-channel-pick` checkboxes.

Change `syncSequenceBusyFromStatus` so a sequence busy snapshot triggers a progress refresh rather than globally disabling every card; Delay/REST/version busy still disables starts as an exclusive conflict.

- [ ] **Step 6: Make polling shared and lifecycle-aware**

`startSequenceProgressPoll` becomes idempotent: return when a timer already exists. `reconcileSequenceProgressPoll` starts polling when `anySequenceChannelActivity()` is true and stops only when it is false. Call it after every progress snapshot, start transition, request completion, abort transition, and sequence-page status refresh.

On page entry or a status response with `busy_reason === "sequence"`, fetch `/api/sequence/run/progress` immediately before scheduling the next poll so a reload reconstructs cards.

- [ ] **Step 7: Refactor start and abort requests**

In `runSequence`, resolve requested indexes, remove those for which `isSequenceChannelActive(index)` is true, mark the remaining indexes in `seqPendingChannelStarts`, clear only those channels' previous results, and submit them. In `finally`, clear only those pending keys and reconcile polling; never call a global result clear or unconditional poll stop.

`abortSequenceChannel` URL-encodes the numeric channel index, marks only that key pending, and leaves siblings untouched. `abortSequence` posts the global endpoint and keeps polling until progress reports every channel stopped.

- [ ] **Step 8: Verify frontend state behavior and commit**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Expected: all Node behavior tests pass.

```bash
git add crates/agent/static/app.js crates/agent/tests/workbench_app_behavior.test.js
git commit -m "feat: manage sequence runs per channel"
```

---

### Task 7: Render group/step rows and per-channel abort actions

**Files:**
- Modify: `crates/agent/static/app.js` inside `renderSeqChannelCards` and focus helpers
- Modify: `crates/agent/static/style.css` near `.seq-channel-card-current` and `.seq-channel-card-actions`
- Modify: `crates/agent/tests/static_ui.rs`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`

**Interfaces:**
- Consumes Task 5 card fields: `currentGroupName`, `currentLabel`, `currentName`, `currentElapsedMs`.
- Consumes Task 6 helpers: `isSequenceChannelActive`, `isSequenceChannelRunning`, `abortSequenceChannel`, and `syncSeqControlsState`.
- Adds DOM class: `.seq-channel-card-abort`.
- Adds DOM rows: `.seq-channel-card-current-group` and `.seq-channel-card-current-step`.

- [ ] **Step 1: Add failing rendered-control behavior coverage**

Extend the card-render test fixture so CH0 is running and CH1 is idle. Assert native button state and labels from the rendered fake DOM:

```javascript
assert.equal(ch0.querySelector('.seq-channel-card-run').disabled, true);
assert.equal(ch0.querySelector('.seq-channel-card-abort').disabled, false);
assert.equal(ch1.querySelector('.seq-channel-card-run').disabled, false);
assert.equal(ch1.querySelector('.seq-channel-card-abort').disabled, true);
assert.equal(ch0.querySelector('.seq-channel-card-current-group strong').textContent, '校准组');
assert.equal(ch0.querySelector('.seq-channel-card-current-step strong').textContent, 'Measure');
```

Invoke the CH1 run button and CH0 abort button, then assert the recorded calls are `runSequence([1], false)` and `abortSequenceChannel(0)`. This exercises actual handlers rather than grepping source.

Extend the existing focus tests with abort as a captured kind and assert that a disabled run control prefers the enabled abort control:

```javascript
const abort = { disabled: false, focus(options) { focusCalls.push(['abort', options]); } };
run.disabled = true;
card.querySelector = function (selector) {
  return {
    '.seq-channel-card-body': body,
    '.seq-channel-card-run': run,
    '.seq-channel-card-abort': abort,
    '.seq-channel-card-detail': detail,
  }[selector] || null;
};

context.restoreSequenceChannelCardFocus(host, { channelIndex: '2', kind: 'run' });
assert.deepEqual(JSON.parse(JSON.stringify(focusCalls)), [
  ['abort', { preventScroll: true }],
]);
```

Production mutation caught: using aggregate `seqRunning` disables CH1 and fails the literal state assertion.

- [ ] **Step 2: Run the rendered-card test and verify RED**

Run: `node --test --test-name-pattern="render.*channel card|channel cards.*abort" crates/agent/tests/workbench_app_behavior.test.js`

Expected: FAIL because the abort button and group row are absent and the run button still uses global `seqRunning`.

- [ ] **Step 3: Render the two status rows**

Replace the one-row current block with:

```javascript
const current = document.createElement('div');
current.className = 'seq-channel-card-current';

const groupRow = document.createElement('div');
groupRow.className = 'seq-channel-card-current-row seq-channel-card-current-group';
const groupLabel = document.createElement('span');
groupLabel.textContent = '当前组';
const groupName = document.createElement('strong');
groupName.textContent = model.currentGroupName;
groupRow.append(groupLabel, groupName);

const stepRow = document.createElement('div');
stepRow.className = 'seq-channel-card-current-row seq-channel-card-current-step';
const stepLabel = document.createElement('span');
stepLabel.textContent = model.currentLabel;
const stepName = document.createElement('strong');
stepName.textContent = model.currentName;
const stepTime = document.createElement('span');
stepTime.className = 'mono seq-channel-card-current-time';
stepTime.textContent = model.currentElapsedMs == null ? '—' : formatSequenceElapsed(model.currentElapsedMs);
stepRow.append(stepLabel, stepName, stepTime);
current.append(groupRow, stepRow);
```

- [ ] **Step 4: Render and wire the channel abort button**

Add beside the run action:

```javascript
const abortButton = document.createElement('button');
abortButton.type = 'button';
abortButton.className = 'btn-danger seq-channel-card-abort';
abortButton.textContent = '中止此通道';
abortButton.setAttribute('aria-label', '中止 ' + channelName + ' 通道');
abortButton.disabled = !isSequenceChannelRunning(channel.channel_index);
abortButton.addEventListener('click', function (event) {
  event.stopPropagation();
abortSequenceChannel(channel.channel_index);
});
```

Set the sibling run button with `runButton.disabled = !sequenceRunQueueItems().length || isSequenceChannelActive(channel.channel_index)` so a locally pending double click is also blocked.

Update focus capture/restore with kind `abort`. When a run button becomes disabled after activation, prefer the enabled abort button, then the card body. When an abort button becomes disabled after completion, fall back to the card body.

- [ ] **Step 5: Style the two-row status and three-action footer**

Use bounded grid rows without increasing card width:

```css
.seq-channel-card-current {
  display: grid;
  gap: 0.4rem;
}

.seq-channel-card-current-row {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
}

.seq-channel-card-current-group strong,
.seq-channel-card-current-step strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.seq-channel-card-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.5rem;
}

.seq-channel-card-abort {
  min-height: 2.25rem;
  padding-inline: 0.9rem;
}
```

At `@media (max-width: 640px)`, keep cards one column and use this exact action fallback:

```css
.seq-channel-card-actions {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.seq-channel-card-detail {
  grid-column: 1 / -1;
  justify-self: start;
}
```

- [ ] **Step 6: Update static accessibility/layout contracts**

In `static_ui.rs`, use the existing normalized source strings and assert the new classes/labels plus the mobile action layout. Keep behavior assertions in Node; the Rust static test only protects shipped markup/style contracts:

```rust
assert!(
    app.contains("seq-channel-card-abort")
        && app.contains("中止此通道")
        && app.contains("seq-channel-card-current-group")
        && app.contains("seq-channel-card-current-step")
        && style.contains(".seq-channel-card-current-row")
        && style.contains(".seq-channel-card-abort"),
    "channel cards need per-channel abort and visible group/step context"
);
```

- [ ] **Step 7: Verify UI behavior and commit**

Run: `node --check crates/agent/static/app.js`

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Run: `cargo test -p agent --test static_ui`

Expected: JavaScript syntax and all behavior/static UI tests pass.

```bash
git add crates/agent/static/app.js crates/agent/static/style.css crates/agent/tests/workbench_app_behavior.test.js crates/agent/tests/static_ui.rs
git commit -m "feat: add channel abort and group status to cards"
```

---

### Task 8: Run integrated concurrency and regression verification

**Files:**
- Modify only if a failing regression exposes a defect in a file already listed above.
- Test: all agent and workspace test targets.

**Interfaces:**
- Verifies every interface produced by Tasks 1–7 as one system.

- [ ] **Step 1: Run formatting and syntax checks**

Run: `cargo fmt --all -- --check`

Run: `node --check crates/agent/static/app.js`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 2: Run the frontend suites**

Run: `node --test crates/agent/tests/workbench_app_behavior.test.js`

Run: `cargo test -p agent --test static_ui`

Expected: every Node behavior and Rust static UI test passes.

- [ ] **Step 3: Run focused backend concurrency suites**

Run: `cargo test -p agent -- --nocapture`

Expected: all admission, generation, concurrent progress, resource serialization, API start, per-channel abort, global abort, and force-release tests pass.

- [ ] **Step 4: Run the full workspace**

Run: `cargo test --workspace`

Expected: all workspace tests pass; existing unrelated compiler warnings may remain, but no new warning is introduced by this feature.

- [ ] **Step 5: Inspect the final diff against the approved scope**

Run: `git status --short`

Run: `git diff --stat HEAD~7..HEAD`

Run: `git log -8 --oneline --decorate`

Confirm the diff contains only channel admission/session/API changes, card state/actions/group display, tests, and this plan/design documentation. Confirm no PostgreSQL, scheduler, unrelated worktree, or generated artifact changed.

- [ ] **Step 6: Commit any verification-only correction**

If Step 1–4 required a scoped correction, rerun the failing test first, apply the smallest fix, rerun the affected suite and `cargo test --workspace`, then commit only the affected files:

```bash
git add crates/agent/src crates/agent/static crates/agent/tests
git commit -m "fix: close parallel channel run regressions"
```

If no correction was required, do not create an empty commit.
