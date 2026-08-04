# Multi-Channel Parallel + Resource Locks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Agent (one station) runs the same sequence template on N channels in parallel, with per-channel variable overlays and named resource locks so shared instruments (e.g. eye diagram) serialize while channel-local steps (e.g. sensitivity) run concurrently.

**Architecture:** Keep a single shared run-queue / sequence template. At run start, expand into N channel workers. Each worker gets `base_vars ∪ channel_overlay ∪ {Channel, ChannelIndex}`. Before each step, acquire `resources[]` from an in-process `ResourceLockManager` (FIFO, timeout); release after the step. Station-level `TaskSlot` becomes a run-session lock (one multi-channel run at a time), not a single-step mutex.

**Tech Stack:** Rust (agent executor, scheduler store/API), Postgres migrations, Agent/Center static WebUI (`app.js`).

## Global Constraints

- 1 Agent = 1 physical station; do **not** spawn one Agent process per channel.
- Sequence content is shared (one run-queue / one template); do **not** duplicate the queue once per channel.
- Channel count default `1` preserves today’s single-flight behavior.
- Variable merge priority (highest wins): **channel overlay > manual variables > active device profile > active calibration profile**.
- Builtin expand keys always set for a channel worker: `Channel` (e.g. `"1"`), `ChannelIndex` (0-based `"0"`).
- Step `resources` is a JSON string array of logical names (e.g. `["station.dca"]`). Empty / missing = no lock (fully parallel across channels).
- Resource lock scope is **in-process on the Agent** (v1). Not distributed across Agents.
- Lock acquire: FIFO waiters, default timeout 300s; on timeout the step fails with status `error` and message mentioning the resource; `fail_policy` then applies for that channel only.
- One channel failure does **not** auto-abort other channels in v1 (each channel has independent overall). Station `overall` is `fail` if any channel failed, else `pass`/`ok`.
- Groups remain UI/enable folders only — not channels and not lock scopes.
- **Remove breakpoints entirely** (UI, API fields still accepted as ignored/default false during migration if needed, executor pause/continue-for-breakpoint path, docs). No `SequencePause`, no `/api/sequence/run/continue` for breakpoints. Keep abort.
- Do not force-push; do not amend pushed commits; commit only when asked or at each task’s commit step during plan execution.

## File map

| File | Responsibility |
|------|----------------|
| Breakpoint removal (Task 0) | Strip pause/continue-breakpoint from agent executor, API, static UI, docs; stop requiring/writing breakpoint as a live feature |
| `crates/scheduler/migrations/022_agent_channels.sql` | `agent_channels` table |
| `crates/scheduler/migrations/023_step_resources.sql` | `resources_json` on queue + template steps |
| `crates/common/src/agent_settings.rs` (or new `channel.rs`) | Shared `AgentChannel` / resources parse types if needed |
| `crates/scheduler/src/store.rs` | Channel CRUD + queue/template fields |
| `crates/scheduler/src/api.rs` | Channel + resources API views / PUT body |
| `crates/agent/src/resource_lock.rs` | Named resource mutex + FIFO + timeout |
| `crates/agent/src/channel_run.rs` | Multi-channel orchestrator wrapping `run_sequence_from_with_opts` |
| `crates/agent/src/settings_defaults.rs` | `merge_channel_overlay` into expand map |
| `crates/agent/src/labview_sequence.rs` | `QueueItemForRun.resources`, acquire/release around `run_one_step` |
| `crates/agent/src/task_slot.rs` | Keep single run-session acquire; document owner `"sequence"` = multi-channel session |
| `crates/agent/src/api.rs` | Run body `channels?`, progress/response by channel |
| `crates/agent/src/sequence_session.rs` | Progress snapshot includes per-channel state |
| `crates/agent/static/{app.js,index.html}` | Channel editor + step resources UI + progress matrix |
| `docs/api.md` | Document channels, resources, multi-channel run |

---

### Task 0: Remove breakpoints entirely

