# Command Step and Split Template Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a station 命令行 page that try-runs and registers `kind=cmd` steps, execute them in sequences via CreateProcess + expect_exit_code, and store VI / 通用 / REST / CMD in four center tables (migrate existing REST out of `general_templates`).

**Architecture:** Center migration creates `rest_templates` and `cmd_templates` (same columns as `general_templates`), copies `kind='rest'` rows with the same ids, remaps queue/sequence FKs, then deletes rest rows from general. Station `src/cmd.rs` parses inputs and runs `tokio::process::Command` (no shell). Sequence `run_one_step` gains a cmd branch. REST execution code stays; only storage and catalog routing change.

**Tech Stack:** PostgreSQL migrations, Axum, sqlx, React/Ant Design, Vitest, tokio::process.

**Spec:** `docs/superpowers/specs/2026-08-16-station-cmd-and-split-template-tables-design.md`

## Global Constraints

- JSON/API field names stay `agent_id`, `origin_agent_id`, `created_by_agent_id` (SQL may be `station_*` with `AS`).
- Do not change `judge_limits` or sequence Pass/Fail besides existing `ok: false` → fail.
- Direct CreateProcess: `program` + `args[]`. No `cmd.exe /c` wrapping of a whole line. No pipes, stdin, env map.
- `expect_exit_code` default `0`; `timeout_ms` default `60000`; stdout/stderr truncate 1MB each; UTF-8 lossy.
- `template_source`: `labview` | `general` | `rest` | `cmd` | `section`.
- `POST /api/general-templates` with `kind=rest` or `kind=cmd` → 400.
- Do not split delay/version tables. No auth. Local Postgres only. Do not rewrite historical `docs/superpowers/*` specs (living `docs/api.md` yes).
- Center git: `C:\Users\zhong\git\Atlas\atlas-center`. Station git: `C:\Users\zhong\git\Atlas\atlas-station`. Work on `master` in place.
- Nav copy: 命令行. Drawer button: 已注册命令. Route: `#/cmd`.

---

## File map

| File | Responsibility |
|------|----------------|
| `atlas-center/migrations/035_split_rest_and_cmd_templates.sql` | Tables, copy rest rows, FKs, CHECK |
| `atlas-center/src/store.rs` | CRUD rest/cmd; queue/step columns |
| `atlas-center/src/api.rs` | `/api/rest-templates`, `/api/cmd-templates`; reject rest/cmd on general POST |
| `atlas-center/docs/api.md` | Document new routes |
| `atlas-center/frontend/src/pages/FunctionsPage.tsx` | Four lists |
| `atlas-station/src/cmd.rs` | Parse + run + truncate |
| `atlas-station/src/api.rs` | `/api/cmd/run|register|templates` |
| `atlas-station/src/register.rs` | POST/GET rest-templates and cmd-templates |
| `atlas-station/src/labview_sequence.rs` | `run_one_step` cmd; parse rest/cmd template ids |
| `atlas-station/frontend/src/pages/CmdPage.tsx` | Workbench + drawer |
| `atlas-station/frontend/src/components/AppShell.tsx` | Nav item |
| `atlas-station/frontend/src/pages/sequence/SequenceEditTab.tsx` | Catalog tabs |

---

### Task 1: Center migration

**Files:**
- Create: `atlas-center/migrations/035_split_rest_and_cmd_templates.sql`

**Interfaces:**
- Produces tables `rest_templates`, `cmd_templates` with the same columns as `general_templates` (`id, name, origin_station_id, kind, inputs_json, outputs_json, created_at`).
- Produces columns `rest_template_id`, `cmd_template_id` on `vi_run_queue_items` and `sequence_template_steps`.

- [ ] **Step 1: Write the migration**

Match live `general_templates` column names (`origin_station_id`, not `origin_agent_id`). After `INSERT … SELECT` of rest rows, `setval` the new serial to `MAX(id)`.

CHECK (same on both queue and sequence_template_steps), after dropping `*_one_template_ck`:

```sql
CHECK (
  (template_source = 'section'
    AND vi_template_id IS NULL AND general_template_id IS NULL
    AND rest_template_id IS NULL AND cmd_template_id IS NULL)
  OR (template_source = 'general'
    AND general_template_id IS NOT NULL
    AND vi_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
  OR (template_source = 'labview'
    AND vi_template_id IS NOT NULL
    AND general_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
  OR (template_source = 'rest'
    AND rest_template_id IS NOT NULL
    AND vi_template_id IS NULL AND general_template_id IS NULL AND cmd_template_id IS NULL)
  OR (template_source = 'cmd'
    AND cmd_template_id IS NOT NULL
    AND vi_template_id IS NULL AND general_template_id IS NULL AND rest_template_id IS NULL)
)
```

Remap before delete:

```sql
UPDATE vi_run_queue_items q
SET template_source = 'rest', rest_template_id = q.general_template_id, general_template_id = NULL
WHERE q.general_template_id IN (SELECT id FROM rest_templates);

-- same for sequence_template_steps
DELETE FROM general_templates WHERE kind = 'rest';

ALTER TABLE general_templates DROP CONSTRAINT IF EXISTS general_templates_kind_check;
ALTER TABLE general_templates
  ADD CONSTRAINT general_templates_kind_check CHECK (kind IN ('delay', 'version'));
```

FKs: `ON DELETE CASCADE` to the new tables. `cmd_templates` starts empty.

- [ ] **Step 2: File exists and SQL is internally ordered (create → copy → columns → remap → delete → check)**

- [ ] **Step 3: Commit**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-center
git add migrations/035_split_rest_and_cmd_templates.sql
git commit -m "feat(center): split rest/cmd template tables from general"
```

---

### Task 2: Center store + HTTP for rest/cmd

**Files:**
- Modify: `atlas-center/src/store.rs`
- Modify: `atlas-center/src/api.rs`
- Modify: `atlas-center/docs/api.md`

**Interfaces:**
- Clone `GeneralTemplate` / `insert_general_template` / `list_*_enriched` / `get_` / `delete_` / `find_duplicate` for rest and cmd (types may be aliases of the same row shape).
- Routes next to general-templates:

```
GET/POST /api/rest-templates
GET/DELETE /api/rest-templates/{id}
GET/POST /api/cmd-templates
GET/DELETE /api/cmd-templates/{id}
```

- `create_general_template`: if `req.kind` is `rest` or `cmd`, 400 `{ "error": "use /api/rest-templates or /api/cmd-templates" }`.
- List query `?kind=` on general no longer returns rest.

- [ ] **Step 1: Failing tests** following `list_vi_templates_filter_by_agent_query` DB helper:

1. `POST /api/cmd-templates` with name + object inputs/outputs + existing agent → 200 and `kind=cmd`.
2. `POST /api/general-templates` `kind=rest` → 400.
3. `GET /api/general-templates` items have no `kind=rest`.

- [ ] **Step 2: Run — expect fail**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-center
cargo test cmd_templates -- --nocapture
```

- [ ] **Step 3: Implement store + handlers** (copy general handlers; default kind `rest` / `cmd`). JSON views expose `origin_agent_id` via existing `AS` pattern.

- [ ] **Step 4: Tests + api.md**

```powershell
cargo test cmd_templates rest_templates -- --nocapture
```

Document GET/POST/DELETE in `docs/api.md` §1.1. Change the general-templates remark from Delay/Version/REST to Delay/Version only.

- [ ] **Step 5: Commit**

```powershell
git add src/store.rs src/api.rs docs/api.md
git commit -m "feat(center): add rest-templates and cmd-templates APIs"
```

---

### Task 3: Center queue/sequence FKs + 已注册功能 UI

**Files:**
- Modify: `atlas-center/src/store.rs`
- Modify: `atlas-center/src/api.rs`
- Modify: `atlas-center/frontend/src/pages/FunctionsPage.tsx`
- Modify: `atlas-center/frontend/src/api/schedulerApi.ts`
- Modify: `atlas-center/frontend/src/api/types.ts`

