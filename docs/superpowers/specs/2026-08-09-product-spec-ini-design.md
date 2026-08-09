# Design: Product Spec INI library (`*_Spec.ini`)

Date: 2026-08-09  
Status: approved

## Goal

Import legacy product limit files such as `Tunn_FMT_Spec.ini` into ATLAS as a **center-managed Spec template library**, and let sequence steps reference a template + **full section name** (e.g. `FMT_HT`) so runtime Pass/Fail uses the same metric keys as VI outputs.

This closes the gap between:

- **Device / calibration INI** (instrument parameters, already supported on 配置页), and
- **Per-step `limits_json`** (already supported on 序列执行顺序, but manual only).

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| VI output ↔ INI key | **Same name** (e.g. output `TX_AP`, limits from `TX_AP_UL` / `TX_AP_LL`) |
| Section naming | **Full section string** as in INI: `FMT_HT`, `DMI_RT`, … (no split into suite + corner) |
| Keys without `_UL` / `_LL` | **Ignore in v1** (e.g. `Max_Ber_Curve=6` is not imported as a limit) |
| Primary architecture | **Center Spec template library** + optional step reference (recommended approach B) |
| Coexistence | Hand-edited step `limits_json` **overrides** generated limits for the same `output` |
| `inf` / `-inf` | Treated as **unbounded** (`min` or `max` omitted) in generated rules |
| Phasing | P0 parser + runtime → P1 center library → P2 step/sequence binding → P3 variable-driven section |

## Non-goals (v1)

- Storing Spec INI as device/calibration profiles
- Auto-binding Spec to every step in a sequence without explicit step fields (deferred enhancement)
- `eq` / `in` limits for standalone keys without UL/LL pairs
- Importing entire `ServerConfig` directory trees or PN folder metadata
- Persistent Test Run / report entities
- Cross-product Spec inheritance or diff tooling

## Current baseline

| Area | Today |
|------|--------|
| Device INI | `parseDeviceCfgIni()` → `agent_device_profiles` / `agent_calibration_profiles`; runtime overlay for LabVIEW vars |
| Step Spec | `limits_json` on `vi_run_queue_items`; shape `[{ "output", "min", "max", "unit?" }]` |
| Runtime judge | `crates/agent/src/limits.rs` after each VI step |
| Product Spec library | **Not implemented** (explicit non-goal in 2026-07-29 workbench spec) |

Example legacy file (`Tunn_FMT_Spec.ini`):

```ini
[FMT_HT]
TX_AP_UL = 4.0
TX_AP_LL = -2
JitterRMS_UL = inf
JitterRMS_LL = -inf
```

## Architecture

### Components

1. **Spec INI parser** (shared logic, Rust + optional TS mirror for upload preview)
2. **`spec_templates` store (scheduler)** — parsed JSON blob + metadata
3. **Scheduler + Agent APIs** — CRUD/list/get; Agent proxies for UI
4. **Queue step extension** — optional `spec_template_id`, `spec_section`, `spec_metrics`
5. **Limit resolver (agent)** — before judging, merge template-derived `LimitRule[]` with step `limits_json`
6. **UI** — center Spec templates page; sequence step editor fields

### Data flow

```
Upload *_Spec.ini
  → parse to spec_json
  → save spec_templates (center)

Edit sequence step
  → optional spec_template_id + spec_section (+ spec_metrics)
  → persisted on vi_run_queue_items

Run sequence
  → expand spec_section via variables (${…})
  → resolve template section → LimitRule[]
  → merge with hand limits (hand wins on same output)
  → execute VI → judge_limits
```

## Data model

### Table `spec_templates`

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `name` | TEXT NOT NULL | Display name; default from filename |
| `product_pn` | TEXT | Optional PN / folder label |
| `note` | TEXT DEFAULT `''` | |
| `source_filename` | TEXT | e.g. `Tunn_FMT_Spec.ini` |
| `spec_json` | JSONB NOT NULL | Parsed structure (below) |
| `created_by_agent_id` | TEXT FK → agents | Who uploaded (nullable if center-only UI later) |
| `created_at` | TEXT NOT NULL | RFC3339 string (match existing schema style) |
| `updated_at` | TEXT NOT NULL | |

Index: `(updated_at DESC, id DESC)`.

### `spec_json` shape

```json
{
  "version": 1,
  "sections": {
    "FMT_HT": {
      "TX_AP": { "min": -2, "max": 4.0 },
      "JitterRMS": { "min": null, "max": null }
    },
    "DMI_RT": {
      "DMI_Vcc_Err": { "min": -0.13, "max": 0.13 }
    }
  }
}
```

- Section keys: exact INI header text inside `[...]`.
- Metric keys: base name without `_UL` / `_LL` suffix.
- `min` / `max`: JSON numbers or `null` when bound is `inf` / `-inf` / unparseable bound treated as unbounded for that side only if token is `inf` (case-insensitive).

### Extend `vi_run_queue_items`

Additive columns (defaults keep old clients working):

| Column | Type | Default | Meaning |
|--------|------|---------|---------|
| `spec_template_id` | BIGINT NULL | NULL | FK → `spec_templates.id` ON DELETE SET NULL |
| `spec_section` | TEXT | `''` | Full section name, e.g. `FMT_HT`; may contain `${Var}` |
| `spec_metrics_json` | TEXT | `[]` | JSON string array of metric names; `[]` = all metrics in section |

Existing `limits_json` unchanged.

### Sequence template defaults (phase P2, optional columns)

On `sequence_templates` (or template metadata JSON):

| Field | Meaning |
|-------|---------|
| `default_spec_template_id` | New steps inherit |
| `default_spec_section` | New steps inherit |