**Files:**
- Modify: `crates/agent/src/labview_sequence.rs` — remove breakpoint pause path; drop `SequencePause` / pause fields from response if unused
- Modify: `crates/agent/src/api.rs` — remove `labview_run_sequence_continue` route (or make it 410 Gone); remove continue handler
- Modify: `crates/agent/src/sequence_session.rs` — remove pause/continue session if only used for breakpoints
- Modify: `crates/agent/static/{app.js,index.html}` — remove breakpoint toggles, continue button, pause UI
- Modify: `crates/scheduler/src/{store.rs,api.rs}` — keep DB column for now (no DROP in v1) but stop surfacing as a first-class editor control; accept `breakpoint` in PUT as ignored/`false`
- Modify: `crates/agent/tests/static_ui.rs`, `docs/api.md`, `README.md` — drop breakpoint docs/asserts
- Test: sequence tests that asserted pause/continue must be deleted or rewritten to expect no pause

**Interfaces:**
- Produces: sequences run straight through; only abort interrupts. No `/api/sequence/run/continue`.
- Consumes: existing queue still may have `breakpoint` column = false historically.

- [ ] **Step 1: Grep and list all breakpoint/pause/continue touchpoints; write failing test that continue route is gone or returns 410**

- [ ] **Step 2: Remove executor pause branch and continue API; strip UI controls**

- [ ] **Step 3: Update docs + static_ui asserts; run focused agent/scheduler tests**

- [ ] **Step 4: Commit**

```bash
git add crates/agent crates/scheduler docs/api.md README.md
git commit -m "$(cat <<'EOF'
feat: remove sequence breakpoints and continue/pause path

EOF
)"
```

---

### Task 1: Migration + store for `agent_channels`

**Files:**
- Create: `crates/scheduler/migrations/022_agent_channels.sql`
- Modify: `crates/scheduler/src/store.rs` — add `AgentChannel` struct + CRUD
- Modify: `crates/scheduler/src/api.rs` — list/upsert/delete endpoints
- Test: unit tests in `store.rs` or `api.rs` (follow existing profile CRUD pattern)

**Interfaces:**
- Produces:
  - Table `agent_channels(id TEXT PK, agent_id TEXT FK, channel_index INT NOT NULL, name TEXT NOT NULL, enabled BOOL NOT NULL DEFAULT TRUE, overlay_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL)`
  - Unique `(agent_id, channel_index)`
  - `Store::list_agent_channels(agent_id) -> Vec<AgentChannel>`
  - `Store::replace_agent_channels(agent_id, items: Vec<AgentChannelUpsert>) -> Result<Vec<AgentChannel>, …>` (full replace, like settings)
  - `AgentChannel { id, agent_id, channel_index, name, enabled, overlay: Value, updated_at }`
  - Overlay is a flat JSON object of string values only in v1: `{"EVB_Setting_IP_Add":"10.0.0.1","Port":"1"}` (keys = expand names)

- [ ] **Step 1: Write failing store test**

```rust
#[tokio::test]
async fn replace_agent_channels_roundtrip() {
    let store = test_store().await;
    let agent_id = seed_agent(&store).await;
    store
        .replace_agent_channels(
            &agent_id,
            vec![
                AgentChannelUpsert {
                    channel_index: 0,
                    name: "CH1".into(),
                    enabled: true,
                    overlay: json!({"Port": "1"}),
                },
                AgentChannelUpsert {
                    channel_index: 1,
                    name: "CH2".into(),
                    enabled: true,
                    overlay: json!({"Port": "2"}),
                },
            ],
        )
        .await
        .unwrap();
    let list = store.list_agent_channels(&agent_id).await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].overlay["Port"], "1");
    assert_eq!(list[1].name, "CH2");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p scheduler replace_agent_channels_roundtrip -- --nocapture`  
Expected: FAIL — type/migration missing.

- [ ] **Step 3: Add migration + store + API**

Migration:

```sql
CREATE TABLE IF NOT EXISTS agent_channels (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  overlay_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_channels_agent_index_uidx
  ON agent_channels (agent_id, channel_index);

CREATE INDEX IF NOT EXISTS agent_channels_agent_id_idx
  ON agent_channels (agent_id);
```

