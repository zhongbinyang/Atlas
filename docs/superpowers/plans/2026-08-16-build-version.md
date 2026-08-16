# Build Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp each Rust binary with `YYYY-MM-DD.<shortsha>` at compile time and show that string on the matching WebUI header (station sequence version step uses the same string).

**Architecture:** `build.rs` writes `ATLAS_VERSION` / `ATLAS_BUILD_DATE` / `ATLAS_GIT_REV`. Runtime only reads those constants. `GET /api/version` returns `{ version, date, git }`. AppShell fetches once and renders the third brand line. Station `run_read_version` returns the same `version` constant.

**Tech Stack:** Rust `build.rs` + chrono (build-dep), Axum, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-build-version-design.md`

## Global Constraints

- Version format is `YYYY-MM-DD.<shortsha>`; dirty tree appends `-dirty`.
- Date is the **compile machine local calendar day**, not git commit day, not UTC day-roll.
- SHA is `git rev-parse --short=7 HEAD`; failure → `unknown` and not dirty.
- `git status --porcelain` non-empty → dirty; status failure → not dirty.
- Runtime never runs git. Vite / `npm run build` does not stamp the version.
- `version === date + "." + git` always (`git` already includes `-dirty` when dirty).
- Center and station stamp independently and do not read each other.
- Header fetch failure: hide the version line, no toast.
- Cargo.toml package version stays `0.1.0` and is not shown as the product version.
- Do not rewrite historical `docs/superpowers/*` specs. Update living `docs/api.md` only.
- Center git repo: `C:\Users\zhong\git\Atlas\atlas-center`. Station git repo: `C:\Users\zhong\git\Atlas\atlas-station`.

---

## File map

| File | Responsibility |
|------|----------------|
| `atlas-center/build.rs` | Probe date/git; set `rustc-env` |
| `atlas-center/src/version.rs` | `format_build_version`, `env!` accessors, JSON body |
| `atlas-center/src/main.rs` | `mod version;` |
| `atlas-center/src/api.rs` | `GET /api/version` |
| `atlas-center/Cargo.toml` | `[build-dependencies] chrono` |
| `atlas-center/docs/api.md` | Document the new route |
| `atlas-center/frontend/src/lib/buildVersion.ts` | `readBuildVersion` |
| `atlas-center/frontend/src/api/schedulerApi.ts` | `buildVersion()` |
| `atlas-center/frontend/src/components/AppShell.tsx` | Fetch + third brand line |
| `atlas-center/frontend/src/index.css` | `.atlas-build-version` |
| `atlas-station/build.rs` | Same rules as center |
| `atlas-station/src/version.rs` | Same module as center |
| `atlas-station/src/main.rs` | `mod version;` |
| `atlas-station/src/general.rs` | Version step reads `crate::version::version()` |
| `atlas-station/src/api.rs` | `GET /api/version` + oneshot test |
| `atlas-station/Cargo.toml` | `[build-dependencies] chrono` |
| `atlas-station/frontend/src/lib/buildVersion.ts` | Same helper as center |
| `atlas-station/frontend/src/api/agentApi.ts` | `buildVersion()` |
| `atlas-station/frontend/src/components/AppShell.tsx` | Fetch + third brand line |
| `atlas-station/frontend/src/styles/index.css` | `.atlas-build-version` |
| `atlas-station/frontend/src/pages/stationHelp.ts` | Version help copy |

---

### Task 1: Center compile-time version + API

**Files:**
- Create: `atlas-center/build.rs`
- Create: `atlas-center/src/version.rs`
- Modify: `atlas-center/Cargo.toml` (add `[build-dependencies]`)
- Modify: `atlas-center/src/main.rs` (add `mod version;`)
- Modify: `atlas-center/src/api.rs` (route next to `/api/health`)
- Modify: `atlas-center/docs/api.md`

**Interfaces:**
- Consumes: none
- Produces:
  - `pub fn format_build_version(date: &str, sha: &str, dirty: bool) -> String`
  - `pub fn version() -> &'static str` (`env!("ATLAS_VERSION")`)
  - `pub fn date() -> &'static str` (`env!("ATLAS_BUILD_DATE")`)
  - `pub fn git() -> &'static str` (`env!("ATLAS_GIT_REV")`)
  - `pub fn version_json() -> serde_json::Value`
  - `GET /api/version` → `{ "version", "date", "git" }`

- [ ] **Step 1: Write the failing format tests**

Create `atlas-center/src/version.rs` with only the tests (no `format_build_version` yet). This crate is a binary (no `lib.rs`); add `mod version;` next to the other `mod` lines in `atlas-center/src/main.rs` so `cargo test` compiles the file.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_clean_sha() {
        assert_eq!(
            format_build_version("2026-08-16", "d4279a7", false),
            "2026-08-16.d4279a7"
        );
    }

    #[test]
    fn formats_dirty_sha() {
        assert_eq!(
            format_build_version("2026-08-16", "d4279a7", true),
            "2026-08-16.d4279a7-dirty"
        );
    }

    #[test]
    fn formats_unknown_when_no_git() {
        assert_eq!(
            format_build_version("2026-08-16", "unknown", false),
            "2026-08-16.unknown"
        );
    }
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run (from `atlas-center`):

```powershell
cargo test version:: -- --nocapture
```

Expected: compile error `cannot find function format_build_version`.

- [ ] **Step 3: Implement `format_build_version` only**

Add at the top of `atlas-center/src/version.rs`:

```rust
pub fn format_build_version(date: &str, sha: &str, dirty: bool) -> String {
    if dirty {
        format!("{date}.{sha}-dirty")
    } else {
        format!("{date}.{sha}")
    }
}
```

Do **not** add `env!("ATLAS_*")` yet (no `build.rs`).

- [ ] **Step 4: Run format tests**

```powershell
cargo test version:: -- --nocapture
```

Expected: 3 passed.

- [ ] **Step 5: Add `build.rs`, env accessors, route, and docs**

Append to `atlas-center/Cargo.toml`:

```toml
[build-dependencies]
chrono = { version = "0.4", default-features = false, features = ["clock"] }
```

Create `atlas-center/build.rs`:

```rust
use std::env;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=ATLAS_BUILD_DATE");
    println!("cargo:rerun-if-env-changed=ATLAS_GIT_SHA");
    println!("cargo:rerun-if-env-changed=ATLAS_GIT_DIRTY");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/index");

    let date = env::var("ATLAS_BUILD_DATE").unwrap_or_else(|_| {
        chrono::Local::now().format("%Y-%m-%d").to_string()
    });
    let sha = env::var("ATLAS_GIT_SHA")
        .unwrap_or_else(|_| git_short_sha().unwrap_or_else(|| "unknown".into()));
    let dirty = match env::var("ATLAS_GIT_DIRTY") {
        Ok(value) => value == "1",
        Err(_) => git_is_dirty(),
    };
    let git = if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    };
    let version = format!("{date}.{git}");

    println!("cargo:rustc-env=ATLAS_BUILD_DATE={date}");
    println!("cargo:rustc-env=ATLAS_GIT_REV={git}");
    println!("cargo:rustc-env=ATLAS_VERSION={version}");
}

fn git_short_sha() -> Option<String> {
    let dir = env::var("CARGO_MANIFEST_DIR").ok()?;
    let out = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .current_dir(&dir)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn git_is_dirty() -> bool {
    let Ok(dir) = env::var("CARGO_MANIFEST_DIR") else {
        return false;
    };
    let Ok(out) = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&dir)
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    !String::from_utf8_lossy(&out.stdout).trim().is_empty()
}
```

Add accessors and the identity test to `atlas-center/src/version.rs`:

```rust
pub fn version() -> &'static str {
    env!("ATLAS_VERSION")
}

pub fn date() -> &'static str {
    env!("ATLAS_BUILD_DATE")
}

pub fn git() -> &'static str {
    env!("ATLAS_GIT_REV")
}

pub fn version_json() -> serde_json::Value {
    serde_json::json!({
        "version": version(),
        "date": date(),
        "git": git(),
    })
}
```

Inside `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn version_json_matches_parts() {
        let body = version_json();
        let version = body.get("version").and_then(|v| v.as_str()).unwrap();
        let date = body.get("date").and_then(|v| v.as_str()).unwrap();
        let git = body.get("git").and_then(|v| v.as_str()).unwrap();
        assert_eq!(version, format!("{date}.{git}"));
        assert!(!version.is_empty());
        assert!(!date.is_empty());
        assert!(!git.is_empty());
    }
```

In `atlas-center/src/api.rs`, next to the health route, add:

```rust
        .route("/api/version", get(get_version))
```

Add the handler near the other small handlers (above `pub fn router` is fine):

```rust
async fn get_version() -> Json<serde_json::Value> {
    Json(crate::version::version_json())
}
```

`Json` is already imported.

Update `atlas-center/docs/api.md`:

1. In section **1.1** table, after the `/api/health` row, add:

```markdown
| GET | `/api/version` | **中心 WebUI** | 本进程编译版本 `{ version, date, git }` |
```

2. In section **1.2**, after the health paragraph, add:

```markdown
**GET** `/api/version` → `{ "version": "2026-08-16.d4279a7", "date": "2026-08-16", "git": "d4279a7" }` · 使用方：**中心 WebUI**

`version` 恒等于 `date + "." + git`。脏工作区时 `git` / `version` 带 `-dirty`。值为 `cargo build` 时写入的常量，运行时不查 git。
```

3. In section **2.1** table, after the station `/api/health` row, add:

```markdown
| GET | `/api/version` | **Agent WebUI** | 本进程编译版本 `{ version, date, git }` |
```

4. In section **2.2**, after the health paragraph, add the same **GET** `/api/version` sentence, 使用方：**Agent WebUI**.

5. Replace the CARGO_PKG_VERSION sentence in **2.9.1** with:

```markdown
**POST** `/api/general/version/run` · 使用方：**Agent WebUI** — 无 Body；返回 `{ "ok": true, "kind": "version", "version": "<ATLAS_VERSION>" }`（与 `GET /api/version` 的 `version` 同一编译期常量，例如 `2026-08-16.d4279a7`）
```

- [ ] **Step 6: Run center version tests**

```powershell
cargo test version:: -- --nocapture
```

Expected: 4 passed.

- [ ] **Step 7: Commit center Rust + docs**

```powershell
git add build.rs src/version.rs src/main.rs src/api.rs Cargo.toml docs/api.md
git commit -m "feat(center): stamp compile date and git SHA as version"
```

Working directory: `C:\Users\zhong\git\Atlas\atlas-center`.

---

### Task 2: Center header display

**Files:**
- Create: `atlas-center/frontend/src/lib/buildVersion.ts`
- Create: `atlas-center/frontend/src/lib/buildVersion.test.ts`
- Modify: `atlas-center/frontend/src/api/schedulerApi.ts`
- Modify: `atlas-center/frontend/src/components/AppShell.tsx`
- Modify: `atlas-center/frontend/src/index.css`
- Rebuild: `atlas-center/static/*` via `.\scripts\build-frontend.ps1`

**Interfaces:**
- Consumes: `GET /api/version` JSON
- Produces:
  - `export function readBuildVersion(data: unknown): string | null`
  - `schedulerApi.buildVersion(): Promise<unknown>`
  - AppShell third brand line when `readBuildVersion` returns a string

- [ ] **Step 1: Write the failing helper tests**

Create `atlas-center/frontend/src/lib/buildVersion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readBuildVersion } from './buildVersion';

describe('readBuildVersion', () => {
  it('returns the version string when present', () => {
    expect(
      readBuildVersion({
        version: '2026-08-16.d4279a7',
        date: '2026-08-16',
        git: 'd4279a7',
      }),
    ).toBe('2026-08-16.d4279a7');
  });

  it('returns null when version is missing, blank, or payload is not an object', () => {
    expect(readBuildVersion(null)).toBeNull();
    expect(readBuildVersion('2026-08-16.d4279a7')).toBeNull();
    expect(readBuildVersion({})).toBeNull();
    expect(readBuildVersion({ version: '   ' })).toBeNull();
    expect(readBuildVersion({ version: 1 })).toBeNull();
  });
});
```

Do not create `buildVersion.ts` yet.

- [ ] **Step 2: Run the helper test and confirm it fails**

```powershell
cd frontend
npx vitest run src/lib/buildVersion.test.ts
```

Expected: FAIL, cannot find module `./buildVersion`.

- [ ] **Step 3: Implement helper, API, AppShell, CSS**

Create `atlas-center/frontend/src/lib/buildVersion.ts`:

```ts
export function readBuildVersion(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const version = (data as { version?: unknown }).version;
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  return trimmed ? trimmed : null;
}
```

In `atlas-center/frontend/src/api/schedulerApi.ts`, add this method on the `schedulerApi` object (next to the other getters):

```ts
  buildVersion: () => apiRequest<unknown>('/api/version'),
```

In `atlas-center/frontend/src/components/AppShell.tsx`:

1. Add imports:

```ts
import { useEffect, useState } from 'react';
import { schedulerApi } from '../api/schedulerApi';
import { readBuildVersion } from '../lib/buildVersion';
```

2. Inside `AppShell`, before `return`:

```ts
  const [buildVersion, setBuildVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void schedulerApi
      .buildVersion()
      .then((data) => {
        const version = readBuildVersion(data);
        if (!cancelled) setBuildVersion(version);
      })
      .catch(() => {
        /* hide version line */
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