**Interfaces:**
- Queue/sequence step JSON gains optional `rest_template_id`, `cmd_template_id`. `template_source` may be `rest` or `cmd`.
- Enrichment JOIN: `LEFT JOIN rest_templates` / `cmd_templates` like general.
- Functions page: fetch vi + general + rest + cmd; groups: VI / 通用 / REST / 命令行; delete uses matching DELETE route.

- [ ] **Step 1: Failing store/API test** — write a rest-sourced queue item and a cmd sequence step, read back ids and `template_source`.

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement SQL + FunctionsPage**

`kindLabel`: `rest` → REST, `cmd` → 命令行, `version` → 版本. Do not show rest rows under 通用.

- [ ] **Step 4: Tests + rebuild center static**

```powershell
cargo test --lib -- --nocapture
cd frontend
npx vitest run src/App.test.tsx
cd ..
.\scripts\build-frontend.ps1
```

- [ ] **Step 5: Commit**

```powershell
git add src/store.rs src/api.rs frontend static
git commit -m "feat(center): wire rest/cmd template ids in queues and functions UI"
```

---

### Task 4: Station `cmd.rs` (pure + run)

**Files:**
- Create: `atlas-station/src/cmd.rs`
- Modify: `atlas-station/src/lib.rs` (`mod cmd;`)

**Interfaces:**

```rust
pub const KIND_CMD: &str = "cmd";
pub const CMD_VI_PATH: &str = "__builtin__/cmd";
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_EXPECT_EXIT_CODE: i32 = 0;
pub const MAX_CAPTURE_BYTES: usize = 1_048_576;

pub struct CmdRequest {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: u64,
    pub expect_exit_code: i32,
}

pub fn is_cmd_template(kind: Option<&str>, vi_path: &str) -> bool;
pub fn parse_cmd_request(inputs: &Value) -> Result<CmdRequest, String>;
pub fn truncate_capture(s: &str) -> String;
pub fn cmd_inputs(program: &str, args: &[String], cwd: &str, timeout_ms: u64, expect_exit_code: i32) -> Value;
pub fn cmd_outputs_schema() -> Value;
pub async fn run_command(req: &CmdRequest) -> Value;
pub async fn run_command_from_inputs(inputs: &Value) -> Result<Value, String>;
```

`run_command`: `Command::new(&req.program).args(&req.args)`; nonempty cwd → `current_dir`; `kill_on_drop(true)`; `tokio::time::timeout`. Timeout → `ok:false`, `timed_out:true`, `exit_code: null`. Spawn fail → `Err(String)`. Nonzero/mismatch → `Ok` with `ok:false` so the sequence still records stdout/stderr.

- [ ] **Step 1: Failing unit tests** (parse requires program; defaults 60000/0; args array; truncate length; is_cmd kind/path).

- [ ] **Step 2:** `cargo test cmd:: -- --nocapture` — fail until file exists.

- [ ] **Step 3: Implement.** Reject empty program and NUL in program/args. Empty cwd → None.

- [ ] **Step 4:** `cargo test cmd:: -- --nocapture`

- [ ] **Step 5: Commit**

```powershell
git add src/cmd.rs src/lib.rs
git commit -m "feat(station): parse and run cmd templates"
```

---

### Task 5: Station HTTP + sequence dispatch + register URLs

**Files:**
- Modify: `atlas-station/src/api.rs`
- Modify: `atlas-station/src/register.rs`
- Modify: `atlas-station/src/labview_sequence.rs`

**Interfaces:**
- `POST /api/cmd/run`, `POST /api/cmd/register`, `GET /api/cmd/templates`. Run uses `TaskSlot` name `"cmd"`; busy → same 409 as REST.
- Register does **not** require a prior body_json (unlike REST). Center `POST /api/cmd-templates`.
- REST register/list in `register.rs` move from `/api/general-templates` to `/api/rest-templates`. Station UI paths `/api/general/rest/*` stay.
- `run_one_step`: cmd branch after rest; Lenient `${vars}` expand.
- Queue parse: `rest_template_id` / `cmd_template_id`; kind from `template_source`.