API (mirror device-profiles style):
- `GET /api/agents/{id}/channels`
- `PUT /api/agents/{id}/channels` body `{ "channels": [ { "channel_index", "name", "enabled", "overlay" } ] }`

Agent proxy:
- `GET/PUT /api/channels` → Center

Empty list means “implicit single channel 0 with empty overlay” at runtime (Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p scheduler replace_agent_channels_roundtrip -- --nocapture`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/migrations/022_agent_channels.sql crates/scheduler/src/store.rs crates/scheduler/src/api.rs crates/agent/src/api.rs crates/agent/src/register.rs
git commit -m "$(cat <<'EOF'
feat: add per-agent channel overlays table and API

EOF
)"
```

---

### Task 2: `resources_json` on queue + template steps

**Files:**
- Create: `crates/scheduler/migrations/023_step_resources.sql`
- Modify: `crates/scheduler/src/store.rs` — `ViRunQueueItem.resources_json`, `SequenceTemplateStep.resources_json`, replace/load paths
- Modify: `crates/scheduler/src/api.rs` — `ViRunQueueItemView.resources: Vec<String>`, PUT accept `resources`
- Modify: `crates/agent/src/labview_sequence.rs` — `QueueItemForRun.resources: Vec<String>`
- Test: queue PUT roundtrip includes resources

**Interfaces:**
- Produces:
  - Column `resources_json TEXT NOT NULL DEFAULT '[]'` on `vi_run_queue_items` and `sequence_template_steps`
  - Parse helper `fn parse_resources_json(s: &str) -> Result<Vec<String>, String>` — must be array of non-empty strings; normalize trim; reject duplicates within one step
  - Resource name charset: `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` (examples: `station.dca`, `ch.evb`)

- [ ] **Step 1: Write failing API/store test**

```rust
#[tokio::test]
async fn run_queue_put_persists_resources() {
    // seed agent + labview template, PUT queue item with resources: ["station.dca"]
    // GET and assert resources == ["station.dca"]
}
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cargo test -p scheduler run_queue_put_persists_resources -- --nocapture`

- [ ] **Step 3: Migration + wire through store/api/agent parse**

```sql
ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS resources_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS resources_json TEXT NOT NULL DEFAULT '[]';
```

In `queue_items_for_run`, read `resources` / `resources_json` into `QueueItemForRun.resources`.  
Template load-to-agent copies `resources_json`.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler/migrations/023_step_resources.sql crates/scheduler/src/store.rs crates/scheduler/src/api.rs crates/agent/src/labview_sequence.rs
git commit -m "$(cat <<'EOF'
feat: persist step resources_json on queue and templates

EOF
)"
```

---

### Task 3: `ResourceLockManager` (FIFO + timeout)

**Files:**
- Create: `crates/agent/src/resource_lock.rs`
- Modify: `crates/agent/src/main.rs` / `lib` module tree — `mod resource_lock;`
- Modify: `crates/agent/src/api.rs` `AppState` — `resource_locks: Arc<ResourceLockManager>`
- Test: in `resource_lock.rs` `#[cfg(test)]`

**Interfaces:**
- Produces:

```rust
pub struct ResourceLockManager { /* mutex + per-resource WaitQueue */ }

pub struct ResourceGuard { /* Drop releases all held */ }

impl ResourceLockManager {
    pub fn new() -> Arc<Self>;
    /// Acquire all `names` (sorted + deduped to avoid deadlock: always lock in lexicographic order).
    /// Waits FIFO per resource. Returns Err on timeout or cancel.
    pub async fn acquire(
        &self,
        names: &[String],
        owner: &str,           // e.g. "ch-1"
        timeout: Duration,
        cancel: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> Result<ResourceGuard, ResourceLockError>;
}

pub enum ResourceLockError {
    Timeout { resource: String },
    Cancelled,
}
```

Deadlock avoidance: sort resource names before acquire; hold all-or-wait (do not partially hold across channels without ordering).