3. Inside `.atlas-brand-text`, after the tagline span, add:

```tsx
            {buildVersion ? (
              <span className="atlas-build-version" title="编译版本">
                {buildVersion}
              </span>
            ) : null}
```

In `atlas-center/frontend/src/index.css`, after `.atlas-tagline`:

```css
.atlas-build-version {
  display: block;
  margin-top: 2px;
  color: rgba(244, 247, 250, 0.42);
  font-family: var(--atlas-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  line-height: 1.2;
}

.atlas-header.ant-layout-header {
  height: auto;
  min-height: 64px;
  padding-top: 8px;
  padding-bottom: 8px;
}
```

The second rule already exists as `.atlas-header.ant-layout-header` with `display/flex/...`. **Do not duplicate the selector.** Merge `height`, `min-height`, and padding into the existing `.atlas-header.ant-layout-header` block at the top of the file.

- [ ] **Step 4: Run helper tests**

```powershell
cd frontend
npx vitest run src/lib/buildVersion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Rebuild static assets**

```powershell
.\scripts\build-frontend.ps1
```

Working directory: `atlas-center`. Expected: `static/index.html` and hashed assets update.

- [ ] **Step 6: Commit center UI**

```powershell
git add frontend/src/lib/buildVersion.ts frontend/src/lib/buildVersion.test.ts frontend/src/api/schedulerApi.ts frontend/src/components/AppShell.tsx frontend/src/index.css static
git commit -m "feat(center-ui): show compile version under the header brand"
```

---

### Task 3: Station compile-time version, API, and sequence step

**Files:**
- Create: `atlas-station/build.rs` (same contents as center `build.rs`)
- Create: `atlas-station/src/version.rs` (same contents as center `src/version.rs`)
- Modify: `atlas-station/Cargo.toml`
- Modify: `atlas-station/src/main.rs`
- Modify: `atlas-station/src/general.rs`
- Modify: `atlas-station/src/api.rs`
- Modify: `atlas-center/docs/api.md` only if Task 1 already updated 2.1 / 2.2 / 2.9.1 — do not edit again unless those lines are still `CARGO_PKG_VERSION`

**Interfaces:**
- Consumes: same `format_build_version` / `version()` contract as Task 1
- Produces:
  - `GET /api/version` on the station router
  - `agent_package_version()` returns `crate::version::version()` (no longer `CARGO_PKG_VERSION`)
  - `run_read_version()` / `version_outputs()` use that string

- [ ] **Step 1: Write the failing format tests**

Create `atlas-station/src/version.rs` with the same three format tests as Task 1 Step 1 (copy the test module verbatim). Do not add `format_build_version` yet.

- [ ] **Step 2: Run and confirm fail**

Add `mod version;` to `atlas-station/src/main.rs` (with the other `mod` lines) so the binary crate compiles the file.

```powershell
cargo test version:: -- --nocapture
```

Expected: compile error `cannot find function format_build_version`.

- [ ] **Step 3: Implement version module + build.rs**

Copy the finished `format_build_version`, accessors, `version_json`, and `version_json_matches_parts` test from center `src/version.rs`.

Copy center `build.rs` to `atlas-station/build.rs` unchanged.

Append to `atlas-station/Cargo.toml`:

```toml
[build-dependencies]
chrono = { version = "0.4", default-features = false, features = ["clock"] }
```

- [ ] **Step 4: Run version tests**

```powershell
cargo test version:: -- --nocapture
```

Expected: 4 passed.

- [ ] **Step 5: Point the sequence version step at the new constant**

In `atlas-station/src/general.rs`, replace `agent_package_version`:

```rust
/// Compile-time station version (`YYYY-MM-DD.<sha>`, optional `-dirty`).
pub fn agent_package_version() -> &'static str {
    crate::version::version()
}
```

Keep `run_read_version` / `version_outputs` as they are (they already call `agent_package_version()`).

In `version_outputs_match_runtime`, add:

```rust
        assert_eq!(agent_package_version(), crate::version::version());
