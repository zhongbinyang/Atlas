# Agent File Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all Agent tracing to daily `.log` files (no console) and write each sequence completion to a JSON `.log` under `sequence_runs/`.

**Architecture:** New `logging` module owns directory resolution, retention prune, file-only `tracing` init, and sequence-run file writes. `AppState` carries `log_dir`; `log_sequence_run` writes JSON then emits a short `sequence_run` info line. Status exposes `log_dir` for UI copy.

**Tech Stack:** Rust, `tracing` + `tracing-subscriber` (EnvFilter, fmt to file via `MakeWriter`), `chrono`, `serde_json`, existing agent/static UI.

## Global Constraints

- Console: no stdout/stderr tracing layers.
- Default log root: `%LOCALAPPDATA%\atlas-agent\logs` (override `AGENT_LOG_DIR`).
- Files: `agent-YYYY-MM-DD.log` and `sequence_runs/YYYY-MM-DD/{utc}_{overall}[_sn-…].log`.
- Retention: agent logs 14 days; sequence_runs dirs 30 days; prune at startup.
- Sequence write failure must not fail HTTP; warn via tracing if possible.
- Do not dump full sequence JSON into the general log.

---

### Task 1: `logging` module — path helpers + sequence file write + prune

**Files:**
- Create: `crates/agent/src/logging.rs`
- Modify: `crates/agent/src/main.rs` (add `mod logging;`)

**Interfaces:**
- Produces:
  - `pub fn default_log_dir() -> PathBuf`
  - `pub fn resolve_log_dir(override_dir: Option<&str>) -> PathBuf`
  - `pub fn ensure_log_dirs(root: &Path) -> std::io::Result<()>`
  - `pub fn prune_old_logs(root: &Path, now: chrono::DateTime<chrono::Utc>)`
  - `pub fn sanitize_sn(sn: &str) -> Option<String>`
  - `pub fn sequence_log_filename(finished_at: DateTime<Utc>, overall: &str, sn: Option<&str>) -> String`
  - `pub fn write_sequence_run_log(root: &Path, payload: &serde_json::Value, finished_at: DateTime<Utc>, overall: &str, sn: Option<&str>) -> std::io::Result<PathBuf>`
  - `pub fn init_file_tracing(root: &Path) -> std::io::Result<()>`

- [ ] **Step 1: Implement `logging.rs` with unit tests**

