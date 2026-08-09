# Task 7 Report: Center UI — Spec 模板 page

**Status:** Complete  
**Base commit:** d7e7c3e (Task 6)  
**Date:** 2026-08-09

## Summary

Added scheduler center UI for managing product Spec INI templates: upload `.ini` with client-side parse preview, list/delete templates, and detail view with section/metric bounds.

## Files Created

| File | Purpose |
|------|---------|
| `frontend/scheduler/src/pages/SpecsPage.tsx` | Main page: Upload, Table, confirm Modal, detail Modal |
| `frontend/scheduler/src/utils/specIni.ts` | Copied parser from agent utils for upload preview |

## Files Modified

| File | Change |
|------|--------|
| `frontend/scheduler/src/App.tsx` | Route `#/specs` → `SpecsPage` |
| `frontend/scheduler/src/components/AppShell.tsx` | Nav link「Spec 模板」 |
| `frontend/scheduler/src/api/schedulerApi.ts` | `listSpecTemplates`, `createSpecTemplate`, `getSpecTemplate`, `deleteSpecTemplate` |
| `frontend/scheduler/src/api/types.ts` | `SpecTemplateSummary`, `SpecTemplateDetail`, `CreateSpecTemplateRequest` |
| `crates/scheduler/static/*` | Synced via `scripts/build-frontend.ps1` |

## Upload Flow

1. User selects `.ini` via Ant Design `Upload` (`beforeUpload` returns `false`).
2. `FileReader` reads text → `parseSpecIni()` → preview section/metric counts + warnings.
3. Confirm modal collects name / product_pn / note.
4. `POST /api/spec-templates` with `{ ini_text, name, product_pn, note, source_filename }`.
5. Table refreshes on success.

## Detail View

- Fetches `GET /api/spec-templates/{id}`.
- Shows metadata + section summary table + paginated metric bounds (LL/UL, `∞` for unbounded).

## Build / Test

```powershell
cd frontend/scheduler && npm run build   # PASS (tsc + vite)
powershell -File scripts/build-frontend.ps1   # PASS, synced crates/scheduler/static
```

No new Vitest tests in scheduler (parser covered in `frontend/agent/src/utils/specIni.test.ts`).

## API Alignment

Matches scheduler backend views from Task 5:

- List: `{ items: SpecTemplateListItemView[] }`
- Create: returns `SpecTemplateListItemView` (201)
- Get: `SpecTemplateDetailView` with `spec.sections`
- Delete: 204

## Concerns / Follow-ups

- Parser duplicated in `frontend/scheduler/src/utils/specIni.ts` vs agent copy — intentional per plan to avoid cross-package imports; keep in sync when parser rules change.
- Large Spec files may produce long detail metric tables; pagination at 20 rows mitigates UI load.
- Task 8+ (queue spec fields, Agent sequence UI) not in scope for this task.
