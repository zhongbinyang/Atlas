# Agent Screenshot (Center View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators capture an Agent’s primary-monitor desktop as PNG via the scheduler WebUI, proxying through the center, and permanently archive each success on disk with SQLite metadata.

**Architecture:** Agent exposes `GET /api/screenshot` (Windows primary display → PNG). Scheduler `POST /api/agents/{id}/screenshots` fetches that URL with the existing timed reqwest client, enforces a 20 MiB cap and PNG magic-bytes check, writes `data/screenshots/{agent_id}/{id}.png`, inserts `screenshots` row, and serves history + image for the Chinese WebUI.

**Tech Stack:** Existing Axum/SQLx/Tokio workspace; Agent capture via `xcap` + PNG encode; scheduler filesystem + SQLite metadata.

**Spec:** `docs/superpowers/specs/2026-07-15-agent-screenshot-design.md`

## Global Constraints

- On-demand capture only (no auto-refresh)
- Primary monitor only
- Permanent archive; no auto-delete
- Browser talks only to scheduler `:26630` (center proxies Agent)
- Image format PNG; max body **20 MiB** (`20 * 1024 * 1024`)
- Paths relative to scheduler CWD: `data/screenshots/{agent_id}/{id}.png`
- List API: `GET .../screenshots?limit=&offset=` → `{ "items": [...], "total": N }`; default `limit=50`, `offset=0`, `limit` max **200**
- No auth / no TLS; Windows Agent only for capture
- Chinese WebUI labels; do not add Agent local WebUI screenshot UI (v1)
- Atomicity: write file then INSERT; on INSERT failure delete file
- Connection failures → HTTP **503**; invalid/non-PNG/oversize/agent error → **502**; missing agent → **404**

---

## File Structure

```text
crates/agent/src/capture.rs          # NEW — primary display → PNG bytes
crates/agent/src/api.rs              # ADD route GET /api/screenshot
crates/agent/src/main.rs             # mod capture
crates/agent/Cargo.toml              # xcap, image (or png) deps
crates/scheduler/migrations/002_screenshots.sql   # NEW
crates/scheduler/src/db.rs           # run 002 after 001
crates/scheduler/src/config.rs       # screenshot_dir
crates/scheduler/src/store.rs        # Screenshot CRUD
crates/scheduler/src/screenshot.rs   # NEW — fetch Agent + persist
crates/scheduler/src/api.rs          # screenshot routes; AppState + client/dir
crates/scheduler/src/main.rs         # wire AppState fields
crates/scheduler/static/index.html   # buttons + modal/history
crates/scheduler/static/app.js
crates/scheduler/static/style.css
README.md                            # Chinese docs for feature
```

| Path | Responsibility |
|------|----------------|
| `capture.rs` | `capture_primary_png() -> Result<Vec<u8>, String>` |
| `002_screenshots.sql` | `screenshots` table + index |
| `screenshot.rs` | `capture_and_archive(store, client, dir, agent_id) -> Result<ScreenshotMeta, CaptureError>` |
| `store` screenshot methods | insert / list_page / get / count |
| WebUI | 截图 / 历史 UX |

---

### Task 1: Agent primary-display capture + `GET /api/screenshot`

**Files:**
- Create: `crates/agent/src/capture.rs`
- Modify: `crates/agent/Cargo.toml`
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/main.rs`
- Test: `crates/agent/src/capture.rs` / `api.rs` (`#[cfg(all(test, windows))]`)

**Interfaces:**
- Consumes: none from scheduler
- Produces: `pub fn capture_primary_png() -> Result<Vec<u8>, String>`; route `GET /api/screenshot` → `200 image/png` or JSON `ErrorBody`

- [ ] **Step 1: Add dependencies**

In `crates/agent/Cargo.toml`:

```toml
xcap = "0.0.14"
image = { version = "0.25", default-features = false, features = ["png"] }
```

(If `xcap` version resolves differently on crates.io, pin the latest compatible 0.x that builds on Windows.)

- [ ] **Step 2: Write failing test for PNG magic bytes (Windows)**