YAGNI: can defer until step-level fields work.

## INI parsing rules (v1)

Input: UTF-8 text, `.ini` extension.

1. Lines: trim; skip empty and `#` / `;` / `//` comments.
2. `[Section]` → current section name (trimmed, used as-is).
3. `key = value` → parse key/value (trim).
4. If key ends with `_UL` or `_LL` (case-sensitive suffix match):
   - Base metric = key without suffix.
   - `_UL` → `max`; `_LL` → `min`.
   - Value parsing:
     - `inf`, `+inf`, `infinity` (case-insensitive) → `null` for that bound
     - `-inf`, `-infinity` → `null` for that bound
     - Otherwise parse as `f64` (support scientific notation `8E-5`)
5. Keys **not** ending with `_UL` / `_LL`: **skip** (v1).
6. If only `_UL` or only `_LL` present for a metric: store the side that exists; missing side = `null` (unbounded).
7. Duplicate keys in same section: last wins (documented).

Parser returns structured `spec_json` + parse warnings list (unknown tokens, orphan UL/LL) for UI display; hard errors only on completely invalid file (no sections).

## Runtime limit resolution

### When

During sequence run, **per step**, after expanding variables on `spec_section` and before `judge_limits`.

### Algorithm

```text
hand = parse_limits_json(step.limits_json)
if step.spec_template_id is null:
  use hand
else:
  template = load spec_templates.spec_json
  section = expand_str(step.spec_section, vars)
  metrics = parse spec_metrics_json (empty → all keys in section)
  generated = []
  for m in metrics:
    if section[m] exists:
      append LimitRule { output: m, min, max, unit: null }
  merged = generated overwritten by hand where hand.output == generated.output
  judge merged
```

### `limits.rs` changes (P0)

- `expand_limit_number`: accept `inf` / `-inf` string tokens as `None` (unbounded).
- Range check: if `min` is None, only test `value <= max`; if `max` is None, only test `value >= min`; both None → always Pass for range rule (or skip rule — **choose skip empty range**: if both None, omit rule from generated set).

Generated rules use default `op: range`.

### Error handling

| Condition | Result |
|-----------|--------|
| `spec_template_id` set but template missing | Step **Error** before run |
| `spec_section` empty after expand | Step **Error** |
| Section not in template | Step **Error** |
| Metric in `spec_metrics_json` missing from section | Warning in step meta; skip that metric |
| VI output missing for a limit | Existing behavior: **Error** |
| Value out of range | **Fail** |

Fail policy (`stop` / `continue`) unchanged.

## API (scheduler)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/spec-templates` | List summaries |
| POST | `/api/spec-templates` | Create from `{ name?, product_pn?, note?, source_filename, spec_json }` or raw `ini_text` (server parses) |
| GET | `/api/spec-templates/{id}` | Full template incl. `spec_json` |
| DELETE | `/api/spec-templates/{id}` | Delete |

Agent proxies mirror under `/api/spec-templates` (same pattern as config templates).

Queue PUT/GET includes new step fields.

## UI

### Center — Spec 模板 (P1)

- Route `#/specs` (or tab under 机台配置 if preferred later)
- Table: ID, name, product_pn, source file, section count, updated_at
- Upload `.ini` → preview parsed sections/metric count → save
- View detail: section list, metric min/max preview

### Agent — 序列步骤 (P2)

In step detail drawer:

- Spec template: dropdown (center list)
- Section: text input with `/` variable picker (e.g. `FMT_HT` or `${SpecSection}`)
- Metrics: optional multi-select (empty = all)
- Existing Spec / limits JSON editor remains; show hint that hand limits override template

Step table Spec column summary: `模板#12·FMT_HT·18项` or `手填 3项`.

## Phased delivery

| Phase | Scope | Exit criteria |
|-------|--------|----------------|
| **P0** | Rust parser + `limits.rs` inf + unit tests; TS parser mirror for preview | Parse sample `Tunn_FMT_Spec.ini`; generate correct `LimitRule[]` for `FMT_HT` |
| **P1** | Migration, store, scheduler API, center upload UI | Upload INI on center; list/get/delete |
| **P2** | Queue columns, agent resolver, step UI | Step references template+section; run judges correctly |
| **P3** | Variable section + channel overlay + sequence template defaults | Change `SpecSection` var switches HT/RT/LT without re-editing steps |

## Testing

### Unit

- Parser: UL/LL pairs, inf, scientific notation, multiple sections, ignored standalone keys
- Resolver: merge precedence, missing section, variable expansion
- `limits.rs`: one-sided bounds (only min or only max)

### Integration

- Upload template → bind step → run sequence with mocked VI outputs → Pass/Fail
- Hand limit overrides template for same `output`

## Relation to other features

| Feature | Relationship |
|---------|----------------|
| Device/calibration profiles | Unchanged; do not route Spec INI here |
| Agent config templates | Orthogonal (machine settings snapshot) |
| Center units | Optional `unit` on hand limits only in v1; template-generated limits omit unit |
| Multi-channel | P3: `SpecSection` in channel overlay |

## Open questions (deferred)

- Center-only upload vs Agent upload (recommend Agent + center UI both POST via scheduler)
- Whether to show parse warnings as blocking or non-blocking on upload
- Sequence-template-level default spec (P2 vs P3)

## References

- Legacy example: `Tunn_FMT_Spec.ini` (`[FMT_HT]`, `[DMI_RT]`, …)
- Existing step limits: `docs/superpowers/specs/2026-07-29-formal-sequence-workbench-design.md`
- Device INI import (different purpose): `docs/superpowers/specs/2026-08-03-device-cfg-variables-import-design.md`
