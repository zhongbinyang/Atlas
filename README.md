# ATLAS 测试机台编排系统

Rust 工作区（拆仓前仍在同一仓库）：**atlas-center**（端口 **9080**）与 Windows **atlas-station**（端口 **9090**）。中心用 PostgreSQL（默认 `127.0.0.1:5432/atlas`）保存机台、VI/通用功能模板与序列模板，轮询机台状态。两端均提供中文 WebUI 与 REST API。HTTP 接口汇总见 [docs/api.md](docs/api.md)。

WebUI 统一为 **Vite + React + Ant Design + ECharts**（两端源码独立）：中心 hash 路由 **机台** / **机台详情** / **已注册功能** / **序列模板** / **Spec 模板** / **单位**；Agent hash 路由 **VI** / **通用** / **REST** / **序列** / **配置**。顶栏品牌为 **ATLAS**。中心 **Spec 模板** 页（`#/specs`）可上传 legacy `*_Spec.ini` 为产品限值模板库，序列步骤可引用模板 section 自动生成 Pass/Fail 规则。

## 前端开发（React）

源码位于 `frontend/scheduler` 与 `frontend/agent`（互相独立，技术栈均为 Vite + React + TypeScript + Ant Design + ECharts）。

```powershell
cd frontend/scheduler
npm install
npm run dev    # http://127.0.0.1:5173，代理 /api -> 9080

cd frontend/agent
npm install
npm run dev    # http://127.0.0.1:5174，代理 /api -> 9090
```

发布前构建并同步到 Rust 静态目录：

```powershell
.\scripts\build-frontend.ps1
cargo build -p scheduler
cargo build -p agent
```

## 安全提示

**无鉴权。** 全部 HTTP API 与 WebUI 均对外开放。请仅部署在可信内网，或自行做好网络访问控制。**不要**把这些端口暴露到公网。

## 本地 PostgreSQL（Docker）

仓库根目录提供 `docker-compose.yml`，可在本机起一份 `atlas` 库，并从远程（默认 `10.102.30.18`）复制数据：

```powershell
docker compose up -d postgres
.\scripts\sync-atlas-db.ps1
$env:SCHEDULER_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable"
cargo run -p scheduler
```

本地连接串：`postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable`（用户/密码/库名与远程默认一致）。

## 平台支持


| 组件 | 平台 |
|------|------|
| 调度中心 | 跨平台（在 Windows 上验证） |
| Agent | **仅 Windows** — LabVIEW CLI / 序列 / REST / Delay 在本机执行 |

## 端口

| 服务 | 默认端口 | WebUI / API |
|------|----------|-------------|
| atlas-center | 9080 | `http://127.0.0.1:9080` |
| atlas-station | 9090 | `http://127.0.0.1:9090` |

## 环境变量

### 调度中心

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCHEDULER_BIND` | `0.0.0.0` | 监听地址 |
| `SCHEDULER_PORT` | `9080` | 监听端口 |
| `SCHEDULER_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable` | PostgreSQL 连接串 |
| `SCHEDULER_POLL_STATUS_INTERVAL_SECS` | `5` | Agent 状态巡检间隔（秒） |

可选：设置 `RUST_LOG=info`（或 `debug`）过滤调度中心控制台日志级别。

### Agent

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_CENTER_URL` | *（必填）* | 调度中心根地址，例如 `http://127.0.0.1:9080` |
| `AGENT_BIND` | `0.0.0.0` | 监听地址 |
| `AGENT_PORT` | `9090` | 监听端口 |
| `AGENT_ADVERTISE_IP` | 自动探测（优先：连向中心的出口网卡 IP；排除 Mihomo `198.18/15` 等虚拟地址） | 向调度中心注册的 IP；探测不准时可手动指定 |
| `AGENT_HOSTNAME` | 系统计算机名 | 向调度中心注册的电脑名称 |
| `AGENT_LOG_DIR` | `%LOCALAPPDATA%\atlas-agent\logs` | Agent 日志根目录（**不写控制台**）；见下方布局 |
| `AGENT_LABVIEW_CLI` | `C:\labview-runner-cli\labview-runner-cli.exe` | LabVIEW 试跑 CLI 可执行文件路径 |
| `AGENT_LABVIEW_GETINFO_VI` | `C:\labview-runner-cli\getinfo.vi` | LabVIEW inspect 用的 getinfo VI 路径 |

