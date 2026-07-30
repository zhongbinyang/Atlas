//! Agent file logging: daily general log + per-run sequence JSON logs.
//! No console subscriber — all operational tracing goes to files under `log_dir`.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::{fmt, EnvFilter};

pub fn default_log_dir() -> PathBuf {
    if let Ok(base) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(base).join("atlas-agent").join("logs");
    }
    PathBuf::from("atlas-agent").join("logs")
}

pub fn resolve_log_dir(override_dir: Option<&str>) -> PathBuf {
    match override_dir {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
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
        if out.len() >= 64 {
            break;
        }
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn sequence_log_filename(
    finished_at: DateTime<Utc>,
    overall: &str,
    sn: Option<&str>,
) -> String {
    let ts = finished_at.format("%Y%m%dT%H%M%SZ");
    let overall_part = sanitize_sn(overall).unwrap_or_else(|| "unknown".into());
    match sn.and_then(sanitize_sn) {
        Some(s) => format!("{ts}_{overall_part}_sn-{s}.json"),
        None => format!("{ts}_{overall_part}.json"),
    }
}

pub fn format_finished_at_local(finished_at: DateTime<Utc>) -> String {
    finished_at
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
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
        let stem = base.trim_end_matches(".json");
        path = dir.join(format!("{stem}_{n}.json"));
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
    let s = name.strip_prefix("agent-")?.strip_suffix(".log")?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

pub fn prune_old_logs(root: &Path, now: DateTime<Utc>) {
    let today = now.date_naive();
    if let Ok(rd) = fs::read_dir(root) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if let Some(d) = parse_agent_log_date(&name) {
                if today.signed_duration_since(d) > Duration::days(14) {
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
                if today.signed_duration_since(d) > Duration::days(30) {
                    let _ = fs::remove_dir_all(ent.path());
                }
            }
        }
    }
}

struct DailyFileWriter {
    root: PathBuf,
    day: String,
    file: File,
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

#[derive(Clone)]
struct SharedDailyWriter {
    inner: Arc<Mutex<DailyFileWriter>>,
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

impl<'a> MakeWriter<'a> for SharedDailyWriter {
    type Writer = GuardWriter;

    fn make_writer(&'a self) -> Self::Writer {
        GuardWriter {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// Initialize file-only tracing. Idempotent failure if already set (tests).
pub fn init_file_tracing(root: &Path) -> io::Result<()> {
    ensure_log_dirs(root)?;
    prune_old_logs(root, Utc::now());
    let writer = SharedDailyWriter {
        inner: Arc::new(Mutex::new(DailyFileWriter::new(root.to_path_buf())?)),
    };
    let filter = EnvFilter::from_default_env().add_directive("info".parse().unwrap());
    let subscriber = fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer)
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| io::Error::new(io::ErrorKind::AlreadyExists, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_sn_strips_and_limits() {
        assert_eq!(sanitize_sn("  "), None);
        assert_eq!(sanitize_sn("AB-12.3").as_deref(), Some("AB-12.3"));
        assert_eq!(sanitize_sn("a/b c").as_deref(), Some("a_b_c"));
        let long = "x".repeat(80);
        assert_eq!(sanitize_sn(&long).unwrap().len(), 64);
    }

    #[test]
    fn sequence_filename_includes_sn_when_present() {
        let t = DateTime::parse_from_rfc3339("2026-07-30T11:22:33Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            sequence_log_filename(t, "pass", Some("SN1")),
            "20260730T112233Z_pass_sn-SN1.json"
        );
        assert_eq!(
            sequence_log_filename(t, "fail", None),
            "20260730T112233Z_fail.json"
        );
    }

    #[test]
    fn finished_at_local_is_second_precision() {
        let t = DateTime::parse_from_rfc3339("2026-07-30T11:20:45.095528600+00:00")
            .unwrap()
            .with_timezone(&Utc);
        let s = format_finished_at_local(t);
        assert_eq!(s.len(), "2026-07-30 19:20:45".len());
        assert!(!s.contains('.'));
        assert!(!s.contains('T'));
        assert!(!s.contains('+'));
    }

    #[test]
    fn write_sequence_run_log_creates_json_and_collides() {
        let dir = tempfile::tempdir().unwrap();
        let t = DateTime::parse_from_rfc3339("2026-07-30T11:22:33Z")
            .unwrap()
            .with_timezone(&Utc);
        let payload = json!({"overall": "pass", "steps": []});
        let p1 = write_sequence_run_log(dir.path(), &payload, t, "pass", Some("A1")).unwrap();
        assert!(p1.ends_with("20260730T112233Z_pass_sn-A1.json"));
        let body: Value = serde_json::from_str(&fs::read_to_string(&p1).unwrap()).unwrap();
        assert_eq!(body["overall"], "pass");
        let p2 = write_sequence_run_log(dir.path(), &payload, t, "pass", Some("A1")).unwrap();
        assert!(p2
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("_2.json"));
    }

    #[test]
    fn prune_removes_old_agent_and_sequence_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sequence_runs")).unwrap();
        fs::write(root.join("agent-2026-01-01.log"), b"old").unwrap();
        fs::write(root.join("agent-2026-07-29.log"), b"new").unwrap();
        fs::create_dir_all(root.join("sequence_runs").join("2026-01-01")).unwrap();
        fs::create_dir_all(root.join("sequence_runs").join("2026-07-01")).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-07-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        prune_old_logs(root, now);
        assert!(!root.join("agent-2026-01-01.log").exists());
        assert!(root.join("agent-2026-07-29.log").exists());
        assert!(!root.join("sequence_runs").join("2026-01-01").exists());
        assert!(root.join("sequence_runs").join("2026-07-01").exists());
    }

    #[test]
    fn resolve_override_and_default() {
        let custom = resolve_log_dir(Some(r"D:\logs\agent"));
        assert_eq!(custom, PathBuf::from(r"D:\logs\agent"));
        let d = resolve_log_dir(None);
        assert!(d.ends_with(Path::new("atlas-agent").join("logs")));
    }
}