```rust
//! Agent file logging: daily general log + per-run sequence JSON logs.

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing_subscriber::{fmt, EnvFilter};

pub fn default_log_dir() -> PathBuf {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(base).join("atlas-agent").join("logs");
    }
    std::env::temp_dir().join("atlas-agent").join("logs")
}

pub fn resolve_log_dir(override_dir: Option<&str>) -> PathBuf {
    match override_dir {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s),
        _ => default_log_dir(),
    }
}

pub fn ensure_log_dirs(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    fs::create_dir_all(root.join("sequence_runs"))?;
    Ok(())
}

pub fn sanitize_sn(sn: &str) -> Option<String> {
    let trimmed = sn.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::new();
    for c in trimmed.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else {
            out.push('_');
        }
        if out.len() >= 64 {
            break;
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

pub fn sequence_log_filename(
    finished_at: DateTime<Utc>,
    overall: &str,
    sn: Option<&str>,
) -> String {
    let ts = finished_at.format("%Y%m%dT%H%M%SZ");
    let overall_part = sanitize_sn(overall).unwrap_or_else(|| "unknown".into());
    match sn.and_then(sanitize_sn) {
        Some(s) => format!("{ts}_{overall_part}_sn-{s}.log"),
        None => format!("{ts}_{overall_part}.log"),
    }
}

pub fn write_sequence_run_log(
    root: &Path,
    payload: &Value,
    finished_at: DateTime<Utc>,
    overall: &str,
    sn: Option<&str>,
) -> io::Result<PathBuf> {
    let day = finished_at.format("%Y-%m-%d").to_string();
    let dir = root.join("sequence_runs").join(&day);
    fs::create_dir_all(&dir)?;
    let base = sequence_log_filename(finished_at, overall, sn);
    let mut path = dir.join(&base);
    let mut n = 2u32;
    while path.exists() {
        let stem = base.trim_end_matches(".log");
        path = dir.join(format!("{stem}_{n}.log"));
        n += 1;
    }
    let mut f = OpenOptions::new().create_new(true).write(true).open(&path)?;
    let body = serde_json::to_vec_pretty(payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    f.write_all(&body)?;
    f.write_all(b"\n")?;
    Ok(path)
}

fn parse_agent_log_date(name: &str) -> Option<NaiveDate> {
    // agent-YYYY-MM-DD.log
    let s = name.strip_prefix("agent-")?.strip_suffix(".log")?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

pub fn prune_old_logs(root: &Path, now: DateTime<Utc>) {
    let today = now.date_naive();
    if let Ok(rd) = fs::read_dir(root) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if let Some(d) = parse_agent_log_date(&name) {
                if today - d > Duration::days(14) {
                    let _ = fs::remove_file(ent.path());
                }
            }
        }
    }
    let seq_root = root.join("sequence_runs");
    if let Ok(rd) = fs::read_dir(&seq_root) {
        for ent in rd.flatten() {
            if !ent.path().is_dir() {
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if let Ok(d) = NaiveDate::parse_from_str(&name, "%Y-%m-%d") {
                if today - d > Duration::days(30) {
                    let _ = fs::remove_dir_all(ent.path());
                }
            }
        }
    }
}

struct DailyFileWriter {
    root: PathBuf,
    inner: Mutex<(String, fs::File)>,
}

impl DailyFileWriter {
    fn open(root: &Path) -> io::Result<Self> {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        let path = root.join(format!("agent-{day}.log"));
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            root: root.to_path_buf(),
            inner: Mutex::new((day, file)),
        })
    }

    fn current_file(&self) -> io::Result<std::sync::MutexGuard<'_, (String, fs::File)>> {
        let mut g = self.inner.lock().unwrap();
        let day = Utc::now().format("%Y-%m-%d").to_string();
        if g.0 != day {
            let path = self.root.join(format!("agent-{day}.log"));
            let file = OpenOptions::new().create(true).append(true).open(&path)?;
            *g = (day, file);
        }
        Ok(g)
    }
}

impl<'a> fmt::MakeWriter<'a> for DailyFileWriter {
    type Writer = DailyFileHandle;

    fn make_writer(&'a self) -> Self::Writer {
        DailyFileHandle {
            writer: Arc::new(self.current_file().expect("open agent log").1.try_clone().expect("clone log file")),
        }
    }
}

// Prefer simpler approach: Arc<Mutex<DailyFileWriter>> implementing Write via make_writer that locks and writes.
```

Use a simpler `MakeWriter` pattern that works reliably:

```rust
#[derive(Clone)]
struct SharedDailyWriter {
    inner: Arc<Mutex<DailyFileWriter>>,
}

struct DailyFileWriter {
    root: PathBuf,
    day: String,
    file: fs::File,
}

impl DailyFileWriter {
    fn new(root: PathBuf) -> io::Result<Self> {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(format!("agent-{day}.log")))?;
        Ok(Self { root, day, file })
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        if self.day != day {
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.root.join(format!("agent-{day}.log")))?;
            self.day = day;
        }
        self.file.write_all(buf)?;
        self.file.flush()
    }
}

struct GuardWriter {
    inner: Arc<Mutex<DailyFileWriter>>,
}

impl Write for GuardWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.lock().unwrap().write_all(buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> fmt::MakeWriter<'a> for SharedDailyWriter {
    type Writer = GuardWriter;
    fn make_writer(&'a self) -> Self::Writer {
        GuardWriter {
            inner: Arc::clone(&self.inner),
        }
    }
}

pub fn init_file_tracing(root: &Path) -> io::Result<()> {
    ensure_log_dirs(root)?;
    prune_old_logs(root, Utc::now());
    let writer = SharedDailyWriter {
        inner: Arc::new(Mutex::new(DailyFileWriter::new(root.to_path_buf())?)),
    };
    let filter = EnvFilter::from_default_env().add_directive("info".parse().unwrap());
    fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer)
        .try_init()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    Ok(())
}
```

Include tests for `sanitize_sn`, `sequence_log_filename`, `write_sequence_run_log` collision, and `prune_old_logs`.

- [ ] **Step 2: Wire `mod logging` in `main.rs`**

- [ ] **Step 3: Run tests**

Run: `cargo test -p agent --bin agent sanitize_sn -- --nocapture`  
Also: `cargo test -p agent --bin agent write_sequence_run_log -- --nocapture`  
Expected: PASS

- [ ] **Step 4: Commit** (only if user asked; skip if not)

---

### Task 2: Config + AppState + main init + status `log_dir`

**Files:**
- Modify: `crates/agent/src/config.rs`
- Modify: `crates/agent/src/api.rs` (`AppState`, `status`, test_state)
- Modify: `crates/agent/src/main.rs`
- Modify: `crates/common/src/types.rs` (`AgentStatusResponse.log_dir`)

