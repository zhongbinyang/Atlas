# Design: Agent file logging (no console)

Date: 2026-07-30

## Goal

Agent must not print any tracing to the console. All logs go to `.log` files under a configurable directory: daily general logs plus per-run sequence result logs.

## Non-goals

- No log shipping / remote aggregation
- No WebUI log browser in this change
- No change to center/scheduler logging
- Sequence results still not stored in the center DB

## Directory layout

Default root (Windows):

```
%LOCALAPPDATA%\atlas-agent\logs\
```

Override: `AGENT_LOG_DIR` (absolute or relative path resolved at startup).

```
{AGENT_LOG_DIR}/
  agent-YYYY-MM-DD.log
  sequence_runs/
    YYYY-MM-DD/
      {utc_compact}_{overall}[_sn-{sanitized_sn}].json
```

- Create root and `sequence_runs` on startup (and before each write if missing).
- `utc_compact`: `YYYYMMDDTHHMMSSZ` (UTC).
- `overall`: sequence overall status string (e.g. `pass` / `fail` / `error` / `aborted` / `paused` — use whatever `SequenceResponse.overall` already emits).
- `sn` segment omitted when SN empty; sanitize to `[A-Za-z0-9._-]+`, max ~64 chars.
- Filename collision: append `_2`, `_3`, …

## Console behavior

- `tracing_subscriber` must **not** attach a stdout/stderr layer.
- Only file appenders (and optional test capture in unit tests).
- Panic / Rust default hooks unchanged (out of scope); normal operational logs never go to console.

## General log (`agent-YYYY-MM-DD.log`)

- Format: human-readable text lines (tracing-subscriber fmt, with timestamp + level + target + message).
- Level: default `info` and above; still honor `RUST_LOG` / `EnvFilter` for filtering what is written to the file.
- Content: existing agent tracing (bind, register, API errors, busy, etc.).
- Sequence completion: **do not** dump the full `result=` JSON into this file.
  - Emit one short `info` line on target `sequence_run`, e.g. overall + relative path of the sequence `.json` written (or absolute under `AGENT_LOG_DIR`).

## Sequence run log (`sequence_runs/.../*.json`)

Written when `log_sequence_run` runs today (after run / continue / abort completion paths).

- File extension: `.json`
- Body: JSON object (UTF-8), pretty-printed optional; compact is fine if tests assert via parse.
- Fields:
  - Existing payload: `sequence_template_id`, `overall`, `stopped`, `failed_at`, `sn`, `work_order`, `steps[]` (position, template_id, template_source, name, kind, ok, status, measured, limits, result, error)
  - Add: `finished_at` (local wall clock, second precision, e.g. `2026-07-30 19:20:45`), `hostname`
  - Add when present on response: `pause` (same shape as API pause object)
- Write failures must **not** fail the HTTP sequence response; attempt a one-line warn into the general log; if that also fails, drop silently.

## Retention

On Agent startup (best-effort):

- Delete `agent-*.log` older than **14** days (by date in filename).
- Delete `sequence_runs/YYYY-MM-DD/` directories older than **30** days.

No runtime size-based rotation beyond daily files in v1.

## Config

| Env | Meaning |
|-----|---------|
| `AGENT_LOG_DIR` | Log root; default `%LOCALAPPDATA%\atlas-agent\logs` |
| `RUST_LOG` | Filter for what enters the general `.log` (unchanged semantics) |

Expose resolved log dir on `AppState` so `log_sequence_run` can write files.

Optional later (not required now): `GET /api/status` field `log_dir` for UI tip — include if cheap.

## UI / docs

- Sequence result banner: stop saying「详细日志见 Agent sequence_run」; point to log directory (e.g.「详细日志已写入 Agent 日志目录 sequence_runs」+ resolved path if available from status/config).
- README: document `AGENT_LOG_DIR`, file layout, no-console behavior; remove “看控制台 RUST_LOG” as the primary way to read sequence details.

## Implementation sketch

1. New module `crates/agent/src/logging.rs` (or similar): resolve default dir, ensure dirs, prune old logs, open daily rolling file for tracing, helper `write_sequence_run_log(...)`.
2. `main.rs`: init file-only subscriber; run prune at startup.
3. `config.rs`: load `AGENT_LOG_DIR`.
4. `api.rs` `log_sequence_run`: write JSON `.log`; tracing one-liner with path; remove huge `result = %payload` field.
5. Tests: temp `AGENT_LOG_DIR` / injected path — after simulated log write, file exists and parses; subscriber does not require console.
6. `static` + `static_ui` / README string updates.

## Testing

- Unit: default path resolution (mock or Windows-only LOCALAPPDATA), filename sanitization, collision suffix.
- Unit/integration: write sequence payload to tempdir; assert JSON keys.
- Existing agent API tests still pass with logging pointed at tempfile (test `AppState` sets `log_dir`).
