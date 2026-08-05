# Multi-channel Station Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the development-stage station configuration model with one revisioned aggregate that supports station defaults, independent per-channel device/calibration bindings, effective-variable preview, and immutable run snapshots.

**Architecture:** Shared DTOs and one pure resolver live in `common`. Center owns transactional aggregate persistence and revision checks; Agent exposes guarded configuration routes, adds current machine system values, and supplies immutable resolved channel snapshots to sequence workers. Agent WebUI is replaced by a channel matrix and effective-preview inspector implemented in a focused standalone script.

**Tech Stack:** Rust 2021, Axum 0.8, Tokio, SQLx/PostgreSQL, Serde/serde_json, existing `toml` crate, vanilla JavaScript/HTML/CSS, Node's built-in test runner.

## Global Constraints

- This is a development-stage replacement: final code has no legacy `/api/settings`, `/api/channels`, separate profile CRUD, compatibility shim, or dual write.
- One Agent represents one physical station.
- Configuration precedence is calibration profile → device profile → manual station variables → refreshed `Hostname`/station `IP` → channel overlay → reserved `Channel`/`ChannelIndex`.
- Only `Channel` and `ChannelIndex` are unconditionally reserved; a channel overlay may intentionally override station `IP`.
- Device and calibration inheritance are independent; null binding means inherit the station default.
- Missing inherited defaults warn; missing explicit profile references are hard errors.
- A valid channel starts even if a requested sibling has a configuration error; all-invalid requests return HTTP 422.
- Configuration is immutable for an admitted run and recorded with its revision/profile context.
- Configuration binding never acquires a channel-wide resource lock; test-item `resources` remain the only cross-channel serialization mechanism.
- Agent configuration mutation is rejected while any sequence channel is active; preview and GET remain available.
- Do not add a new third-party dependency; reuse workspace `serde`, `serde_json`, and `toml`.
- Use product base commit `ca032c9` for feature-wide dependency, formatting, and final-review diffs.
- Keep old and new schema paths only as temporary implementation staging. Task 10 removes all old paths and columns.
- Run `rustfmt` only on touched Rust files. Repository-wide rustfmt 1.9.0 has documented baseline drift; verification must prove zero formatter-hunk intersection with feature-changed Rust lines.

---

### Task 1: Define the authoritative configuration aggregate

**Files:**
- Create: `crates/common/src/station_configuration.rs`
- Modify: `crates/common/src/lib.rs`
- Test: `crates/common/src/station_configuration.rs`

**Interfaces:**
- Produces: `StationConfigurationDraft`, `StationConfigurationEnvelope`, `StationDefaults`, `StationProfile`, `StationChannel`, `ReplaceStationConfigurationRequest`, `ProfileKind`, `ConfigurationDiagnostics`, `ConfigDiagnostic`, `DiagnosticSeverity`, `ConfigurationApiError`, and stable diagnostic/error-code constants.
- Consumes: existing `AgentVariable` and `ArrayExpandMode` from `common::agent_settings`.

- [ ] **Step 1: Add failing aggregate serialization tests**

Add a `#[cfg(test)]` module asserting nullable inheritance and stable request shape:

```rust
#[test]
fn configuration_draft_roundtrip_keeps_independent_inheritance() {
    let draft = StationConfigurationDraft {
        defaults: StationDefaults {
            device_profile_id: Some("device-a".into()),
            calibration_profile_id: Some("cal-a".into()),
        },
        variables: vec![],
        array_expand_mode: ArrayExpandMode::Semicolon,
        device_profiles: vec![profile("device-a", "Device A")],
        calibration_profiles: vec![profile("cal-a", "Calibration A")],
        channels: vec![StationChannel {
            id: "channel-1".into(),
            channel_index: 1,
            name: "CH1".into(),
            enabled: true,
            device_profile_id: Some("device-a".into()),
            calibration_profile_id: None,
            overlay: serde_json::json!({"Port": "2"}),
            updated_at: None,
        }],
    };
    let value = serde_json::to_value(&draft).unwrap();
    assert_eq!(value["channels"][0]["device_profile_id"], "device-a");
    assert!(value["channels"][0]["calibration_profile_id"].is_null());
    assert_eq!(serde_json::from_value::<StationConfigurationDraft>(value).unwrap(), draft);
}

#[test]
fn replace_request_requires_explicit_base_revision() {
    let err = serde_json::from_value::<ReplaceStationConfigurationRequest>(
        serde_json::json!({"configuration": empty_draft()}),
    )
    .unwrap_err();
    assert!(err.to_string().contains("base_revision"));
}

#[test]
fn configuration_rejects_unknown_array_expand_mode() {
    let value = serde_json::json!({
        "defaults": {},
        "variables": [],
        "array_expand_mode": "unsupported",
        "device_profiles": [],
        "calibration_profiles": [],
        "channels": []
    });
    assert!(serde_json::from_value::<StationConfigurationDraft>(value).is_err());
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test -p common station_configuration::tests -- --nocapture
```

Expected: compilation fails because `common::station_configuration` and its DTOs do not exist.

- [ ] **Step 3: Implement the aggregate DTOs and stable diagnostic codes**

