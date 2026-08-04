const STYLE: &str = include_str!("../static/style.css");
const INDEX: &str = include_str!("../static/index.html");
const APP: &str = include_str!("../static/app.js");

fn has_exact_selector(rules: &str, selector: &str) -> bool {
    let expected = format!("{selector} {{");
    rules.lines().any(|line| line.trim() == expected)
}

fn normalized_style() -> String {
    STYLE.replace("\r\n", "\n")
}

#[test]
fn sequence_page_has_mobile_safe_layout_rules() {
    let style = normalized_style();
    let mobile_rules = style
        .split("@media (max-width: 640px) {")
        .nth(1)
        .expect("a mobile breakpoint for the sequence page");

    assert!(
        style.contains("#page-sequence-edit,\n#page-sequence-run {")
            && style.contains("min-width: 0;"),
        "the sequence pages must shrink without page-level overflow"
    );
    assert!(
        style.contains(".seq-queue-section {\n  margin-bottom: 0.75rem;\n  min-width: 0;\n}"),
        "the execution queue must be allowed to shrink so only its table scrolls"
    );
    assert!(
        style.contains(".seq-drawer {\n  margin-bottom: 0.75rem;"),
        "registered functions and templates must use collapsible drawers"
    );
    assert!(
        mobile_rules.contains(".seq-channel-cards")
            && mobile_rules.contains("grid-template-columns: 1fr;")
            && mobile_rules.contains(".seq-run-controls"),
        "operator cards and top run controls must stack safely on small screens"
    );
}

#[test]
fn sequence_run_page_uses_persistent_channel_cards_and_detail_view() {
    assert!(
        !INDEX.contains("id=\"seq-sn\"")
            && !INDEX.contains("id=\"seq-work-order\"")
            && !APP.contains("payload.sn")
            && !APP.contains("payload.work_order"),
        "the current run page must not expose or submit SN/work-order fields"
    );
    assert!(
        INDEX.contains("id=\"seq-run-status-card\"")
            && INDEX.contains("id=\"seq-run-status-label\"")
            && INDEX.contains("id=\"seq-run-meta\"")
            && INDEX.contains("class=\"seq-run-controls\"")
            && INDEX.contains("id=\"seq-channel-pick\"")
            && INDEX.contains("id=\"seq-run-btn\"")
            && INDEX.contains("id=\"seq-abort-btn\""),
        "the run page needs a compact status summary with controls in document flow"
    );
    assert!(
        INDEX.contains("id=\"seq-channel-overview\"")
            && INDEX.contains("id=\"seq-channel-cards\"")
            && INDEX.contains("id=\"seq-channel-detail\"")
            && INDEX.contains("id=\"seq-channel-detail-back\"")
            && INDEX.contains("id=\"seq-channel-detail-prev\"")
            && INDEX.contains("id=\"seq-channel-detail-next\"")
            && INDEX.contains("id=\"seq-channel-detail-title\"")
            && INDEX.contains("id=\"seq-channel-detail-status\"")
            && INDEX.contains("id=\"seq-channel-detail-elapsed\"")
            && INDEX.contains("id=\"seq-channel-detail-counts\"")
            && INDEX.contains("id=\"seq-channel-current\"")
            && INDEX.contains("id=\"seq-channel-detail-steps\"")
            && !INDEX.contains("seq-run-bar-fixed"),
        "fixed channel cards must lead to a dedicated channel detail screen"
    );
    assert!(
        !INDEX.contains("id=\"seq-channel-cards\" class=\"seq-channel-cards\" aria-live"),
        "the card grid is rebuilt during polling and must not announce the entire grid on every update"
    );
    assert!(
        APP.contains("buildSequenceChannelCardModel")
            && APP.contains("buildSequenceChannelDetailModel")
            && APP.contains("formatSequenceElapsed")
            && APP.contains("renderSeqChannelCards")
            && APP.contains("renderSeqChannelDetail")
            && APP.contains("openSeqChannelDetail")
            && !INDEX.contains("id=\"seq-progress-matrix\"")
            && !INDEX.contains("id=\"seq-operator-view\"")
            && !INDEX.contains("id=\"seq-engineer-view\"")
            && !INDEX.contains("id=\"seq-step-inspector\"")
            && !INDEX.contains("id=\"seq-run-report\"")
            && !INDEX.contains("id=\"seq-exception-filter-btn\""),
        "the old matrix, mode switch, inspector, report, and exception filter must be removed"
    );
    assert!(
        APP.contains("buildSequenceDetailSections")
            && APP.contains("buildSequenceGroupSummary")
            && APP.contains("appendSequenceDetailStep")
            && STYLE.contains(".seq-channel-group {")
            && STYLE.contains(".seq-channel-group-body {")
            && STYLE.contains(".seq-channel-group-guide {")
            && STYLE.contains(".seq-channel-group[data-state=\"running\"]")
            && APP.contains("model.sections.forEach")
            && APP.contains("data-group-key")
            && APP.contains("data-state")
            && APP.contains("已禁用")
            && APP.contains("section.summary.completed")
            && APP.contains("该组暂无步骤")
            && APP.contains("seq-channel-group-chevron")
            && APP.contains("chevron.setAttribute('aria-hidden', 'true')")
            && APP.contains("data-kind")
            && STYLE.contains(".seq-channel-group[open] > .seq-channel-group-summary .seq-channel-group-chevron")
            && STYLE.contains(".seq-channel-group[data-kind=\"ungrouped\"]")
            && STYLE.contains(".seq-channel-group[data-kind=\"result-only\"]"),
        "channel detail must render state-aware grouped sections"
    );
}

