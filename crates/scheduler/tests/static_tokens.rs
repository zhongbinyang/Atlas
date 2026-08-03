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
    assert!(
        app.matches("dashboardRuntime.createLatestResourceLoader")
            .count()
            >= 2,
        "template resources must use shared latest-generation loaders"
    );
    assert!(
        app.contains("function fetchViTemplates(shouldCommit = isFunctionsRoute)"),
        "non-route VI reload entries must still require the functions route"
    );
    assert!(
        app.contains("function fetchSequenceTemplates(shouldCommit = isSequencesRoute)"),
        "non-route sequence reload entries must still require the sequences route"
    );
    assert!(
        !app.contains("if (!resp.ok) continue;"),
        "template requests must not partially commit after a failed response"
    );
    assert!(
        !app.contains("tbody.innerHTML = '<tr><td colspan=\"5\" class=\"empty\">加载失败:"),
        "sequence load failures must not replace the last successful table"
    );
    assert!(
        !app.contains("showViTemplatesMsg('加载失败: '"),
        "VI load failures must not overwrite operation messages"
    );
    assert!(
        !app.contains("showSequenceTemplatesMsg('加载失败: '"),
        "sequence load failures must not overwrite operation messages"
    );
    assert!(
        index.contains(r#"id="vi-templates-load-msg" class="msg" hidden"#),
        "VI templates need a dedicated load message"
    );
    assert!(
        index.contains(r#"id="sequence-templates-load-msg" class="msg" hidden"#),
        "sequence templates need a dedicated load message"
    );
    assert!(
        app.contains("createMessageChannel(document.getElementById('vi-templates-msg'))"),
        "VI operations must retain their original message element"
    );
    assert!(
        app.contains("createMessageChannel(document.getElementById('sequence-templates-msg'))"),
        "sequence operations must retain their original message element"
    );
    assert!(
        app.contains("createMessageChannel(document.getElementById('vi-templates-load-msg'))"),
        "VI loader must own only its load message"
    );
    assert!(
        app.contains(
            "createMessageChannel(document.getElementById('sequence-templates-load-msg'))"
        ),
        "sequence loader must own only its load message"
    );
    assert!(
        app.contains("viTemplateLoadMessages.clearError()")
            && app.contains("viTemplateLoadMessages.show('加载失败: '"),
        "VI loader clear/error paths must use the load channel"
    );
    assert!(
        app.contains("sequenceTemplateLoadMessages.clearError()")
            && app.contains("sequenceTemplateLoadMessages.show('加载失败: '"),
        "sequence loader clear/error paths must use the load channel"
    );
}

#[test]
fn scheduler_static_ui_uses_offline_assets_and_accessible_feedback() {
    let index = fs::read_to_string(manifest_dir().join("static/index.html")).unwrap();
    let app = fs::read_to_string(manifest_dir().join("static/app.js")).unwrap();
    let agent_index = fs::read_to_string(manifest_dir().join("../agent/static/index.html")).unwrap();

    for page in [&index, &agent_index] {
        assert!(
            !page.contains("fonts.googleapis.com") && !page.contains("fonts.gstatic.com"),
            "static pages must not depend on public font hosts"
        );
        assert!(page.contains("<link rel=\"icon\" href=\"/favicon.svg\""));
    }
    assert!(manifest_dir().join("static/favicon.svg").is_file());
    assert!(manifest_dir().join("../agent/static/favicon.svg").is_file());

    assert!(index.contains("id=\"toast\" class=\"toast\" role=\"status\""));
    assert!(index.contains("id=\"confirm-modal\" class=\"modal\" role=\"dialog\" aria-modal=\"true\""));
    assert!(app.contains("dialogController.confirm"));
    assert!(
        !app.contains("window.confirm(") && !app.contains("if (!confirm("),
        "native confirmation must be removed"
    );
    assert!(!app.contains("alert("), "native alerts must be removed");
    assert!(app.contains("setAttribute('aria-current', 'page')"));
    assert!(
        index.contains("id=\"nav-units\"")
            && index.contains("id=\"view-units\"")
            && index.contains("id=\"units-body\"")
            && index.contains("id=\"units-save-btn\"")
            && app.contains("/api/units")
            && app.contains("loadCenterUnitsPage")
            && app.contains("saveCenterUnits"),
        "center WebUI must expose shared units page and /api/units"
    );
    assert!(
        !app.contains("detail-shot")
            && !app.contains("detail-history")
            && !app.contains("detail-files")
            && !index.contains("shot-modal")
            && !index.contains("files-modal"),
        "screenshot/history/files UI must be removed"
    );
    assert!(
        !app.contains("btn-vi-edit") && app.contains("btn-template-delete"),
        "center functions page must expose delete but not rename/edit"
    );
}

#[test]
fn scheduler_machine_telemetry_strip_is_accessible_and_mobile_safe() {
    let index = fs::read_to_string(manifest_dir().join("static/index.html")).unwrap();
    let app = fs::read_to_string(manifest_dir().join("static/app.js")).unwrap();
    let css = fs::read_to_string(manifest_dir().join("static/style.css")).unwrap();

    assert!(index.contains("id=\"machine-telemetry\""));
    assert!(index.contains("for=\"agent-search\""));
    assert!(index.contains("id=\"agent-search\""));
    assert!(index.contains("for=\"agent-status-filter\""));
    assert!(index.contains("for=\"agent-sort\""));
    assert!(index.contains("for=\"agent-abnormal-only\""));
    assert!(index.contains("id=\"agents-empty\" class=\"empty\" hidden"));
    assert!(app.contains("没有匹配机台"));
    assert!(app.contains("dashboardRuntime.getAgentTelemetry"));
    assert!(app.contains("dashboardRuntime.formatAgentHeartbeat"));
    assert!(app.contains("lastAgentsRefreshAt = new Date()"));
    assert!(css.contains(".machine-control-strip"));
    assert!(css.contains(".machine-controls"));
    assert!(css.contains("@media (max-width: 640px)"));
    assert!(css.contains(".machine-control-strip { grid-template-columns: 1fr; }"));
}
