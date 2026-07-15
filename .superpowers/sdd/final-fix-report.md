# Final Fix Report — Important Follow-ups

**Commit:** `fix: harden timeouts, output caps, and recovery requeue`

## Changes

1. **reqwest timeouts** — Scheduler `main` and agent `register::http_client()` build clients with 10s request timeout and 5s connect timeout; shared client passed to poller/dispatcher and registration.
2. **timeout_secs validation** — Scheduler `POST /api/templates` and ad-hoc `POST /api/tasks`, plus agent `POST /api/tasks`, return 400 when `timeout_secs == 0` (omitted default remains 300).
3. **Stdout/stderr cap** — Agent executor truncates stdout/stderr to 256 KiB with `...[truncated]` suffix before storing in TaskSlot.
4. **Agent WebUI command column** — Added `command: String` to `AgentTaskView`; set from `request.command` in `TaskSlot::submit` (agent `app.js` already renders `t.command`).
5. **README** — Warning that agent restart during execution may requeue and re-run tasks via recovery.
6. **GET recover non-2xx** — `recover_in_flight` requeues on any non-success GET (not only 404), logs status.

## Tests

`cargo test --workspace` — 20 passed (7 agent, 2 common, 11 scheduler).
