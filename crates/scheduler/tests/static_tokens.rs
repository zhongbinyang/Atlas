use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn extract_root_vars(css: &str) -> BTreeMap<String, String> {
    let start = css.find(":root").expect("missing :root");
    let rest = &css[start..];
    let open = rest.find('{').expect("missing { after :root");
    let close = rest.find('}').expect("missing } after :root");
    let body = &rest[open + 1..close];
    let mut map = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim().trim_end_matches(';');
        if line.is_empty() || !line.starts_with("--") {
            continue;
        }
        let mut parts = line.splitn(2, ':');
        let key = parts.next().unwrap().trim().to_string();
        let val = parts.next().expect("var value").trim().to_string();
        map.insert(key, val);
    }
    map
}

#[test]
fn scheduler_and_agent_share_design_tokens() {
    let sched = fs::read_to_string(manifest_dir().join("static/style.css")).unwrap();
    let agent_css = fs::read_to_string(
        manifest_dir()
            .join("../agent/static/style.css"),
    )
    .unwrap();
    let a = extract_root_vars(&sched);
    let b = extract_root_vars(&agent_css);
    assert_eq!(a, b, "design tokens must match between scheduler and agent");

    let expected = [
        ("--bg", "#e8eef3"),
        ("--surface", "#f4f7fa"),
        ("--panel", "#ffffff"),
        ("--border", "#c5d0db"),
        ("--text", "#1a2332"),
        ("--muted", "#5a6b7d"),
        ("--accent", "#0b3d91"),
        ("--ok", "#1f8a4c"),
        ("--busy", "#c47a00"),
        ("--err", "#c0392b"),
        ("--radius", "4px"),
    ];
    for (k, v) in expected {
        assert_eq!(a.get(k).map(String::as_str), Some(v), "token {k}");
    }
}