- [ ] **Step 1: Failing `labview_sequence` test** — cmd queue item keeps `kind=cmd`.

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4:** `cargo test cmd:: labview_sequence:: -- --nocapture`

- [ ] **Step 5: Commit**

```powershell
git add src/api.rs src/register.rs src/labview_sequence.rs
git commit -m "feat(station): expose cmd APIs and run cmd sequence steps"
```

---

### Task 6: Station 命令行 page

**Files:**
- Create: `atlas-station/frontend/src/pages/CmdPage.tsx`
- Modify: `atlas-station/frontend/src/App.tsx`
- Modify: `atlas-station/frontend/src/components/AppShell.tsx`
- Modify: `atlas-station/frontend/src/api/agentApi.ts`
- Modify: `atlas-station/frontend/src/pages/stationHelp.ts`
- Modify: `atlas-station/frontend/src/lib/registeredCatalogCopy.ts` (`cmd: { button: '已注册命令' }`)
- Modify: `atlas-station/frontend/src/lib/registeredCatalogCopy.test.ts`
- Modify: `atlas-station/frontend/src/lib/registeredCatalogPages.test.ts`

**Interfaces:**
- Mirror RestPage: 可执行文件, 参数 TextArea (split lines), cwd, timeout_ms 60000, expect_exit_code 0, 注册名称.
- Header: 已注册命令 left of 刷新. Drawer 720. Load fills and closes.

- [ ] **Step 1:** Copy test `cmd.button === '已注册命令'` — fail.

- [ ] **Step 2:** vitest fail

- [ ] **Step 3:** Page + nav between REST and 序列 (`/cmd`).

- [ ] **Step 4:**

```powershell
cd frontend
npx vitest run src/lib/registeredCatalogCopy.test.ts src/lib/registeredCatalogPages.test.ts src/pages/stationHelp.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add frontend/src
git commit -m "feat(station-ui): add 命令行 page with registered drawer"
```

---

### Task 7: Sequence catalog tabs + queue ids

**Files:**
- Modify: `atlas-station/frontend/src/pages/sequence/SequenceEditTab.tsx`
- Modify: `atlas-station/frontend/src/pages/sequence/` helpers as needed
- Modify: `atlas-station/frontend/src/api/agentApi.ts`

**Interfaces:**
- `loadAll` fetches vi + general + rest + cmd; `source: 'labview'|'general'|'rest'|'cmd'`.
- Tabs: 全部 / VI / 通用 / REST / 命令行.
- Add-to-queue sets `template_source` and matching `*_template_id`.

```ts
export function catalogSourceLabel(source: string): string {
  if (source === 'labview') return 'VI';
  if (source === 'rest') return 'REST';
  if (source === 'cmd') return '命令行';
  return '通用';
}
```

- [ ] **Step 1–4:** TDD `catalogSourceLabel`; wire SequenceEditTab.

- [ ] **Step 5: Rebuild static + commit**

```powershell
cd C:\Users\zhong\git\Atlas\atlas-station
.\scripts\build-frontend.ps1
git add frontend static
git commit -m "feat(station-ui): catalog rest and cmd sequence functions"
```

---

## Manual check

1. Migrate local DB; existing REST templates appear under REST, not 通用; old sequences still run.
2. `#/cmd`: try-run `cmd.exe` args `/c` + `echo atlas-cmd`; register; 加入功能 → 命令行 → 开测 Pass with no limits.
3. Wrong `expect_exit_code` → Fail via `ok: false`.
4. Busy sequence: cmd 试跑 rejected.
5. Center 已注册功能 four groups; delete REST/CMD works.
6. `POST` general-templates `kind=rest` → 400.

## Spec coverage

| Spec | Task |
|------|------|
| cmd page + APIs | 4–6 |
| CreateProcess + expect_exit_code + truncate | 4 |
| Four tables + REST migrate | 1–2 |
| Queue/sequence FKs + catalog | 3, 5, 7 |
| Pass/Fail unchanged | 5 (`ok:false` only) |
| api.md | 2 |
| Functions UI | 3 |
