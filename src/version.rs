#[allow(dead_code)]
pub fn format_build_version(date: &str, sha: &str, dirty: bool) -> String {
    if dirty {
        format!("{date}.{sha}-dirty")
    } else {
        format!("{date}.{sha}")
    }
}

pub fn version() -> &'static str {
    env!("ATLAS_VERSION")
}

pub fn date() -> &'static str {
    env!("ATLAS_BUILD_DATE")
}

pub fn git() -> &'static str {
    env!("ATLAS_GIT_REV")
}

pub fn version_json() -> serde_json::Value {
    serde_json::json!({
        "version": version(),
        "date": date(),
        "git": git(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_clean_sha() {
        assert_eq!(
            format_build_version("2026-08-16", "d4279a7", false),
            "2026-08-16.d4279a7"
        );
    }

    #[test]
    fn formats_dirty_sha() {
        assert_eq!(
            format_build_version("2026-08-16", "d4279a7", true),
            "2026-08-16.d4279a7-dirty"
        );
    }

    #[test]
    fn formats_unknown_when_no_git() {
        assert_eq!(
            format_build_version("2026-08-16", "unknown", false),
            "2026-08-16.unknown"
        );
    }

    #[test]
    fn version_json_matches_parts() {
        let body = version_json();
        let version = body.get("version").and_then(|v| v.as_str()).unwrap();
        let date = body.get("date").and_then(|v| v.as_str()).unwrap();
        let git = body.get("git").and_then(|v| v.as_str()).unwrap();
        assert_eq!(version, format!("{date}.{git}"));
        assert!(!version.is_empty());
        assert!(!date.is_empty());
        assert!(!git.is_empty());
    }
}
