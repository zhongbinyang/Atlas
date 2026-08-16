# Design: 机台 Tauri 安装包与中心升级

**日期：** 2026-08-16  
**状态：** 已批准  
**范围：** atlas-station 用 Tauri 打成 Windows 当前用户安装包；升级包放在 atlas-center 所在服务器。中心继续用现有 Web，不包 Tauri。

与机台仓库同文：[atlas-station 2026-08-16-station-tauri-packaging-design](https://github.com/zhongbinyang/atlas-station/blob/master/docs/superpowers/specs/2026-08-16-station-tauri-packaging-design.md)。

## 1. 目标

产线电脑用普通账号安装机台程序，不弹 UAC。工程师把新包放到中心服务器后，操作员在机台上**主动检查**，下载完成后**提示重启**才换成新版本。开测中不能更新；空闲时也不自动更新。

成功标准：

- 普通 Windows 账号能装完并打开机台窗口，无需管理员。
- 装好后行为与现在一致：本机听 `9090`，中心仍轮询 `GET /api/status`，序列 / LabVIEW / 日志语义不变。
- 中心提供「当前应装的机台版本」和安装包下载。
- 机台只有操作员点「检查更新」才去中心比版本、下载。
- 开测中（Slot 忙或序列进行中）拒绝更新，说明等结束后再试。
- 空闲时不轮询、不后台下载、不自动替换进程。
- 下载成功后只提示「重启应用以完成更新」；点确定才退出并套用新包。
- 顶栏版本仍是编译期 `YYYY-MM-DD.<sha>`，与 `GET /api/version`、序列版本步骤同一串。

## 2. 非目标

- 不管 Windows 入站防火墙 / 9090 放行。
- 不做 SCCM / Intune / MSI / MSIX / 商店更新。
- 不做空闲自动升级、启动自动检查、定时轮询。
- 不做开测中热更新、不替换正在跑的进程。
- 中心不改成 Tauri。
- 不加鉴权、TLS、`/v1`。
- 不改序列 Pass/Fail、不恢复 SN/工单输入、不改设备/校验分表。
- 开发期 `cargo run` + 浏览器打开 `9090` 仍可用，不强制每次走安装包。

## 3. 已锁定决策

| 主题 | 选择 |
|------|------|
| 壳 | Tauri 2，窗口加载本机 UI；Axum 仍听 `AGENT_BIND`:`AGENT_PORT`（默认 `0.0.0.0:9090`） |
| 安装包 | NSIS `.exe`，**Current User**，目录 `%LOCALAPPDATA%`，不写 `Program Files` |
| 权限 | 安装和升级都不要求管理员 |
| 分发 | 只走中心服务器，不走公网、不用 IT 分发工具 |
| 谁发起更新 | 仅操作员点「检查更新」 |
| 开测中 | 不下载、不重启 |
| 空闲 | 不自动升级 |
| 套用时机 | 下载完成后提示重启；确认后退出进程，由安装程序静默覆盖再拉起 |
| 版本比较 | 与现有产品版本字符串全等比较：本地 `GET /api/version` 的 `version` vs 中心清单的 `version` |
| 入站规则 | 本设计不处理 |

未选方案：MSI + IT 静默装（没有统一分发）；Tauri 内置定时 updater（会在空闲/启动时自己查）；装到 Program Files（要管理员）。

## 4. 架构

```text
工程师打 NSIS 包
    │
    v
拷到中心机器目录（不进 git）
    releases/station/latest.json
    releases/station/atlas-station-<version>-setup.exe
    │
    v
atlas-center:9080
    GET /api/station-releases/latest
    GET /releases/station/<file>
    │
    │  仅当操作员点「检查更新」
    v
atlas-station（Tauri 窗口 + Axum :9090）
    本地 version === 清单 version ? 已是最新
    开测中 ? 拒绝
    否则下载 → 提示重启 → 确认后静默安装并拉起
```

开发：`cargo run` 仍起 Axum + `static/`，浏览器访问 `9090`。Tauri 是产线打包路径，不是唯一运行方式。

## 5. 安装包

- 工具：Tauri 2 bundler，目标 `nsis`，`installMode` = 当前用户。
- 产物：单文件 `atlas-station-<version>-setup.exe`，`<version>` 用编译期版本（如 `2026-08-16.d4279a7`），文件名里的点保持原样。
- 安装位置：`%LOCALAPPDATA%\Atlas\atlas-station\`（可执行文件、资源）。日志仍走现有 `AGENT_LOG_DIR` / 默认日志目录，不强制装到安装目录。
- 快捷方式：当前用户开始菜单；可选当前用户开机启动（第一期可以没有，不阻塞）。
- 升级安装：同一路径覆盖。NSIS 静默参数以 Tauri 当前用户包实际支持的为准（常见 `/S`），写进实现计划时对着打出来的包验证一次。
- 代码签名：局域网推荐签，但不作为第一期成功标准。未签名时 SmartScreen 可能提示，操作员选「仍要运行」即可。

## 6. 中心托管

安装包**不进 git**。中心进程读本机目录（环境变量 `ATLAS_STATION_RELEASE_DIR`，默认 `<center 工作目录>/releases/station`）。

**GET** `/api/station-releases/latest` · 使用方：**机台「检查更新」**

目录中有 `latest.json` 则原样返回 JSON；没有则 `404` `{ "error": "no station release" }`。无鉴权。

`latest.json` 形状：

```json
{
  "version": "2026-08-16.d4279a7",
  "date": "2026-08-16",
  "git": "d4279a7",
  "filename": "atlas-station-2026-08-16.d4279a7-setup.exe",
  "sha256": "<hex>"
}
```

恒等式与产品版本相同：`version === date + "." + git`。

**GET** `/releases/station/{filename}` · 使用方：**机台下载**

只允许文件名（无路径分隔符），从同一目录送文件。文件不存在 → `404`。

工程师发版：把新 exe 和改好的 `latest.json` 放进该目录，不必重启中心（实现用读盘，不缓存清单到内存；若实现时要缓存，文件变更后下次 GET 必须能读到新内容）。

`docs/api.md` 补上上述两条。不改历史 `docs/superpowers/*`。

## 7. 机台更新流程

入口：机台 Tauri 窗口顶栏右侧（「重新注册」旁）「检查更新」。不要启动时查，不要定时器。

1. 读本地 `GET /api/version`（本进程常量）。
2. 读中心 `GET {center_url}/api/station-releases/latest`。`center_url` 即现有 `AGENT_CENTER_URL`。
3. 中心 404 / 网络失败：提示「暂时无法检查更新」，不下载。
4. `latest.version === 本地 version`：提示「已是最新」。
5. 本机正在开测（与现有 `GET /api/status` 的 `busy` 或序列进行中同一判定）：提示「开测中，结束后再更新」，不下载、不重启。
6. 否则下载 `{center_url}/releases/station/{filename}` 到临时目录，校验 `sha256`。校验失败：删临时文件，提示失败，保持旧版。
7. 校验通过：对话框「已下载新版本 {version}，重启应用以完成更新」。取消则保留临时包、不重启、不替换当前进程。确定则退出 Tauri/Axum，静默跑安装包，再拉起新进程。

空闲且没人点按钮：零网络、零下载、零替换。

## 8. 进程与 UI

- Tauri 启动时拉起现有 Axum（同一进程或由 Tauri 侧 `setup` 调现有 `main` 逻辑）。窗口打开 `http://127.0.0.1:{port}/`（或等价本地地址），不要改成纯 IPC 替代 HTTP。
- 对外仍 `0.0.0.0:9090`（可用环境变量改），中心 poller 不变。
- 「检查更新」只出现在 Tauri 窗口。浏览器开发模式可以没有该按钮。
- 顶栏版本显示仍按 `2026-08-16-build-version-design.md`，不另做关于页。

## 9. 测试

- 中心：无目录 / 无 `latest.json` → `404`；有合法 JSON → 200 且 `version === date + "." + git`；`filename` 含 `..` 或路径分隔符 → 拒绝。
- 机台更新状态机（纯函数，不打真实包）：已是最新 / 开测中拒绝 / 清单失败 / 校验失败 / 下载成功待重启。
- 不在 CI 打真实 NSIS（除非实现时加可选 job）。人工：普通账号安装、开测中点更新被拒、空闲不点则无下载、下完取消仍是旧版、确定后版本字符串变成清单值。

## 10. 实现落点

| 仓库 | 内容 |
|------|------|
| atlas-station | Tauri 工程、NSIS 当前用户、检查更新 UI、下载与重启套用、状态机测试 |
| atlas-center | `latest.json` + 文件下载路由、`docs/api.md`、`ATLAS_STATION_RELEASE_DIR` |

第一期只打 `windows-x86_64`。