`crates/agent/src/capture.rs`:

```rust
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn capture_primary_returns_png_magic() {
        let bytes = capture_primary_png().expect("capture");
        assert!(bytes.len() > 8);
        assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n");
    }
}
```

Also add stub `pub fn capture_primary_png() -> Result<Vec<u8>, String> { Err("not implemented".into()) }` so the test compiles and fails.

- [ ] **Step 3: Run test (expect FAIL)**

Run: `cargo test -p agent capture:: -- --nocapture`

Expected: FAIL with capture error or assertion failure.

- [ ] **Step 4: Implement capture**

```rust
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use xcap::Monitor;

pub fn capture_primary_png() -> Result<Vec<u8>, String> {
    let monitors = Monitor::all().map_err(|e| format!("list monitors: {e}"))?;
    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| Monitor::all().ok().and_then(|mut v| v.drain(..).next()))
        .ok_or_else(|| "no monitor found".to_string())?;

    let img = primary
        .capture_image()
        .map_err(|e| format!("capture failed: {e}"))?;

    let mut buf = Vec::new();
    {
        let encoder = PngEncoder::new(&mut buf);
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("png encode: {e}"))?;
    }
    Ok(buf)
}
```

Adjust `xcap` / `image` APIs to match the resolved crate versions (primary API may be `is_primary()` boolean field — adapt in implementation). Prefer explicitly selecting the primary monitor; if API lacks primary flag, document fallback to monitor index 0 and keep behavior “primary when available”.

- [ ] **Step 5: Wire HTTP handler**

In `api.rs` router add:

```rust
.route("/api/screenshot", get(screenshot))
```

```rust
async fn screenshot() -> impl IntoResponse {
    match tokio::task::spawn_blocking(crate::capture::capture_primary_png).await {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "image/png")],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody { error: e }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("capture join: {e}"),
            }),
        )
            .into_response(),
    }
}
```

Add `mod capture;` in `main.rs`.

- [ ] **Step 6: Run tests**

Run: `cargo test -p agent`

Expected: PASS (Windows capture test + existing suite).

- [ ] **Step 7: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): add primary-monitor PNG screenshot API"
```

---

### Task 2: Scheduler migration + screenshot store

**Files:**
- Create: `crates/scheduler/migrations/002_screenshots.sql`
- Modify: `crates/scheduler/src/db.rs`
- Modify: `crates/scheduler/src/store.rs`
- Modify: `crates/scheduler/src/config.rs`
- Test: store tests in `store.rs`

**Interfaces:**
- Consumes: SQLite pool
- Produces:
  - `SchedulerConfig.screenshot_dir: String` (default `data/screenshots`, env `SCHEDULER_SCREENSHOT_DIR`)
  - `struct Screenshot { id, agent_id, file_path, content_type, byte_size, width, height, created_at }`
  - `Store::insert_screenshot(...)`
  - `Store::count_screenshots(agent_id) -> i64`
  - `Store::list_screenshots(agent_id, limit, offset) -> Vec<Screenshot>`
  - `Store::get_screenshot(id) -> Option<Screenshot>`

- [ ] **Step 1: Migration SQL**

`002_screenshots.sql`:

```sql
CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_screenshots_agent_created
  ON screenshots(agent_id, created_at DESC);
```

Update `db.rs`:

```rust
    for sql in [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/002_screenshots.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await?;
    }
```

- [ ] **Step 2: Config field**

```rust
screenshot_dir: std::env::var("SCHEDULER_SCREENSHOT_DIR")
    .unwrap_or_else(|_| "data/screenshots".into()),
