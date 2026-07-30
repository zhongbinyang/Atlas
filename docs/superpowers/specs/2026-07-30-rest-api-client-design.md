# Design: Agent REST API Client page + sequence step

Date: 2026-07-30

## Scope

1. Add top-level tab **API** beside VI / 通用 / 序列.
2. Builtin REST client (`kind=rest`): Method, URL, Headers, JSON Body, timeout, expect_status.
3. Trial run + register to center; steps can join the execution queue.
4. Response assertions via existing sequence Spec/limits on `status` and flattened numeric JSON body fields.
5. Auth via custom Headers only (no dedicated Bearer/Basic UI).

## Storage

- `general_templates.kind = 'rest'`
- Sentinel path `__builtin__/rest` (detection aid; queue `vi_path` for general is empty string)
- Inputs / outputs in `inputs_json` / `outputs_json` (same as Delay)
- No center schema or queue API changes

### Inputs

| name | className | Default |
|------|-----------|---------|
| method | String | POST |
| url | String | (required) |
| headers | String | `{}` |
| body | String | `` |
| timeout_ms | Digital | 10000 |
| expect_status | Digital | 200 |

### Outputs (registered schema)

Fixed: `ok`, `kind`, `status`, `elapsed_ms`, `body`  
Optional: user-declared top-level numeric response field names for Spec.

## Agent

- API page: editor, format/validate JSON, trial run (busy slot), register, center REST list.
- `POST /api/general/rest/run`, `…/register-template`, `GET …/templates`
- Sequence `run_one_step`: branch on `kind=rest` / `__builtin__/rest`
- Runtime result: `ok`, `status`, `elapsed_ms`, `headers`, `body`, optional `body_json`, flattened top-level numbers (skip reserved keys)
- Success: HTTP completed and `status == expect_status`; else `ok=false`. Network/timeout/invalid JSON body → step error.

## Center

- Reuse `POST/GET /api/general-templates` (any kind string already accepted).