```

- [ ] **Step 6: Add `GET /api/version` and an oneshot test**

In `atlas-station/src/api.rs` `router()`, immediately after `/api/health`:

```rust
        .route("/api/version", get(get_version))
```

Add handler (near other small handlers):

```rust
async fn get_version() -> Json<Value> {
    Json(crate::version::version_json())
}
```

`Json` and `Value` (`serde_json::Value`) are already in scope in this file. If `Value` is not imported at the top, use `serde_json::Value`.

In the existing `#[cfg(test)]` module of `atlas-station/src/api.rs` (same module as `status_responds_within_150_ms`), add:

```rust
    #[tokio::test]
    async fn version_returns_compile_stamp() {
        let app = router(test_state());
        let req = Request::builder()
            .uri("/api/version")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let version = body.get("version").and_then(|v| v.as_str()).unwrap();
        let date = body.get("date").and_then(|v| v.as_str()).unwrap();
        let git = body.get("git").and_then(|v| v.as_str()).unwrap();
        assert_eq!(version, format!("{date}.{git}"));
        assert_eq!(version, crate::version::version());
    }
```

`Request`, `Body`, `oneshot`, `test_state`, `StatusCode` are already used in that test module.

- [ ] **Step 7: Run station tests**

```powershell
cargo test version:: -- --nocapture
cargo test version_outputs_match_runtime version_returns_compile_stamp -- --nocapture
```