- [ ] **Step 1: Write failing unit tests**

```rust
#[tokio::test]
async fn second_acquirer_waits_until_release() {
    let m = ResourceLockManager::new();
    let g1 = m.acquire(&["station.dca".into()], "ch-1", Duration::from_secs(5), None).await.unwrap();
    let m2 = m.clone();
    let h = tokio::spawn(async move {
        m2.acquire(&["station.dca".into()], "ch-2", Duration::from_secs(5), None).await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!h.is_finished());
    drop(g1);
    assert!(h.await.unwrap().is_ok());
}

#[tokio::test]
async fn acquire_times_out() {
    let m = ResourceLockManager::new();
    let _g = m.acquire(&["station.dca".into()], "ch-1", Duration::from_secs(30), None).await.unwrap();
    let err = m.acquire(&["station.dca".into()], "ch-2", Duration::from_millis(30), None).await.unwrap_err();
    assert!(matches!(err, ResourceLockError::Timeout { .. }));
}

#[tokio::test]
async fn empty_resources_is_noop() {
    let m = ResourceLockManager::new();
    let g = m.acquire(&[], "ch-1", Duration::from_secs(1), None).await.unwrap();
    drop(g);
}
```

- [ ] **Step 2: Run tests — expect FAIL** (module missing)

Run: `cargo test -p agent resource_lock -- --nocapture`

- [ ] **Step 3: Implement `resource_lock.rs` and wire into `AppState`**

Use `tokio::sync::{Mutex, Notify}` or a small waiter list per resource. Prefer Notify + queue of oneshots for FIFO.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/resource_lock.rs crates/agent/src/main.rs crates/agent/src/api.rs
git commit -m "$(cat <<'EOF'
feat: add FIFO resource lock manager on Agent

EOF
)"
```

---

### Task 4: Channel overlay merge + expand map helper

**Files:**
- Modify: `crates/agent/src/settings_defaults.rs`
- Test: existing module tests

**Interfaces:**
- Produces:

```rust
pub fn apply_channel_overlay(
    base: &HashMap<String, String>,
    channel_index: usize,
    channel_name: &str,
    overlay: &serde_json::Value, // object of string|number|bool → stringified
) -> HashMap<String, String> {
    // clone base, insert overlay keys, then:
    // map.insert("Channel".into(), channel_name_or_index_display);
    // map.insert("ChannelIndex".into(), channel_index.to_string());
}
```

Display for `Channel`: prefer `channel_name` if non-empty, else `(channel_index + 1).to_string()`.

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn channel_overlay_overrides_device_and_sets_builtins() {
    let mut base = HashMap::new();
    base.insert("Port".into(), "0".into());
    base.insert("DCA_IP".into(), "10.0.0.9".into());
    let map = apply_channel_overlay(&base, 1, "CH2", &json!({"Port": "2"}));
    assert_eq!(map.get("Port").map(String::as_str), Some("2"));
    assert_eq!(map.get("DCA_IP").map(String::as_str), Some("10.0.0.9"));
    assert_eq!(map.get("Channel").map(String::as_str), Some("CH2"));
    assert_eq!(map.get("ChannelIndex").map(String::as_str), Some("1"));
}
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `apply_channel_overlay`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/settings_defaults.rs
git commit -m "$(cat <<'EOF'
feat: merge channel overlay into expand variable map

EOF
)"
```

---

### Task 5: Acquire/release around each step in sequence runner

**Files:**
- Modify: `crates/agent/src/labview_sequence.rs` — `SequenceRunOpts` + loop
- Test: optional integration with mock step runner; at minimum unit-test that empty resources skip lock

**Interfaces:**
- Extends:

```rust
pub struct SequenceRunOpts {
    // existing fields...
    pub resource_locks: Option<Arc<ResourceLockManager>>,
    pub resource_owner: String,              // "ch-0"
    pub resource_timeout: Duration,          // default 300s
    pub cancel: Option<watch::Receiver<bool>>,
}
```

