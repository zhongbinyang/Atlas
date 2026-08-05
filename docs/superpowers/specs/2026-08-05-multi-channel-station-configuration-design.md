# Design: Multi-channel station configuration

Date: 2026-08-05
Status: approved for planning

## Goal

Redesign Agent WebUI station configuration around multi-channel operation. A station owns shared defaults; each channel may independently inherit or select device and calibration profiles, then apply a small flat overlay. Operators can compare all channels in one matrix and preview the exact effective variables before saving or running.

This is a development-stage replacement design. It does not preserve legacy configuration APIs, UI structure, database contents, or dual-write behavior.

## Product decisions

- One Agent still represents one physical station.
- The station has one default device profile and one default calibration profile.
- Each channel independently chooses either `inherit` or a specific profile for each profile kind.
- Device and calibration inheritance are independent.
- A channel overlay contains only channel-local scalar variables such as `Port` or a channel IP.
- Shared instrument serialization remains step-level through `resources`; configuration binding never creates a channel-level resource lock.
- Configuration is immutable for an admitted channel run. A later configuration change affects only a later run.
- If some requested channels have invalid configuration, valid channels may start immediately and invalid channels become per-channel configuration errors.
- While any channel is active, station configuration is view-only through Agent WebUI and Agent mutation APIs.

## Non-goals

- Preserving or migrating development database contents.
- Maintaining `/api/settings`, `/api/channels`, or the existing separate profile CRUD contracts.
- Supporting multiple Agents in one station configuration.
- Adding channel-wide execution locks.
- Building named station configuration packages in the first version.
- Allowing live configuration mutation to alter an already admitted run.

## Authoritative data model

The new schema replaces the old activation model. Profile rows no longer own `is_active`; station defaults are explicit references in `agent_configurations`.

### `agent_configurations`

| Column | Type | Notes |
|---|---|---|
| `agent_id` | TEXT PK/FK | One configuration root per Agent |
| `default_device_profile_id` | TEXT NULL | Station default; null means no device layer |
| `default_calibration_profile_id` | TEXT NULL | Station default; null means no calibration layer |
| `variables_json` | TEXT NOT NULL | Manual station variables |
| `array_expand_mode` | TEXT NOT NULL | `semicolon` or `json` |
| `revision` | BIGINT NOT NULL | Optimistic concurrency token |
| `updated_at` | TEXT NOT NULL | RFC3339 |

### `agent_device_profiles`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Stable profile ID |
| `agent_id` | TEXT FK | Owning Agent |
| `name` | TEXT NOT NULL | Unique within the Agent's device profiles |
| `setting_json` | TEXT NOT NULL | Imported or edited structured settings |
| `source_filename` | TEXT NOT NULL | Optional provenance |
| `updated_at` | TEXT NOT NULL | Used in run configuration context |

### `agent_calibration_profiles`

Same shape as device profiles, with names unique within the Agent's calibration profiles.

### `agent_channels`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Stable channel ID |
| `agent_id` | TEXT FK | Owning Agent |
| `channel_index` | INTEGER NOT NULL | Unique within Agent |
| `name` | TEXT NOT NULL | Operator-facing name |
| `enabled` | BOOLEAN NOT NULL | Disabled channels keep all bindings |
| `device_profile_id` | TEXT NULL | Null means inherit station default |
| `calibration_profile_id` | TEXT NULL | Null means inherit station default |
| `overlay_json` | TEXT NOT NULL | Flat scalar key/value object |
| `updated_at` | TEXT NOT NULL | RFC3339 |

Profile references use delete restriction. Service validation additionally guarantees that referenced profiles belong to the same Agent and have the correct profile kind.

Because this is a development-stage replacement, implementation may rewrite the current development migrations and rebuild the database. No backfill or compatibility columns are required.

## Inheritance and merge semantics

For each channel, resolve the profile IDs first:

1. Use the channel-specific device profile when set; otherwise use the station default device profile.
2. Use the channel-specific calibration profile when set; otherwise use the station default calibration profile.
3. A missing inherited default creates an empty layer and a warning, not an automatic hard failure.
4. A missing explicitly referenced profile is a hard configuration error.

Build effective variables in this order, with later layers overriding earlier layers:

1. Effective calibration profile, flattened to variables.
2. Effective device profile, flattened to variables.
3. Manual station variables.
4. Channel overlay.
5. System-injected `Channel` and `ChannelIndex`.

Only `Channel` and `ChannelIndex` are reserved. They cannot be supplied by a profile, manual variable, or overlay. `Hostname` and station `IP` are refreshed by the Agent into the station base before the channel overlay is applied. A channel may intentionally override `IP`; preview provenance must show the station value and the channel override.

Duplicate keys across legitimate layers are allowed. They are displayed as overrides in preview rather than treated as conflicts.

## Shared resolver

One pure resolver is the only implementation of profile selection, flattening, precedence, reserved-key checks, and provenance.

It is consumed by:

- unsaved configuration preview;
- save validation;
- run-start channel preflight;
- channel worker variable construction;
- run configuration context logging.

Inputs include a station configuration draft, available profiles, and one channel. Output includes:

- effective device and calibration profile identities and whether each is inherited or channel-selected;
- effective variable map;
- provenance for every effective variable;
- overridden source history;
- hard errors and non-blocking warnings.

Frontend code must not independently reproduce merge precedence.

## Agent WebUI layout

The existing settings page is replaced by the confirmed **channel matrix plus right-side effective preview** layout.

### Header

- Page title and synchronization/dirty state.
- Unsaved change count.
- `Discard changes` and `Save station configuration` actions.
- When any channel is active, a read-only banner explains that changes affect future runs and saving is unavailable.

### Station defaults

A compact three-column summary/editor contains:

- default device profile selector;
- default calibration profile selector;
- manual station variable count and editor entry.

The first selector option is `No default`. Profile creation/import/editing is available from the selector management action and updates the same page draft.

### Channel matrix

Columns:

- row selection;
- channel name/index and enabled state;
- device profile selection;
- calibration profile selection;
- overlay summary/editor;
- validation status;
- effective-preview action.

Each profile selector begins with `Inherit station default` and also shows the currently resolved profile name below it. Disabled channels remain editable when no run is active and retain bindings.

Bulk action initially supports only `Set selected rows to inherit`; broader bulk editing is deferred.

Overlay cells show a concise summary. Editing expands a flat key/value editor without making every row permanently tall.

### Effective preview inspector

Selecting a row opens a right-side inspector with:

- effective profile identities and source chain;
- `Effective variables`, `Differences only`, and `Validation` views;
- value and source badge for each variable;
- overridden source history;
- copy-effective-variables action.

Preview runs against the unsaved page draft. On narrow screens the inspector renders immediately below the selected channel row.

## Unified configuration API

The new Agent endpoints are the only WebUI configuration contract:

```text
GET  /api/configuration
PUT  /api/configuration
POST /api/configuration/preview
POST /api/configuration/import-preview
```

Center exposes equivalent Agent-scoped endpoints under `/api/agents/{id}/configuration`. Agent routes identify the current Agent, apply run-state guards, and proxy or resolve as appropriate.

### `GET /api/configuration`

Returns one aggregate:

- `revision`;
- station defaults;
- manual variables and array expansion mode;
- device and calibration profiles;
- channels and their nullable bindings;
- diagnostics for the saved aggregate.

The page loads from this one response. It does not combine independently fetched settings, profiles, and channels.

### `PUT /api/configuration`

Replaces the complete draftable aggregate in one database transaction. The request contains `base_revision`, defaults, variables, profiles, and channels.

Validation happens before mutation. A successful transaction increments `revision` exactly once and returns the complete normalized aggregate.

If `base_revision` is stale, return `409 CONFIG_REVISION_CONFLICT` with the current revision. The WebUI retains its draft and offers reload; it never silently overwrites another update.

If any channel is active, the Agent route returns `409 SEQUENCE_ACTIVE`. Center remains consistent if called directly because admitted workers already own immutable snapshots; direct Center changes affect only later runs.

### `POST /api/configuration/preview`

Accepts the same unsaved aggregate without writing. It returns per-channel resolved profiles, effective variables with provenance, and diagnostics. Preview and run preflight use the same resolver.

### `POST /api/configuration/import-preview`

