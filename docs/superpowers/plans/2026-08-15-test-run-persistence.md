# Test Run Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each station channel's terminal sequence result into atlas-center's local PostgreSQL and let the center list/open those runs.

**Architecture:** Station builds a UUID-keyed payload at channel admission and POSTs it to center after the channel reaches a terminal overall. Center writes immutable rows in `test_runs` + `test_run_context` + `test_run_steps`. Local `sequence_runs/*.json` stays as-is. Center WebUI `#/runs` reads GET APIs only.

**Tech Stack:** Rust (atlas-center, atlas-station), PostgreSQL/sqlx, Axum, React + Ant Design + Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-test-run-persistence-design.md`

## Global Constraints

- Data store is **local PostgreSQL only**. No Camstar / MES / external report DB.
- One `test_runs` row = **one channel terminal result**, not one multi-channel HTTP request.
- Persist is **best-effort**: failure must not change `POST /api/sequence/run` status or body.
- Existing `log_multi_channel_run` file format and timing **do not change**.
- Timestamps are **UTC RFC3339 TEXT** via `chrono::Utc::now().to_rfc3339()`.
- `product_pn` and `corner` are stored as `''` in v1.
- No PATCH/DELETE for runs. No station SN/work-order UI restore. No `/v1`. No auth.
- Center git repo: `C:\Users\zhong\git\Atlas\atlas-center`. Station git repo: `C:\Users\zhong\git\Atlas\atlas-station`.

---

## File map

| File | Responsibility |
|------|----------------|
| `atlas-center/migrations/028_test_runs.sql` | Three tables + indexes |
| `atlas-center/src/db.rs` | Register migration 028 |
| `atlas-center/src/test_runs.rs` | Types + `impl Store` insert/get/list |
| `atlas-center/src/store.rs` | `pub(crate) fn pool()` |
| `atlas-center/src/main.rs` | `mod test_runs;` |
| `atlas-center/src/api.rs` | `POST/GET /api/test-runs` |
| `atlas-center/docs/api.md` | Contract |
| `atlas-station/src/test_run_persist.rs` | Payload build + HTTP POST |
| `atlas-station/src/api.rs` | Admission `run_id` + spawn persist |
| `atlas-center/frontend/src/pages/RunsPage.tsx` | List + detail |
| `atlas-center/frontend/src/pages/runs/runDisplay.ts` | Empty SN → `—` |

---

### Task 1: Migration and store insert/get/list

**Files:**
- Create: `atlas-center/migrations/028_test_runs.sql`
- Create: `atlas-center/src/test_runs.rs`
- Modify: `atlas-center/src/db.rs` (add `apply_migration` for 028 after 027)
- Modify: `atlas-center/src/store.rs` (`pub(crate) fn pool(&self) -> &PgPool`)
- Modify: `atlas-center/src/main.rs` (`mod test_runs;`)
- Test: `atlas-center/src/test_runs.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `Store`, `db::GuardedStore` / `TestDb` migrate path
- Produces:
  - `Store::insert_test_run(NewTestRun) -> Result<InsertTestRunOutcome, sqlx::Error>`
  - `Store::get_test_run(id: &str) -> Result<Option<TestRunDetail>, sqlx::Error>`
  - `Store::list_test_runs(TestRunListQuery) -> Result<TestRunListPage, sqlx::Error>`
  - `Store::agent_exists(id: &str) -> Result<bool, sqlx::Error>` (thin `SELECT 1 FROM agents`)

- [ ] **Step 1: Write the failing store test**

