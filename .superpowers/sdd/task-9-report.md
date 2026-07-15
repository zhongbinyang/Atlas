# Task 9 Report: Dispatcher (dispatch + result recovery)

## Status

DONE

## What Was Implemented

### `crates/scheduler/src/dispatcher.rs` (new)

- **`dispatcher_tick`**: two-phase tick per design §4.2 / §5.3
  1. **Recover in-flight** — for `dispatched`/`running` tasks with `agent_task_id`, `GET /api/tasks/{id}` on agent; map `AgentTaskView` to center status; set `started_at` on `running`, terminal fields on `succeeded`/`failed`/`timeout`
  2. **Dispatch queued** — for `queued` tasks, if agent `online` and not `busy`, `POST /api/tasks` with `CreateAgentTaskRequest`; on 201 → `dispatched` + `agent_task_id`; on 409 → stay `queued`; on network/other errors → requeue + clear `agent_task_id` + mark agent offline
- **`run_dispatcher`**: interval loop (default 1s via `poll_task_interval_secs`)
- Uses `common::CreateAgentTaskRequest`, `TaskStatus`, `AgentTaskView`

### `crates/scheduler/src/main.rs`

- Spawns `run_dispatcher` alongside `run_status_poller`

## Tests and Results

### Command

```text
cargo test -p scheduler dispatcher::
cargo test -p scheduler
```

### Output

```text
running 2 tests
test dispatcher::tests::dispatcher_tick_409_keeps_task_queued ... ok
test dispatcher::tests::dispatcher_tick_success_path_reaches_succeeded ... ok

running 10 tests
test result: ok. 10 passed; 0 failed
```

Mock Axum agent: POST 201/409; GET returns `running` for 100ms then `succeeded` with stdout.

## Files Changed

| File | Action |
|------|--------|
| `crates/scheduler/src/dispatcher.rs` | Created — dispatcher + 2 integration tests |
| `crates/scheduler/src/main.rs` | Modified — spawn dispatcher loop |

**Commit:** `28a6976` — `feat(scheduler): task dispatcher and result polling`

## Self-Review

- Matches brief and design state machine: queued → dispatched → running → terminal
- Recovery runs before dispatch each tick
- 409 does not mutate task; network errors requeue safely

## Concerns

1. **`Cargo.lock` untracked** — same as prior tasks
2. **Recovery GET failure on 404 requeues** — reasonable for lost agent tasks; no dedicated test
3. **No test for running intermediate state** — success test sleeps 150ms and asserts terminal only

## Test Gap Follow-up (network requeue)

### Added

- `dispatcher_tick_network_error_requeues_task` — online agent on closed local port; queued task stays `queued` with `agent_task_id` cleared after POST connection refused
- `dispatcher_tick_success_path_reaches_succeeded` — mid-poll assert `running` before terminal `succeeded`

### Command

```text
cargo test -p scheduler dispatcher::
```

### Output

```text
running 3 tests
test dispatcher::tests::dispatcher_tick_409_keeps_task_queued ... ok
test dispatcher::tests::dispatcher_tick_success_path_reaches_succeeded ... ok
test dispatcher::tests::dispatcher_tick_network_error_requeues_task ... ok
test result: ok. 3 passed; 0 failed
```

**Commit:** `7959f70` — `test(scheduler): cover dispatcher network requeue`