Agent 日志布局（`AGENT_LOG_DIR`）：

```
{AGENT_LOG_DIR}/
  agent-YYYY-MM-DD.log              # 通用 tracing（默认 info+；RUST_LOG 可过滤）
  sequence_runs/YYYY-MM-DD/*.json    # 每次序列结束一份 JSON 结果
```

`finished_at` 字段为本地时间秒级（如 `2026-07-30 19:20:45`）。文件名仍用紧凑 UTC 时间戳。
可选：调度中心侧设置 `RUST_LOG=info`（或 `debug`）开启**中心**控制台日志。Agent 业务日志不写控制台。

## LabVIEW VI 模板

### 前置条件

- **仅 Agent 机台**安装 LabVIEW 与外部工具 **`labview-runner-cli`**（安装与用法见 [`C:\Users\zhong\test06\README.md`](file:///C:/Users/zhong/test06/README.md)）。
- 将 `labview-runner-cli.exe` 与 `getinfo.vi` 部署到 Agent 本机（默认目录 `C:\labview-runner-cli\`），或通过 `AGENT_LABVIEW_CLI` / `AGENT_LABVIEW_GETINFO_VI` 覆盖路径。
- 调度中心 **不** 在本机调用 LabVIEW；VI **注册 / inspect / 试跑** 仅在 Agent WebUI；中心 `#/functions` 可浏览并 **删除** 已注册模板（无修改），`#/sequences` 可浏览并删除序列模板。

### 工作流

1. **查询参数（inspect）**：对目标 VI 绝对路径调用 `labview-runner-cli --action inspect`，返回 inputs/outputs JSON；在 WebUI 表格中编辑各参数的默认 `value`（`name` / `className` 只读）。
2. **试跑（run）**：用当前 inputs 同步执行 `--action run`，返回 outputs JSON；可选「显示前面板」与 CLI `--timeout`（秒）。
3. **注册**：**仅在 Agent WebUI** 填写 **显示名称**（必填），将 VI 路径、inputs/outputs、前面板/超时选项及 **注册时刻的 CLI/getinfo 路径快照** 写入中心 PostgreSQL 表 `vi_templates`，由数据库分配 **自增 ID**，并记录 **来源机台**（`origin_agent_id`）与 **类型**（`kind`：通常 `labview`）。若已存在 **同名且入参相同** 的模板则拒绝注册（HTTP 409）。同一 Agent 可注册同路径但不同名称/入参的多条记录。中心 WebUI **不提供** VI 登记 / inspect / 试跑表单。
4. **通用功能**：Agent 顶栏「**通用**」页可配置 **延迟毫秒**、试跑（本机 sleep）并 **注册到中心**（写入 `general_templates`，与 VI 分表）；可与 VI 一并加入序列按序执行。中心「已注册功能」分 **VI** / **通用** 两组展示。
5. **REST**：Agent「**API**」页可配置并试跑 REST 请求，注册到中心后亦可加入序列。

### 已注册列表（中心一份）

1. **Agent**：在「VI」工作台 **注册到中心** 后，「**中心 VI 功能**」列表出现该项；可 **试跑**、**重命名**、**加载到编辑区**；入参列悬停查看完整 JSON。无「本机已注册」副本列表。「通用」页同理维护「中心通用功能」。
2. **调度中心**：顶栏「**已注册功能**」（`#/functions`）；VI 与通用分栏；列含 **ID**、**类型**、**来源机台**、路径/入参；支持 **删除**（无中心侧修改/注册/试跑）。模板的 PATCH API 仍可供 Agent 调用。
3. **同路径多份**：同一 VI 路径可在同一或不同机台重复注册，每条记录拥有独立 `id` / 显示名称；**不会** 按路径合并覆盖。

### 执行序列（Agent）

1. **Agent「序列」页**：左「**中心全部功能**」（可搜索名称/ID/机台，按 LabVIEW/通用筛选）→ 右「**执行顺序**」（同一模板可重复加入；支持拖拽与上下移动排序）。
2. **队列存中心**：每机台一份有序队列（`vi_run_queue_items`）；步骤可引用 `vi_template_id` 或 `general_template_id`；每步可覆盖 **入参**（`inputs_json`）；增删改序 / 改元数据后自动 `PUT` 保存。
3. **步骤元数据**（随队列持久化）：`enabled`（未勾选则跳过）、`fail_policy`（`stop` 遇 Fail/Error 即停 / `continue` 继续后续步）、`limits`（JSON 数组，每步 Spec；支持 range / eq / ne / in）、`inputs`（步骤级入参覆盖）。历史字段 `breakpoint` 仍可出现在 PUT 中，但会被忽略并落库为 `false`。
4. **主表与详情**：主表列含 `# / 启用 / 名称 / 类型 / 结果 / 值 / 下限 / 上限 / 单位 / 操作`；点「**详情**」展开编辑入参 / Spec / Fail 策略，并查看实测与原始返回 JSON。
5. **按序执行**：`POST /api/sequence/run` 可选 body `{ "sn", "work_order", "sequence_template_id", "channel_indexes" }`；开始时清空结果，执行中可轮询 `GET /api/sequence/run/progress` 按步刷新。遇 Fail/Error 且 `fail_policy=stop` 或 CLI 失败即停；与 Delay/REST 试跑共用 busy 槽，忙碌时返回 409。序列一次性跑完，不再支持断点暂停。
6. **中止**：保留 `POST /api/sequence/run/abort`；`POST /api/sequence/run/continue` 已移除（410 Gone）。WebUI 顶部状态区集中提供通道选择、开始/中止与总体结果；SN/工单当前不在 WebUI 展示或提交，API 字段仍保留兼容性。
7. **序列模板**：Agent 可将当前队列 **保存为模板**（中心表 `sequence_templates` + `sequence_template_steps`），或从「中心序列模板」**加载到当前队列**。中心 `#/sequences` 可浏览并 **删除** 模板（不再提供「加载到机台」）。
8. **运行结果**：不落库「最近一次结果」；运行页始终按所选通道展示固定卡片，卡片实时显示当前步骤、完成统计、当前步耗时和通道总耗时。点击整张卡片进入对应通道详情，按原队列顺序以具名组分区展示步骤；组头汇总组状态及完成/通过/失败/跳过计数，轮询刷新时保留各组和步骤的展开状态及摘要焦点。详情仍可查看每步状态、实测/Spec、输入输出、原始 JSON 和实际耗时。详细结果（含毫秒耗时）写入 Agent 日志文件（见 `AGENT_LOG_DIR` / `sequence_runs`）。通用 tracing 写入按日 `agent-YYYY-MM-DD.log`，**不输出到控制台**。

### WebUI 入口

| 位置 | 路由 / 分区 | 说明 |
|------|-------------|------|
| atlas-station WebUI（`:9090`） | VI / **通用** / **API** / **序列** / **配置** | VI 工作台；通用；REST；序列；本机台单位与变量 |
| atlas-center WebUI（`:9080`） | `#/machines` | **机台** 卡片网格；点击卡片进入 Agent 详情 |
| atlas-center WebUI | `#/agents/{id}` | Agent **详情**：状态概览（无截图 / 历史 / 文件） |
| atlas-center WebUI | `#/functions` | **已注册功能**：VI + 通用分栏；按 **来源机台** 筛选；**删除** |
| atlas-center WebUI | `#/sequences` | **序列模板**：浏览步骤数/来源机台；**删除** |
| atlas-center WebUI | `#/specs` | **Spec 模板**：上传 `*_Spec.ini`、预览 section/指标、**删除** |

VI 路径请 **手填或粘贴绝对路径**（不使用浏览器文件选择器作为路径来源）。Agent 注册到中心后（启动自动注册或点击「重新注册」）方可成功「注册到中心」。

**已移除**：桌面截图 / 截图历史 / 文件浏览；中心「作业」与 Shell 任务下发；Agent Shell `cmd` 任务 API；中心已注册功能的「修改」按钮。

### 相关 API（摘要）

- Agent：`GET /api/labview/config`，`POST /api/labview/inspect|run`，`POST /api/labview/register-template`（必填 `name`；服务端代写中心 `POST /api/vi-templates`），`PATCH /api/labview/templates/{id}`，`GET /api/labview/all-templates`，`GET /api/general/all-templates`，`GET/PUT /api/sequence/run-queue`，`POST /api/sequence/run`（可选 `sn`/`work_order`/`sequence_template_id`），`GET /api/sequence/run/progress`，`POST /api/sequence/run/abort`，`GET/POST /api/sequence-templates`，`POST /api/sequence-templates/{id}/load`，`GET/PUT /api/settings`，`POST /api/slot/force-release`。
- 中心：`GET/POST/PATCH/DELETE /api/vi-templates`，`GET/POST/DELETE /api/general-templates`，`GET/POST /api/sequence-templates`，`GET/DELETE /api/sequence-templates/{id}`，`POST /api/sequence-templates/{id}/load-to-agent`（供 Agent 代理加载；中心 WebUI 不再暴露），`GET/PUT /api/agents/{id}/run-queue`，`GET/PUT /api/agents/{id}/settings`。

CLI / getinfo / VI 文件不存在或 Agent 离线时，API 返回明确 4xx/5xx 错误（见设计规格 `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`）。

## 运行

先构建一次：

```powershell
cargo build --release
```

**终端 A — 调度中心：**

```powershell
$env:SCHEDULER_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable"
cargo run --release -p scheduler
```

浏览器打开 `http://127.0.0.1:9080` 进入 atlas-center WebUI。

**终端 B — Agent（Windows）：**

```powershell
$env:AGENT_CENTER_URL = "http://127.0.0.1:9080"
cargo run --release -p agent
```

浏览器打开 `http://127.0.0.1:9090` 进入 atlas-station WebUI。

## 手工联调清单

1. **调度中心启动**：监听 `:9080`；`GET http://127.0.0.1:9080/` 返回 WebUI（200）；默认 `#/machines` 显示机台卡片。
2. **Agent 注册**：约 5 秒内，`GET http://127.0.0.1:9080/api/agents` 可见该 Agent 为 `online`，并带有 CPU、内存占用百分比；卡片与详情页状态一致。
3. **机台卡片 → 详情**：点击卡片进入 `#/agents/{id}`；仅状态概览；**返回机台** 回到卡片网格。
4. **已注册功能页**：打开 `#/functions`；按机台筛选；查看 VI / 通用分栏、名称/**来源机台**/路径/入参；可 **删除** 模板（无修改）。
5. **序列模板页**：打开 `#/sequences`；可见已保存序列模板；可 **删除**。
6. **LabVIEW VI（需本机 LabVIEW + labview-runner-cli）**：
   - Agent：对 `Add.vi`（或任意测试 VI）执行 **查询参数** → 编辑 inputs → **试跑** → **注册到中心**；「中心 VI 功能」出现该项且可试跑；入参列可悬停查看。
   - 中心 `#/functions`：模板表可见刚注册项，**来源机台** 为注册 Agent。
   - Agent「序列编排」：可搜索/筛选中心功能，添加到本机队列并编辑步骤详情（入参/Spec/Fail）；「序列运行」顶部选择通道，运行前即显示固定通道卡片，点击卡片查看该通道的完整步骤与耗时；可 **保存为模板** 并在中心 `#/sequences` 看到。
   - 覆盖 `AGENT_LABVIEW_CLI` / `AGENT_LABVIEW_GETINFO_VI` 后重启 Agent，`GET /api/labview/config` 与 WebUI 只读路径应反映新值。

## 测试

```powershell
cargo test --workspace
# 或分包：
cargo test -p agent
cargo test -p scheduler
```

自动化测试使用 mock/fake CLI，**不** 依赖本机 LabVIEW；需硬件或真实 CLI 的用例标有 `#[ignore]` 或仅作手工验收。

## 目录结构

```
crates/
  common/     共享类型与 API 模型
  scheduler/  调度中心服务 + WebUI
  agent/      Windows 执行节点 + WebUI
```
