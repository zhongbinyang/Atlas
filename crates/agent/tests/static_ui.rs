const STYLE: &str = include_str!("../static/style.css");
const INDEX: &str = include_str!("../static/index.html");
const APP: &str = include_str!("../static/app.js");

fn rule_body<'a>(rules: &'a str, selector: &str) -> &'a str {
    rules
        .split_once(selector)
        .and_then(|(_, after_selector)| after_selector.split_once('}'))
        .map(|(body, _)| body)
        .unwrap_or_else(|| panic!("missing {selector} rule"))
}

fn has_exact_selector(rules: &str, selector: &str) -> bool {
    let expected = format!("{selector} {{");
    rules.lines().any(|line| line.trim() == expected)
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

#[test]
fn vi_workbench_exposes_staged_and_accessible_controls() {
    assert!(
        INDEX.contains("class=\"lv-stage-rail\" aria-label=\"VI 工作阶段\""),
        "the VI workflow needs a labelled stage rail"
    );
    for stage in ["路径", "参数", "试跑", "命名", "注册"] {
        assert!(
            INDEX.contains(&format!("<span class=\"lv-stage-label\">{stage}</span>")),
            "missing stage {stage}"
        );
    }
    assert!(
        INDEX.contains("<details id=\"lv-advanced\" class=\"lv-advanced\">"),
        "advanced settings must be collapsed by default"
    );
    assert!(
        INDEX.contains("id=\"lv-schema-summary\"")
            && INDEX.contains("role=\"status\" aria-live=\"polite\""),
        "schema counts need a polite status region"
    );
    assert!(
        INDEX.contains(
            "<p id=\"lv-action-hint\" class=\"lv-action-hint\" role=\"status\" aria-live=\"polite\">"
        ),
        "disabled VI actions need a visible reason"
    );
    assert!(
        APP.contains(
            "syncAdvancedDetailsDisabledState(advanced, controls.advancedDisabled);"
        ) && APP.contains("details.setAttribute('inert', '');")
            && APP.contains("details.setAttribute('aria-disabled', 'true');")
            && APP.contains("details.removeAttribute('inert');")
            && APP.contains("details.removeAttribute('aria-disabled');")
            && APP.contains("summary.removeAttribute('tabindex');"),
        "advanced settings must use inert and aria-disabled without changing summary focusability"
    );
    assert!(
        !APP.contains("summary.tabIndex =")
            && !APP.contains("summary.setAttribute('tabindex'"),
        "native summaries must never receive an explicit tabindex"
    );
}

#[test]
fn vi_run_result_has_summary_raw_json_and_copy_action() {
    assert!(INDEX.contains("id=\"lv-run-result\""));
    assert!(INDEX.contains("id=\"lv-run-summary\""));
    assert!(INDEX.contains("<details class=\"lv-run-raw\">"));
    assert!(INDEX.contains("id=\"lv-run-json\""));
    assert!(
        INDEX.contains(
            "<button id=\"lv-copy-result-btn\" type=\"button\" aria-label=\"复制试跑原始 JSON\">"
        ),
        "copy action needs an accessible name"
    );
}

#[test]
fn vi_registration_followups_and_center_search_are_present() {
    assert!(INDEX.contains("id=\"lv-registered-actions\""));
    assert!(INDEX.contains("id=\"lv-view-registered-btn\""));
    assert!(INDEX.contains("id=\"lv-edit-copy-btn\""));
    assert!(
        INDEX.contains(
            "<input id=\"lv-center-search\" type=\"search\" aria-label=\"搜索中心 VI 功能\""
        ),
        "center VI search needs an accessible name"
    );
    assert!(
        APP.contains("origin_agent_name")
            && APP.contains("vi_path")
            && APP.contains("lvCenterQuery"),
        "client filtering must include source machine and VI path"
    );
}

#[test]
fn vi_runtime_loads_before_the_application_and_has_mobile_layout_rules() {
    let runtime_pos = INDEX
        .find("<script src=\"/workbench-runtime.js\"></script>")
        .expect("workbench runtime script");
    let app_pos = INDEX
        .find("<script src=\"/app.js\"></script>")
        .expect("application script");
    assert!(runtime_pos < app_pos, "runtime must load before app.js");

    let mobile_rules = STYLE
        .split("@media (max-width: 640px) {")
        .last()
        .expect("mobile rules");
    assert!(
        mobile_rules.contains(".lv-stage-rail {\n    grid-template-columns: repeat(2, minmax(0, 1fr));")
    );
    assert!(
        STYLE.contains("#page-workbench {\n  min-width: 0;\n}")
            && STYLE.contains("#page-workbench .lv-toolbar > * {\n  min-width: 0;\n}"),
        "the workbench must shrink without page-level overflow"
    );
    assert!(
        STYLE.contains(
            ".lv-stage-rail {\n  display: grid;\n  grid-template-columns: repeat(5, minmax(0, 1fr));"
        ),
        "the desktop stage rail must expose five stages"
    );
    assert!(
        APP.contains("snapshot.stages.forEach(function (stageState, index) {"),
        "the stage rail must render runtime-derived naming progress"
    );
    assert_eq!(
        INDEX.matches("class=\"lv-stage-state\">待处理</span>").count(),
        4,
        "waiting VI stages must expose visible initial status text"
    );
    assert_eq!(
        INDEX.matches("class=\"lv-stage-state\">当前</span>").count(),
        1,
        "the initial current VI stage must expose visible status text"
    );
    assert!(
        APP.contains("stage.querySelector('.lv-stage-state').textContent =")
            && APP.contains("lvStageStatusText(stageState.status)"),
        "runtime stage status changes must update visible text"
    );
    assert!(
        mobile_rules.contains("#page-workbench .lv-actions {\n    width: 100%;")
            && mobile_rules
                .contains("#page-workbench .lv-actions button {\n    flex: 1 1 8rem;"),
        "responsive VI actions must remain scoped to the VI workbench"
    );
    assert!(
        STYLE.contains(
            "\n.lv-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 0.5rem;\n}"
        ),
        "the shared action layout used by the general workbench must remain available"
    );
    assert!(
        !has_exact_selector(STYLE, ".lv-toolbar > *"),
        "the VI toolbar shrink rule must not leak into other workbenches"
    );
    for selector in [".lv-actions", ".lv-actions button"] {
        assert!(
            !has_exact_selector(mobile_rules, selector),
            "mobile {selector} overrides must not leak into the general workbench"
        );
    }
}