```

- [ ] **Step 3: Failing store test**

```rust
#[tokio::test]
async fn insert_and_list_screenshots() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}", dir.path().join("t.db").display());
    let pool = crate::db::connect(&url).await.unwrap();
    let store = Store::new(pool);
    let agent = store.upsert_agent("n", "1.2.3.4", 26631).await.unwrap();
    let meta = store
        .insert_screenshot(
            &agent.id,
            "data/screenshots/x/y.png",
            "image/png",
            12,
            Some(1),
            Some(1),
        )
        .await
        .unwrap();
    let total = store.count_screenshots(&agent.id).await.unwrap();
    assert_eq!(total, 1);
    let page = store.list_screenshots(&agent.id, 50, 0).await.unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].id, meta.id);
    assert!(store.get_screenshot(&meta.id).await.unwrap().is_some());
}
```

- [ ] **Step 4: Implement store methods** (UUID + chrono now for `created_at`, same patterns as tasks)

- [ ] **Step 5: Run tests**

Run: `cargo test -p scheduler store::`

Expected: PASS including new test.

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): add screenshots table and store"
```

---

### Task 3: Scheduler capture service + REST API

**Files:**
- Create: `crates/scheduler/src/screenshot.rs`
- Modify: `crates/scheduler/src/api.rs`
- Modify: `crates/scheduler/src/main.rs`
- Test: `screenshot.rs` and/or `api.rs` with mock agent + tempfile dir

**Interfaces:**
- Consumes: `Store`, `reqwest::Client`, `screenshot_dir: PathBuf/String`, agent id
- Produces: routes listed in spec; `pub const MAX_SCREENSHOT_BYTES: usize = 20 * 1024 * 1024;`
- `AppState { store, client, screenshot_dir }`

- [ ] **Step 1: Extend AppState and main**

```rust
pub struct AppState {
    pub store: Store,
    pub client: reqwest::Client,
    pub screenshot_dir: String,
}
```

In `main.rs` pass `client.clone()` and `cfg.screenshot_dir` into `AppState`. Update existing API tests that construct `AppState { store }` to include dummy client + temp dir.

- [ ] **Step 2: Write failing integration test — happy path**

Spin mock Axum agent:

```rust
async fn mock_shot() -> impl IntoResponse {
    // minimal valid 1x1 PNG bytes constant
    ([(header::CONTENT_TYPE, "image/png")], MINIMAL_PNG)
}
```

Register agent in temp DB; set mock listen addr into agent ip/port; call `POST /api/agents/{id}/screenshots` via oneshot; assert:

- status 200
- JSON has `id`
- file exists under temp `screenshot_dir`
- `GET /api/screenshots/{id}/image` returns same PNG bytes
- list endpoint returns `total >= 1`

- [ ] **Step 3: Write failing test — agent unreachable → 503, no files**

- [ ] **Step 4: Implement `screenshot.rs`**

```rust
pub const MAX_SCREENSHOT_BYTES: usize = 20 * 1024 * 1024;

pub enum CaptureError {
    AgentNotFound,
    Unreachable(String),   // -> 503
    BadImage(String),      // -> 502
    Io(String),            // -> 500
}

pub async fn capture_and_archive(
    store: &Store,
    client: &reqwest::Client,
    screenshot_root: &str,
    agent_id: &str,
) -> Result<Screenshot, CaptureError> {
    let agent = store.get_agent(agent_id).await... // NotFound
    let url = format!("http://{}:{}/api/screenshot", agent.ip, agent.port);
    let resp = client.get(&url).send().await.map_err(|e| Unreachable(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(BadImage(format!("agent status {}", resp.status())));
    }
    let bytes = resp.bytes().await.map_err(|e| BadImage(e.to_string()))?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(BadImage("exceeds 20 MiB".into()));
    }
    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(BadImage("not a PNG".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let rel = format!("{screenshot_root}/{agent_id}/{id}.png");
    // normalize: screenshot_root already "data/screenshots"
    let path = std::path::Path::new(&rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Io(e.to_string()))?;
    }
    std::fs::write(path, &bytes).map_err(|e| Io(e.to_string()))?;
    match store
        .insert_screenshot(agent_id, &rel, "image/png", bytes.len() as i64, None, None)
        .await
    {
        Ok(meta) => Ok(meta),
        Err(e) => {
            let _ = std::fs::remove_file(path);
            Err(Io(e.to_string()))
        }
    }
}
```

Use the `id` from insert (store generates UUID) — align so file name uses the same id as the row: generate id once, pass into `insert_screenshot` with explicit id, write `{id}.png`.

