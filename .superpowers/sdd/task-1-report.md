# Task 1 Report: Agent metrics background sampling

## TDD evidence

### RED

Command:

```powershell
cargo test -p agent status_responds_within_150_ms
```

Before the implementation, the regression test failed as intended:

```text
test api::tests::status_responds_within_150_ms ... FAILED
status request took 205.2744ms
```

The failure came from the existing synchronous 200 ms CPU sampling wait on the
`/api/status` request path.

### GREEN

Command:

```powershell
cargo test -p agent status_responds_within_150_ms
```

Result after the implementation:

```text
test api::tests::status_responds_within_150_ms ... ok
test result: ok. 1 passed; 0 failed
```

The same test preloads a snapshot with CPU `12.5` and memory `34.5`, verifies
those values in the unchanged status response, and enforces the 150 ms limit.

## Implementation

- Added `MetricsSnapshot`, held by `AppState` behind an async `RwLock`.
- Changed `/api/status` to read the snapshot only; it no longer samples or sleeps.
- Added a Tokio background sampler with a 2,000 ms interval. CPU settling uses
  `tokio::time::sleep`, and the initial default snapshot remains available until
  the first collection completes.
- Started the sampler during agent startup without changing the HTTP response type.

## Verification

| Command | Result |
| --- | --- |
| `cargo test -p agent metrics` | Passed (0 matching tests; command completed successfully). |
| `cargo test -p agent status_responds_within_150_ms` | Passed (1/1). |
| `cargo test -p agent` | Passed (65/65). |
| `cargo fmt --check` | Passed. |
| `cargo clippy -p agent --all-targets -- -D warnings` | Blocked by 10 pre-existing diagnostics. |

The Clippy diagnostics are in unchanged baseline code, including unused imports
in `api.rs` outside test builds, dead code in `files.rs`, `general.rs`,
`labview_sequence.rs`, `register.rs`, and `sequence_session.rs`, plus existing
style suggestions in `labview.rs`, `executor.rs`, and `limits.rs`. The Task 1
changes introduced no Clippy diagnostic.

## Changed files

- `crates/agent/src/metrics.rs`
- `crates/agent/src/api.rs`
- `crates/agent/src/main.rs`
- `.superpowers/sdd/task-1-report.md`

## Self-review

- Confirmed the status handler only reads a copy of the latest snapshot and
  retains the existing `AgentStatusResponse` fields.
- Confirmed background scheduling uses a Tokio interval and sampling delay uses
  Tokio's timer; `std::thread::sleep` is absent from the agent metrics path.
- Confirmed the background task owns the sampler, so status requests cannot
  contend for it.
- Ran `git diff --check`; no whitespace errors. Reverted unrelated formatting
  changes produced by `cargo fmt`, leaving only the Task 1 files above.

## Concerns

- Repository-wide Clippy with `-D warnings` remains red because of the listed
  pre-existing warnings. This task does not alter those unrelated files.
- Independent review found no critical or important issues. It noted that
  Tokio's default missed-tick behavior can briefly catch up after a severely
  delayed runtime; this is non-blocking for the required 2-second sampler and
  is left unchanged to keep the task focused.
