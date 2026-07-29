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
    let agent_css = fs::read_to_string(manifest_dir().join("../agent/static/style.css")).unwrap();
    let a = extract_root_vars(&sched);
    let b = extract_root_vars(&agent_css);
    assert_eq!(a, b, "design tokens must match between scheduler and agent");

    let expected = [
        ("--bg", "#dce4ec"),
        ("--surface", "#eef3f7"),
        ("--panel", "#f7fafc"),
        ("--border", "#b7c4d0"),
        ("--text", "#15202b"),
        ("--muted", "#5c6b7a"),
        ("--accent", "#0a6e7a"),
        ("--ok", "#1a7f4b"),
        ("--busy", "#b86a00"),
        ("--err", "#b33a2b"),
        ("--radius", "3px"),
    ];
    for (k, v) in expected {
        assert_eq!(a.get(k).map(String::as_str), Some(v), "token {k}");
    }
}

#[test]
fn scheduler_dashboard_loads_self_scheduling_refresh_runtime() {
    let index = fs::read_to_string(manifest_dir().join("static/index.html")).unwrap();
    let app = fs::read_to_string(manifest_dir().join("static/app.js")).unwrap();

    let runtime_pos = index
        .find(r#"<script src="/dashboard-runtime.js"></script>"#)
        .expect("dashboard runtime script");
    let app_pos = index
        .find(r#"<script src="/app.js"></script>"#)
        .expect("dashboard app script");
    assert!(
        runtime_pos < app_pos,
        "dashboard runtime must load before the app"
    );
    assert!(
        !app.contains("setInterval(refreshCurrent, POLL_MS)"),
        "the overlapping interval refresh must be removed"
    );
    assert!(
        !app.contains("addEventListener('change', fetchViTemplates)"),
        "filter events must not pass Event as the template commit guard"
    );
    assert!(
        app.contains("dashboardRuntime.createSafeEventHandler"),
        "filter events must use the rejection-safe event adapter"
    );
    assert!(
        app.contains("dashboardRuntime.startDashboard(applyCurrentRoute, refreshController)"),
        "automatic refresh must start without awaiting the initial route"
    );
    assert!(
        !app.contains("applyCurrentRoute().finally"),
        "automatic refresh start must not depend on initial route settlement"
    );
}