Preferred store signature:

```rust
pub async fn insert_screenshot_with_id(
    &self,
    id: &str,
    agent_id: &str,
    file_path: &str,
    content_type: &str,
    byte_size: i64,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<Screenshot, sqlx::Error>
```

- [ ] **Step 5: Implement API handlers**

Map `CaptureError` → status codes per Global Constraints.

List handler parse `limit`/`offset` from query (`axum::extract::Query`), clamp limit to 1..=200, default 50/0; body:

```json
{ "items": [ ... ], "total": 123 }
```

Image handler: `tokio::fs::read` `file_path`; missing → 404 `ErrorBody`.

- [ ] **Step 6: Run tests**

Run: `cargo test -p scheduler`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): proxy and archive agent screenshots"
```

---

### Task 4: Scheduler WebUI — 截图 / 历史

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css`

**Interfaces:**
- Consumes: screenshot REST APIs from Task 3
- Produces: Chinese UI actions on Agent table

- [ ] **Step 1: Extend Agent table header/body**

Add column `操作` with buttons `截图` and `历史`.

- [ ] **Step 2: Modal markup**

Add a dialog/section:

- `#shot-modal` with `<img id="shot-img" alt="截图">`, close button `关闭`
- `#shot-history-modal` with table (时间、大小、查看) + prev/next if `total > items.length`

- [ ] **Step 3: JS handlers**

```javascript
async function takeScreenshot(agentId) {
  const resp = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/screenshots', {
    method: 'POST',
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert(err.error || ('截图失败: ' + resp.status));
    return;
  }
  const meta = await resp.json();
  document.getElementById('shot-img').src =
    '/api/screenshots/' + encodeURIComponent(meta.id) + '/image?' + Date.now();
  openShotModal();
}

async function openHistory(agentId, offset = 0) {
  const resp = await fetch(
    '/api/agents/' + encodeURIComponent(agentId) +
      '/screenshots?limit=50&offset=' + offset
  );
  // render items; wire 查看 → set img src to /api/screenshots/{id}/image
}
```

Escape agent ids in HTML; use `textContent` for labels.

- [ ] **Step 4: Minimal CSS** for modal overlay (reuse existing palette; no marketing gradients).

- [ ] **Step 5: Manual smoke (optional in CI)**

Document in commit/report: start scheduler+agent → 截图 → 历史.

- [ ] **Step 6: Commit**

```bash
git add crates/scheduler/static
git commit -m "feat(scheduler): WebUI for screenshot capture and history"
```

---

### Task 5: README + workspace verification

**Files:**
- Modify: `README.md`
- Modify: `.gitignore` only if needed (`data/` already ignored)

**Interfaces:** none

- [ ] **Step 1: Update Chinese README**

Add section **桌面截图**:

- 中心 Agent 列表「截图 / 历史」
- 仅主显示器；中心代理 Agent
- 永久保存在 `data/screenshots/`（可用 `SCHEDULER_SCREENSHOT_DIR`）
- **磁盘会持续增长，需自行清理**
- 无鉴权提示沿用

Also note commit of prior Chinese README translation if still uncommitted: include full README update in this commit.

- [ ] **Step 2: Run full suite**

Run: `cargo test --workspace`

Expected: all PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document agent screenshot archive feature"
```

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| Agent GET /api/screenshot PNG primary | 1 |
| POST archive via center proxy | 3 |
| Disk path layout | 3 |
| SQLite screenshots + index | 2 |
| List `{items,total}` pagination | 3 |
| GET meta + image | 3 |
| 20 MiB / PNG check / 502/503/404 | 3 |
| Atomic file+row | 3 |
| WebUI 截图/历史 | 4 |
| README 磁盘风险 | 5 |
| No Agent WebUI / no auto refresh / no cleanup | Global / omitted |

**Placeholder scan:** none intentional; `xcap` version note allows pin adjust at implement time.

**Type consistency:** `Screenshot` / `CaptureError` / `AppState { store, client, screenshot_dir }` / `MAX_SCREENSHOT_BYTES` shared across Tasks 2–3.
