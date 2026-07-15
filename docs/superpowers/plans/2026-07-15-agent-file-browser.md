# Agent File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators browse an Agent’s configured files root from the scheduler WebUI (breadcrumbs), preview/download `.txt` and `.gif` only, all proxied live through the center with no center-side archive.

**Architecture:** Agent exposes read-only `GET /api/files` and `GET /api/files/content` under `AGENT_FILES_ROOT` with path jail. Scheduler proxies those endpoints per agent id using the existing timed reqwest client. Chinese WebUI adds a file browser modal mirroring the screenshot UX patterns.

**Tech Stack:** Existing Axum/Tokio/serde workspace; std `fs` + path canonicalize; no new DB tables.

**Spec:** `docs/superpowers/specs/2026-07-15-agent-file-browser-design.md`

## Global Constraints

- Root via `AGENT_FILES_ROOT`; missing/invalid → Agent **503** + `ErrorBody`
- Relative `path` only; reject `..`, absolute/drive paths → **400**; must stay under canonical root
- Content allowed extensions only: `txt`, `gif` (case-insensitive) → else **403**
- Max file size **20 MiB** (`20 * 1024 * 1024`) → **413**
- List: dirs first, then name case-insensitive; show all entries; non-txt/gif have no preview/download in UI
- Content: raw bytes; txt `text/plain; charset=utf-8`; gif `image/gif`; `download=1` → `Content-Disposition: attachment`
- Center: proxy + pass-through status/body/headers; connection failure → **503**; no disk archive
- Browser never talks to Agent `:26631` for files
- Chinese WebUI; no Agent local file UI in v1

---

## File Structure

```text
crates/common/src/types.rs          # optional FileEntry DTOs (or keep in agent only — prefer common)
crates/agent/src/config.rs          # files_root: Option<PathBuf>
crates/agent/src/files.rs           # NEW — resolve, list, read
crates/agent/src/api.rs             # routes + AppState.files_root
crates/agent/src/main.rs            # wire config
crates/scheduler/src/api.rs         # proxy routes
crates/scheduler/static/index.html  # 文件 modal
crates/scheduler/static/app.js
crates/scheduler/static/style.css
README.md
```

| Path | Responsibility |
|------|----------------|
| `files.rs` | `resolve_path`, `list_dir`, `read_file` |
| agent API | HTTP mapping of files errors |
| scheduler API | forward GET with query string |
| WebUI | breadcrumbs + preview/download |

---

### Task 1: Agent path jail + list/read library

**Files:**
- Create: `crates/agent/src/files.rs`
- Modify: `crates/agent/src/config.rs`
- Modify: `crates/agent/src/main.rs` (`mod files`)
- Test: `crates/agent/src/files.rs`

**Interfaces:**
- Consumes: `files_root: PathBuf`
- Produces:
  - `pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;`
  - `pub enum FilesError { NotConfigured, RootMissing, BadPath, NotFound, NotDir, ForbiddenExt, TooLarge, Io(String) }`
  - `pub struct FileEntry { name: String, kind: EntryKind, size: Option<u64>, ext: Option<String> }`
  - `pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, FilesError>`
  - `pub fn list_dir(root: &Path, rel: &str) -> Result<(String /*normalized path*/, Vec<FileEntry>), FilesError>`
  - `pub fn read_file(root: &Path, rel: &str) -> Result<(String /*filename*/, String /*content_type*/, Vec<u8>), FilesError>`

- [ ] **Step 1: Extend config**

```rust
pub files_root: Option<std::path::PathBuf>,
// in load_from_env:
files_root: std::env::var("AGENT_FILES_ROOT").ok().map(std::path::PathBuf::from),
```

- [ ] **Step 2: Write failing path jail tests**

Use `tempfile::TempDir` (add `tempfile` to agent `[dev-dependencies]` if missing):