Parses INI or TOML into a draft profile without persistence. The operator reviews the result in the page draft, then the next aggregate `PUT` saves it atomically with bindings and defaults.

There are no legacy configuration mutation endpoints or dual writes in the new design.

## Validation and diagnostics

Hard errors prevent saving or starting the affected channel:

- a referenced profile does not exist;
- a referenced profile belongs to another Agent or the wrong profile kind;
- duplicate channel indexes;
- invalid or duplicate profile IDs/names;
- an overlay is not a flat scalar object;
- invalid variable names;
- use of reserved system variables;
- unsupported array expansion mode.

Warnings do not prevent saving:

- an inherited layer has no station default;
- an overlay or manual variable overrides a profile value;
- enabled channels resolve to the same operator-sensitive address such as Port or IP;
- a disabled channel retains a channel-specific profile binding.

Diagnostics use stable codes, severity, channel index, field path, and an operator-facing message. UI rendering must not parse message text to determine behavior.

## Run admission and immutable snapshots

At start, the Agent fetches or reads one configuration aggregate and resolves every requested channel. Each successfully admitted channel owns an immutable configuration snapshot containing:

- configuration revision;
- channel identity;
- effective profile IDs, names, timestamps, and selection source;
- overlay;
- effective variables and provenance.

Valid channels start independently. A channel with hard configuration errors does not acquire a sequence slot and receives a terminal `configuration_error` result. Other valid channels are not blocked. If every requested channel is invalid, the request returns `422 CHANNEL_CONFIG_INVALID` with per-channel diagnostics.

Run logs record the revision and profile/channel context. Full effective variables need not be duplicated for every step; the per-channel run envelope holds the snapshot context.

Configuration resolution does not acquire or hold `ResourceLockManager` resources. Test-item `resources` remain the only cross-channel serialization mechanism.

## Error handling

Stable API errors include:

- `CONFIG_REVISION_CONFLICT` — stale editor revision;
- `CONFIG_VALIDATION_FAILED` — aggregate cannot be saved;
- `CHANNEL_CONFIG_INVALID` — one or more requested channels failed run preflight;
- `SEQUENCE_ACTIVE` — Agent configuration mutation attempted during activity.

Partial run-start responses distinguish busy/skipped channels from configuration-invalid channels. The sequence cards show `Configuration error` with a link to the corresponding channel row and inspector validation tab.

## Testing

### Resolver tests

- independent device and calibration inheritance;
- channel-specific binding overrides only its profile kind;
- exact precedence and provenance across all layers;
- reserved system variables cannot be overridden;
- no effective-variable leakage between channels;
- missing inherited defaults warn, while missing explicit references fail;
- preview and runtime resolution produce identical outputs.

### Store and API tests

- aggregate GET/PUT round trip;
- one successful PUT increments revision once;
- stale revision returns conflict without partial mutation;
- invalid channel/profile reference rolls back the entire transaction;
- wrong-Agent and wrong-kind references fail;
- aggregate replacement cannot remove a referenced profile;
- import preview does not persist;
- Agent mutation rejects while any channel is active;
- direct later configuration change cannot mutate an admitted snapshot.

### Run tests

- valid channels run while an invalid sibling becomes `configuration_error`;
- all-invalid selection returns 422;
- each worker receives its own effective variables;
- independently started channels snapshot their admission-time revision;
- step resources still serialize shared instruments and unrelated resources remain concurrent;
- logs retain per-channel configuration context.

### WebUI tests

- matrix displays inherited and selected profile names correctly;
- unsaved draft preview updates without persistence;
- source badges and override history match preview response;
- hard errors and warnings render differently;
- revision conflict retains the local draft;
- any active channel makes mutation controls read-only while preview remains usable;
- narrow layout moves the inspector below the selected row;
- invalid channel cards link back to the correct configuration row.

## Implementation boundaries

The work should be delivered in four coherent phases:

1. Replace the development schema and implement the pure resolver.
2. Implement aggregate Center/Agent APIs, revision checks, and transactional validation.
3. Replace the Agent station-configuration page with the matrix and inspector.
4. Integrate immutable snapshots and per-channel configuration errors into sequence admission, logging, and cards.

Each phase requires focused behavior tests before implementation and a task-scoped review before the next phase.
