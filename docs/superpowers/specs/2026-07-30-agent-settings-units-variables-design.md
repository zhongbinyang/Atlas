# Design: Agent settings — units & variables (per machine)

Date: 2026-07-30

## Goal

Add an Agent **配置** page for per-machine **units** and **variables**, stored on the center keyed by `agent_id`. Spec `unit` chooses from the unit list; value fields can embed `/VarName` (picker on `/`) and Agent expands them at run/trial time.

## Decisions (confirmed)

- Storage: **center, isolated per agent** (`agent_settings`).
- Variable use: **broad** — step/VI inputs, Spec min/max, Delay, REST URL/headers/body, and similar fillable fields.
- Syntax: **embeddable** `/VarName`; `/` opens picker; handwritten `/VarName` allowed.
- Approach: center table + Agent config tab + runtime expand on Agent (Approach A).

## Non-goals (v1)

- Center WebUI editor for these settings
- Expressions (`/A+/B`)
- Sharing variable packs across machines
- Expanding `unit` via variables (units are a plain string list only)

## Storage

New table `agent_settings`:

| Column | Type | Notes |
|--------|------|--------|
| `agent_id` | TEXT PK | FK → `agents(id)` ON DELETE CASCADE |
| `units_json` | TEXT NOT NULL | JSON array of strings, default `[]` |
| `variables_json` | TEXT NOT NULL | JSON array of `{ "name", "value" }`, default `[]` |
| `updated_at` | TEXT NOT NULL | RFC3339 |

### Validation (PUT)

- `units`: unique trimmed non-empty strings; reasonable max length (e.g. 32) and count (e.g. 200).
- `variables[].name`: `^[A-Za-z_][A-Za-z0-9_]*$`, unique per agent, max length e.g. 64.
- `variables[].value`: string (numbers/bools stored as string or JSON scalar serialized to string consistently — **store as JSON string values in the `value` field**; UI may coerce display). Prefer `value` always a **string** in API for simplicity; numeric Spec fields expand then parse.

## API

### Center

- `GET /api/agents/{id}/settings` → `{ units: string[], variables: { name: string, value: string }[] }`
- `PUT /api/agents/{id}/settings` — replace both lists; 404 if agent missing; 400 on validation errors.

### Agent

- `GET /api/settings` / `PUT /api/settings` — resolve current machine’s `agent_id` via existing register identity (hostname/ip/port as today); proxy to center. If not registered / unknown agent → **503** with clear message.
- Optional: include `units` / `variables` (or `settings_updated_at`) on `GET /api/status` only if cheap; not required for v1 if config page always fetches `/api/settings`.

## Agent UI — 配置 tab

Top-level tab sibling of VI / 通用 / API / 序列.

1. **单位** — editable list (add / rename / delete).
2. **变量** — table name + value; reject illegal/duplicate names on save.
3. Load on tab open; Save button → `PUT /api/settings`.

## Spec unit

In Spec modal, `unit` column:

- `<select>` options = configured units + current value if not in list + 「自定义…」
- Choosing 自定义 shows a text input (existing free-text behavior).
- Empty unit still omitted from saved limits JSON (unchanged).

## `/` picker

Attach to fillable value controls (VI inputs, sequence step inputs, Spec min/max, Delay ms, REST URL/headers/body, etc.):

- On input of `/` (or focusing and typing `/`), show a filtered list of variable names.
- Selecting inserts `/Name` at caret (replace the triggering `/` + any partial filter text).
- Does not block normal typing of paths; picker closes on Escape / blur without selection.

## Runtime expansion (Agent)

Before using a value for LabVIEW CLI / Delay / REST / Spec compare:

1. Fetch settings (or use short TTL cache from last GET).
2. Walk strings (and string leaves inside JSON input trees). For Spec min/max: if the stored cell is a string containing `/`, expand then parse as number; if expand fails or parse fails → step error.
3. Replace tokens matching `/Name` where `Name` is in the variable map and the next character is end-of-string or not `[A-Za-z0-9_]`.
4. Undefined `/Name` that matches the name pattern and is not in the map → **fail that step** with error mentioning the variable (do not silently leave token).
5. Persist queue/templates **with** `/Name` literals; expand only in memory for execution.
6. `unit` fields are **not** expanded.

### Ambiguity note

Windows paths use `\`, not `/Name`-shaped tokens. Strings containing `://` (URLs) use **lenient** expand: only **defined** variables are substituted, so ordinary path segments like `/add` are left intact. Outside URLs, undefined `/Name` still fails the step. If a URL path segment equals a defined variable name (e.g. `https://h/LOT/x` and variable `LOT`), it **will** expand — operators should avoid colliding path segments or rename variables.

## Logging / results

- Expanded values appear in actual CLI/REST calls and thus in step `result` / sequence JSON logs as today.
- Optional (not required): log `settings_agent_id` or variable snapshot hash — skip in v1.

## Testing

- Center: PUT/GET settings round-trip; validation 400; delete agent cascades.
- Agent static UI: config tab ids; Spec unit select present; picker helper unit-testable if extracted.
- Expansion unit tests: embed in URL, multiple vars, undefined var error, no expand inside longer identifier (`/LOTextra` not matching `LOT` if we require boundary — `/LOT` + `extra` without boundary would be `/LOTextra` as one token → undefined unless named that).

## Docs

- README: 配置 tab, `agent_settings`, `/VarName`, unit dropdown.
- Spec file: this document.

## Implementation order (sketch)

1. Migration + center store/API.
2. Agent proxy `/api/settings` + config page UI.
3. Spec unit select + `/` picker on value fields.
4. Runtime expand in sequence / delay / rest / VI run paths.
5. Tests + README.