Expected: all passed.

- [ ] **Step 8: Commit station Rust**

```powershell
git add build.rs src/version.rs src/main.rs src/general.rs src/api.rs Cargo.toml
git commit -m "feat(station): stamp compile version and expose /api/version"
```

Working directory: `C:\Users\zhong\git\Atlas\atlas-station`.

---

### Task 4: Station header display

**Files:**
- Create: `atlas-station/frontend/src/lib/buildVersion.ts`
- Create: `atlas-station/frontend/src/lib/buildVersion.test.ts`
- Modify: `atlas-station/frontend/src/api/agentApi.ts`
- Modify: `atlas-station/frontend/src/components/AppShell.tsx`
- Modify: `atlas-station/frontend/src/styles/index.css`
- Modify: `atlas-station/frontend/src/pages/stationHelp.ts`
- Rebuild: `atlas-station/static/*` via `.\scripts\build-frontend.ps1`

**Interfaces:**
- Consumes: `GET /api/version`, `readBuildVersion`
- Produces: header third line; help copy mentions compile date + git SHA

- [ ] **Step 1: Write the failing helper tests**

Create `atlas-station/frontend/src/lib/buildVersion.test.ts` with the **same** two cases as Task 2 Step 1 (copy verbatim, including the import from `./buildVersion`).