In `run_sequence_from_with_opts`, immediately before `run_one_step` (after skip/breakpoint checks):

```rust
let _guard = if let Some(locks) = &opts.resource_locks {
    if !item.resources.is_empty() {
        match locks.acquire(&item.resources, &opts.resource_owner, opts.resource_timeout, opts.cancel.clone()).await {
            Ok(g) => Some(g),
            Err(e) => { /* push SequenceStepResult status=error, apply fail_policy; continue/break */ }
        }
    } else { None }
} else { None };
// run_one_step(...); guard drops at end of iteration
```

Progress status while waiting: set step status hint `"waiting_resource"` in progress slot if easy; else leave as not-started until acquired (document in api.md).

- [ ] **Step 1: Write a focused test with a fake async step** (if current runner is hard to inject, add `#[cfg(test)]` hook or test `ResourceLockManager` integration via a small helper `run_with_resources`). Prefer extracting:

```rust
pub async fn with_step_resources<F, Fut, T>(
    locks: Option<&ResourceLockManager>,
    resources: &[String],
    owner: &str,
    timeout: Duration,
    cancel: Option<watch::Receiver<bool>>,
    f: F,
) -> Result<T, ResourceLockError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
```

Test: two concurrent `with_step_resources` on same name serialize.

- [ ] **Step 2: Run — expect FAIL / wire missing**

- [ ] **Step 3: Implement helper + call site in sequence loop**

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/labview_sequence.rs
git commit -m "$(cat <<'EOF'
feat: acquire step resources before each sequence step

EOF
)"
```

---

### Task 6: Multi-channel orchestrator

**Files:**
- Create: `crates/agent/src/channel_run.rs`
- Modify: `crates/agent/src/api.rs` — `labview_run_sequence` uses orchestrator
- Modify: `crates/agent/src/sequence_session.rs` — progress shape
- Test: `channel_run` unit test with 2 channels, mock/no-op steps if possible; otherwise test planning/merge only + manual note

**Interfaces:**
- Produces:

```rust
pub struct ChannelRunRequest {
    pub items: Vec<QueueItemForRun>,
    pub base_vars: HashMap<String, String>,
    pub channels: Vec<ChannelSpec>, // enabled only; if empty → one synthetic CH index 0
    pub resource_locks: Arc<ResourceLockManager>,
    pub resource_timeout: Duration,
    pub sn: Option<String>,
    pub work_order: Option<String>,
    pub progress: Arc<SequenceProgressSlot>,
    pub cancel: watch::Receiver<bool>,
}

pub struct ChannelSpec {
    pub channel_index: usize,
    pub name: String,
    pub overlay: Value,
}

pub struct ChannelSequenceResponse {
    pub channel_index: usize,
    pub channel_name: String,
    pub response: SequenceResponse,
}

pub struct MultiChannelSequenceResponse {
    pub channels: Vec<ChannelSequenceResponse>,
    pub overall: String, // fail if any channel fail/error/stop-fail; else pass
    pub sn: Option<String>,
    pub work_order: Option<String>,
}

pub async fn run_multi_channel(req: ChannelRunRequest) -> MultiChannelSequenceResponse;
```

Behavior:
1. Still require `TaskSlot.try_acquire("sequence")` once for the whole multi-channel session.
2. Spawn one tokio task per enabled channel (or `futures::future::join_all`).
3. Each task: `vars = apply_channel_overlay(&base, …)`; call `run_sequence_from_with_opts` with per-channel `resource_owner`.
4. Abort: set cancel flag; workers should stop between steps / while waiting on lock.
5. Progress JSON: `{ "channels": [ { "channel_index", "name", "steps": [...], "overall" } ] }` so UI can poll a matrix.

Backward compatible single-channel: if channels table empty or only one enabled, prefer **always** wrap in multi envelope once UI is updated (Task 7), and document in `api.md`.

- [ ] **Step 1: Write failing test for overall aggregation**

```rust
#[test]
fn multi_overall_fails_if_any_channel_fails() {
    assert_eq!(aggregate_overall(&["pass", "fail"]), "fail");
    assert_eq!(aggregate_overall(&["pass", "pass"]), "pass");
}
```

- [ ] **Step 2: Implement `channel_run.rs` + wire `labview_run_sequence`**

Load channels via Agent proxy `GET /api/channels` (or include in settings payload — prefer dedicated GET already from Task 1).  
Run body optional filter:

```json
{ "sn": "...", "work_order": "...", "channel_indexes": [0, 2] }
```

If `channel_indexes` omitted → all enabled.

- [ ] **Step 3: Wire abort cancel to all channel workers (no breakpoint/continue — already removed in Task 0)**

- [ ] **Step 4: Tests + commit**

```bash
git add crates/agent/src/channel_run.rs crates/agent/src/api.rs crates/agent/src/sequence_session.rs crates/agent/src/main.rs
git commit -m "$(cat <<'EOF'
feat: run sequence across channels with shared resource locks

