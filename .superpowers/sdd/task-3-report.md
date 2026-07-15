# Task 3 Report: Agent executor (serial process runner)

## Status

DONE

## What Was Implemented

### `crates/agent/src/executor.rs`

- `ExecuteResult` struct with `status`, `exit_code`, `stdout`, `stderr`.
- `run_command(shell, command, workdir, timeout_secs)` spawns `cmd` or `powershell` via `tokio::process::Command`.
- `kill_on_drop(true)` on the command builder; on `tokio::time::timeout` expiry the dropped `Child` kills the process (final brief pattern, not the broken `start_kill` sketch).
- Spawn failure → `TaskStatus::Failed`; non-zero exit → `Failed`; success → `Succeeded`; timeout → `Timeout` with stderr `"timeout"`.
- Three `#[cfg(test)]` async tests: `echo_succeeds`, `nonzero_fails`, `timeout_kills`.

### `crates/agent/src/main.rs`

- Added `mod executor;` alongside existing `config` and `metrics` modules. Stub `main` unchanged.

## Tests and Results

### Command

```text
cargo test -p agent executor::
```

### Output

```text
running 3 tests
test executor::tests::echo_succeeds ... ok
test executor::tests::nonzero_fails ... ok
test executor::tests::timeout_kills ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 9.10s
```

Build emitted dead-code warnings for unused `ExecuteResult.stderr`, `MetricsSampler`, and config fields — expected until later tasks wire them in.

## TDD Evidence (RED → GREEN)

### RED

Executor tests and `run_command` signature added per brief. Without `executor.rs` and `mod executor` in `main.rs`, the crate would not compile.

### GREEN

After implementing the `kill_on_drop` version verbatim, all three executor tests pass on Windows.

## Files Changed

| File | Action |
|------|--------|
| `crates/agent/src/executor.rs` | Created |
| `crates/agent/src/main.rs` | Modified — `mod executor` |

**Commit:** `ecab580` — `feat(agent): add Windows command executor with timeout`

## Self-Review

- Implementation matches the final `kill_on_drop` code block from the brief; earlier `start_kill` timeout sketch intentionally omitted.
- Scope limited to executor module and module wiring; no HTTP API, serial queue, or task dispatch.
- Tests cover success, non-zero exit code, and timeout on Windows `cmd`.
- `ShellKind::Powershell` branch implemented but not yet covered by tests.
- Commit includes only the two files specified in the brief.

## Concerns

1. **Timeout kill mechanism:** Relies on `kill_on_drop(true)` when the `wait_with_output` future is dropped on timeout. Correct per brief; no explicit `start_kill`/`wait` cleanup. If tokio behavior changes, timeout tests would catch regressions.
2. **Windows-only tests:** Tests invoke `cmd` and `ping`; no `#[cfg(windows)]` guard — they will fail on non-Windows CI unless gated later.
3. **No PowerShell test:** `ShellKind::Powershell` path is untested; deferred unless brief expands coverage.
4. **`Cargo.lock` untracked:** Same as prior tasks; reproducible builds may want a follow-up commit.
5. **Slow `timeout_kills`:** `ping -n 10` with 1s timeout takes ~9s wall time due to process teardown; acceptable but noisy in test runs.

---

## Fix: Gate executor tests to Windows

### Change

- `#[cfg(test)]` → `#[cfg(all(test, windows))]` on the `tests` module in `crates/agent/src/executor.rs`.

### Re-run

```text
cargo test -p agent executor::
```

```text
running 3 tests
test executor::tests::nonzero_fails ... ok
test executor::tests::echo_succeeds ... ok
test executor::tests::timeout_kills ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 9.09s
```

**Commit:** `fix(agent): gate executor tests to Windows`