- [ ] **Step 2: Run and confirm fail**

```powershell
cd frontend
npx vitest run src/lib/buildVersion.test.ts
```

Expected: FAIL, cannot find module `./buildVersion`.

- [ ] **Step 3: Implement helper, API, AppShell, CSS, help**

Create `atlas-station/frontend/src/lib/buildVersion.ts` with the **same** `readBuildVersion` as center.

In `atlas-station/frontend/src/api/agentApi.ts`, add:

```ts
  buildVersion: () => apiRequest<unknown>('/api/version'),
```

In `atlas-station/frontend/src/components/AppShell.tsx`:

1. Add imports:

```ts
import { readBuildVersion } from '../lib/buildVersion';
```

(`useEffect` / `useState` are already imported. `agentApi` is already imported.)

2. Inside `AppShell`, add state and the same fetch `useEffect` as center, but call `agentApi.buildVersion()` instead of `schedulerApi.buildVersion()`. Do not touch the existing status-poll `useEffect`.

3. Inside `.atlas-brand-text`, after the tagline, add the same `{buildVersion ? <span className="atlas-build-version" title="编译版本">...</span> : null}` block.

In `atlas-station/frontend/src/styles/index.css`, add `.atlas-build-version` after `.atlas-tagline` (same CSS as center). Merge `height: auto; min-height: 64px; padding-top: 8px; padding-bottom: 8px;` into the existing `.atlas-header.ant-layout-header` rule. Do not move `MachineInfoPopover` or 「重新注册」.