```rust
#[test]
fn rejects_parent_segments() {
    let dir = tempfile::tempdir().unwrap();
    let err = resolve(dir.path(), "../x").unwrap_err();
    assert!(matches!(err, FilesError::BadPath));
}

#[test]
fn lists_nested_eye_diagram_style() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("EyeDiagram/35")).unwrap();
    std::fs::write(dir.path().join("Log.txt"), b"hello").unwrap();
    std::fs::write(dir.path().join("EyeDiagram/35/CH1.gif"), b"GIF89a").unwrap();
    let (_p, entries) = list_dir(dir.path(), "").unwrap();
    assert!(entries.iter().any(|e| e.name == "Log.txt"));
    let (_p, sub) = list_dir(dir.path(), "EyeDiagram/35").unwrap();
    assert!(sub.iter().any(|e| e.name == "CH1.gif" && e.ext.as_deref() == Some("gif")));
}

#[test]
fn content_rejects_pdf() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.pdf"), b"%PDF").unwrap();
    let err = read_file(dir.path(), "a.pdf").unwrap_err();
    assert!(matches!(err, FilesError::ForbiddenExt));
}

#[test]
fn content_too_large() {
    let dir = tempfile::tempdir().unwrap();
    // write file with len MAX_FILE_BYTES+1 — use File::set_len or sparse write
    let p = dir.path().join("big.txt");
    let f = std::fs::File::create(&p).unwrap();
    f.set_len(MAX_FILE_BYTES + 1).unwrap();
    let err = read_file(dir.path(), "big.txt").unwrap_err();
    assert!(matches!(err, FilesError::TooLarge));
}
```

Stub functions returning `Err(FilesError::NotConfigured)` so tests fail for real.

- [ ] **Step 3: Run tests (expect FAIL)**

Run: `cargo test -p agent files::`

- [ ] **Step 4: Implement `files.rs`**

Follow spec normalization order. On Windows, detect absolute via `Path::new(rel).is_absolute()` after `\`→`/` normalization, and reject strings containing `:` in the relative path before join.

`read_file`: check ext; `metadata().len()`; if `> MAX_FILE_BYTES` → TooLarge; else read.

- [ ] **Step 5: Run tests (expect PASS)**

- [ ] **Step 6: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): add files root path jail and list/read helpers"
```

---

### Task 2: Agent HTTP `GET /api/files` + `/api/files/content`

**Files:**
- Modify: `crates/agent/src/api.rs`
- Modify: `crates/agent/src/main.rs`
- Test: api oneshot tests with temp root in `AppState`

**Interfaces:**
- Consumes: Task 1 functions; `AppState.files_root: Option<PathBuf>`
- Produces: routes mapping `FilesError` → status codes per Global Constraints

- [ ] **Step 1: Map errors**

```text
NotConfigured | RootMissing -> 503
BadPath | NotDir -> 400
NotFound -> 404
ForbiddenExt -> 403
TooLarge -> 413
Io -> 500
```

- [ ] **Step 2: Failing HTTP test — list + gif content + escape**

Build router with `files_root = Some(tempdir)`; seed files; `GET /api/files` and `GET /api/files/content?path=Log.txt`; `GET ...?path=../x` expect 400.

- [ ] **Step 3: Implement handlers**

Query structs:

```rust
#[derive(Deserialize)]
struct FilesQuery { path: Option<String>, download: Option<String> }
```

`download` true if `Some("1")`.

Content response use `[(CONTENT_TYPE, ...), (CONTENT_DISPOSITION, ...)]` optionally.

If `files_root` is `None` → 503 immediately without calling list.

- [ ] **Step 4: Wire `main.rs`**

Pass `cfg.files_root` into `AppState`. Update existing test `AppState` constructors.

