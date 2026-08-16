# Station Tauri Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a normal Windows account install atlas-station via a Tauri NSIS per-user package, and let operators pull a new package from atlas-center only when they click 检查更新.

**Architecture:** Center serves `latest.json` and the setup exe from a disk folder (not git). Station keeps Axum on `:9090`. Tauri is a desktop window around that server. Update decide/download/apply run as Tauri commands (no CORS, no idle timer). Apply happens only after the operator confirms restart.

**Tech Stack:** Axum, Tauri 2, NSIS (`installMode: currentUser`), React/Ant Design, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-station-tauri-packaging-design.md`

## Global Constraints

- NSIS **Current User** only. No admin, no `Program Files`, no MSI/MSIX/SCCM.
- Do not handle Windows inbound firewall.
- 检查更新 is the only trigger. No startup check, no interval, no idle auto-upgrade.
- While a test is running (`GET /api/status` `busy == true`): no download, no restart.
- After a good download: prompt restart; Cancel keeps the current process; OK runs silent NSIS `/S` then relaunches.
- Version compare is **string equality** of `YYYY-MM-DD.<sha>` (`version === date + "." + git`).
- Axum still binds `AGENT_BIND`:`AGENT_PORT` (default `0.0.0.0:9090`). Do not replace HTTP with IPC.
- `cargo run` + browser on 9090 must keep working. 检查更新 is Tauri-only.
- No auth, no TLS, no `/v1`. Do not change sequence Pass/Fail or restore SN/work-order UI.
- Release binaries are **not** committed. Do not rewrite historical `docs/superpowers/*` specs.
- Center git: `C:\Users\zhong\git\Atlas\atlas-center`. Station git: `C:\Users\zhong\git\Atlas\atlas-station`.

---

## File map

| File | Responsibility |
|------|----------------|
| `atlas-center/src/station_releases.rs` | Release dir, `latest.json` parse, safe filename |
| `atlas-center/src/api.rs` | `GET /api/station-releases/latest`, `GET /releases/station/{filename}` |
| `atlas-center/src/main.rs` | `mod station_releases;` |
| `atlas-center/src/config.rs` | `ATLAS_STATION_RELEASE_DIR` (optional; default `<cwd>/releases/station`) |
| `atlas-center/docs/api.md` | Document the two routes |
| `atlas-center/.gitignore` | Ignore `releases/station/*.exe` |
| `atlas-station/src/station_update.rs` | Decide + sha256 verify (pure) |
| `atlas-station/frontend/src/lib/isDesktop.ts` | Detect Tauri window |
| `atlas-station/frontend/src/lib/stationUpdateCopy.ts` | Chinese prompt strings |
| `atlas-station/frontend/src/components/AppShell.tsx` | 检查更新 button when desktop |
| `atlas-station/src/lib.rs` | Export existing modules + `serve` |
| `atlas-station/src/main.rs` | Thin `serve` caller |
| `atlas-station/src-tauri/*` | Tauri 2 desktop crate, NSIS currentUser, update commands |

---

### Task 1: Center release hosting

**Files:**
- Create: `atlas-center/src/station_releases.rs`
- Modify: `atlas-center/src/main.rs` (`mod station_releases;`)
- Modify: `atlas-center/src/api.rs` (two GET routes)
- Modify: `atlas-center/src/config.rs` (optional `station_release_dir()` helper — or keep path logic only in `station_releases.rs`)
- Modify: `atlas-center/docs/api.md`
- Modify: `atlas-center/.gitignore` (add `/releases/station/*.exe`)

**Interfaces:**
- Consumes: filesystem under `ATLAS_STATION_RELEASE_DIR` or `<current_dir>/releases/station`
- Produces:
  - `pub fn release_dir() -> PathBuf`
  - `pub fn is_safe_release_filename(name: &str) -> bool`
  - `pub fn parse_latest_json(bytes: &[u8]) -> Result<LatestManifest, String>`
  - `pub struct LatestManifest { version, date, git, filename, sha256: String }`
  - `GET /api/station-releases/latest`
  - `GET /releases/station/{filename}`

- [ ] **Step 1: Write failing unit tests**

Create `atlas-center/src/station_releases.rs` with tests only (no impl yet). Add `mod station_releases;` to `main.rs` so the binary crate compiles the file.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_filename() {
        assert!(!is_safe_release_filename("../x.exe"));
        assert!(!is_safe_release_filename("a/b.exe"));
        assert!(!is_safe_release_filename("a\\b.exe"));
        assert!(!is_safe_release_filename(""));
        assert!(is_safe_release_filename("atlas-station-2026-08-16.d4279a7-setup.exe"));
    }

    #[test]
    fn parse_latest_requires_identity() {
        let raw = br#"{
          "version": "2026-08-16.d4279a7",
          "date": "2026-08-16",
          "git": "d4279a7",
          "filename": "atlas-station-2026-08-16.d4279a7-setup.exe",
          "sha256": "abcd"
        }"#;
        let m = parse_latest_json(raw).unwrap();
        assert_eq!(m.version, "2026-08-16.d4279a7");
        assert_eq!(m.filename, "atlas-station-2026-08-16.d4279a7-setup.exe");

        let bad = br#"{
          "version": "nope",
          "date": "2026-08-16",
          "git": "d4279a7",
          "filename": "atlas-station-2026-08-16.d4279a7-setup.exe",
          "sha256": "abcd"
        }"#;
        assert!(parse_latest_json(bad).is_err());
        assert!(parse_latest_json(br#"{"version":"x"}"#).is_err());
    }
}
```

- [ ] **Step 2: Run tests — expect compile fail**

```powershell
cargo test station_releases:: -- --nocapture
```

Expected: `cannot find function is_safe_release_filename`.

- [ ] **Step 3: Implement parse + safe name + handlers**

```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatestManifest {
    pub version: String,
    pub date: String,
    pub git: String,
    pub filename: String,
    pub sha256: String,
}

pub fn release_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("ATLAS_STATION_RELEASE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("releases")
        .join("station")
}

pub fn is_safe_release_filename(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn parse_latest_json(bytes: &[u8]) -> Result<LatestManifest, String> {
    let m: LatestManifest =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid latest.json: {e}"))?;
    if m.version != format!("{}.{}", m.date, m.git) {
        return Err("version must equal date + \".\" + git".into());
    }
    if !is_safe_release_filename(&m.filename) {
        return Err("unsafe filename".into());
    }
    if m.sha256.trim().is_empty() {
        return Err("sha256 required".into());
    }
    Ok(m)
}

pub fn read_latest(dir: &Path) -> Result<LatestManifest, String> {
    let path = dir.join("latest.json");
    let bytes = std::fs::read(&path).map_err(|_| "no station release".to_string())?;
    parse_latest_json(&bytes)
}
```

In `api.rs`, add routes next to `/api/version`:

```rust
        .route("/api/station-releases/latest", get(station_release_latest))
        .route("/releases/station/{filename}", get(station_release_file))
```

Handlers (no cache — read disk every request):

```rust
async fn station_release_latest() -> impl IntoResponse {
    match crate::station_releases::read_latest(&crate::station_releases::release_dir()) {
        Ok(m) => (StatusCode::OK, Json(m)).into_response(),
        Err(err) if err == "no station release" => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "no station release".into(),
            }),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody { error: err }),
        )
            .into_response(),
    }
}

async fn station_release_file(Path(filename): Path<String>) -> impl IntoResponse {
    if !crate::station_releases::is_safe_release_filename(&filename) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "invalid filename".into(),
            }),
        )
            .into_response();
    }
    let path = crate::station_releases::release_dir().join(&filename);
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/octet-stream",
            )],
            bytes,
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                error: "file not found".into(),
            }),
        )
            .into_response(),
    }
}
```

`ErrorBody` is already in `crate::error`.

`docs/api.md` section **1.1** after `/api/version`:

```markdown
| GET | `/api/station-releases/latest` | **机台「检查更新」** | 读盘 `latest.json`；无文件 → 404 |
| GET | `/releases/station/{filename}` | **机台下载** | 仅安全文件名；无文件 → 404 |
```

Add a short **1.x** subsection with the JSON example from the spec.

`.gitignore` add:

```
/releases/station/*.exe
```

- [ ] **Step 4: Run tests**

```powershell
cargo test station_releases:: -- --nocapture
```

Expected: 2 passed.

- [ ] **Step 5: Commit center**

```powershell
git add src/station_releases.rs src/main.rs src/api.rs docs/api.md .gitignore
git commit -m "feat(center): host station release manifest and installer files"
```

Working directory: `C:\Users\zhong\git\Atlas\atlas-center`.

---

### Task 2: Station update decision + sha256

**Files:**
- Create: `atlas-station/src/station_update.rs`
- Modify: `atlas-station/src/main.rs` (`mod station_update;` — later `lib.rs` will re-export)

**Interfaces:**
- Consumes: local version string, optional `LatestManifest`, `busy: bool`, downloaded bytes
- Produces:
  - `pub enum UpdateDecision { AlreadyLatest, Unavailable, Busy, Ready { version, filename, sha256 } }`
  - `pub fn decide_station_update(local: &str, latest: Option<&LatestManifest>, busy: bool) -> UpdateDecision`
  - `pub fn verify_sha256_hex(bytes: &[u8], expected_hex: &str) -> bool`

Use the same `LatestManifest` field names as center (duplicate the struct in this crate — do not add a workspace dep on center).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn latest() -> LatestManifest {
        LatestManifest {
            version: "2026-08-16.aaaaaaa".into(),
            date: "2026-08-16".into(),
            git: "aaaaaaa".into(),
            filename: "atlas-station-2026-08-16.aaaaaaa-setup.exe".into(),
            sha256: "00".into(),
        }
    }

    #[test]
    fn decide_cases() {
        assert!(matches!(
            decide_station_update("2026-08-16.aaaaaaa", Some(&latest()), false),
            UpdateDecision::AlreadyLatest
        ));
        assert!(matches!(
            decide_station_update("2026-08-16.bbbbbbb", Some(&latest()), true),
            UpdateDecision::Busy
        ));
        assert!(matches!(
            decide_station_update("2026-08-16.bbbbbbb", None, false),
            UpdateDecision::Unavailable
        ));
        match decide_station_update("2026-08-16.bbbbbbb", Some(&latest()), false) {
            UpdateDecision::Ready { version, filename, .. } => {
                assert_eq!(version, "2026-08-16.aaaaaaa");
                assert_eq!(filename, "atlas-station-2026-08-16.aaaaaaa-setup.exe");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn sha256_matches() {
        let bytes = b"abc";
        let hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_sha256_hex(bytes, hex));
        assert!(!verify_sha256_hex(bytes, "00"));
        assert!(!verify_sha256_hex(bytes, "zz"));
    }
}
```

Add `mod station_update;` to `main.rs`.

- [ ] **Step 2: Run — expect fail**

```powershell
cargo test station_update:: -- --nocapture
```

- [ ] **Step 3: Implement**

Add to `atlas-station/Cargo.toml` dependencies if missing:

```toml
sha2 = "0.10"
hex = "0.4"
```

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LatestManifest {
    pub version: String,
    pub date: String,
    pub git: String,
    pub filename: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateDecision {
    AlreadyLatest,
    Unavailable,
    Busy,
    Ready {
        version: String,
        filename: String,
        sha256: String,
    },
}

pub fn decide_station_update(
    local: &str,
    latest: Option<&LatestManifest>,
    busy: bool,
) -> UpdateDecision {
    let Some(latest) = latest else {
        return UpdateDecision::Unavailable;
    };
    if latest.version == local {
        return UpdateDecision::AlreadyLatest;
    }
    if busy {
        return UpdateDecision::Busy;
    }
    UpdateDecision::Ready {
        version: latest.version.clone(),
        filename: latest.filename.clone(),
        sha256: latest.sha256.clone(),
    }
}

pub fn verify_sha256_hex(bytes: &[u8], expected_hex: &str) -> bool {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let actual = hex::encode(digest);
    actual.eq_ignore_ascii_case(expected_hex.trim())
}
```

- [ ] **Step 4: Run tests — expect pass**

```powershell
cargo test station_update:: -- --nocapture
```

- [ ] **Step 5: Commit station**

```powershell
git add src/station_update.rs src/main.rs Cargo.toml Cargo.lock
git commit -m "feat(station): decide manual update without auto-apply"
```

---

### Task 3: Extract `atlas_station` lib + `serve`

**Files:**
- Create: `atlas-station/src/lib.rs`
- Modify: `atlas-station/src/main.rs` (thin)
- Modify: `atlas-station/Cargo.toml` (`[lib]` name `atlas_station`)

**Interfaces:**
- Produces: `pub async fn serve() -> Result<(), String>` that contains today’s `main` body (config, register, bind, `axum::serve`).
- `main.rs` only calls `atlas_station::serve().await`.

Do **not** add Tauri in this task. After this, `cargo test` and `cargo run` still work.

- [ ] **Step 1:** Add to `Cargo.toml`:

```toml
[lib]
name = "atlas_station"
path = "src/lib.rs"
```

Create `src/lib.rs` that lists every current `mod` from `main.rs` (copy the `mod` list verbatim) plus `pub use` nothing extra. Move `serve` logic from `main` into `pub async fn serve()`.

`src/main.rs` becomes:

```rust
#[tokio::main]
async fn main() {
    if let Err(e) = atlas_station::serve().await {
        panic!("{e}");
    }
}
```

`serve` must still call `AgentConfig::load_from_env`, file logging, register, `api::router` + `web::static_router`, bind, `axum::serve`.

Because modules move to the lib, tests that were `cargo test version::` keep working (they live on the lib).

- [ ] **Step 2: Verify**

```powershell
cargo test version:: station_update:: -- --nocapture
```

Expected: pass. If `mod` visibility breaks a `pub(crate)` test, fix visibility only as needed (`pub(crate) mod api` etc.). Prefer `mod` private + `pub async fn serve`.

- [ ] **Step 3: Commit**

```powershell
git add src/lib.rs src/main.rs Cargo.toml
git commit -m "refactor(station): extract serve() for a desktop host"
```

---

### Task 4: Tauri 2 desktop crate (NSIS current user)

**Files:**
- Create: `atlas-station/src-tauri/Cargo.toml`
- Create: `atlas-station/src-tauri/src/main.rs`
- Create: `atlas-station/src-tauri/tauri.conf.json`
- Create: `atlas-station/src-tauri/capabilities/default.json` (Tauri 2 minimum)
- Modify: `atlas-station/Cargo.toml` — add workspace member `src-tauri` **only if** the root crate is not already a workspace; if adding `[workspace] members = ["src-tauri"]` conflicts, keep `src-tauri` as a standalone path crate and build with `cargo build -p atlas-station-desktop`.
- Modify: `atlas-station/.gitignore` — `src-tauri/target` if it has its own target, plus `*.exe` under src-tauri/bundle.

**Interfaces:**
- Desktop bin starts Axum via `atlas_station::serve()` on a background tokio runtime **or** `tauri::async_runtime::spawn(atlas_station::serve())`.
- Window URL: `http://127.0.0.1:{port}/` where `port` is `AGENT_PORT` or `9090`.
- Bundle: `targets: ["nsis"]`, `windows.nsis.installMode: "currentUser"`.
- `productName`: `Atlas Station`. `identifier`: `com.atlas.station`.
- Do **not** enable Tauri updater plugin (it polls).

Use Tauri **2.x**. NSIS current-user default is `%LOCALAPPDATA%`; set `installMode` explicitly:

```json
{
  "productName": "Atlas Station",
  "version": "0.1.0",
  "identifier": "com.atlas.station",
  "build": {
    "frontendDist": "../static",
    "devUrl": "http://127.0.0.1:9090"
  },
  "app": {
    "windows": [
      {
        "title": "Atlas Station",
        "width": 1280,
        "height": 800
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

`src-tauri/src/main.rs` first cut (no update commands yet):

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            tauri::async_runtime::spawn(async {
                if let Err(e) = atlas_station::serve().await {
                    eprintln!("atlas-station server failed: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri");
}
```

Wait ~300ms or poll `http://127.0.0.1:9090/api/health` before creating the window if the first load races; if `devUrl`/`frontendDist` load immediately, set window URL in setup after health is `ok`. Prefer: create the window in `setup` after a short health retry loop (max 50 × 100ms).

`src-tauri/Cargo.toml` depends on `atlas-station = { path = ".." }` and `tauri = { version = "2", features = [] }`, `tauri-build` in build-dependencies, plus a `build.rs` that calls `tauri_build::build()`.

Copy a default Tauri icon set or reuse `frontend/public/favicon.svg` converted later; if icons are missing, use Tauri’s default icon generation (`npx @tauri-apps/cli icon path/to/favicon.png`) once.

- [ ] **Step 1:** Scaffold the files above. Do not add 检查更新 yet.

- [ ] **Step 2:** `cargo check -p atlas-station-desktop` from `atlas-station` (or `cd src-tauri && cargo check`). Fix crate name / workspace until it compiles.

- [ ] **Step 3:** Document in `atlas-station/README.md` (living doc):

```markdown
## 产线安装包（Tauri）

```powershell
$env:AGENT_CENTER_URL = "http://127.0.0.1:9080"
cargo tauri build --bundles nsis
```

产物为当前用户 NSIS。开发仍用 `cargo run` + 浏览器 `9090`。
```

- [ ] **Step 4: Commit**

```powershell
git add src-tauri Cargo.toml .gitignore README.md
git commit -m "feat(station): add Tauri current-user NSIS desktop host"
```

---

### Task 5: 检查更新 UI + Tauri commands

**Files:**
- Create: `atlas-station/frontend/src/lib/isDesktop.ts`
- Create: `atlas-station/frontend/src/lib/isDesktop.test.ts`
- Create: `atlas-station/frontend/src/lib/stationUpdateCopy.ts`
- Modify: `atlas-station/frontend/src/components/AppShell.tsx`
- Modify: `atlas-station/src-tauri/src/main.rs` (commands)
- Modify: `atlas-station/frontend/src/pages/stationHelp.ts` (one line)
- Rebuild: `.\scripts\build-frontend.ps1`

**Interfaces:**
- `export function isDesktopShell(): boolean` — true iff `window` has `__TAURI_INTERNALS__` (Tauri 2). No timer.
- Commands (invoke from the button only):
  - `check_station_update` → `{ kind: "latest"|"unavailable"|"busy"|"ready", version?: string, filename?: string }`
  - `download_station_update` → `{ version: string, path: string }` or error
  - `apply_station_update` → starts installer `/S` and exits the app
- Copy (verbatim):
  - 检查更新
  - 已是最新
  - 暂时无法检查更新
  - 开测中，结束后再更新
  - 已下载新版本 {version}，重启应用以完成更新
  - 更新失败，仍使用当前版本

`check_station_update` implementation:

1. `local = crate::version::version()`
2. `GET {center_url}/api/station-releases/latest` with existing `reqwest` client (`AGENT_CENTER_URL`). 404/network → `Unavailable`
3. Parse JSON into `LatestManifest` (if `version != date + "." + git`, treat as Unavailable)
4. `busy` from the live `AppState.slot` / same flag as `/api/status` `busy`. Because `serve()` owns state, share it: put `AppState` in a `OnceLock<AppState>` set at the start of `serve()`, or return `busy` via an internal `try_status_busy() -> bool` that reads the same `TaskSlot`. Do **not** invent a second busy definition.
5. `decide_station_update(local, latest, busy)`

`download_station_update`:

1. Re-run decide; if not `Ready`, return that kind (do not download if now busy).
2. `GET {center_url}/releases/station/{filename}`
3. `verify_sha256_hex`; fail → delete temp, error copy 更新失败，仍使用当前版本
4. Write `%TEMP%\atlas-station-update\<filename>`
5. Return path + version — **do not** start installer

`apply_station_update`:

1. If busy → error 开测中，结束后再更新
2. `Command::new(path).arg("/S").spawn()`
3. `app.exit(0)` so Axum dies with the window

AppShell: if `isDesktopShell()`, show `<Button ghost>检查更新</Button>` immediately to the left of 「重新注册」. On click: invoke check → if ready, invoke download → `Modal.confirm` with the restart sentence → OK invoke apply, Cancel do nothing. Use `message.info` / `message.error` for the other kinds. **No `useEffect` that calls check.**

- [ ] **Step 1: Frontend tests for `isDesktopShell`**

```ts
import { describe, expect, it } from 'vitest';
import { isDesktopShell } from './isDesktop';

describe('isDesktopShell', () => {
  it('is false in vitest/node', () => {
    expect(isDesktopShell()).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fail until file exists, then pass with `false`**

```powershell
cd frontend
npx vitest run src/lib/isDesktop.test.ts
```

- [ ] **Step 3: Implement helper, copy, AppShell, commands, help, rebuild static**

`isDesktop.ts`:

```ts
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
```

Help: add `sequence` is wrong place — add under a small `desktop` key or `run`:

```ts
  desktop: {
    checkUpdate: '向中心比对机台安装包版本。开测中不能更新；空闲也不会自动更新。',
  },
```

`stationHelp.test.ts` only checks non-empty groups — adding a `desktop` key requires adding `'desktop'` to the expected `Object.keys` list.

- [ ] **Step 4: Tests**

```powershell
cd frontend
npx vitest run src/lib/isDesktop.test.ts src/pages/stationHelp.test.ts
```

```powershell
cargo test station_update:: -- --nocapture
```

- [ ] **Step 5: Rebuild static + commit**

```powershell
.\scripts\build-frontend.ps1
git add frontend src-tauri src/lib.rs static
git commit -m "feat(station): add manual check-update in the Tauri window"
```

---

### Task 6: Bundle name + release checklist (no CI NSIS)

**Files:**
- Modify: `atlas-station/src-tauri/tauri.conf.json` so the NSIS artifact name includes the compile version if Tauri allows a hook; if `productName`/`version` cannot use `YYYY-MM-DD.sha`, keep Tauri `version` as `0.1.0` and **rename** the built setup exe in a script.
- Create: `atlas-station/scripts/package-station.ps1`
- Modify: `atlas-station/README.md` with engineer copy steps to the center folder.

`scripts/package-station.ps1`:

1. `.\scripts\build-frontend.ps1`
2. `cargo tauri build --bundles nsis` (from repo root or src-tauri)
3. Read `ATLAS_VERSION` from the just-built binary if easy; otherwise run `git rev-parse --short=7 HEAD` + local date `yyyy-MM-dd` the same way as `build.rs` (do not invent a third format).
4. Copy/rename the NSIS exe to `atlas-station-<version>-setup.exe`
5. Print `Get-FileHash -Algorithm SHA256` and a sample `latest.json`

Engineer then copies exe + `latest.json` to the center machine’s `releases/station`.

Do not add a CI job that builds NSIS.

- [ ] **Step 1:** Write the script and README section (exact commands, `ATLAS_STATION_RELEASE_DIR`, 404 if folder empty).

- [ ] **Step 2:** Run `Get-Content scripts/package-station.ps1` mentally against the spec filename `atlas-station-2026-08-16.d4279a7-setup.exe`.

- [ ] **Step 3: Commit**

```powershell
git add scripts/package-station.ps1 README.md src-tauri/tauri.conf.json
git commit -m "docs(station): add per-user NSIS package script and release copy steps"
```

---

## Manual check

1. Ordinary Windows user runs the NSIS exe — no UAC, app opens, `:9090` still serves, center still polls status.
2. Browser `cargo run` has **no** 检查更新 button.
3. Tauri window: idle, do nothing — no request to `/api/station-releases/latest` (watch center logs / DevTools network).
4. Click 检查更新 with no `latest.json` → 暂时无法检查更新.
5. Matching version → 已是最新.
6. Start a sequence, click 检查更新 → 开测中，结束后再更新；no download.
7. Different version, not busy: download, Cancel on restart dialog → process stays, version unchanged.
8. OK on dialog → app exits, installer `/S`, relaunch, top-bar version equals `latest.json`.