#[test]
fn sequence_page_uses_collapsed_drawers_around_queue() {
    assert!(
        INDEX.contains("<details class=\"seq-drawer\" id=\"seq-registered-drawer\">")
            && INDEX.contains("<details class=\"seq-drawer\" id=\"seq-templates-drawer\">"),
        "registered functions and templates must be collapsible drawers"
    );
    assert!(
        !INDEX.contains("id=\"seq-registered-drawer\" open")
            && !INDEX.contains("id=\"seq-templates-drawer\" open"),
        "sequence drawers must stay collapsed by default"
    );
    assert!(
        INDEX.contains("<section class=\"seq-queue-section\">"),
        "the execution queue must remain the primary middle section"
    );
    assert!(
        INDEX.contains("id=\"seq-insert-group\"")
            && INDEX.contains("id=\"seq-group-selected\"")
            && INDEX.contains("id=\"seq-insert-badge\"")
            && APP.contains("insertSeqGroup")
            && APP.contains("groupSelectedSteps")
            && APP.contains("groupCheckedIntoFolder")
            && APP.contains("insertIndexForNewStep")
            && APP.contains("moveGroupBlock")
            && APP.contains("seq-outline-child")
            && APP.contains("template_source: 'group'"),
        "execution queue must support outline folders, multi-select grouping, and group block moves"
    );
    assert!(
        APP.contains("展开上方「中心全部功能」后添加"),
        "empty-queue guidance must point to the top drawer"
    );
}

#[test]
fn machine_info_is_collapsed_in_topbar_before_register() {
    let register_pos = INDEX
        .find("id=\"register-btn\"")
        .expect("register button");
    let machine_pos = INDEX
        .find("<details class=\"machine-info\" id=\"machine-info\">")
        .expect("machine info details");
    assert!(
        machine_pos < register_pos,
        "machine info must sit before the re-register button"
    );
    assert!(
        !INDEX.contains("id=\"machine-info\" open"),
        "machine info must stay collapsed by default"
    );
    assert!(
        INDEX.contains("id=\"machine-info-busy\"")
            && APP.contains("machine-info-busy"),
        "summary should mirror busy/idle without opening the panel"
    );
    assert!(
        INDEX.contains("id=\"hostname\"")
            && INDEX.contains("id=\"ip\"")
            && INDEX.contains("id=\"uptime\"")
            && INDEX.contains("id=\"metric-cpu\"")
            && INDEX.contains("id=\"metric-memory\"")
            && INDEX.contains("id=\"metric-busy\""),
        "status field ids must remain for fetchStatus"
    );
    assert!(
        INDEX.contains("id=\"machine-busy-actions\"")
            && INDEX.contains("id=\"force-release-btn\"")
            && APP.contains("forceReleaseSlot")
            && APP.contains("syncSequenceBusyFromStatus")
            && APP.contains("formatBusyConflictMessage"),
        "busy recovery UI must allow force-idle"
    );
    assert!(
        !INDEX.contains("id=\"seq-continue-btn\"")
            && !INDEX.contains(">断点</th>")
            && !APP.contains("continueSequence")
            && !APP.contains("seqPaused")
            && !APP.contains("/api/sequence/run/continue"),
        "sequence UI must not expose breakpoint continue controls"
    );
    assert!(
        INDEX.contains("id=\"seq-abort-btn\"") && APP.contains("abortSequence"),
        "sequence UI must keep abort control"
    );
}