- [ ] **Step 5: `cargo test -p agent`**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/agent
git commit -m "feat(agent): expose files list and content HTTP APIs"
```

---

### Task 3: Scheduler proxy APIs

**Files:**
- Modify: `crates/scheduler/src/api.rs`
- Test: mock agent file endpoints in `api.rs` tests

**Interfaces:**
- Consumes: `AppState { store, client, screenshot_dir }` (reuse client)
- Produces:
  - `GET /api/agents/{id}/files`
  - `GET /api/agents/{id}/files/content`

- [ ] **Step 1: Write failing proxy tests**

Mock agent returns list JSON / bytes; scheduler forwards; assert body. Unreachable port → 503. Unknown agent id → 404.

- [ ] **Step 2: Implement proxy helpers**

```rust
async fn proxy_agent_get(
    client: &reqwest::Client,
    agent: &Agent,
    path_and_query: &str, // e.g. "/api/files?path=EyeDiagram%2F35"
) -> Result<reqwest::Response, ()> // map connect err separately
```

Build URL `http://{ip}:{port}{path_and_query}`. On success, rebuild axum response with status, filter headers (`content-type`, `content-disposition`), and body bytes.

- [ ] **Step 3: Register routes on router**

Preserve query string from incoming request (`path`, `download`).

- [ ] **Step 4: `cargo test -p scheduler`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/scheduler
git commit -m "feat(scheduler): proxy agent file browse APIs"
```

---

### Task 4: Scheduler WebUI file browser

**Files:**
- Modify: `crates/scheduler/static/index.html`
- Modify: `crates/scheduler/static/app.js`
- Modify: `crates/scheduler/static/style.css`

**Interfaces:**
- Consumes: Task 3 APIs
- Produces: Chinese「文件」UX

- [ ] **Step 1: HTML**

Add Agent button `文件`. Modal `#files-modal` with:

- breadcrumb container `#files-crumb`
- table `#files-body`
- preview sub-modal: `#file-preview-modal` with `#file-preview-pre` and `#file-preview-img`

- [ ] **Step 2: JS**

```javascript
let filesAgentId = null;
let filesPath = '';

async function openFiles(agentId) {
  filesAgentId = agentId;
  filesPath = '';
  await loadFiles();
  // show modal
}

async function loadFiles() {
  const q = filesPath ? ('?path=' + encodeURIComponent(filesPath)) : '';
  const resp = await fetch('/api/agents/' + encodeURIComponent(filesAgentId) + '/files' + q);
  // render breadcrumb from filesPath.split('/')
  // dirs: click -> filesPath = join; loadFiles()
  // txt/gif: 预览 / 下载 buttons
}

function previewFile(relPath, ext) {
  const url = '/api/agents/' + encodeURIComponent(filesAgentId) +
    '/files/content?path=' + encodeURIComponent(relPath);
  if (ext === 'gif') { img.src = url; show img; hide pre; }
  else { fetch(url).then(r => r.text()).then(t => { pre.textContent = t; }); }
}

function downloadFile(relPath) {
  window.open(contentUrl + '&download=1', '_blank');
}
```

Use `escapeHtml` for names. Join path carefully (no leading slash).

- [ ] **Step 3: CSS** for files modal (reuse shot-modal styles where possible)

- [ ] **Step 4: Commit**

```bash
git add crates/scheduler/static
git commit -m "feat(scheduler): WebUI file browser for txt and gif"
```

---

### Task 5: README + workspace tests

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document**

Chinese section **文件浏览**:

- `AGENT_FILES_ROOT`
- 仅 `.txt` / `.gif` 预览下载
- 中心代理、不落盘
- 路径限制与 20 MiB
- 手工：指向样例结果目录测 `Log.txt` 与 `EyeDiagram/35/CH1.gif`

Add `AGENT_FILES_ROOT` to Agent env table.

- [ ] **Step 2: `cargo test --workspace`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document agent file browser feature"
```

---

## Spec Coverage Self-Review

| Spec item | Task |
|-----------|------|
| Path jail + list/read | 1 |
| Agent HTTP + 503 when no root | 2 |
| Scheduler proxy + passthrough | 3 |
| WebUI breadcrumbs/preview/download | 4 |
| README | 5 |
| 20 MiB / txt/gif only / no archive | Global |

**Ambiguity resolved:** txt content = raw bytes + `charset=utf-8` (no lossy re-encode).  
**Placeholder scan:** none.
