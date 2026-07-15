# Task 3 Report: Scheduler capture service + REST API

## Status

DONE

## What Was Implemented

### `crates/scheduler/src/screenshot.rs` (created)

- `MAX_SCREENSHOT_BYTES` = 20 MiB
- `CaptureError` variants: `AgentNotFound`, `Unreachable`, `BadImage`, `Io`
- `capture_and_archive` — proxies `GET http://{ip}:{port}/api/screenshot`, validates PNG magic, size cap, writes `{screenshot_root}/{agent_id}/{id}.png`, inserts via `insert_screenshot_with_id`; rolls back file on DB failure

### `crates/scheduler/src/api.rs` (modified)

- `AppState { store, client, screenshot_dir }`
- Routes: `POST/GET /api/agents/{id}/screenshots`, `GET /api/screenshots/{id}`, `GET /api/screenshots/{id}/image`
- `ScreenshotView`, paginated list `{ items, total }` with `limit` clamped 1..=200 (default 50)
- Error mapping: 404 agent, 503 unreachable, 502 bad image, 500 IO
- Tests: `capture_screenshot_happy_path`, `capture_screenshot_agent_unreachable`; all existing tests updated for extended `AppState`

### `crates/scheduler/src/main.rs` (modified)

- `mod screenshot`
- Wires `client` and `cfg.screenshot_dir` into `AppState`

## Tests and Results

```text
cargo test -p scheduler
```

```text
running 15 tests
test api::tests::capture_screenshot_happy_path ... ok
test api::tests::capture_screenshot_agent_unreachable ... ok
(... 13 other tests) ... ok

test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

## TDD Evidence

1. Extended `AppState` + updated test constructors with temp dir + `reqwest::Client`
2. Added failing integration tests (mock Axum agent with minimal 1×1 PNG constant)
3. Implemented `screenshot.rs` capture service
4. Implemented REST handlers and routes
5. All scheduler tests GREEN

## Files Changed

| File | Action |
|------|--------|
| `crates/scheduler/src/screenshot.rs` | Created |
| `crates/scheduler/src/api.rs` | Modified — routes, handlers, tests |
| `crates/scheduler/src/main.rs` | Modified — wire AppState |

**Commit:** `2564c91` — `feat(scheduler): proxy and archive agent screenshots`

## Self-Review

- Brief interfaces delivered; id/file alignment via single UUID + `insert_screenshot_with_id`
- Mock agent uses well-known minimal 1×1 PNG bytes
- Unreachable test asserts 503 and no files under `screenshot_dir`
- Atomic write: file first, DB insert, remove file on insert failure

## Concerns

1. **No BadImage integration test** — 502 path (non-PNG, oversize, agent 5xx) covered by unit logic only; mock could be extended later.
2. **Width/height always `None`** — per spec; dimension parsing deferred.
3. **`Store::pool()` dead-code warning** — pre-existing; unrelated to this task.
4. **File paths use forward slashes in string** — works on Windows; consistent with Task 2 store tests.

## Test Gap Follow-up (2026-07-15)

Added integration tests for previously uncovered error paths:

| Test | Asserts |
|------|---------|
| `capture_screenshot_agent_returns_500` | Mock agent 500 → POST 502, no files, DB count 0 |
| `capture_screenshot_agent_returns_non_png` | Mock agent non-PNG body → POST 502, no files, DB count 0 |
| `capture_screenshot_unknown_agent_returns_404` | POST unknown agent → 404 |
| `get_screenshot_image_unknown_returns_404` | GET unknown screenshot image → 404 |

Shared helpers extracted from `capture_screenshot_happy_path`: `start_mock_agent_responding`, `post_capture_screenshot`, `assert_no_screenshot_artifacts`. `capture_screenshot_agent_unreachable` updated to use `assert_no_screenshot_artifacts` (now also asserts DB count 0).

```text
cargo test -p scheduler
running 19 tests
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

**Commit:** `67451e8` — `test(scheduler): cover screenshot 502 and 404 paths`
