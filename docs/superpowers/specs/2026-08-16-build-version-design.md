# Design: 编译日期 + Git 版本号

**日期：** 2026-08-16  
**状态：** 已批准  
**范围：** atlas-center 与 atlas-station 各自在编译期生成版本号，经 `GET /api/version` 在本应用顶栏显示；机台通用「版本」步骤改用同一串。

## 1. 目标

操作员在中心、机台各自的 WebUI 顶栏能看到**正在运行的进程**是哪天编译、对应哪次 git 提交。机台序列里的版本步骤与顶栏是同一串，现场对版本时不会对不上。

成功标准：

- `cargo build` 后，该二进制的版本为 `YYYY-MM-DD.<shortsha>`，例如 `2026-08-16.d4279a7`。
- 工作区有未提交改动时为 `2026-08-16.d4279a7-dirty`。
- 中心、机台各提供 `GET /api/version`，返回本进程常量，不读对方、不查 git。
- 两边顶栏品牌字下显示 `version`；请求失败则不显示、不 toast。
- 机台 `POST /api/general/version/run` 与序列 `kind: version` 的 `version` 字段等于同一常量，不再返回 Cargo `0.1.0`。

## 2. 非目标

- 不把 Cargo.toml `0.1.0` 当产品版本展示；该字段可保持不动。
- 不在 Vite / `npm run build` 时写入版本。
- 不在进程启动或请求时查 git、不把「启动日」当版本日。
- 中心机台列表不展示对方版本；两边互不读取。
- 不新开关于页、不弹窗、不加鉴权。
- 不改序列 Pass/Fail 语义，不改其它通用步骤。
- 不自动把版本写入 sequence `.log`（需要时仍用版本步骤）。

## 3. 已锁定决策

| 主题 | 选择 |
|------|------|
| 格式 | `YYYY-MM-DD.<shortsha>`，脏工作区加 `-dirty` |
| 日期 | 编译机本地日历日，不是 git 提交日，不是 UTC 换日 |
| SHA | `git rev-parse --short=7 HEAD`；失败则为 `unknown` |
| 脏检测 | `git status --porcelain` 非空则 `-dirty`；status 失败视为不脏 |
| 生成时机 | `build.rs` 在 `cargo build` 时写入 `rustc-env` |
| 运行时 | 只读编译期常量 |
| 展示 | 顶栏品牌第三行，等宽淡色，`title="编译版本"` |
| 失败 | 前端隐藏版本行；序列/试跑仍返回编译期字符串 |
| 两应用 | 各自编译、各自显示 |

未选方案：Vite 注入（与 Rust 进程分叉）；启动时现查 git（日期不是编译日，部署机可能无 git）。

## 4. 架构

```text
cargo build
    │
    v
build.rs
    ├─ date = 本地 YYYY-MM-DD（或 ATLAS_BUILD_DATE）
    ├─ sha  = git --short=7（或 ATLAS_GIT_SHA，失败 unknown）
    └─ dirty = porcelain 非空（或 ATLAS_GIT_DIRTY=1）
    │
    v
rustc-env: ATLAS_VERSION / ATLAS_BUILD_DATE / ATLAS_GIT_REV
    │
    ├─ GET /api/version  →  { version, date, git }
    ├─ 前端 AppShell     →  显示 version
    └─ 机台 version 步骤 →  outputs.version = ATLAS_VERSION
```

中心与机台各有一份 `build.rs` 和 `version` 模块，规则相同，数值独立。

恒等式：`version === date + "." + git`。`git` 在脏时为 `<sha>-dirty`，例如 `d4279a7-dirty`。

## 5. 版本字符串

纯函数（Rust 单测，不调 git）：

```text
format_build_version(date, sha, dirty) ->
    dirty ? "{date}.{sha}-dirty" : "{date}.{sha}"
```

规则：

- `date` 必须是 `YYYY-MM-DD`。
- `sha` 为 7 位小写十六进制，或字面量 `unknown`。
- 无 git 仓库、`git` 不在 PATH、命令失败：`sha = unknown`，`dirty = false`，例如 `2026-08-16.unknown`。
- 覆盖测试用环境变量（`build.rs` 优先于探测）：
  - `ATLAS_BUILD_DATE`：日期
  - `ATLAS_GIT_SHA`：SHA（可为 `unknown`）
  - `ATLAS_GIT_DIRTY`：`1` 为脏，其它为不脏

## 6. API

两边新增（与现有 `GET /api/health` 并列，不改 health 文本）：

**GET** `/api/version`

```json
{
  "version": "2026-08-16.d4279a7",
  "date": "2026-08-16",
  "git": "d4279a7"
}
```

脏工作区示例：

```json
{
  "version": "2026-08-16.d4279a7-dirty",
  "date": "2026-08-16",
  "git": "d4279a7-dirty"
}
```

无鉴权。机台 `POST /api/general/version/run` 与序列步骤输出保持：

```json
{ "ok": true, "kind": "version", "version": "2026-08-16.d4279a7" }
```

`docs/api.md` 补上中心与机台的 `GET /api/version`，并改写 version 步骤「返回 CARGO_PKG_VERSION」的说明。

## 7. 前端

中心、机台 `AppShell` 品牌块现有两行（`ATLAS` + 副标题）。其下增加第三行：

- 内容：`version` 字段原文
- 字体：已有 IBM Plex Mono；字号小于副标题；颜色偏淡
- `title="编译版本"`
- 挂载时请求一次 `GET /api/version`；成功且 `version` 为非空字符串才渲染
- 网络失败、非 JSON、缺字段：不渲染该行，不 `message.error`

机台右侧「机台信息」「重新注册」不因本功能改位置。通用页「当前：」继续读试跑返回的 `version`。

## 8. 测试

- Rust：`format_build_version` 覆盖普通、`-dirty`、`unknown`。
- 机台：`run_read_version()` 的 `version` 等于 `ATLAS_VERSION` 常量。
- 前端：有 `version` 渲染文本；无数据不渲染。不测真实 git。
- `GET /api/version` 返回三字段且满足 `version === date + "." + git`。

## 9. 实现落点

| 仓库 | 新增/改动 |
|------|-----------|
| atlas-center | `build.rs`、`src/version.rs`、`GET /api/version`、AppShell、`docs/api.md` |
| atlas-station | 同上；`general.rs` 的 `agent_package_version` / `run_read_version` 改为编译版本 |

两边各自 `cargo build` 后版本才更新。只重编前端、不重编 Rust 时，顶栏仍显示当前二进制的版本。