Add `atlas-center/src/test_runs.rs` with types left unimplemented and this test module. The first compile will fail until types exist; write the test first, then the minimum types needed to compile the test, then run it and expect a missing-table / missing-method failure.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

    async fn store() -> crate::db::GuardedStore {
        crate::db::GuardedStore::new().await
    }

    fn sample(agent_id: &str, id: &str, sn: &str, overall: &str, finished_at: &str) -> NewTestRun {
        NewTestRun {
            id: id.into(),
            agent_id: Some(agent_id.into()),
            channel_index: 0,
            channel_name: "CH0".into(),
            sequence_template_id: None,
            run_generation: 7,
            overall: overall.into(),
            stopped: false,
            failed_at: None,
            elapsed_ms: 12,
            started_at: "2026-08-15T14:00:00+00:00".into(),
            finished_at: finished_at.into(),
            context: NewTestRunContext {
                sn: sn.into(),
                work_order: "WO-1".into(),
                product_pn: String::new(),
                corner: String::new(),
                hostname: "ATE01".into(),
                config_revision: Some(3),
                device_profile_id: String::new(),
                device_profile_name: String::new(),
                calibration_profile_id: String::new(),
                calibration_profile_name: String::new(),
            },
            steps: vec![NewTestRunStep {
                position: 1,
                queue_item_id: "q-1".into(),
                template_id: "12".into(),
                template_source: "labview".into(),
                name: "TX_AP".into(),
                kind: "labview".into(),
                ok: true,
                status: "pass".into(),
                elapsed_ms: 10,
                measured: Some(json!({"TX_AP": 1.2})),
                limits: Some(json!([{"output":"TX_AP","min":-2.0,"max":4.0}])),
                result: Some(json!({"TX_AP":"pass"})),
                error: None,
                spec_template_id: Some(1),
                spec_section: "FMT_HT".into(),
            }],
        }
    }

    #[tokio::test]
    async fn insert_then_get_round_trips_steps_and_context() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        let created = store
            .insert_test_run(sample(&agent.id, "run-1", "SN001", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        assert!(created.created);
        let got = store.get_test_run("run-1").await.unwrap().unwrap();
        assert_eq!(got.channel_name, "CH0");
        assert_eq!(got.context.sn, "SN001");
        assert_eq!(got.steps.len(), 1);
        assert_eq!(got.steps[0].spec_section, "FMT_HT");
        assert_eq!(got.steps[0].measured, Some(json!({"TX_AP": 1.2})));
    }

    #[tokio::test]
    async fn second_insert_same_id_is_not_created_and_does_not_overwrite() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        store
            .insert_test_run(sample(&agent.id, "run-dup", "SN001", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        let mut again = sample(&agent.id, "run-dup", "SN999", "fail", "2026-08-15T15:00:00+00:00");
        again.steps.clear();
        let outcome = store.insert_test_run(again).await.unwrap();
        assert!(!outcome.created);
        let got = store.get_test_run("run-dup").await.unwrap().unwrap();
        assert_eq!(got.overall, "pass");
        assert_eq!(got.context.sn, "SN001");
        assert_eq!(got.steps.len(), 1);
    }

    #[tokio::test]
    async fn unknown_sequence_template_id_is_stored_as_null() {
        let store = store().await;
        let agent = store.upsert_agent("n", "1.2.3.4", 9090).await.unwrap();
        let mut run = sample(&agent.id, "run-tpl", "", "pass", "2026-08-15T14:01:00+00:00");
        run.sequence_template_id = Some(999_999);
        let outcome = store.insert_test_run(run).await.unwrap();
        assert!(outcome.created);
        let got = store.get_test_run("run-tpl").await.unwrap().unwrap();
        assert_eq!(got.sequence_template_id, None);
    }

    #[tokio::test]
    async fn list_filters_agent_overall_sn_and_time_and_ignores_empty_sn_param() {
        let store = store().await;
        let a = store.upsert_agent("a", "1.2.3.4", 9090).await.unwrap();
        let b = store.upsert_agent("b", "1.2.3.5", 9090).await.unwrap();
        store
            .insert_test_run(sample(&a.id, "r1", "SN-A", "pass", "2026-08-15T14:01:00+00:00"))
            .await
            .unwrap();
        store
            .insert_test_run(sample(&a.id, "r2", "", "fail", "2026-08-15T14:02:00+00:00"))
            .await
            .unwrap();
        store
            .insert_test_run(sample(&b.id, "r3", "SN-A", "pass", "2026-08-15T14:03:00+00:00"))
            .await
            .unwrap();

        let page = store
            .list_test_runs(TestRunListQuery {
                agent_id: Some(a.id.clone()),
                overall: Some("pass".into()),
                sn: Some("SN-A".into()),
                from: None,
                to: None,
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, "r1");

        let empty_sn = store
            .list_test_runs(TestRunListQuery {
                agent_id: Some(a.id.clone()),
                overall: None,
                sn: Some(String::new()),
                from: None,
                to: None,
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(empty_sn.total, 2);

        let window = store
            .list_test_runs(TestRunListQuery {
                agent_id: None,
                overall: None,
                sn: None,
                from: Some("2026-08-15T14:02:00+00:00".into()),
                to: Some("2026-08-15T14:03:00+00:00".into()),
                limit: 100,
                offset: 0,
            })
            .await
            .unwrap();
        assert_eq!(window.total, 2);
        assert_eq!(window.items[0].id, "r3");
        assert_eq!(window.items[1].id, "r2");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `C:\Users\zhong\git\Atlas\atlas-center`:

```powershell
cargo test --lib test_runs::tests::insert_then_get_round_trips_steps_and_context -- --nocapture
```

Expected: compile error (`insert_test_run` / `NewTestRun` missing) or runtime missing relation `test_runs`.

- [ ] **Step 3: Add migration, `Store::pool`, types, and store methods**

`migrations/028_test_runs.sql`:

```sql
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  channel_index INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  sequence_template_id BIGINT REFERENCES sequence_templates(id) ON DELETE SET NULL,
  run_generation BIGINT NOT NULL,
  overall TEXT NOT NULL,
  stopped BOOLEAN NOT NULL,
  failed_at INTEGER,
  elapsed_ms BIGINT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_runs_finished
  ON test_runs (finished_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_agent_finished
  ON test_runs (agent_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_overall_finished
  ON test_runs (overall, finished_at DESC);

CREATE TABLE IF NOT EXISTS test_run_context (
  test_run_id TEXT PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  sn TEXT NOT NULL DEFAULT '',
  work_order TEXT NOT NULL DEFAULT '',
  product_pn TEXT NOT NULL DEFAULT '',
  corner TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  config_revision BIGINT,
  device_profile_id TEXT NOT NULL DEFAULT '',
  device_profile_name TEXT NOT NULL DEFAULT '',
  calibration_profile_id TEXT NOT NULL DEFAULT '',
  calibration_profile_name TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_test_run_context_sn ON test_run_context (sn);

CREATE TABLE IF NOT EXISTS test_run_steps (
  id BIGSERIAL PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  queue_item_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_source TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  elapsed_ms BIGINT NOT NULL,
  measured_json JSONB,
  limits_json JSONB,
  result_json JSONB,
  error TEXT,
  spec_template_id BIGINT,
  spec_section TEXT NOT NULL DEFAULT '',
  UNIQUE (test_run_id, position)
);

CREATE INDEX IF NOT EXISTS idx_test_run_steps_run_pos
  ON test_run_steps (test_run_id, position);
```

In `db.rs` `migrate`, after 027:

```rust
    apply_migration(
        pool,
        include_str!("../migrations/028_test_runs.sql"),
    )
    .await?;
```

In `Store`:

```rust
    pub(crate) fn pool(&self) -> &sqlx::PgPool {
        &self.pool
    }
```

Implement types and methods in `test_runs.rs`. Required shapes:

```rust
pub struct NewTestRun { /* fields from the test */ }
pub struct NewTestRunContext { /* ... */ }
pub struct NewTestRunStep { /* measured/limits/result: Option<serde_json::Value> */ }
pub struct InsertTestRunOutcome { pub created: bool, pub detail: TestRunDetail }
pub struct TestRunDetail { /* run + context + steps */ }
pub struct TestRunContext { /* same columns as NewTestRunContext */ }
pub struct TestRunStep { /* same as NewTestRunStep + no extras */ }
pub struct TestRunListQuery {
    pub agent_id: Option<String>,
    pub overall: Option<String>,
    pub sn: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: i64,
    pub offset: i64,
}
pub struct TestRunListPage { pub items: Vec<TestRunListItem>, pub total: i64 }
pub struct TestRunListItem {
    pub id: String,
    pub agent_id: Option<String>,
    pub channel_index: i32,
    pub channel_name: String,
    pub sequence_template_id: Option<i64>,
    pub overall: String,
    pub elapsed_ms: i64,
    pub started_at: String,
    pub finished_at: String,
    pub sn: String,
    pub work_order: String,
    pub hostname: String,
}
```

`insert_test_run` rules:

1. If `get_test_run(&id)` is `Some`, return `created: false` and that detail. Do not write.
2. If `sequence_template_id` is `Some` and `SELECT 1 FROM sequence_templates WHERE id=$1` misses, set the value to `None` before insert.
3. Transaction: insert `test_runs` (`created_at = Utc::now().to_rfc3339()`), insert context, insert steps. Bind JSON as text + `::jsonb` (same as `spec_templates`).
4. On unique-violation race, `get_test_run` and return `created: false`.

`list_test_runs`:

- Clamp `limit` to `1..=200` (default 100 if `<= 0`).
- Treat `sn` / `from` / `to` that are `Some("")` as `None`.
- `ORDER BY finished_at DESC, id DESC`.
- `COUNT(*)` with the same WHERE for `total`.

`agent_exists`: `SELECT id FROM agents WHERE id=$1` optional.

- [ ] **Step 4: Run the store tests**

```powershell
cargo test --lib test_runs::tests -- --nocapture
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit in atlas-center**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-center
git add migrations/028_test_runs.sql src/db.rs src/store.rs src/main.rs src/test_runs.rs
git commit -m "feat(center): store channel test runs in postgres"
```

---

### Task 2: Center POST/GET `/api/test-runs`

**Files:**
- Modify: `atlas-center/src/api.rs`
- Test: `atlas-center/src/api.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `Store::insert_test_run`, `get_test_run`, `list_test_runs`, `agent_exists`
- Produces:
  - `POST /api/test-runs` → 201 created / 200 existing / 400 validation
  - `GET /api/test-runs` → `{ items, total }`
  - `GET /api/test-runs/{id}` → detail or 404

- [ ] **Step 1: Write the failing API tests**

Add at the end of `api.rs` tests, using existing `test_app`, `register_agent_id`, `json_request`:

```rust
    fn sample_test_run_body(agent_id: &str, id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "agent_id": agent_id,
            "channel_index": 0,
            "channel_name": "CH0",
            "sequence_template_id": null,
            "run_generation": 1,
            "overall": "pass",
            "stopped": false,
            "failed_at": null,
            "elapsed_ms": 10,
            "started_at": "2026-08-15T14:00:00+00:00",
            "finished_at": "2026-08-15T14:01:00+00:00",
            "context": { "sn": "SN001", "work_order": "WO-1", "hostname": "ATE01" },
            "steps": [{
                "position": 1,
                "queue_item_id": "q-1",
                "template_id": "12",
                "template_source": "labview",
                "name": "TX_AP",
                "kind": "labview",
                "ok": true,
                "status": "pass",
                "elapsed_ms": 8,
                "measured": {"TX_AP": 1.2},
                "limits": [],
                "result": {"TX_AP": "pass"},
                "error": null,
                "spec_template_id": null,
                "spec_section": "FMT_HT"
            }]
        })
    }

    #[tokio::test]
    async fn test_run_post_get_list_and_idempotent() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let body = sample_test_run_body(&agent_id, "api-run-1");

        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app.clone().oneshot(
            Request::builder().uri("/api/test-runs/api-run-1").body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let detail: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(detail["context"]["sn"], "SN001");
        assert_eq!(detail["steps"].as_array().unwrap().len(), 1);

        let resp = app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/test-runs?agent_id={agent_id}&overall=pass&sn=SN001"))
                .body(Body::empty())
                .unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let page: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["id"], "api-run-1");
    }

    #[tokio::test]
    async fn test_run_post_rejects_bad_overall_empty_id_and_unknown_agent() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;

        let mut bad = sample_test_run_body(&agent_id, "x");
        bad["overall"] = serde_json::json!("maybe");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let mut bad = sample_test_run_body(&agent_id, "");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let mut bad = sample_test_run_body("missing-agent", "y");
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &bad)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_run_unknown_sequence_template_still_created() {
        let test = test_app().await;
        let app = &test.router;
        let agent_id = register_agent_id(app).await;
        let mut body = sample_test_run_body(&agent_id, "api-run-tpl");
        body["sequence_template_id"] = serde_json::json!(999999);
        let resp = app.clone().oneshot(json_request("POST", "/api/test-runs", &body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let detail: serde_json::Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert!(detail["sequence_template_id"].is_null());
    }

    #[tokio::test]
    async fn test_run_get_missing_is_404() {
        let test = test_app().await;
        let resp = test.router.clone().oneshot(
            Request::builder().uri("/api/test-runs/nope").body(Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cargo test --lib test_run_post_get_list_and_idempotent -- --nocapture
```

Expected: FAIL (404 on POST, route missing).

- [ ] **Step 3: Implement routes and handlers**

Add to `router()`:

```rust
        .route("/api/test-runs", get(list_test_runs).post(create_test_run))
        .route("/api/test-runs/{id}", get(get_test_run))
```

Request structs (serde, defaults):

```rust
#[derive(Debug, Deserialize)]
struct CreateTestRunRequest {
    id: String,
    agent_id: Option<String>,
    channel_index: i32,
    channel_name: String,
    sequence_template_id: Option<i64>,
    run_generation: i64,
    overall: String,
    stopped: bool,
    failed_at: Option<i32>,
    elapsed_ms: i64,
    started_at: String,
    finished_at: String,
    #[serde(default)]
    context: CreateTestRunContext,
    #[serde(default)]
    steps: Vec<CreateTestRunStep>,
}

#[derive(Debug, Default, Deserialize)]
struct CreateTestRunContext {
    #[serde(default)] sn: String,
    #[serde(default)] work_order: String,
    #[serde(default)] product_pn: String,
    #[serde(default)] corner: String,
    #[serde(default)] hostname: String,
    config_revision: Option<i64>,
    #[serde(default)] device_profile_id: String,
    #[serde(default)] device_profile_name: String,
    #[serde(default)] calibration_profile_id: String,
    #[serde(default)] calibration_profile_name: String,
}

#[derive(Debug, Deserialize)]
struct CreateTestRunStep {
    position: i32,
    queue_item_id: String,
    template_id: String,
    template_source: String,
    name: String,
    kind: String,
    ok: bool,
    status: String,
    #[serde(default)] elapsed_ms: i64,
    measured: Option<serde_json::Value>,
    limits: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<String>,
    spec_template_id: Option<i64>,
    #[serde(default)] spec_section: String,
}

#[derive(Debug, Deserialize)]
struct TestRunListParams {
    agent_id: Option<String>,
    overall: Option<String>,
    sn: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}
```

Validation before insert:

- `id.trim()` empty → 400 `{ "error": "id is required" }`
- `overall` not in `pass|fail|error|aborted` → 400
- `channel_index < 0` → 400
- `started_at` / `finished_at` empty → 400
- `agent_id` present and `!store.agent_exists` → 400 `{ "error": "unknown agent_id" }`

Map request → `NewTestRun`. `insert_test_run`: `created` true → **201**, false → **200**. Serialize detail with `context` object and `steps` (JSON fields named `measured` / `limits` / `result`, not `*_json`).

List: map query to `TestRunListQuery` (`limit` default 100). Return `{ items, total }`.

GET by id: `None` → 404 `{ "error": "test run not found" }`. Store errors → 500 `{ "error": e.to_string() }`.

- [ ] **Step 4: Run API tests**

```powershell
cargo test --lib test_run_ -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit in atlas-center**

```powershell
git add src/api.rs
git commit -m "feat(center): add test-run create and query APIs"
```

---

### Task 3: Station persist payload + HTTP client

**Files:**
- Create: `atlas-station/src/test_run_persist.rs`
- Modify: `atlas-station/src/main.rs` (`mod test_run_persist;`)
- Test: `atlas-station/src/test_run_persist.rs`

**Interfaces:**
- Consumes: `QueueItemForRun`, `ChannelSequenceResponse`, `resolve_agent_id`
- Produces:
  - `TestRunPostBody` (serde, matches center POST)
  - `fn build_test_run_payload(BuildTestRunArgs) -> TestRunPostBody`
  - `async fn post_test_run(client, center_url, body) -> Result<(), String>`
  - `async fn persist_test_run_to_center(client, center_url, hostname, ip, port, body: &mut TestRunPostBody) -> Result<(), String>`

- [ ] **Step 1: Write the failing unit tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::labview_sequence::{QueueItemForRun, SequenceResponse, SequenceStepResult};
    use crate::channel_run::ChannelSequenceResponse;
    use serde_json::json;

    fn item() -> QueueItemForRun {
        QueueItemForRun {
            position: 1,
            queue_item_id: "q-1".into(),
            template_id: "12".into(),
            name: "TX_AP".into(),
            kind: "labview".into(),
            vi_path: "C:/a.vi".into(),
            inputs: json!([]),
            show_front_panel: false,
            timeout_secs: None,
            enabled: true,
            breakpoint: false,
            fail_policy: "stop".into(),
            limits: vec![],
            resources: vec![],
            spec_template_id: Some(1),
            spec_section: "FMT_HT".into(),
            spec_metrics_json: "[]".into(),
        }
    }

    #[test]
    fn build_payload_copies_channel_steps_and_blank_sn() {
        let ch = ChannelSequenceResponse {
            channel_index: 2,
            channel_name: "CH2".into(),
            run_generation: 9,
            response: SequenceResponse {
                stopped: false,
                failed_at: None,
                steps: vec![SequenceStepResult {
                    position: 1,
                    queue_item_id: "q-1".into(),
                    template_id: "12".into(),
                    name: "TX_AP".into(),
                    ok: true,
                    status: "pass".into(),
                    elapsed_ms: 5,
                    measured: Some(json!({"TX_AP": 1.2})),
                    limits: None,
                    result: None,
                    error: None,
                }],
                sn: None,
                work_order: None,
                overall: "pass".into(),
                elapsed_ms: 11,
            },
        };
        let body = build_test_run_payload(BuildTestRunArgs {
            id: "rid".into(),
            agent_id: "agent-1".into(),
            sequence_template_id: Some(12),
            started_at: "2026-08-15T14:00:00+00:00".into(),
            finished_at: "2026-08-15T14:01:00+00:00".into(),
            hostname: "ATE01".into(),
            items: &[item()],
            channel: &ch,
        });
        assert_eq!(body.channel_index, 2);
        assert_eq!(body.overall, "pass");
        assert_eq!(body.context.sn, "");
        assert_eq!(body.context.product_pn, "");
        assert_eq!(body.context.corner, "");
        assert_eq!(body.steps[0].spec_section, "FMT_HT");
        assert_eq!(body.steps[0].template_source, "labview");
    }

    #[test]
    fn build_payload_empty_steps_for_error_channel() {
        let ch = ChannelSequenceResponse {
            channel_index: 0,
            channel_name: "CH0".into(),
            run_generation: 1,
            response: SequenceResponse {
                stopped: true,
                failed_at: None,
                steps: vec![],
                sn: None,
                work_order: None,
                overall: "error".into(),
                elapsed_ms: 0,
            },
        };
        let body = build_test_run_payload(BuildTestRunArgs {
            id: "rid".into(),
            agent_id: "agent-1".into(),
            sequence_template_id: None,
            started_at: "t0".into(),
            finished_at: "t1".into(),
            hostname: "h".into(),
            items: &[],
            channel: &ch,
        });
        assert_eq!(body.overall, "error");
        assert!(body.steps.is_empty());
    }
}
```

- [ ] **Step 2: Run to verify fail**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-station
cargo test --lib test_run_persist::tests::build_payload_copies_channel_steps_and_blank_sn -- --nocapture
```

Expected: FAIL compile (`build_test_run_payload` missing).

- [ ] **Step 3: Implement module**

`TestRunPostBody` / `TestRunPostContext` / `TestRunPostStep` must serialize to the center POST JSON (`measured`/`limits`/`result`, not `*_json`). `template_source`: `general` when the matching queue item has `kind != "labview"` and empty `vi_path`; otherwise `labview` (same rule as `steps_log_json`).

`post_test_run`:

```rust
pub async fn post_test_run(
    client: &reqwest::Client,
    center_url: &str,
    body: &TestRunPostBody,
) -> Result<(), String> {
    let url = format!("{}/api/test-runs", center_url.trim_end_matches('/'));
    let resp = client.post(url).json(body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(format!("persist test run failed: {status} {text}"))
    }
}
```

`persist_test_run_to_center(client, center_url, hostname, ip, port, body: &mut TestRunPostBody)`:

1. `resolve_agent_id(client, center_url, hostname, ip, port).await` — `hostname` is the registered computer name (`AppState.hostname`)
2. On error, return `Err` (caller warns and does not POST)
3. Assign `body.agent_id` and call `post_test_run`

Do **not** call file logging from this module.

- [ ] **Step 4: Run persist tests**

```powershell
cargo test --lib test_run_persist -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit in atlas-station**

```powershell
git add src/test_run_persist.rs src/main.rs
git commit -m "feat(station): build center test-run persist payload"
```

---

### Task 4: Wire persist into station sequence run

**Files:**
- Modify: `atlas-station/src/api.rs`
- Test: `atlas-station/src/api.rs` tests (existing sequence-run helpers + new persist hook)

**Interfaces:**
- Consumes: `build_test_run_payload`, `persist_test_run_to_center`, `TestRunPostBody`
- Produces: `AppState.persist_test_run: Option<TestRunPersistFn>`; admission field `run_id` + `started_at`; each terminal channel enqueues persist

```rust
pub type TestRunPersistFn = std::sync::Arc<
    dyn Fn(crate::test_run_persist::TestRunPostBody) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), String>> + Send>,
        > + Send + Sync,
>;
```

- [ ] **Step 1: Write failing API tests that inject a persist hook**

Add to `AppState`:

```rust
    pub persist_test_run: Option<TestRunPersistFn>,
```

In production `main.rs` AppState construction, set `persist_test_run: None`. In existing test AppState constructors, set `None` first so the crate compiles, then add tests.

Use a shared collector:

```rust
    fn capturing_persist() -> (TestRunPersistFn, Arc<Mutex<Vec<TestRunPostBody>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let hook: TestRunPersistFn = Arc::new(move |body| {
            seen2.lock().unwrap().push(body);
            Box::pin(async { Ok(()) })
        });
        (hook, seen)
    }
```

Tests (adapt to the existing `mount_sequence_run_center` / fake LabVIEW fixtures already in `api.rs`):

1. `sequence_run_persists_each_started_channel` — start one enabled channel; after `POST /api/sequence/run` returns 200, `seen` has one payload with that `channel_index` and `overall`.
2. `sequence_run_still_ok_when_persist_fails` — hook returns `Err("boom")`; HTTP still 200; channel `overall` unchanged.
3. `sequence_run_persists_error_when_worker_panics` — add `force_execution_panic: Option<usize>` to `SequenceLifecycleTestHooks` (channel index). When the inner `execution` spawn starts for that index, `panic!("test persist panic")`. Assert HTTP 200, persist called once, `overall == "error"`, `steps` empty. The `execution.await Err` branch must call the same `enqueue_test_run_persist` as the success path.

- [ ] **Step 2: Run tests to verify they fail**

```powershell
cargo test --lib sequence_run_persists_each_started_channel -- --nocapture
```

Expected: FAIL (field/hook/helper missing).

- [ ] **Step 3: Implement admission id + enqueue**

Extend `AdmittedChannelRun`:

```rust
struct AdmittedChannelRun {
    spec: ChannelSpec,
    generation: u64,
    cancel: watch::Receiver<bool>,
    lease: SequenceAdmissionLease,
    run_id: String,
    started_at: String,
}
```

When pushing an admitted channel:

```rust
run_id: uuid::Uuid::new_v4().to_string(),
started_at: chrono::Utc::now().to_rfc3339(),
```

Add:

```rust
fn enqueue_test_run_persist(
    state: &AppState,
    items: &[crate::labview_sequence::QueueItemForRun],
    sequence_template_id: Option<i64>,
    run_id: String,
    started_at: String,
    channel: &ChannelSequenceResponse,
) {
    let finished_at = chrono::Utc::now().to_rfc3339();
    let mut body = crate::test_run_persist::build_test_run_payload(
        crate::test_run_persist::BuildTestRunArgs {
            id: run_id,
            agent_id: String::new(),
            sequence_template_id,
            started_at,
            finished_at,
            hostname: state.hostname.clone(),
            items,
            channel,
        },
    );
    let hook = state.persist_test_run.clone();
    let client = state.http_client.clone();
    let center_url = state.center_url.clone();
    let hostname = state.hostname.clone();
    let ip = state.ip.clone();
    let port = state.port;
    tokio::spawn(async move {
        let result = if let Some(hook) = hook {
            hook(body).await
        } else {
            crate::test_run_persist::persist_test_run_to_center(
                &client, &center_url, &hostname, &ip, port, &mut body,
            )
            .await
        };
        if let Err(error) = result {
            tracing::warn!(target: "test_run", error = %error, "failed to persist test run");
        }
    });
}
```

Call `enqueue_test_run_persist` in **three** places in `labview_run_sequence`, always before returning the channel into the aggregate, and **never await** the spawn:

1. After `execution.await` `Ok(response)` — for each `response.channels` item (production path is one channel).
2. After `execution.await` `Err` — on the synthesized error `ChannelSequenceResponse`.
3. After supervisor `handle.await` `Err` — on the synthesized error channel.

Do not change `log_multi_channel_run`.

In API tests that construct `AppState`, add `persist_test_run: None` (or the capturing hook). Grep `AppState {` in `api.rs` tests and `main.rs` and fill the new field everywhere.

- [ ] **Step 4: Run station tests**

```powershell
cargo test --lib -- --nocapture
```

Expected: PASS, including the three new persist tests.

- [ ] **Step 5: Commit in atlas-station**

```powershell
git add src/api.rs src/main.rs src/test_run_persist.rs
git commit -m "feat(station): post channel test runs to center"
```

---

### Task 5: Center WebUI `#/runs`

**Files:**
- Create: `atlas-center/frontend/src/pages/runs/runDisplay.ts`
- Create: `atlas-center/frontend/src/pages/runs/runDisplay.test.ts`
- Create: `atlas-center/frontend/src/pages/RunsPage.tsx`
- Modify: `atlas-center/frontend/src/api/types.ts`
- Modify: `atlas-center/frontend/src/api/schedulerApi.ts`
- Modify: `atlas-center/frontend/src/api/schedulerApi.test.ts`
- Modify: `atlas-center/frontend/src/App.tsx`
- Modify: `atlas-center/frontend/src/components/AppShell.tsx`
- Modify: `atlas-center/frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: `GET /api/test-runs`, `GET /api/test-runs/{id}`, `GET /api/agents`
- Produces: `schedulerApi.listTestRuns`, `schedulerApi.getTestRun`; routes `#/runs` and `#/runs/:id`

- [ ] **Step 1: Write failing frontend tests**

`runDisplay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { displayOptional } from './runDisplay';

describe('displayOptional', () => {
  it('shows an em dash when empty', () => {
    expect(displayOptional('')).toBe('—');
    expect(displayOptional(undefined)).toBe('—');
    expect(displayOptional('SN001')).toBe('SN001');
  });
});
```

`schedulerApi.test.ts` add:

```ts
  it('lists test runs with query string', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 }),
    );
    await schedulerApi.listTestRuns({ agent_id: 'a 1', overall: 'pass', sn: 'S N' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/test-runs?agent_id=a%201&overall=pass&sn=S%20N',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
```

In `App.test.tsx` mock:

```ts
    listTestRuns: vi.fn(),
    getTestRun: vi.fn(),
```

In `beforeEach`:

```ts
    vi.mocked(schedulerApi.listTestRuns).mockResolvedValue({
      items: [{
        id: 'run-1',
        agent_id: 'agent-1',
        channel_index: 0,
        channel_name: 'CH0',
        sequence_template_id: 12,
        overall: 'pass',
        elapsed_ms: 12,
        started_at: '2026-08-15T14:00:00+00:00',
        finished_at: '2026-08-15T14:01:00+00:00',
        sn: 'SN001',
        work_order: 'WO-1',
        hostname: 'ATE01',
      }],
      total: 1,
    });
    vi.mocked(schedulerApi.getTestRun).mockResolvedValue({
      id: 'run-1',
      agent_id: 'agent-1',
      channel_index: 0,
      channel_name: 'CH0',
      sequence_template_id: 12,
      run_generation: 1,
      overall: 'pass',
      stopped: false,
      failed_at: null,
      elapsed_ms: 12,
      started_at: '2026-08-15T14:00:00+00:00',
      finished_at: '2026-08-15T14:01:00+00:00',
      created_at: '2026-08-15T14:01:01+00:00',
      context: { sn: '', work_order: '', hostname: 'ATE01' },
      steps: [{
        position: 1, queue_item_id: 'q-1', template_id: '12', template_source: 'labview',
        name: 'TX_AP', kind: 'labview', ok: true, status: 'pass', elapsed_ms: 8,
        measured: { TX_AP: 1.2 }, limits: [], result: {}, error: null,
        spec_template_id: null, spec_section: 'FMT_HT',
      }],
    });
```

Add:

```ts
  it('lists test runs and opens a detail with empty SN as dash', async () => {
    rendered = await renderAt('#/runs');
    await waitFor(() => {
      expect(document.body.textContent).toContain('运行');
      expect(document.body.textContent).toContain('SN001');
      expect(document.body.textContent).toContain('CH0');
    });
    const row = Array.from(document.querySelectorAll('tr')).find((el) =>
      (el.textContent || '').includes('SN001'),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(schedulerApi.getTestRun).toHaveBeenCalledWith('run-1');
      expect(document.body.textContent).toContain('TX_AP');
      expect(document.body.textContent).toContain('—');
    });
  });
```

- [ ] **Step 2: Run frontend tests to verify fail**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-center\frontend
npm test -- src/pages/runs/runDisplay.test.ts src/App.test.tsx src/api/schedulerApi.test.ts
```

Expected: FAIL (`listTestRuns` / `displayOptional` / `#/runs` missing).

- [ ] **Step 3: Implement API client, display helper, pages, nav**

Types in `types.ts`: `TestRunListItem`, `TestRunListPage`, `TestRunDetail` matching GET JSON.

`schedulerApi.listTestRuns(params)` builds query with `URLSearchParams`, omitting empty `agent_id` / `overall` / `sn`.  
`schedulerApi.getTestRun(id)` → `/api/test-runs/${id}`.

`runDisplay.ts`:

```ts
export function displayOptional(value?: string | null): string {
  return value && value.trim() !== '' ? value : '—';
}

export function agentLabel(
  agentId: string | null | undefined,
  agents: { id: string; name: string }[],
  hostname?: string,
): string {
  const found = agents.find((a) => a.id === agentId);
  if (found?.name) return found.name;
  if (hostname && hostname.trim() !== '') return hostname;
  return agentId && agentId.trim() !== '' ? agentId : '—';
}
```

`RunsPage.tsx`:

- If path is `/runs/:id`, show detail (Descriptions + steps Table). Else list.
- List filters: Select 机台 (`listAgents`), Select 总结果 (`pass/fail/error/aborted`), Input SN. Load `listTestRuns` on change.
- Columns: 结束时间 (`formatTimestamp`), 机台 (`agentLabel`), 通道 (`channel_name`), 总结果, SN (`displayOptional`), 耗时 (`elapsed_ms` + ` ms`).
- Row click → `navigate(/runs/${id})`.
- Detail header: channel, overall, times, SN/工单 via `displayOptional`. Steps: 步骤/状态/实测/限值/耗时/错误. JSON cells `JSON.stringify` compact. Back button to `#/runs`.
- No rerun/abort/edit.

`App.tsx` routes:

```tsx
<Route path="/runs" element={<RunsPage />} />
<Route path="/runs/:id" element={<RunsPage />} />
```

`AppShell` items, **between 序列模板 and 机台配置**:

```ts
  { key: '/runs', label: <Link to="/runs">运行</Link> },
```

Selected key: `pathname.startsWith('/runs')` → `/runs`.

- [ ] **Step 4: Run frontend tests**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit in atlas-center**

```powershell
git add frontend/src
git commit -m "feat(center-ui): add test run list and detail pages"
```

---

### Task 6: Docs and spec status

**Files:**
- Modify: `atlas-center/docs/api.md`
- Modify: `atlas-center/README.md`
- Modify: `atlas-station/README.md`
- Modify: `atlas-center/docs/superpowers/specs/2026-08-15-test-run-persistence-design.md` (status → 已批准)

- [ ] **Step 1: Update api.md**

In §0.3 table add:

| `test_runs` | 每通道一次终态（overall / 耗时 / 模板快照） |
| `test_run_context` | 1:1 SN / 工单 / hostname；PN、温度角第一期空串 |
| `test_run_steps` | 逐步实测、限值、Pass/Fail |

Add section **1.x 测试运行** (center):

- `POST /api/test-runs` · 使用方：**Agent 进程** · 201/200/400 as spec
- `GET /api/test-runs` · 使用方：**中心 WebUI** · query `agent_id` `overall` `sn` `from` `to` `limit` `offset`
- `GET /api/test-runs/{id}` · 使用方：**中心 WebUI** · 404 if missing

Copy the JSON examples from the spec. State: no PATCH/DELETE; WebUI does not POST.

- [ ] **Step 2: Update READMEs**

Center README 运行结果 bullet: 终态写入 Postgres `test_runs`；本机 `sequence_runs` JSON 仍是备份。中心 WebUI `#/runs` 可查。

Station README after the browser line:

```text
通道序列终态会 POST 中心 `/api/test-runs`。回写失败只打日志，不影响开测 HTTP 结果。本机 sequence_runs JSON 仍会写。
```

Spec header: `状态：已批准`.

- [ ] **Step 3: There is no automated test for docs.** Read the three files and confirm they match the shipped routes.

- [ ] **Step 4: Commit docs in each repo that changed**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-center
git add docs/api.md README.md docs/superpowers/specs/2026-08-15-test-run-persistence-design.md
git commit -m "docs: document test-run persistence APIs"

cd C:\Users\zhong\git\Atlas\atlas-station
git add README.md
git commit -m "docs: note best-effort test-run persist"
```

---

## Spec coverage

| Spec section | Task |
|--------------|------|
| 5.x tables / indexes / FKs | 1 |
| insert + get + list filters + empty SN | 1 |
| POST 201/200/400, GET list/detail, no DELETE | 2 |
| payload shape, blank PN/corner, steps from queue | 3 |
| admission UUID, spawn persist, panic path, swallow errors, file log unchanged | 4 |
| `#/runs` list/detail, `—` for empty SN | 5 |
| api.md + READMEs | 6 |

## Type names (do not rename later)

`NewTestRun`, `InsertTestRunOutcome`, `TestRunDetail`, `TestRunListQuery`, `TestRunListPage`, `build_test_run_payload`, `BuildTestRunArgs`, `TestRunPostBody`, `persist_test_run_to_center`, `enqueue_test_run_persist`, `TestRunPersistFn`.
