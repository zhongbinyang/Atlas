# Task 4 Report: Scheduler WebUI file browser

## Status

DONE

## What Was Implemented

### `crates/scheduler/static/index.html`

- Agent row action button: **文件**
- `#files-modal` with breadcrumb (`#files-crumb`), file table (`#files-body`)
- `#file-preview-modal` with `#file-preview-pre` (txt) and `#file-preview-img` (gif)

### `crates/scheduler/static/app.js`

- `openFiles`, `loadFiles`, `previewFile`, `downloadFile` wired to Task 3 proxy APIs
- Breadcrumb navigation from `path` segments; dirs open via `打开`
- txt preview via `fetch` + `pre.textContent`; gif preview via `img.src`
- Download via `window.open(...&download=1)`
- `escapeHtml` for table cell names; `textContent` for breadcrumb labels
- Modal open/close handlers reuse shot-modal backdrop pattern

### `crates/scheduler/static/style.css`

- `.files-crumb` breadcrumb styles; `#file-preview-pre` max-height
- Reuses existing `.modal`, `.modal-panel`, `.modal-panel-wide` classes

## Commits

| Hash | Message |
|------|---------|
| `f254cff` | feat(scheduler): WebUI file browser for txt and gif |

## Concerns / Notes

1. **No automated UI tests** — manual verification against live agent with `files_root` configured.
2. **Non-txt/gif files** — no action buttons (fixed); only txt/gif preview+download.
3. **Errors use `alert`** — consistent with screenshot flows; could be friendlier for 503.

## Ready for Task 5

End-to-end manual test: scheduler WebUI → agent `EyeDiagram` / `Log.txt` / gif preview and download.

## Critical Fix (Task 4)

**Issue:** Non-txt/gif files incorrectly showed a 下载 button.

**Fix:** In `renderFiles`, only dirs get 打开; only txt/gif get 预览+下载; all other files get empty `actions`.

| Hash | Message |
|------|---------|
| `6e895dc` | fix(scheduler): hide file actions for non-txt/gif entries |