#[test]
fn settings_and_sequence_expose_channels_and_step_resources() {
    assert!(
        APP.contains("loadAgentChannels") && APP.contains("saveAgentChannels"),
        "settings must load/save channel overlays via helpers"
    );
    assert!(
        APP.contains("resources") || INDEX.contains("step-resources"),
        "sequence step editor must bind resources"
    );
    assert!(
        INDEX.contains("id=\"settings-channels-section\"")
            && INDEX.contains("id=\"settings-channels-body\"")
            && INDEX.contains("id=\"settings-channels-save-btn\"")
            && INDEX.contains("id=\"settings-channel-add-btn\"")
            && APP.contains("/api/channels")
            && APP.contains("renderAgentChannels")
            && APP.contains("collectChannelsFromDom"),
        "config page must expose 通道 section with save → PUT /api/channels"
    );
    assert!(
        INDEX.contains("id=\"resource-presets\"")
            && INDEX.contains("station.dca")
            && INDEX.contains("station.osa")
            && INDEX.contains("ch.evb")
            && APP.contains("renderStepResourcesEditor")
            && APP.contains("normalizeResourceName"),
        "step resources UI needs presets datalist and tag editor"
    );
    assert!(
        INDEX.contains("data-page=\"sequence-edit\"")
            && INDEX.contains("data-page=\"sequence-run\"")
            && INDEX.contains("id=\"page-sequence-edit\"")
            && INDEX.contains("id=\"page-sequence-run\"")
            && INDEX.contains("id=\"seq-goto-run-btn\"")
            && INDEX.contains("id=\"seq-goto-edit-btn\"")
            && APP.contains("showPage('sequence-run')")
            && APP.contains("showPage('sequence-edit')"),
        "sequence must split into 编排 / 运行 pages with cross-links"
    );
    assert!(
        INDEX.contains("id=\"seq-channel-pick\"")
            && INDEX.contains("id=\"seq-channel-overview\"")
            && INDEX.contains("id=\"seq-channel-cards\"")
            && INDEX.contains("id=\"seq-channel-detail\"")
            && INDEX.contains("id=\"seq-channel-detail-steps\"")
            && INDEX.contains("id=\"seq-results-section\"")
            && APP.contains("channel_indexes")
            && APP.contains("applyMultiChannelProgress")
            && APP.contains("renderSeqChannelCards")
            && APP.contains("renderSeqChannelDetail")
            && APP.contains("openSeqChannelDetail")
            && APP.contains("handleSequenceResponse")
            && APP.contains("data.channels")
            && APP.contains("Keep the edit queue free of per-channel")
            && (INDEX.contains("序列运行") || INDEX.contains("不写回本队列")),
        "run page must provide persistent channel cards and a per-channel detail screen; edit queue stays edit-only"
    );
    assert!(
        INDEX.contains("共用仪表填相同资源名")
            || APP.contains("共用仪表填相同资源名"),
        "help text must explain shared resource names vs empty parallel steps"
    );
    assert!(
        APP.contains("abortBtn.disabled = !disabled")
            || APP.contains("abortBtn.disabled = !seqRunning"),
        "abort must be enabled while sequence is running"
    );
    assert!(
        APP.contains("sequenceWasAborted")
            && APP.contains("showSeqMsg('已中止'")
            && APP.contains(".step-resources-input"),
        "abort toast must detect per-channel abort; resource inputs re-enabled after run"
    );
}