In `atlas-station/frontend/src/pages/stationHelp.ts`, set:

```ts
    version: '读取本机工位程序版本（编译日期 + git SHA）。注册后可当序列一步做版本核对。',
```

- [ ] **Step 4: Run helper tests**

```powershell
cd frontend
npx vitest run src/lib/buildVersion.test.ts
```

Expected: PASS.

`stationHelp.test.ts` only checks that help strings are non-empty. No assertion change. Optional: `npx vitest run src/pages/stationHelp.test.ts` still passes.

- [ ] **Step 5: Rebuild static assets**

```powershell
.\scripts\build-frontend.ps1
```

Working directory: `atlas-station`.

- [ ] **Step 6: Commit station UI**

```powershell
git add frontend/src/lib/buildVersion.ts frontend/src/lib/buildVersion.test.ts frontend/src/api/agentApi.ts frontend/src/components/AppShell.tsx frontend/src/styles/index.css frontend/src/pages/stationHelp.ts frontend/src/pages/stationHelp.test.ts static
git commit -m "feat(station-ui): show compile version under the header brand"
```

---

## Manual check (after all tasks)

1. Restart `atlas-center` and `atlas-station` (Rust must be rebuilt).
2. Open `http://127.0.0.1:9080` — brand third line shows today’s date and a 7-char SHA (or `-dirty` if the tree is dirty).
3. Open `http://127.0.0.1:9090` — same placement; the string may differ from center (separate repo).
4. Station 通用 → 版本 → 试跑：`version` equals the station header string.
5. Stop the center process and refresh 9080: version line disappears, no error toast.
