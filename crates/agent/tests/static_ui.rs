const STYLE: &str = include_str!("../static/style.css");
const INDEX: &str = include_str!("../static/index.html");

fn rule_body<'a>(rules: &'a str, selector: &str) -> &'a str {
    rules
        .split_once(selector)
        .and_then(|(_, after_selector)| after_selector.split_once('}'))
        .map(|(body, _)| body)
        .unwrap_or_else(|| panic!("missing {selector} rule"))
}

#[test]
fn sequence_page_has_mobile_safe_layout_rules() {
    let mobile_rules = STYLE
        .split("@media (max-width: 640px) {")
        .nth(1)
        .expect("a mobile breakpoint for the sequence page");

    assert!(
        STYLE.contains(".seq-col {\n  min-width: 0;\n}"),
        "sequence columns must be allowed to shrink so only their tables scroll"
    );
    assert!(
        mobile_rules.contains(".seq-columns {\n    grid-template-columns: 1fr;\n  }"),
        "sequence columns must remain a single column on small screens"
    );
    assert!(
        mobile_rules.contains("#page-sequence {\n    padding-bottom: 0;\n  }"),
        "the fixed-bar spacer must be removed on small screens"
    );
    assert!(
        mobile_rules.contains(".seq-run-bar-fixed {\n    position: static;"),
        "the run bar must return to document flow on small screens"
    );
    assert!(
        rule_body(mobile_rules, ".seq-run-bar input[type=\"text\"] {").contains("min-width: 0;"),
        "SN and work-order fields must be able to shrink on small screens"
    );
    assert!(
        mobile_rules.contains("#seq-overall {\n    margin-left: 0;\n    flex: 1 1 100%;"),
        "the overall status must wrap below controls on small screens"
    );
}

#[test]
fn sequence_filter_controls_have_accessible_names() {
    assert!(
        INDEX.contains(
            "<input id=\"seq-registered-search\" type=\"search\" aria-label=\"搜索中心功能\""
        ),
        "the registered-function search requires an accessible name"
    );
    assert!(
        INDEX.contains("<select id=\"seq-registered-filter\" aria-label=\"按类型筛选\">"),
        "the registered-function type filter requires an accessible name"
    );
}

#[test]
fn agent_static_ui_uses_local_font_stack_and_favicon() {
    assert!(!INDEX.contains("fonts.googleapis.com"));
    assert!(!INDEX.contains("fonts.gstatic.com"));
    assert!(INDEX.contains("<link rel=\"icon\" href=\"/favicon.svg\""));
    assert!(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("static/favicon.svg")
        .is_file());
}