#[test]
fn settings_page_exposes_units_and_variables() {
    assert!(
        INDEX.contains("data-page=\"settings\"") && INDEX.contains("id=\"page-settings\""),
        "配置 must be a top-level tab"
    );
    assert!(
        !INDEX.contains("id=\"settings-units-body\"")
            && !INDEX.contains("id=\"settings-restore-units-btn\"")
            && INDEX.contains("id=\"settings-vars-body\"")
            && INDEX.contains("settings-col-desc")
            && INDEX.contains("id=\"settings-save-btn\"")
            && INDEX.contains("id=\"settings-array-expand-mode\"")
            && INDEX.contains("settings-stack")
            && INDEX.contains("settings-toolbar")
            && INDEX.contains("settings-help"),
        "settings page must drop units editor; keep vars/profiles toolbar and help"
    );
    assert!(
        APP.contains("loadAgentSettingsPage")
            && APP.contains("fetchCenterUnits")
            && APP.contains("centerUnits")
            && APP.contains("attachVarPicker")
            && APP.contains("getCaretViewportPoint")
            && APP.contains("ArrowDown")
            && APP.contains("settingsDirty")
            && APP.contains("isSystemVarName")
            && APP.contains("spec-unit-select")
            && APP.contains("/api/settings")
            && APP.contains("/api/units"),
        "settings UI must load center units for Spec; dirty/vars/picker remain"
    );
    assert!(
        APP.contains("DEVICE_CFG_ADDRESS_KEYS")
            && APP.contains("parseDeviceCfgIni")
            && APP.contains("iniToSettingJson")
            && APP.contains("coerceIniScalarOrArray")
            && APP.contains("tomlToSettingJson")
            && APP.contains("textToSettingJson")
            && APP.contains("openProfileImportPreview")
            && APP.contains("sanitizeDeviceCfgIdent")
            && APP.contains("buildDeviceCfgImportPreview")
            && APP.contains("mergeDeviceCfgPreviewIntoVariables"),
        "settings must expose INI/TOML→profile helpers"
    );
    assert!(
        INDEX.contains("id=\"settings-import-device-cfg-btn\"")
            && INDEX.contains("id=\"settings-device-cfg-file\"")
            && INDEX.contains("id=\"settings-import-calibration-cfg-btn\"")
            && INDEX.contains("id=\"settings-device-profiles-body\"")
            && INDEX.contains("id=\"settings-calibration-profiles-body\"")
            && INDEX.contains("id=\"settings-device-flat-body\"")
            && INDEX.contains("id=\"settings-calibration-flat-body\"")
            && INDEX.contains("id=\"settings-device-section\"")
            && INDEX.contains("id=\"settings-calibration-section\"")
            && INDEX.contains("id=\"settings-vars-section\"")
            && INDEX.contains("id=\"device-cfg-import-modal\"")
            && INDEX.contains("id=\"device-cfg-import-apply-btn\"")
            && INDEX.contains("id=\"profile-import-name\""),
        "settings page must stack device/cal/vars sections with flat expand tables"
    );
    assert!(
        APP.contains("openProfileImportPreview")
            && APP.contains("applyDeviceCfgImportPreview")
            && APP.contains("refreshConfigProfiles")
            && APP.contains("activateConfigProfile")
            && APP.contains("settingJsonToToml")
            && APP.contains("exportViewedProfileToml")
            && APP.contains("renderActiveProfileFlat")
            && APP.contains("saveActiveProfileFlat")
            && APP.contains("/api/device-profiles")
            && APP.contains("/api/calibration-profiles"),
        "settings must wire profile CRUD, flat edit, TOML import/view/export"
    );
    assert!(
        INDEX.contains("id=\"profile-view-toml\"")
            && INDEX.contains("id=\"profile-view-export-btn\""),
        "profile view modal must show TOML and offer export"
    );
}

