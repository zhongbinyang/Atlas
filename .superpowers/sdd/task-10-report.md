# Task 10 Report: Scheduler WebUI + main wiring

## Status: Complete

## Changes

| File | Action |
|------|--------|
| `crates/scheduler/src/web.rs` | Created — `ServeDir` static router (mirrors agent) |
| `crates/scheduler/static/index.html` | Created — Chinese single-page UI |
| `crates/scheduler/static/app.js` | Created — agents/templates/tasks CRUD + polling |
| `crates/scheduler/static/style.css` | Created — practical table/form layout |
| `crates/scheduler/src/main.rs` | Modified — `mod web`, merge API + static router |

## WebUI Features

- **Agent 列表**: 电脑名、IP、状态、CPU%、内存%、忙碌；2s 轮询
- **任务模板**: 创建表单 + 列表 + 删除按钮
- **任务**: 选择 Agent + 模板或临时命令提交；列表点击展开详情（stdout/stderr）

## Tests

```
cargo test -p scheduler
11 passed; 0 failed
```

## Manual E2E

| Check | Result |
|-------|--------|
| Scheduler starts on `:26630` | OK |
| Agent registers, status online with CPU/memory ~5s | OK (9.8% CPU, 46.7% mem) |
| Create template via API | OK |
| Task from template → succeeded | OK (`from-template`) |
| Ad-hoc `echo ok` → succeeded | OK |
| Static UI `GET /` returns 200 | OK |
| Queued while busy | OK (see E2E #5 below) |

## E2E Check #5 — Queued while busy

**Ports:** scheduler `:27630`, agent `:27631` (26630/26631 in use). Temp SQLite DB.

**Setup:** `scheduler.exe` + `agent.exe` (AGENT_CENTER_URL → scheduler). Agent online ~10s.

**Commands:** POST long `ping -n 8 127.0.0.1`, immediately POST short `echo second`.

**Poll trace (500ms):**

```
poll2  long=dispatched short=queued
poll4  long=running   short=queued
poll6–16 long=running short=queued busy=True
poll17 long=succeeded short=queued busy=True
poll19 long=succeeded short=dispatched
poll22 long=succeeded short=succeeded
```

**Result:** `sawLongRunning=true`, `sawShortQueued=true`. Second task stayed `queued` until first finished, then succeeded.

**Fix applied:** `dispatcher.rs` — dispatch queued tasks FIFO (`created_at ASC`) and at most one dispatch per agent per tick (root cause: `list_tasks` returns DESC, so newer task was dispatched first).

## Concerns

- None blocking. `Store::pool()` dead-code warning pre-existing.
- README deferred to Task 11 (not in repo yet).

## Commit

`feat(scheduler): WebUI and process entrypoint`
