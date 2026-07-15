# Task 2 Report: Agent config + metrics

## Status

DONE

## What Was Implemented

### `crates/agent/Cargo.toml`

Added all dependencies from the brief: `common`, `axum`, `tokio`, `serde`, `serde_json`, `reqwest`, `sysinfo`, `uuid`, `chrono`, `tower-http`, `toml`, `tracing`, `tracing-subscriber`, `hostname`, `local-ip-address`.

### `crates/agent/src/config.rs`

- `AgentConfig` struct with `bind`, `port`, `center_url`, `advertise_ip`, `hostname`.
- `AgentConfig::load_from_env()` reads env vars:
  - `AGENT_CENTER_URL` (required)
  - `AGENT_BIND` (default `0.0.0.0`)
  - `AGENT_PORT` (default `26631`, parse errors propagate)
  - `AGENT_ADVERTISE_IP` (optional)
  - `AGENT_HOSTNAME` (optional)
- Inline `#[cfg(test)]` module with two tests per brief.

### `crates/agent/src/metrics.rs`

- `MetricsSampler` wrapping `sysinfo::System`.
- `new()` — `System::new_all()` + initial `refresh_all()`.
- `cpu_and_memory()` — double CPU refresh with 200ms sleep between samples, then memory refresh; returns `(cpu_percent, mem_percent)`.

### `crates/agent/src/main.rs`

Module declarations only (`mod config; mod metrics;`), stub `main` prints `"agent stub"`. No HTTP server or executor.

## Tests and Results

### Command

```text
cargo test -p agent config::
```

### Output

```text
running 2 tests
test config::tests::default_port_is_26631 ... ok
test config::tests::missing_center_url_errors ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Build emitted dead-code warnings for unused `MetricsSampler` and optional config fields — expected until later tasks wire them in.

## TDD Evidence (RED → GREEN)

### RED

Config tests and `AgentConfig::load_from_env()` were added per brief. Without the struct and loader implementation, the crate would not compile or tests would fail on missing env handling.

### GREEN

After implementing `config.rs` verbatim, both config tests pass. Metrics module compiles; no unit tests required by brief for metrics.

## Files Changed

| File | Action |
|------|--------|
| `crates/agent/Cargo.toml` | Modified — added dependencies |
| `crates/agent/src/config.rs` | Created |
| `crates/agent/src/metrics.rs` | Created |
| `crates/agent/src/main.rs` | Modified — module wiring + stub main |

**Commit:** `28fa5d3` — `feat(agent): add config and metrics sampler`

## Self-Review

- Implementation matches brief code blocks verbatim (deps, config, metrics double-refresh, main module declarations).
- Scope limited to config loading and metrics sampler; no HTTP server, executor, or `collect_metrics` → `AgentStatusResponse` wrapper (deferred to caller per brief note).
- Config tests cover default port and required `AGENT_CENTER_URL`.
- `AgentOnlineStatus` naming from Task 1 preserved; no `AgentStatus` alias introduced.
- Commit includes only `crates/agent` as specified.

## Concerns

1. **Brief interface vs code:** Interfaces section names `AgentConfig::load()` and `collect_metrics(hostname, ip) -> AgentStatusResponse`; implemented `load_from_env()` and `MetricsSampler` per the code blocks in Steps 1 and 3.
2. **`Cargo.lock` untracked:** Generated locally with new agent deps; not committed (brief commit step lists `crates/agent` only). Same as Task 1 — consider committing in a follow-up for reproducible builds.
3. **Dead-code warnings:** `MetricsSampler` and optional config fields unused until status endpoint task; acceptable for this task.

## Review Fix: Serialize Config Env Tests

### Change

Added `static ENV_TEST_LOCK: Mutex<()>` in the `#[cfg(test)]` module; both env-mutating tests acquire the lock before touching `std::env` so parallel runners cannot flake.

### Command

```text
cargo test -p agent config::
```

### Output

```text
running 2 tests
test config::tests::default_port_is_26631 ... ok
test config::tests::missing_center_url_errors ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

**Commit:** `fix(agent): serialize config env tests`