#[test]
fn api_page_exposes_rest_client_controls() {
    assert!(
        INDEX.contains("data-page=\"api\"") && INDEX.contains("id=\"page-api\""),
        "API must be a top-level tab sibling of VI/general/sequence"
    );
    assert!(
        INDEX.contains("id=\"api-method\"")
            && INDEX.contains("id=\"api-url\"")
            && INDEX.contains("id=\"api-headers\"")
            && INDEX.contains("id=\"api-headers-kv-body\"")
            && INDEX.contains("id=\"api-body\"")
            && INDEX.contains("id=\"api-run-btn\"")
            && INDEX.contains("id=\"api-register-btn\"")
            && INDEX.contains("id=\"api-body-format-btn\"")
            && INDEX.contains("id=\"api-body-minify-btn\"")
            && INDEX.contains("id=\"api-response\"")
            && INDEX.contains("data-api-headers-mode=\"json\"")
            && !INDEX.contains("api-output-fields")
            && !INDEX.contains("api-extract-fields-btn"),
        "REST editor needs method/url/headers/body tools and response panel without Spec field UI"
    );
    assert!(
        APP.contains("/api/general/rest/run")
            && APP.contains("/api/general/rest/register-template")
            && APP.contains("case 'rest': return 'REST'")
            && APP.contains("setApiHeadersMode")
            && APP.contains("setApiEditorTab")
            && APP.contains("refreshBodyJsonStatus"),
        "client must call REST endpoints and support JSON header/body editors"
    );
    assert!(
        INDEX.contains("id=\"gen-version-run-btn\"")
            && INDEX.contains("id=\"gen-version-register-btn\"")
            && APP.contains("/api/general/version/run")
            && APP.contains("/api/general/version/register-template")
            && APP.contains("case 'version': return '版本号'")
            && APP.contains("registerGeneralVersion"),
        "general workbench must expose Agent version read + register for sequences"
    );
    assert!(
        INDEX.contains("class=\"api-workbench\"")
            && INDEX.contains("class=\"api-main-split\"")
            && INDEX.contains("data-api-editor-tab=\"headers\"")
            && INDEX.contains("data-api-editor-tab=\"body\"")
            && INDEX.contains("id=\"api-templates-drawer\""),
        "API page should use workbench + Headers/Body tabs + response split + templates drawer"
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
        INDEX.contains("<p id=\"lv-action-hint\" class=\"lv-action-hint\">")
            && !INDEX.contains(
                "<p id=\"lv-action-hint\" class=\"lv-action-hint\" role=\"status\" aria-live=\"polite\">"
            )
            && INDEX.contains(
                "<p id=\"lv-stage-status\" class=\"lv-stage-status\" role=\"status\" aria-live=\"polite\">"
            ),
        "VI status and action hint must expose exactly one polite live region"
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
    let style = normalized_style();
    let runtime_pos = INDEX
        .find("<script src=\"/workbench-runtime.js\"></script>")
        .expect("workbench runtime script");
    let app_pos = INDEX
        .find("<script src=\"/app.js\"></script>")
        .expect("application script");
    assert!(runtime_pos < app_pos, "runtime must load before app.js");

    let mobile_rules = style
        .split("@media (max-width: 640px) {")
        .last()
        .expect("mobile rules");
    assert!(
        mobile_rules.contains(".lv-stage-rail {\n    grid-template-columns: repeat(2, minmax(0, 1fr));")
    );
    assert!(
        style.contains("#page-workbench {\n  min-width: 0;\n}")
            && style.contains("#page-workbench .lv-toolbar > * {\n  min-width: 0;\n}"),
        "the workbench must shrink without page-level overflow"
    );
    assert!(
        style.contains(
            ".lv-stage-rail {\n  display: grid;\n  grid-template-columns: repeat(5, minmax(0, 1fr));"
        ),
        "the desktop stage rail must expose five stages"
    );
    assert!(
        APP.contains("snapshot.stages.forEach(function (stageState, index) {"),
        "the stage rail must render runtime-derived naming progress"
    );
    assert!(
        APP.contains(
            "setTextIfChanged(document.getElementById('lv-stage-status'), stageMessage);"
        ) && APP.contains("setTextIfChanged(actionHint, actionHintText);")
            && APP.contains(
                "setTextIfChanged(stage.querySelector('.lv-stage-state'),"
            ),
        "VI synchronization must not reassign unchanged visible status text"
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
        APP.contains("setTextIfChanged(stage.querySelector('.lv-stage-state'),")
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
        style.contains(
            "\n.lv-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 0.5rem;\n}"
        ),
        "the shared action layout used by the general workbench must remain available"
    );
    assert!(
        !has_exact_selector(&style, ".lv-toolbar > *"),
        "the VI toolbar shrink rule must not leak into other workbenches"
    );
    for selector in [".lv-actions", ".lv-actions button"] {
        assert!(
            !has_exact_selector(mobile_rules, selector),
            "mobile {selector} overrides must not leak into the general workbench"
        );
    }
}