Create the module with these public shapes:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationConfigurationDraft {
    pub defaults: StationDefaults,
    #[serde(default)]
    pub variables: Vec<AgentVariable>,
    #[serde(default)]
    pub array_expand_mode: ArrayExpandMode,
    #[serde(default)]
    pub device_profiles: Vec<StationProfile>,
    #[serde(default)]
    pub calibration_profiles: Vec<StationProfile>,
    #[serde(default)]
    pub channels: Vec<StationChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationConfigurationEnvelope {
    pub revision: i64,
    pub updated_at: Option<String>,
    pub configuration: StationConfigurationDraft,
    #[serde(default)]
    pub diagnostics: ConfigurationDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplaceStationConfigurationRequest {
    pub base_revision: i64,
    pub configuration: StationConfigurationDraft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct StationDefaults {
    pub device_profile_id: Option<String>,
    pub calibration_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub setting: serde_json::Value,
    #[serde(default)]
    pub source_filename: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationChannel {
    pub id: String,
    pub channel_index: usize,
    pub name: String,
    pub enabled: bool,
    pub device_profile_id: Option<String>,
    pub calibration_profile_id: Option<String>,
    #[serde(default)]
    pub overlay: serde_json::Value,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileKind {
    Device,
    Calibration,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ConfigurationApiError {
    pub code: String,
    pub message: String,
    pub current_revision: Option<i64>,
    #[serde(default)]
    pub diagnostics: ConfigurationDiagnostics,
}

pub type ConfigurationDiagnostics = Vec<ConfigDiagnostic>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub channel_index: Option<usize>,
    pub field_path: Option<String>,
}
```

Define `DiagnosticSeverity` with serialized values `error` and `warning`. Define constants exactly:

```rust
pub const CODE_REVISION_CONFLICT: &str = "CONFIG_REVISION_CONFLICT";
pub const CODE_VALIDATION_FAILED: &str = "CONFIG_VALIDATION_FAILED";
pub const CODE_CHANNEL_CONFIG_INVALID: &str = "CHANNEL_CONFIG_INVALID";
pub const CODE_SEQUENCE_ACTIVE: &str = "SEQUENCE_ACTIVE";
pub const DIAG_PROFILE_MISSING: &str = "PROFILE_MISSING";
pub const DIAG_PROFILE_WRONG_KIND: &str = "PROFILE_WRONG_KIND";
pub const DIAG_DUPLICATE_CHANNEL_INDEX: &str = "DUPLICATE_CHANNEL_INDEX";
pub const DIAG_INVALID_PROFILE_ID: &str = "INVALID_PROFILE_ID";
pub const DIAG_DUPLICATE_PROFILE_ID: &str = "DUPLICATE_PROFILE_ID";
pub const DIAG_DUPLICATE_PROFILE_NAME: &str = "DUPLICATE_PROFILE_NAME";
pub const DIAG_OVERLAY_NOT_FLAT: &str = "OVERLAY_NOT_FLAT";
pub const DIAG_INVALID_VARIABLE_NAME: &str = "INVALID_VARIABLE_NAME";
pub const DIAG_RESERVED_VARIABLE: &str = "RESERVED_VARIABLE";
pub const DIAG_ARRAY_EXPAND_MODE_INVALID: &str = "ARRAY_EXPAND_MODE_INVALID";
pub const DIAG_INHERITED_DEFAULT_MISSING: &str = "INHERITED_DEFAULT_MISSING";
pub const DIAG_VALUE_OVERRIDDEN: &str = "VALUE_OVERRIDDEN";
pub const DIAG_SHARED_OPERATOR_ADDRESS: &str = "SHARED_OPERATOR_ADDRESS";
pub const DIAG_DISABLED_CHANNEL_BOUND: &str = "DISABLED_CHANNEL_BOUND";
```

Re-export the module's public types from `common::lib`.

- [ ] **Step 4: Run common tests and serialization checks**

Run:

```bash
cargo test -p common station_configuration::tests -- --nocapture
cargo test -p common
```

Expected: focused tests pass and the complete `common` suite passes.

- [ ] **Step 5: Commit Task 1**

```bash
git add crates/common/src/station_configuration.rs crates/common/src/lib.rs
git commit -m "feat: define station configuration aggregate"
```

---

### Task 2: Implement one shared resolver with provenance

**Files:**
- Modify: `crates/common/src/station_configuration.rs`
- Modify: `crates/agent/src/settings_defaults.rs`
- Test: `crates/common/src/station_configuration.rs`
- Test: `crates/agent/src/settings_defaults.rs`

**Interfaces:**
- Consumes: Task 1 aggregate DTOs.
- Produces: `resolve_station_base(...)`, `resolve_channel_configuration(...)`, `validate_station_configuration(...)`, `ResolvedStationBase`, `ResolvedChannelConfiguration`, `ResolvedProfile`, `ProfileSelection`, `ResolvedVariable`, `VariableSource`, and `VariableOverride`.
- Later tasks must not implement configuration precedence outside these functions.

- [ ] **Step 1: Add failing precedence, inheritance, and isolation tests**

Add literal profiles and two channels:

```rust
#[test]
fn channel_resolver_applies_exact_precedence_and_provenance() {
    let draft = fixture_draft(
        json!({"Main": {"Port": "cal", "CalOffset": "0.12"}}),
        json!({"Main": {"Port": "device", "DCA_IP": "10.0.0.9"}}),
        vec![AgentVariable { name: "Port".into(), value: "manual".into(), description: "".into() }],
        json!({"Port": "2", "IP": "10.0.0.12"}),
    );
    let system = BTreeMap::from([
        ("Hostname".into(), "station-a".into()),
        ("IP".into(), "10.0.0.1".into()),
    ]);
    let resolved = resolve_channel_configuration(&draft, 1, &system).unwrap();

    assert_eq!(resolved.variables["Port"].value, "2");
    assert_eq!(resolved.variables["Port"].source, VariableSource::ChannelOverlay);
    assert_eq!(resolved.variables["IP"].value, "10.0.0.12");
    assert_eq!(resolved.variables["Channel"].value, "CH1");
    assert_eq!(resolved.variables["ChannelIndex"].value, "1");
    assert_eq!(resolved.variables["CalOffset"].source, VariableSource::CalibrationProfile);
    assert_eq!(resolved.variables["DCA_IP"].source, VariableSource::DeviceProfile);
    assert_eq!(resolved.variables["Port"].overridden.len(), 3);
}

#[test]
fn device_and_calibration_inheritance_are_independent() {
    let resolved = resolve_channel_configuration(&independent_binding_fixture(), 2, &Default::default()).unwrap();
    assert_eq!(resolved.device_profile.as_ref().unwrap().id, "device-b");
    assert_eq!(resolved.device_profile.as_ref().unwrap().selection, ProfileSelection::Channel);
    assert_eq!(resolved.calibration_profile.as_ref().unwrap().id, "cal-a");
    assert_eq!(resolved.calibration_profile.as_ref().unwrap().selection, ProfileSelection::StationDefault);
}

#[test]
fn resolving_one_channel_never_mutates_a_sibling() {
    let draft = two_channel_fixture();
    let ch0 = resolve_channel_configuration(&draft, 0, &Default::default()).unwrap();
    let ch1 = resolve_channel_configuration(&draft, 1, &Default::default()).unwrap();
    assert_eq!(ch0.variables["Port"].value, "1");
    assert_eq!(ch1.variables["Port"].value, "2");
}
```

Add diagnostics tests covering every resolver-level design rule: missing inherited defaults, missing explicit references, cross-Agent/wrong-kind references, duplicate channel indexes, invalid/duplicate profile IDs and names, a non-flat overlay, invalid variable names, reserved `Channel`/`ChannelIndex`, value overrides, shared operator-sensitive `Port`/`IP`, and a disabled channel retaining an explicit binding. Assert stable code, severity, channel index, and field path; warnings must not make resolution fail. Task 1 serialization tests reject an unsupported `array_expand_mode`, and Task 4 maps that request rejection to a structured validation error.

- [ ] **Step 2: Run resolver tests and verify RED**

Run:

```bash
cargo test -p common station_configuration::tests::channel_resolver -- --nocapture
cargo test -p common station_configuration::tests::validation -- --nocapture
```

Expected: compilation fails because resolver types/functions are undefined.

- [ ] **Step 3: Move flattening and merge semantics into `common`**

Move the reusable behavior currently represented by `sanitize_profile_ident` and `flatten_setting_json` out of Agent-only code. Preserve array expansion behavior.

Expose these signatures:

```rust
pub fn resolve_station_base(
    draft: &StationConfigurationDraft,
    system_variables: &BTreeMap<String, String>,
) -> ResolvedStationBase;

pub fn resolve_channel_configuration(
    draft: &StationConfigurationDraft,
    channel_index: usize,
    system_variables: &BTreeMap<String, String>,
) -> Result<ResolvedChannelConfiguration, ConfigurationDiagnostics>;

pub fn validate_station_configuration(
    draft: &StationConfigurationDraft,
    system_variables: &BTreeMap<String, String>,
) -> ConfigurationDiagnostics;
```

`ResolvedVariable` keeps the winning source plus every overridden value:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSelection {
    StationDefault,
    Channel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedProfile {
    pub id: String,
    pub name: String,
    pub updated_at: Option<String>,
    pub selection: ProfileSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VariableSource {
    CalibrationProfile,
    DeviceProfile,
    ManualStation,
    StationSystem,
    ChannelOverlay,
    ReservedChannel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VariableOverride {
    pub value: String,
    pub source: VariableSource,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedVariable {
    pub value: String,
    pub source: VariableSource,
    pub source_id: Option<String>,
    pub overridden: Vec<VariableOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedStationBase {
    pub variables: BTreeMap<String, ResolvedVariable>,
    pub diagnostics: ConfigurationDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedChannelConfiguration {
    pub channel_id: String,
    pub channel_index: usize,
    pub channel_name: String,
    pub device_profile: Option<ResolvedProfile>,
    pub calibration_profile: Option<ResolvedProfile>,
    pub variables: BTreeMap<String, ResolvedVariable>,
    pub diagnostics: ConfigurationDiagnostics,
}
```

Apply layers in the exact Global Constraints order. Reject `Channel` and `ChannelIndex` before merging; inject them last. `Hostname` and station `IP` enter immediately before overlay, allowing intentional channel `IP` override.

- [ ] **Step 4: Make Agent defaults delegate to the shared resolver helpers**

Keep any temporarily required old wrapper signatures in `settings_defaults.rs`, but make their flatten/sanitize logic call `common`. Add a parity test showing old station-only expansion and `resolve_station_base` return the same variable values. Task 10 deletes the wrappers.

- [ ] **Step 5: Run resolver, Agent, and workspace-focused tests**

Run:

```bash
cargo test -p common station_configuration::tests -- --nocapture
cargo test -p agent settings_defaults::tests -- --nocapture
cargo test -p common
```

Expected: all pass; no resolver code remains duplicated in Agent.

- [ ] **Step 6: Commit Task 2**

```bash
git add crates/common/src/station_configuration.rs crates/agent/src/settings_defaults.rs
git commit -m "feat: resolve effective channel configuration"
```

---

### Task 3: Add revisioned aggregate persistence

**Files:**
- Create: `crates/scheduler/migrations/024_station_configuration_v2.sql`
- Create: `crates/scheduler/src/station_configuration.rs`
- Modify: `crates/scheduler/src/main.rs`
- Test: `crates/scheduler/src/station_configuration.rs`
- Test: `crates/scheduler/tests/static_tokens.rs`

**Interfaces:**
- Consumes: Task 1 DTOs and Task 2 validation.
- Produces: `load_configuration(&Store, agent_id)`, `replace_configuration(&Store, agent_id, request)`, and `ReplaceConfigurationError::{RevisionConflict, Validation, Database}`.
- Keeps old tables/columns only as temporary staging until Task 10; new writes use only the new aggregate root and bindings.

- [ ] **Step 1: Add failing migration-contract and store tests**

Add a static migration test:

```rust
#[test]
fn station_configuration_v2_schema_has_revision_and_channel_bindings() {
    let sql = include_str!("../migrations/024_station_configuration_v2.sql");
    assert!(sql.contains("CREATE TABLE IF NOT EXISTS agent_configurations"));
    assert!(sql.contains("default_device_profile_id"));
    assert!(sql.contains("default_calibration_profile_id"));
    assert!(sql.contains("ADD COLUMN IF NOT EXISTS device_profile_id"));
    assert!(sql.contains("ADD COLUMN IF NOT EXISTS calibration_profile_id"));
}
```

Add async store tests using `crate::db::GuardedStore`:

```rust
#[tokio::test]
async fn replace_is_atomic_and_increments_revision_once() {
    let store = crate::db::GuardedStore::new().await;
    let agent_id = seed_agent(&store).await;
    let first = replace_configuration(&store, &agent_id, replace_request(0)).await.unwrap();
    assert_eq!(first.revision, 1);
    let second = replace_configuration(&store, &agent_id, replace_request(1)).await.unwrap();
    assert_eq!(second.revision, 2);
}

#[tokio::test]
async fn stale_revision_rolls_back_every_table() {
    let store = crate::db::GuardedStore::new().await;
    let agent_id = seed_agent(&store).await;
    replace_configuration(&store, &agent_id, replace_request(0)).await.unwrap();
    let before = load_configuration(&store, &agent_id).await.unwrap();
    let err = replace_configuration(&store, &agent_id, replace_request(0)).await.unwrap_err();
    assert!(matches!(err, ReplaceConfigurationError::RevisionConflict { current: 1 }));
    assert_eq!(load_configuration(&store, &agent_id).await.unwrap(), before);
}
```

Also test a cross-Agent profile ID, wrong profile kind, removal of a still-referenced profile, and a SQL failure after profile writes; every case must leave the prior aggregate intact.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test -p scheduler station_configuration -- --nocapture
cargo test -p scheduler --test static_tokens station_configuration_v2_schema_has_revision_and_channel_bindings -- --exact
```

Expected: static test cannot find migration and Rust cannot find the station-configuration store module.

- [ ] **Step 3: Add the development-stage staging migration**

`024_station_configuration_v2.sql` must:

```sql
CREATE TABLE IF NOT EXISTS agent_configurations (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  default_device_profile_id TEXT NULL REFERENCES agent_device_profiles(id) ON DELETE RESTRICT,
  default_calibration_profile_id TEXT NULL REFERENCES agent_calibration_profiles(id) ON DELETE RESTRICT,
  variables_json TEXT NOT NULL DEFAULT '[]',
  array_expand_mode TEXT NOT NULL DEFAULT 'semicolon',
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

ALTER TABLE agent_channels
  ADD COLUMN IF NOT EXISTS device_profile_id TEXT NULL REFERENCES agent_device_profiles(id) ON DELETE RESTRICT;
ALTER TABLE agent_channels
  ADD COLUMN IF NOT EXISTS calibration_profile_id TEXT NULL REFERENCES agent_calibration_profiles(id) ON DELETE RESTRICT;
```

Drop the two `one_active` unique indexes because defaults now live in `agent_configurations`. Keep old `is_active` columns temporarily so pre-Task-10 code still compiles and old staging tests can run.

- [ ] **Step 4: Implement transactional load and replacement**

Use `Store::pool()` and a PostgreSQL transaction. Lock the root row with `SELECT ... FOR UPDATE`; lazily insert revision 0 if absent. Compare `base_revision` before deleting or updating child rows.

The replacement order is:

1. validate the full draft with Task 2;
2. upsert device/calibration profiles with stable request IDs;
3. update root defaults/variables/mode and increment revision once;
4. replace channels and binding IDs;
5. delete profiles removed by the draft after root/channel references have changed;
6. reload the normalized aggregate inside the transaction;
7. commit.

Do not call old `replace_agent_channels` or old profile activation methods.

- [ ] **Step 5: Run store and scheduler tests**

Run:

```bash
cargo test -p scheduler station_configuration -- --nocapture
cargo test -p scheduler --test static_tokens station_configuration_v2_schema_has_revision_and_channel_bindings -- --exact
cargo test -p scheduler
```

Expected: transaction, revision, cross-Agent, wrong-kind, reference, and rollback tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add crates/scheduler/migrations/024_station_configuration_v2.sql crates/scheduler/src/station_configuration.rs crates/scheduler/src/main.rs crates/scheduler/tests/static_tokens.rs
git commit -m "feat: persist revisioned station configuration"
```

---

### Task 4: Expose Center aggregate and import-preview APIs

**Files:**
- Create: `crates/scheduler/src/station_configuration_api.rs`
- Modify: `crates/scheduler/src/main.rs`
- Test: `crates/scheduler/src/station_configuration_api.rs`

**Interfaces:**
- Consumes: Task 3 load/replace store API and Task 2 resolver.
- Produces: Center `GET/PUT /api/agents/{id}/configuration`, `POST /api/agents/{id}/configuration/preview`, and `POST /api/agents/{id}/configuration/import-preview` routes.
- Error bodies include stable `code`, `message`, optional `current_revision`, and diagnostics; frontend never parses message text.

- [ ] **Step 1: Add failing HTTP behavior tests**

Using `tower::ServiceExt`, add tests that assert bodies, not only statuses:

```rust
#[tokio::test]
async fn put_configuration_returns_normalized_revisioned_aggregate() {
    let (app, agent_id) = seeded_app().await;
    let response = app.oneshot(put_request(&agent_id, request(0))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: StationConfigurationEnvelope = json_body(response).await;
    assert_eq!(body.revision, 1);
    assert_eq!(body.configuration.channels[0].device_profile_id.as_deref(), Some("device-b"));
}

#[tokio::test]
async fn stale_put_returns_structured_conflict() {
    let (app, agent_id) = seeded_configured_app().await;
    let response = app.oneshot(put_request(&agent_id, request(0))).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: ConfigurationApiError = json_body(response).await;
    assert_eq!(body.code, CODE_REVISION_CONFLICT);
    assert_eq!(body.current_revision, Some(1));
}

#[tokio::test]
async fn preview_matches_shared_resolver_without_persisting() {
    let before = get_configuration(&app, &agent_id).await;
    let preview = post_preview(&app, &agent_id, changed_draft()).await;
    assert_eq!(preview.channels[0].variables["Port"].value, "9");
    assert_eq!(get_configuration(&app, &agent_id).await, before);
}
```

Add an import-preview test with literal INI and TOML text; assert the returned draft profile has a caller-provided stable ID and no database row is created.

- [ ] **Step 2: Run Center API tests and verify RED**

Run:

```bash
cargo test -p scheduler station_configuration_api::tests -- --nocapture
```

Expected: compile/route failure because the focused router does not exist.

- [ ] **Step 3: Implement the focused router and structured errors**

Expose:

```rust
pub fn router() -> Router<AppState>;
```

Routes:

```text
/api/agents/{id}/configuration
/api/agents/{id}/configuration/preview
/api/agents/{id}/configuration/import-preview
```

GET lazily returns revision 0 and an empty normalized draft. PUT maps `ReplaceConfigurationError` to 409/422/500. Use an explicit JSON rejection mapper on configuration routes so malformed payloads, including an unsupported array mode, return `ConfigurationApiError` with `CODE_VALIDATION_FAILED` instead of Axum's default plain rejection. Preview uses registered Agent name/IP as station system variables and calls Task 2 without writing.

Import preview accepts:

```rust
pub struct ImportPreviewRequest {
    pub profile_id: String,
    pub kind: ProfileKind,
    pub name: String,
    pub source_filename: String,
    pub format: ImportFormat,
    pub text: String,
}
```

Parse TOML with the existing `toml` crate and port the current INI scalar/array rules into a Rust helper in this module. Return a `StationProfile`; do not persist.

- [ ] **Step 4: Run Center API and full scheduler tests**

Run:

```bash
cargo test -p scheduler station_configuration_api::tests -- --nocapture
cargo test -p scheduler
```

Expected: aggregate GET/PUT, structured conflict, non-persistent preview/import, and all prior scheduler tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add crates/scheduler/src/station_configuration_api.rs crates/scheduler/src/main.rs
git commit -m "feat: expose station configuration aggregate API"
```

---

### Task 5: Add guarded Agent configuration routes

**Files:**
- Create: `crates/agent/src/station_configuration.rs`
- Modify: `crates/agent/src/main.rs`
- Modify: `crates/agent/src/register.rs` to add aggregate client calls, then remove superseded calls in Task 10
- Test: `crates/agent/src/station_configuration.rs`

**Interfaces:**
- Consumes: Task 4 Center API and Task 2 resolver.
- Produces: Agent `GET/PUT /api/configuration`, `POST /api/configuration/preview`, `POST /api/configuration/import-preview`, plus `fetch_station_configuration(&AppState)` for runtime Task 8.
- Mutation guard checks exact sequence holds; GET/preview remain usable during runs.

- [ ] **Step 1: Add failing proxy, preview, and activity-guard tests**

Use `wiremock` for Center and `tower::ServiceExt` for Agent:

```rust
#[tokio::test]
async fn configuration_get_proxies_one_aggregate() {
    let (state, center) = state_with_center().await;
    center.mock_get_configuration(envelope(7)).await;
    let response = router().with_state(state).oneshot(get("/api/configuration")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body::<StationConfigurationEnvelope>(response).await.revision, 7);
}

#[tokio::test]
async fn configuration_put_rejects_while_any_sequence_channel_runs() {
    let state = test_state();
    let hold = state.slot.try_acquire_sequence(3).await.unwrap();
    let response = router().with_state(state.clone()).oneshot(put_configuration(request(4))).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(json_body::<ConfigurationApiError>(response).await.code, CODE_SEQUENCE_ACTIVE);
    assert!(state.slot.release_sequence(3, hold).await);
}

#[tokio::test]
async fn configuration_put_and_sequence_admission_cannot_cross_the_lifecycle_gate() {
    // Pause PUT after it owns sequence_lifecycle but before snapshot_holds().
    // A concurrent run cannot admit until PUT finishes; reversing ownership makes
    // PUT observe the admitted hold and return CODE_SEQUENCE_ACTIVE.
    assert_lifecycle_gate_serializes_put_and_admission().await;
}

#[tokio::test]
async fn preview_stays_available_during_a_run_and_injects_current_machine_values() {
    // Center returns the draft; Agent preview resolves Hostname/IP using AppState.
    let preview = post_preview_while_sequence_held().await;
    assert_eq!(preview.channels[0].variables["Hostname"].value, "agent-host");
    assert_eq!(preview.channels[0].variables["IP"].value, "10.0.0.12"); // channel override wins
}
```

- [ ] **Step 2: Run Agent configuration tests and verify RED**

Run:

```bash
cargo test -p agent station_configuration::tests -- --nocapture
```

Expected: module/routes/client helpers are absent.

- [ ] **Step 3: Implement Center client and focused Agent router**

Expose:

```rust
pub async fn fetch_station_configuration(
    state: &AppState,
) -> Result<StationConfigurationEnvelope, ConfigurationFetchError>;

pub fn router() -> Router<AppState>;
```

Resolve current `agent_id` once per request. Proxy GET/PUT/import bodies without reshaping. Preview must use the unsaved draft plus `AppState.hostname`/`AppState.ip` through Task 2 so the UI sees actual Agent system values.

For PUT, acquire the existing `state.sequence_lifecycle` mutex, keep it held across `snapshot_holds()` and the complete Center PUT, and reject when any hold has `channel_index.is_some()`. Sequence admission already uses this gate; add focused test hooks so both possible ownership orders are deterministic. Do not reject GET or preview. Do not acquire `ResourceLockManager`.

- [ ] **Step 4: Run focused and full Agent API tests**

Run:

```bash
cargo test -p agent station_configuration::tests -- --nocapture
cargo test -p agent api::tests -- --nocapture
```

Expected: proxy bodies/statuses, active-channel guard, live preview, and existing sequence lifecycle tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add crates/agent/src/station_configuration.rs crates/agent/src/main.rs crates/agent/src/register.rs
git commit -m "feat: proxy guarded station configuration"
```

---

### Task 6: Implement frontend aggregate state and preview behavior

**Files:**
- Create: `crates/agent/static/station-configuration.js`
- Modify: `crates/agent/static/index.html` to load the new script before `app.js`
- Modify: `crates/agent/static/app.js` to call the new page controller instead of old settings loaders
- Test: `crates/agent/tests/station_configuration_behavior.test.js`

**Interfaces:**
- Consumes: Task 5 Agent routes.
- Produces global `window.StationConfigurationPage` with `load`, `discard`, `save`, `previewChannel`, `setActive`, `getDraft`, and pure exported/model helpers for Node tests.
- Does not render final matrix DOM; Task 7 consumes the view model and event callbacks.

- [ ] **Step 1: Add failing state, dirty, preview-order, and conflict tests**

Create a VM-based Node test harness following `workbench_app_behavior.test.js`:

```javascript
test('station configuration draft tracks dirty count without mutating the loaded aggregate', () => {
  const page = createController({ fetch: fakeFetch(getEnvelope(4)) });
  await page.load();
  page.updateChannel(1, { device_profile_id: 'device-b' });
  assert.equal(page.getState().dirtyCount, 1);
  assert.equal(page.getState().loaded.configuration.channels[1].device_profile_id, null);
  assert.equal(page.getDraft().channels[1].device_profile_id, 'device-b');
});

test('newest preview response wins and stale preview cannot replace the inspector', async () => {
  const requests = deferredFetches();
  const page = createController({ fetch: requests.fetch });
  const first = page.previewChannel(1);
  const second = page.previewChannel(2);
  requests.resolve(1, previewFor(2, 'Port', '3'));
  requests.resolve(0, previewFor(1, 'Port', '2'));
  await Promise.all([first, second]);
  assert.equal(page.getState().preview.channel_index, 2);
});

test('revision conflict keeps local draft and records the server revision', async () => {
  const page = configuredControllerWithConflict(9);
  await page.save();
  assert.equal(page.getState().draft.channels[0].overlay.Port, '2');
  assert.equal(page.getState().conflict.current_revision, 9);
});
```

Add tests for stable client IDs via `crypto.randomUUID`, independent device/calibration inheritance, bulk inherit, overlay summary, validation severity, and read-only mutation rejection while `setActive(true)`.

- [ ] **Step 2: Run Node tests and verify RED**

Run:

```bash
node --test crates/agent/tests/station_configuration_behavior.test.js
```

Expected: failure because the page controller script does not exist.

- [ ] **Step 3: Implement the page controller and pure view-model helpers**

Expose a factory for tests and one browser singleton:

```javascript
function createStationConfigurationController(deps) {
  return {
    load,
    discard,
    save,
    previewChannel,
    setActive,
    updateDefaults,
    updateChannel,
    updateOverlay,
    bulkSetInherit,
    getDraft,
    getState,
    subscribe,
  };
}

window.StationConfigurationPage = createStationConfigurationController({
  fetch: window.fetch.bind(window),
  randomUUID: () => crypto.randomUUID(),
});
```

Use deep-cloned loaded/draft aggregates. Maintain one monotonic preview revision. PUT sends `{base_revision: loaded.revision, configuration: draft}`. On 409, retain draft and set structured conflict state. Save success replaces both loaded and draft with the normalized response.

Do not parse diagnostic messages; branch only on `code` and `severity`.

- [ ] **Step 4: Wire page activation without retaining old settings data paths**

Load `station-configuration.js` before `app.js`. On the `settings` page tab, call `StationConfigurationPage.load()`. Keep old DOM/functions temporarily unreachable until Task 7 replaces markup and Task 10 deletes the code.

- [ ] **Step 5: Run focused and existing behavior tests**

Run:

```bash
node --check crates/agent/static/station-configuration.js
node --test crates/agent/tests/station_configuration_behavior.test.js
node --test crates/agent/tests/workbench_app_behavior.test.js
```

Expected: new controller tests and all existing workbench behavior tests pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add crates/agent/static/station-configuration.js crates/agent/static/index.html crates/agent/static/app.js crates/agent/tests/station_configuration_behavior.test.js
git commit -m "feat: manage station configuration draft"
```

---

### Task 7: Replace settings UI with matrix and effective inspector

**Files:**
- Modify: `crates/agent/static/index.html` settings page and configuration modals
- Modify: `crates/agent/static/station-configuration.js`
- Modify: `crates/agent/static/style.css`
- Modify: `crates/agent/tests/static_ui.rs`
- Test: `crates/agent/tests/station_configuration_behavior.test.js`

**Interfaces:**
- Consumes: Task 6 controller state/actions and Task 5 preview responses.
- Produces DOM classes `.station-defaults`, `.station-channel-matrix`, `.station-config-inspector`, `.station-config-diagnostic`, `.station-config-readonly-banner`.
- The controller remains the only owner of loaded/draft/request state.

- [ ] **Step 1: Add failing DOM and static-contract tests**

Add rendered DOM behavior assertions:

```javascript
test('matrix shows inheritance and selected profiles side by side', async () => {
  const fixture = renderFixture(envelopeWithThreeChannels());
  const rows = fixture.document.querySelectorAll('.station-channel-row');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /继承.*Device-A/);
  assert.match(rows[1].textContent, /Device-B.*通道指定/);
  assert.match(rows[2].textContent, /Calibration-C.*通道指定/);
});

test('inspector renders source badges, overrides, and validation severity', async () => {
  const fixture = renderFixture(envelopeWithPreview());
  fixture.click('[data-channel-index="1"] .station-preview-action');
  await fixture.flush();
  assert.match(fixture.text('.station-config-inspector'), /DCA_IP.*Device-B/);
  assert.match(fixture.text('.station-config-inspector'), /Port.*Overlay/);
  assert.equal(fixture.document.querySelectorAll('[data-severity="error"]').length, 1);
  assert.equal(fixture.document.querySelectorAll('[data-severity="warning"]').length, 1);
});

test('active sequence makes mutation controls read only but preview remains enabled', () => {
  const fixture = renderActiveFixture();
  assert.equal(fixture.el('#station-config-save').disabled, true);
  assert.equal(fixture.el('.station-channel-device-select').disabled, true);
  assert.equal(fixture.el('.station-preview-action').disabled, false);
});
```

Extend `static_ui.rs` to require the confirmed headings, matrix/inspector classes, no old channel table ID, and the narrow-screen inspector rule.

- [ ] **Step 2: Run frontend tests and verify RED**

Run:

```bash
node --test --test-name-pattern="matrix|inspector|active sequence" crates/agent/tests/station_configuration_behavior.test.js
cargo test -p agent --test static_ui station_configuration -- --nocapture
```

Expected: failures because old settings markup is still present.

- [ ] **Step 3: Replace settings HTML with the confirmed layout**

Implement:

- header with sync/dirty count, discard, and save;
- read-only running banner;
- three-column station-default area;
- channel matrix with device/calibration selects whose first option is `继承机台默认`;
- overlay summary plus row-local editor;
- validation status and preview action;
- right inspector tabs `生效变量`, `仅看差异`, `校验`;
- profile management/import draft UI using `POST /api/configuration/import-preview`;
- only the initial bulk action `批量设为继承`.

Every interactive control gets an accessible name. Action clicks must not select another row accidentally. Preserve focus across matrix rerenders using channel ID plus control kind.

- [ ] **Step 4: Add responsive styles**

Desktop uses a minimum 600px matrix plus 285px inspector. Overlay summaries clamp long values. At `max-width: 900px`, render the inspector below the selected row and make the matrix horizontally scrollable without hiding action labels.

Use text plus badges for status; never color alone.

- [ ] **Step 5: Run complete frontend/static tests**

Run:

```bash
node --check crates/agent/static/station-configuration.js
node --check crates/agent/static/app.js
node --test crates/agent/tests/station_configuration_behavior.test.js
node --test crates/agent/tests/workbench_app_behavior.test.js
cargo test -p agent --test static_ui
```

Expected: matrix, inspector, responsive contract, accessibility, and all existing UI behaviors pass.

- [ ] **Step 6: Commit Task 7**

```bash
git add crates/agent/static/index.html crates/agent/static/station-configuration.js crates/agent/static/style.css crates/agent/tests/static_ui.rs crates/agent/tests/station_configuration_behavior.test.js
git commit -m "feat: replace station configuration workspace"
```

---

### Task 8: Snapshot resolved configuration into channel workers

**Files:**
- Modify: `crates/agent/src/station_configuration.rs`
- Modify: `crates/agent/src/api.rs` sequence-run preparation
- Modify: `crates/agent/src/channel_run.rs`
- Modify: `crates/agent/src/labview_sequence.rs` only where configuration context reaches logs/results
- Modify: `crates/agent/src/logging.rs`
- Test: `crates/agent/src/api.rs`
- Test: `crates/agent/src/channel_run.rs`
- Test: `crates/agent/src/logging.rs`

**Interfaces:**
- Consumes: Task 5 fetch helper and Task 2 resolver.
- Produces: `ChannelConfigurationSnapshot`, `ResolvedChannelSpec`, `ChannelConfigurationFailure`, `started_channel_indexes`, and `configuration_errors` in multi-channel responses/progress.
- Removes runtime `base_vars + overlay` recomputation from channel workers.

- [ ] **Step 1: Add failing immutable snapshot and partial-preflight tests**

Add deterministic tests:

```rust
#[tokio::test]
async fn valid_channel_runs_while_invalid_sibling_returns_configuration_error() {
    let state = state_with_configuration(two_valid_one_missing_explicit_profile()).await;
    let response = run_selected(&state, &[0, 1, 2]).await;
    assert_eq!(response.started_channel_indexes, vec![0, 1]);
    assert_eq!(response.configuration_errors.len(), 1);
    assert_eq!(response.configuration_errors[0].channel_index, 2);
    assert_eq!(response.configuration_errors[0].code, CODE_CHANNEL_CONFIG_INVALID);
}

#[tokio::test]
async fn all_invalid_channels_return_422_without_acquiring_slots() {
    let state = state_with_configuration(all_invalid()).await;
    let response = post_run(&state, &[0, 1]).await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert!(state.slot.snapshot_holds().await.is_empty());
}

#[tokio::test]
async fn worker_keeps_revision_snapshot_after_center_changes() {
    let harness = paused_worker_with_revision(7, "Port", "1").await;
    harness.center_replace_revision(8, "Port", "9").await;
    harness.resume();
    let result = harness.finish().await;
    assert_eq!(result.configuration.revision, 7);
    assert_eq!(result.observed_inputs["Port"], "1");
}
```

Add a channel-run test proving CH0/CH1 receive distinct effective `Port` values and still serialize only when a step declares the same `resources` name.

- [ ] **Step 2: Run focused runtime tests and verify RED**

Run:

```bash
cargo test -p agent valid_channel_runs_while_invalid_sibling -- --nocapture
cargo test -p agent all_invalid_channels_return_422 -- --nocapture
cargo test -p agent worker_keeps_revision_snapshot -- --nocapture
```

Expected: response/snapshot types do not exist and current worker still recomputes from base vars plus overlay.

- [ ] **Step 3: Resolve all requested channels before admission**

Fetch one `StationConfigurationEnvelope` per run request. Build system variables from current Agent hostname/IP. Resolve every requested enabled channel with Task 2.

Split output into:

```rust
pub struct ResolvedChannelSpec {
    pub channel_index: usize,
    pub name: String,
    pub effective_vars: HashMap<String, String>,
    pub configuration: ChannelConfigurationSnapshot,
}

pub struct ChannelConfigurationSnapshot {
    pub revision: i64,
    pub channel_id: String,
    pub channel_index: usize,
    pub channel_name: String,
    pub device_profile: Option<ResolvedProfile>,
    pub calibration_profile: Option<ResolvedProfile>,
    pub overlay: serde_json::Value,
    pub variables: BTreeMap<String, ResolvedVariable>,
}

pub struct ChannelConfigurationFailure {
    pub channel_index: usize,
    pub channel_name: String,
    pub code: String,
    pub diagnostics: Vec<ConfigDiagnostic>,
}
```

Add `started_channel_indexes: Vec<usize>` and `configuration_errors: Vec<ChannelConfigurationFailure>` to `MultiChannelSequenceResponse`, both with empty-vector serde defaults for tolerant readers. Progress exposes the same distinction. Only valid specs enter admission. Return 422 when there are no valid specs and at least one configuration failure. Keep busy/skipped indexes separate from configuration failures.

Make preflight and admission atomic relative to configuration PUT: acquire `state.sequence_lifecycle`, fetch one envelope, resolve requested channels, and call a new `admit_sequence_channels_locked` helper that assumes the gate is owned. The existing wrapper may acquire the gate for other call sites, but must delegate to the locked helper so there is no recursive mutex acquisition. Release the gate after slot/cancel generations are installed and before workers execute.

- [ ] **Step 4: Make workers consume immutable resolved specs**

Replace `ChannelSpec.overlay` and request-wide `base_vars` with `ResolvedChannelSpec.effective_vars`. The worker clones that map once and never fetches configuration or reapplies overlay.

Include `ChannelConfigurationSnapshot` in each channel response, progress entry, and per-channel log envelope. It contains revision, profile identity/name/timestamp/selection source, overlay, and provenance. Do not duplicate the full snapshot into each step.

Update station-only Delay/REST/VI expansion to call `resolve_station_base` from the same aggregate instead of old settings/profile helpers.

- [ ] **Step 5: Run runtime, lifecycle, resource, and logging suites**

Run:

```bash
cargo test -p agent api::tests -- --nocapture
cargo test -p agent channel_run::tests -- --nocapture
cargo test -p agent resource_lock::tests -- --nocapture
cargo test -p agent logging::tests -- --nocapture
cargo test -p agent labview_sequence::tests -- --nocapture
```

Expected: partial configuration preflight, immutable revision, independent channel variables, existing exact-generation cleanup, and item-level resource serialization pass.

- [ ] **Step 6: Commit Task 8**

```bash
git add crates/agent/src/station_configuration.rs crates/agent/src/api.rs crates/agent/src/channel_run.rs crates/agent/src/labview_sequence.rs crates/agent/src/logging.rs
git commit -m "feat: snapshot channel configuration at run start"
```

---

### Task 9: Surface channel configuration failures in run cards

**Files:**
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/station-configuration.js`
- Modify: `crates/agent/static/style.css`
- Test: `crates/agent/tests/workbench_app_behavior.test.js`
- Test: `crates/agent/tests/station_configuration_behavior.test.js`
- Modify: `crates/agent/tests/static_ui.rs`

**Interfaces:**
- Consumes: Task 8 `configuration_errors` and per-channel snapshot context.
- Produces card state `configuration_error`, top summary `部分通道未启动`, and link action from a failed card to the exact station-configuration row/validation tab.
- Preserves all existing per-channel run/abort/generation behavior.

- [ ] **Step 1: Add failing card and navigation tests**

```javascript
test('configuration-invalid channel is terminal while valid siblings keep running', () => {
  applyRunResponse({
    started_channel_indexes: [0, 1],
    configuration_errors: [{ channel_index: 2, channel_name: 'CH2', code: 'CHANNEL_CONFIG_INVALID', diagnostics: [missingProfile()] }],
  });
  assert.equal(cardModel(0).state, 'running');
  assert.equal(cardModel(1).state, 'running');
  assert.equal(cardModel(2).state, 'configuration_error');
  assert.equal(sequenceAggregateLabel(), '部分通道未启动');
});

test('configuration-error action opens the exact configuration row validation tab', () => {
  const fixture = renderedRunCardsWithConfigurationError(2);
  fixture.click('[data-channel-index="2"] .seq-channel-config-error-action');
  assert.equal(fixture.activePage(), 'settings');
  assert.equal(fixture.stationConfigState().selectedChannelIndex, 2);
  assert.equal(fixture.stationConfigState().inspectorTab, 'validation');
});
```

Add a stale-generation test proving an older configuration error cannot replace a newer run for the same channel.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run:

```bash
node --test --test-name-pattern="configuration-invalid|configuration-error action" crates/agent/tests/workbench_app_behavior.test.js
```

Expected: card model has no configuration-error state/action.

- [ ] **Step 3: Merge configuration failures into generation-safe card state**

Treat a preflight failure as a terminal channel record tied to the initiating browser request, not to configuration revision alone. Before `fetch('/api/sequence/run')`, increment a monotonic start epoch per requested channel and capture its previously observed run generation. Apply a returned configuration error only when the channel's epoch still matches and no newer generation has appeared; this prevents a slow older response from replacing a newer run. It must not set `running`, must not enable abort, and must not erase an unrelated channel. A newer actual run generation always wins.

Render:

- state label `配置错误`;
- first diagnostic message plus count;
- `查看机台配置` action;
- snapshot revision/profile summary for successfully started channels in detail view.

The action calls `StationConfigurationPage.openChannel(channelIndex, 'validation')` after switching to the settings page.

- [ ] **Step 4: Run all frontend/static tests**

Run:

```bash
node --check crates/agent/static/app.js
node --check crates/agent/static/station-configuration.js
node --test crates/agent/tests/workbench_app_behavior.test.js
node --test crates/agent/tests/station_configuration_behavior.test.js
cargo test -p agent --test static_ui
```

Expected: configuration errors, navigation, old/new generation ordering, cards, matrix, and static contracts all pass.

- [ ] **Step 5: Commit Task 9**

```bash
git add crates/agent/static/app.js crates/agent/static/station-configuration.js crates/agent/static/style.css crates/agent/tests/workbench_app_behavior.test.js crates/agent/tests/station_configuration_behavior.test.js crates/agent/tests/static_ui.rs
git commit -m "feat: show channel configuration failures"
```

---

### Task 10: Remove old configuration model and perform integrated verification

**Files:**
- Create: `crates/scheduler/migrations/025_remove_legacy_station_configuration.sql`
- Modify: `crates/scheduler/src/api.rs`
- Modify: `crates/scheduler/src/store.rs`
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/register.rs`
- Modify: `crates/agent/src/settings_defaults.rs`
- Modify: `crates/agent/static/app.js`
- Modify: `crates/agent/static/index.html`
- Modify: `crates/agent/tests/static_ui.rs`
- Modify: `docs/api.md`
- Modify: `README.md`
- Test: all Rust/Node suites listed below

**Interfaces:**
- Consumes: Tasks 1–9 complete replacement paths.
- Produces: final codebase with only the unified configuration aggregate and no old settings/channels/profile activation contract.

- [ ] **Step 1: Add failing legacy-absence tests**

Update static tests to assert both presence and absence:

```rust
#[test]
fn only_unified_station_configuration_contract_remains() {
    assert!(INDEX.contains("station-configuration.js"));
    assert!(!INDEX.contains("settings-channels-table"));
    assert!(!APP.contains("fetch('/api/settings'"));
    assert!(!APP.contains("fetch('/api/channels'"));
    assert!(!AGENT_API.contains("device-profiles"));
    assert!(!SCHEDULER_API.contains("activate_device_profile"));
}
```

Add a migration assertion that 025 drops `agent_settings` and profile `is_active` columns.

- [ ] **Step 2: Run absence tests and verify RED**

Run:

```bash
cargo test -p agent --test static_ui only_unified_station_configuration_contract_remains -- --exact
cargo test -p scheduler --test static_tokens legacy_station_configuration -- --nocapture
```

Expected: failures because staging old routes/functions/columns still exist.

- [ ] **Step 3: Delete old routes, models, helpers, and markup**

Remove:

- Center `/settings`, `/channels`, device/calibration profile list/create/update/delete/activate routes and their request/view structs;
- old Store settings, active-profile, and channel replacement methods/types no longer used by aggregate persistence;
- Agent old proxy routes and register client functions/types;
- Agent settings/profile/channel page state, renderers, event wiring, import parsers, and modals replaced by Tasks 6–7;
- transitional wrappers in `settings_defaults.rs` after all call sites use `common` resolver.

Keep global units endpoints and unit dropdown behavior; units are not part of the removed per-Agent settings contract.

- [ ] **Step 4: Add the destructive development cleanup migration**

`025_remove_legacy_station_configuration.sql` must:

```sql
DROP TABLE IF EXISTS agent_settings;
ALTER TABLE agent_device_profiles DROP COLUMN IF EXISTS is_active;
ALTER TABLE agent_calibration_profiles DROP COLUMN IF EXISTS is_active;
```

Drop obsolete active indexes if migration 024 did not already remove them. Do not copy/backfill data.

- [ ] **Step 5: Update operator/API documentation**

Document only:

- unified `/api/configuration` GET/PUT/preview/import-preview;
- revision conflict and active-run guard;
- station defaults plus independent channel binding;
- effective-variable precedence/provenance;
- per-channel configuration-error behavior;
- item-level `resources` remaining independent of configuration binding.

Remove old settings/channels/profile activation endpoint documentation rather than marking it deprecated.

- [ ] **Step 6: Run complete fresh verification**

Run:

```bash
node --check crates/agent/static/station-configuration.js
node --check crates/agent/static/app.js
node --test crates/agent/tests/station_configuration_behavior.test.js
node --test crates/agent/tests/workbench_app_behavior.test.js
node --test crates/agent/tests/workbench_runtime.test.js
cargo test -p common
cargo test -p scheduler
cargo test -p agent
cargo test --workspace
git diff --check
git diff --exit-code ca032c9..HEAD -- crates/common/Cargo.toml crates/agent/Cargo.toml crates/scheduler/Cargo.toml Cargo.lock
```

Expected: all tests pass; dependency diff is empty; worktree contains only intended tracked changes.

Run the scoped rustfmt proof over every Rust file changed in `ca032c9..HEAD`: format temporary base/current copies with installed rustfmt 1.9.0 and confirm no formatter hunk intersects a feature-changed line. Record any remaining repository-wide formatter differences as pre-existing only after the intersection count is zero.

- [ ] **Step 7: Perform manual acceptance walkthrough**

Using a clean development database:

1. create Device-A/Device-B and Calibration-A/Calibration-C in one unsaved aggregate;
2. set station defaults to Device-A and Calibration-A;
3. configure CH0 inherit/inherit, CH1 Device-B/inherit, CH2 inherit/Calibration-C;
4. preview and verify CH1 `Port`/`IP` provenance and CH2 calibration provenance;
5. save, reload, and verify revision increments once;
6. start CH0 and CH1 concurrently and verify distinct effective variables;
7. make CH2 explicitly reference a missing profile in a test fixture and verify CH0/CH1 run while CH2 shows `配置错误`;
8. verify shared `station.dca` steps serialize while resource-free steps overlap;
9. attempt configuration save during the run and verify 409/read-only UI;
10. finish runs and verify configuration becomes editable again.

- [ ] **Step 8: Commit Task 10**

```bash
git add crates/scheduler/migrations/025_remove_legacy_station_configuration.sql crates/scheduler/src/api.rs crates/scheduler/src/store.rs crates/agent/src/api.rs crates/agent/src/register.rs crates/agent/src/settings_defaults.rs crates/agent/static/app.js crates/agent/static/index.html crates/agent/tests/static_ui.rs crates/scheduler/tests/static_tokens.rs docs/api.md README.md
git commit -m "refactor: replace legacy station configuration"
```

---

## Final review gate

After Task 10:

1. Generate a full diff from `ca032c9` to HEAD.
2. Request one broad review covering resolver parity, aggregate atomicity, revision conflicts, active-run mutation races, per-channel snapshot isolation, partial configuration failures, resource-lock independence, UI accessibility, and legacy-code absence.
3. Fix all Critical/Important findings in one remediation round with focused regression tests.
4. Run the complete verification matrix again on the final HEAD before merge or push.