EOF
)"
```

---

### Task 7: Agent UI — channels + step resources + progress matrix

**Files:**
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/style.css` (minimal)
- Modify: `crates/agent/tests/static_ui.rs`
- Modify: `docs/api.md`

**Interfaces / UX:**
- Config page new section **通道** (near device/cal): table of channel_index, name, enabled, overlay key/value editor (flat), Save → `PUT /api/channels`.
- Sequence step editor: multi-select or tag input **资源** bound to `resources` array; presets datalist: `station.dca`, `station.osa`, `ch.evb` (free-text allowed if valid charset).
- Run panel: show channel checkboxes (enabled channels); progress table rows = channels, columns = steps (or nested lists).
- Help text: “共用仪表填相同资源名，例如 station.dca；通道私有步骤留空即可并行。”

- [ ] **Step 1: static_ui asserts for new helpers/DOM ids**

```rust
assert!(APP.contains("loadAgentChannels") && APP.contains("saveAgentChannels"));
assert!(APP.contains("resources") || HTML.contains("step-resources"));
```

- [ ] **Step 2: Implement UI + docs**

- [ ] **Step 3: `cargo test -p agent --test static_ui` PASS**

- [ ] **Step 4: Commit**

```bash
git add crates/agent/static crates/agent/tests/static_ui.rs docs/api.md
git commit -m "$(cat <<'EOF'
feat: UI for channel overlays, step resources, and multi-channel progress

EOF
)"
```

---

### Task 8: End-to-end verification checklist (manual)

**Files:** none (or short note in `docs/api.md` examples)

- [ ] **Step 1: Configure 4 channels** with different `Port` / IP overlay; shared device profile has `DCA_IP`.

- [ ] **Step 2: Sequence**
  - Step A (灵敏度): `resources = []`, inputs use `${Port}` / channel IP.
  - Step B (眼图): `resources = ["station.dca"]`, inputs use `${DCA_IP}`.

- [ ] **Step 3: Run all 4 channels**
  - Expect: Step A timestamps overlap across channels.
  - Expect: Step B non-overlapping (serialized by lock); waiting channels show wait or delayed start.

- [ ] **Step 4: Force long hold** — run eye step with long timeout on CH1; CH2–4 wait then proceed after CH1 finishes; abort cancels waiters.

- [ ] **Step 5: Regression** — 0 channels configured → behaves as single channel (index 0, empty overlay), same as today for one-queue runs.

---

## Self-review

| Spec requirement | Task |
|------------------|------|
| Remove breakpoints | Task 0 |
| 4 channels parallel start, same sequence | Task 6 |
| Per-channel different addresses/inputs | Task 1 + 4 |
| Eye diagram shared → one at a time | Task 2 + 3 + 5 |
| Sensitivity parallel | empty `resources` |
| 1 Agent = 1 station | Global + Task 6 session slot |
| Default single-channel compatible | empty channels → synthetic CH0 |

No TBD placeholders left for core path. Explicit v1 limits: no multi-Agent distributed locks; channel failure does not abort siblings.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-multi-channel-parallel-resource-locks.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