**Interfaces:**
- Consumes: `logging::resolve_log_dir`, `init_file_tracing`
- Produces: `AgentConfig.log_dir: PathBuf`, `AppState.log_dir: PathBuf`, status JSON `log_dir`

- [ ] **Step 1: Add `log_dir` to config**

```rust
pub log_dir: std::path::PathBuf,
// in load_from_env:
log_dir: crate::logging::resolve_log_dir(std::env::var("AGENT_LOG_DIR").ok().as_deref()),
```

Note: `config` cannot call `logging` if that creates a cycle — either put `resolve_log_dir`/`default_log_dir` in `config.rs` or resolve in `main` only. Prefer resolve in `main` + `config` stores `Option<PathBuf>` from env raw, OR move resolve helpers into `config.rs` and keep write/prune/init in `logging.rs`.

Preferred split:
- `config.rs`: `log_dir: PathBuf` from `AGENT_LOG_DIR` or default LOCALAPPDATA path (duplicate tiny default helper OK, or `logging::resolve_log_dir` called from `main` after load).

Simplest: `AgentConfig` has `pub log_dir: PathBuf` set in `load_from_env` using inline default (same logic as `default_log_dir`).

- [ ] **Step 2: `AppState.log_dir` + status field**

```rust
pub log_dir: PathBuf,
// status:
log_dir: Some(s.log_dir.display().to_string()),
```

Add to `AgentStatusResponse`:
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub log_dir: Option<String>,
```

Update all `test_state*` to `log_dir: std::env::temp_dir().join("atlas-agent-test-logs")`.

- [ ] **Step 3: `main.rs` init**

```rust
let cfg = AgentConfig::load_from_env().expect("config");
if let Err(e) = logging::init_file_tracing(&cfg.log_dir) {
    eprintln!("failed to init file logging at {}: {e}", cfg.log_dir.display());
}
// remove previous stdout tracing_subscriber::fmt()...init()
```

Spec says no console tracing — `eprintln` only for fatal init failure is acceptable once at startup.

- [ ] **Step 4: Run** `cargo test -p agent --bin agent status_responds -- --nocapture`  
Expected: PASS

---

### Task 3: `log_sequence_run` writes file + short tracing line

**Files:**
- Modify: `crates/agent/src/api.rs` (`log_sequence_run`)

- [ ] **Step 1: Change `log_sequence_run` to take `&AppState`, build payload with `finished_at`/`hostname`/`pause`, call `write_sequence_run_log`, then:**

```rust
match logging::write_sequence_run_log(...) {
  Ok(path) => {
    let rel = path.strip_prefix(&s.log_dir).unwrap_or(&path);
    tracing::info!(target: "sequence_run", overall = %resp.overall, path = %rel.display(), "sequence run finished");
  }
  Err(e) => {
    tracing::warn!(target: "sequence_run", error = %e, "failed to write sequence run log");
  }
}
```

Remove `result = %payload` from tracing.

Update call sites to pass `&s`.

- [ ] **Step 2: Add test** that acquires temp log_dir on state, sets session or calls `write_sequence_run_log` via public helper assertion — prefer unit test in `logging` already done; add api-level only if easy.

- [ ] **Step 3: Run related tests** Expected: PASS

---

### Task 4: UI + README

**Files:**
- Modify: `crates/agent/static/app.js` (banner text; use `lastAgentStatus.log_dir` if set)
- Modify: `crates/agent/tests/static_ui.rs` (string assert)
- Modify: `README.md` logging section

```javascript
const logHint = (lastAgentStatus && lastAgentStatus.log_dir)
  ? ('详细日志: ' + lastAgentStatus.log_dir + '\\sequence_runs')
  : '详细日志已写入 Agent 日志目录 sequence_runs';
container.textContent = '本次共 ' + data.steps.length + ' 步结果，已写入步骤行；点「详情」查看实测与原始返回。' + logHint;
```

README: document `AGENT_LOG_DIR`, layout, no console logs.

- [ ] **Step 1: Edit UI + README + static_ui assert**
- [ ] **Step 2: Run** `cargo test -p agent --test static_ui` Expected: PASS

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| No console tracing | 2 |
| Default/override dir | 1–2 |
| agent-YYYY-MM-DD.log | 1 |
| sequence_runs JSON .log | 1, 3 |
| Retention 14/30 | 1 |
| finished_at/hostname/pause | 3 |
| Write fail soft | 3 |
| UI + README | 4 |
| status log_dir | 2 |

## Execution

Inline execution in this session (user confirmed continue).
