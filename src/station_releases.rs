use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatestManifest {
    pub version: String,
    pub date: String,
    pub git: String,
    pub filename: String,
    pub sha256: String,
}

pub fn release_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ATLAS_STATION_RELEASE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("releases")
        .join("station")
}

pub fn is_safe_release_filename(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn parse_latest_json(bytes: &[u8]) -> Result<LatestManifest, String> {
    let m: LatestManifest =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid latest.json: {e}"))?;
    if m.version != format!("{}.{}", m.date, m.git) {
        return Err("version must equal date + \".\" + git".into());
    }
    if !is_safe_release_filename(&m.filename) {
        return Err("unsafe filename".into());
    }
    if m.sha256.trim().is_empty() {
        return Err("sha256 required".into());
    }
    Ok(m)
}

pub fn read_latest(dir: &Path) -> Result<LatestManifest, String> {
    let path = dir.join("latest.json");
    let bytes = std::fs::read(&path).map_err(|_| "no station release".to_string())?;
    parse_latest_json(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_filename() {
        assert!(!is_safe_release_filename("../x.exe"));
        assert!(!is_safe_release_filename("a/b.exe"));
        assert!(!is_safe_release_filename("a\\b.exe"));
        assert!(!is_safe_release_filename(""));
        assert!(is_safe_release_filename("atlas-station-2026-08-16.d4279a7-setup.exe"));
    }

    #[test]
    fn parse_latest_requires_identity() {
        let raw = br#"{
          "version": "2026-08-16.d4279a7",
          "date": "2026-08-16",
          "git": "d4279a7",
          "filename": "atlas-station-2026-08-16.d4279a7-setup.exe",
          "sha256": "abcd"
        }"#;
        let m = parse_latest_json(raw).unwrap();
        assert_eq!(m.version, "2026-08-16.d4279a7");
        assert_eq!(m.filename, "atlas-station-2026-08-16.d4279a7-setup.exe");

        let bad = br#"{
          "version": "nope",
          "date": "2026-08-16",
          "git": "d4279a7",
          "filename": "atlas-station-2026-08-16.d4279a7-setup.exe",
          "sha256": "abcd"
        }"#;
        assert!(parse_latest_json(bad).is_err());
        assert!(parse_latest_json(br#"{"version":"x"}"#).is_err());
    }
}
