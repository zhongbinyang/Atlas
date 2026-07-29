# ATLAS 光模块测试监控系统

Rust 工作区：**ATLAS 中心**（端口 **26630**）与 Windows **测试机台 Agent**（端口 **26631**）。中心用 PostgreSQL（默认 `10.102.30.18/atlas`）保存机台、VI 模板与任务，轮询 Agent 状态。两端均提供中文 WebUI 与 REST API。

WebUI 采用「光纤仪表面板」壳层（冷钢灰 + 激光青强调，Space Grotesk 品牌字）：中心 hash 路由 **机台卡片** / **机台详情** / **已注册功能**；Agent 为紧凑状态条 + VI / 序列工作台。两端共享 CSS 设计令牌（`static_tokens` 锁定 `:root`）。

## 安全提示

**无鉴权。** 全部 HTTP API 与 WebUI 均对外开放。请仅部署在可信内网，或自行做好网络访问控制。**不要**把这些端口暴露到公网。

## 平台支持

| 组件 | 平台 |
|------|------|
| 调度中心 | 跨平台（在 Windows 上验证） |
| Agent | **仅 Windows** — 通过 `cmd` / `powershell` 执行任务 |

## 端口

| 服务 | 默认端口 | WebUI / API 地址 |
|------|----------|------------------|
| 调度中心 | 26630 | `http://127.0.0.1:26630` |
| Agent | 26631 | `http://127.0.0.1:26631` |

## 环境变量

### 调度中心

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCHEDULER_BIND` | `0.0.0.0` | 监听地址 |
| `SCHEDULER_PORT` | `26630` | 监听端口 |
| `SCHEDULER_DATABASE_URL` | `postgres://postgres:postgres@10.102.30.18:5432/atlas?sslmode=disable` | PostgreSQL 连接串 |
| `SCHEDULER_SCREENSHOT_DIR` | `data/screenshots` | 截图归档根目录 |
| `SCHEDULER_POLL_STATUS_INTERVAL_SECS` | `5` | Agent 状态巡检间隔（秒） |
| `SCHEDULER_POLL_TASK_INTERVAL_SECS` | `1` | 任务下发 / 结果轮询间隔（秒） |

可选：设置 `RUST_LOG=info`（或 `debug`）开启日志。

### Agent

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_CENTER_URL` | *（必填）* | 调度中心根地址，例如 `http://127.0.0.1:26630` |
| `AGENT_BIND` | `0.0.0.0` | 监听地址 |
| `AGENT_PORT` | `26631` | 监听端口 |
| `AGENT_ADVERTISE_IP` | 自动探测（优先：连向中心的出口网卡 IP；排除 Mihomo `198.18/15` 等虚拟地址） | 向调度中心注册的 IP；探测不准时可手动指定 |
| `AGENT_HOSTNAME` | 系统计算机名 | 向调度中心注册的电脑名称 |
| `AGENT_FILES_ROOT` | *（可选）* | 只读文件浏览根目录（绝对路径推荐）；未配置或无效时文件 API 返回 503 |
| `AGENT_LABVIEW_CLI` | `C:\labview-runner-cli\labview-runner-cli.exe` | LabVIEW 试跑 CLI 可执行文件路径 |
| `AGENT_LABVIEW_GETINFO_VI` | `C:\labview-runner-cli\getinfo.vi` | LabVIEW inspect 用的 getinfo VI 路径 |

## LabVIEW VI 模板

### 前置条件

- **仅 Agent 机台**安装 LabVIEW 与外部工具 **`labview-runner-cli`**（安装与用法见 [`C:\Users\zhong\test06\README.md`](file:///C:/Users/zhong/test06/README.md)）。
- 将 `labview-runner-cli.exe` 与 `getinfo.vi` 部署到 Agent 本机（默认目录 `C:\labview-runner-cli\`），或通过 `AGENT_LABVIEW_CLI` / `AGENT_LABVIEW_GETINFO_VI` 覆盖路径。
- 调度中心 **不** 在本机调用 LabVIEW；VI **注册 / inspect / 试跑** 仅在 Agent WebUI；中心 `#/functions` 仅管理已注册模板（重命名 / 分发 / 删除）。

### 工作流

1. **查询参数（inspect）**：对目标 VI 绝对路径调用 `labview-runner-cli --action inspect`，返回 inputs/outputs JSON；在 WebUI 表格中编辑各参数的默认 `value`（`name` / `className` 只读）。
2. **试跑（run）**：用当前 inputs 同步执行 `--action run`，返回 outputs JSON；可选「显示前面板」与 CLI `--timeout`（秒）。
3. **注册**：**仅在 Agent WebUI** 填写 **显示名称**（必填），将 VI 路径、inputs、前面板/超时选项及 **注册时刻的 CLI/getinfo 路径快照** 写入中心 PostgreSQL 表 `vi_templates`，由数据库分配 **自增 ID**，并记录 **来源机台**（`origin_agent_id`）与 **类型**（`kind`：`labview` / `delay`）。若已存在 **同名且入参相同** 的模板则拒绝注册（HTTP 409）。同一 Agent 可注册同路径但不同名称/入参的多条记录。中心 WebUI **不提供** VI 登记 / inspect / 试跑表单。
4. **通用·延迟**：Agent 顶栏「**通用**」页可配置 **延迟毫秒**、试跑（本机 sleep）并 **注册到中心**；可与 VI 一并加入序列按序执行。
5. **下发（API）**：`POST /api/vi-templates/{id}/dispatch` 仍可将模板拼成 `cmd` 入队 Shell 任务队列；中心 WebUI **不再暴露**「作业」界面，任务结果请通过 API 或 Agent 侧查看。

### 已注册列表（中心一份）

1. **Agent**：在「VI」工作台 **注册到中心** 后，「**中心全部功能**」列表出现该 VI；可 **试跑**、**重命名**、**加载到编辑区**；入参列悬停查看完整 JSON。无「本机已注册」副本列表。
2. **调度中心**：顶栏「**已注册功能**」（`#/functions`）；列含 **ID**、**类型**、**来源机台**、VI 路径、入参、超时；支持 **修改（重命名）**、**删除**（无中心侧注册/试跑）。
3. **同路径多份**：同一 VI 路径可在同一或不同机台重复注册，每条记录拥有独立 `id` / 显示名称；**不会** 按路径合并覆盖。

### 执行序列（Agent）

1. **Agent「序列」页**：左「**中心全部功能**」→ 右「选定」（同一模板可重复加入；支持拖拽与上下移动排序）。
2. **队列存中心**：每机台一份有序队列（`vi_run_queue_items`）；可选用任意中心模板；增删改序后自动 `PUT` 保存。
3. **步骤元数据**（随队列持久化）：`enabled`（未勾选则跳过）、`breakpoint`（执行**前**暂停）、`fail_policy`（`stop` 遇 Fail/Error 即停 / `continue` 继续后续步）、`limits`（JSON 数组，每步 Spec 上下限；API 字段名 `limits`，库表 `limits_json`）。
4. **按序执行**：`POST /api/labview/run-sequence` 可选 body `{ "sn", "work_order" }`；Agent 串行执行已启用步骤，每步后按 limits 判定 Pass/Fail；某步 outputs 含 `SN`/`sn` 时更新本次运行的序列号（body 未填 SN 时亦可解析）。遇 Fail/Error 且 `fail_policy=stop` 或 CLI 失败即停；与 shell 任务共用 busy 槽，忙碌时返回 409。
5. **断点续跑**：步骤设 `breakpoint` 时响应含 `pause`；`POST /api/labview/run-sequence/continue` 继续、`/abort` 中止（无活跃会话时 409）。WebUI 运行栏提供 SN/工单、开始/继续/中止与总体结果。
6. **阶段 1 限制**：暂停期间可 **中止**；**无法** 取消正在执行的 continue / LabVIEW 步骤。断点会话仅存于 Agent 内存，**Agent 重启后会丢失**。

### WebUI 入口

| 位置 | 路由 / 分区 | 说明 |
|------|-------------|------|
| Agent WebUI（`:26631`） | VI / **通用** / **序列** | VI 工作台；**通用·延迟**（试跑/注册）；**序列** 混排 VI 与延迟 |
| ATLAS 中心 WebUI（`:26630`） | `#/machines` | **机台** 卡片网格；点击卡片进入 Agent 详情 |
| ATLAS 中心 WebUI | `#/agents/{id}` | Agent **详情**：状态概览 + **截图** / **历史** / **文件** |
| ATLAS 中心 WebUI | `#/functions` | **已注册功能**：按 **来源机台** 筛选；**ID / 类型** + 入参悬停；**修改** / **删除** |

VI 路径请 **手填或粘贴绝对路径**（不使用浏览器文件选择器作为路径来源）。Agent 注册到中心后（启动自动注册或点击「重新注册」）方可成功「注册到中心」。Shell 任务 API 仍存在，但中心 WebUI **不再提供**「作业」界面。

### 相关 API（摘要）

- Agent：`GET /api/labview/config`，`POST /api/labview/inspect|run`，`POST /api/labview/register-template`（必填 `name`；服务端代写中心 `POST /api/vi-templates`），`PATCH /api/labview/templates/{id}`（重命名等，代理中心 `PATCH`），`GET /api/labview/all-templates`（中心全量，工作台与序列共用），`GET/PUT /api/labview/run-queue`（代理中心队列；项含 `enabled`/`breakpoint`/`fail_policy`/`limits`），`POST /api/labview/run-sequence`（可选 `sn`/`work_order`；串行执行、逐步判定），`POST /api/labview/run-sequence/continue|abort`（断点续跑/中止）。
- 中心：`POST /api/agents/{id}/labview/inspect|run`，`GET/POST/PATCH/DELETE /api/vi-templates`（注册 `name` 必填；列表 `?agent_id=` 按 **来源机台** 筛选），`POST /api/vi-templates/{id}/distribute`（API 仍可用；WebUI 不再暴露），`POST /api/vi-templates/{id}/dispatch`（任务队列下发），`GET/PUT /api/agents/{id}/vi-run-queue`（每机有序队列）。

CLI / getinfo / VI 文件不存在或 Agent 离线时，API 返回明确 4xx/5xx 错误（见设计规格 `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`）。

## 运行

先构建一次：

```powershell
cargo build --release
```

**终端 A — 调度中心：**

```powershell
$env:SCHEDULER_DATABASE_URL = "postgres://postgres:postgres@10.102.30.18:5432/atlas?sslmode=disable"
cargo run --release -p scheduler
```

浏览器打开 `http://127.0.0.1:26630` 进入 ATLAS 中心 WebUI。

**终端 B — Agent（Windows）：**

```powershell
$env:AGENT_CENTER_URL = "http://127.0.0.1:26630"
cargo run --release -p agent
```

浏览器打开 `http://127.0.0.1:26631` 进入 Agent WebUI。

## 调度行为

调度中心在每个调度周期内，对同一 Agent **最多下发一条**排队任务。排队任务按 **FIFO**（`created_at` 升序）处理。Agent 忙碌时，后续任务保持 `queued`；若直接向 Agent 提交第二条任务，Agent 会返回 HTTP 409。

**执行中途 Agent 重启：** 若任务处于 `dispatched` 或 `running` 时 Agent 重启，调度中心恢复时可能在 Agent 侧找不到该任务（例如 HTTP 404 或其他非成功响应）。中心任务会被重新入队，之后可能再次执行。对有副作用或耗时较长的命令请按此风险设计。

## 桌面截图

ATLAS 中心 WebUI 的 Agent **详情页**（`#/agents/{id}`）提供 **截图** / **历史** 操作：

- **截图**：调度中心代理请求在线 Agent 的 `GET /api/screenshot`，捕获成功后归档并弹窗预览 PNG。
- **历史**：分页查看该 Agent 已归档截图（时间、大小、查看）。

**捕获范围：** Agent 仅截取 **主显示器**（primary monitor）；多显示器环境下非主屏内容不会出现在截图中。

**代理与存储：** 截图由调度中心代为调用 Agent，PNG 永久保存在 `data/screenshots/{agent_id}/{id}.png`（可用环境变量 `SCHEDULER_SCREENSHOT_DIR` 更改根目录）。元数据写入 PostgreSQL `screenshots` 表。单张图片上限 20 MiB；非 PNG 或 Agent 不可达时返回相应错误（502/503/404）。

**磁盘风险：** 截图文件 **不会自动清理**，`data/screenshots/` 目录会随使用 **持续增长**，请自行定期删除旧文件或迁移存储。

**安全：** 截图 API 与 WebUI 同样 **无鉴权**（见上文「安全提示」），请勿在不可信网络暴露。

## 文件浏览

ATLAS 中心 WebUI 的 Agent **详情页**提供 **文件** 操作，只读浏览 Agent 配置根目录下的文件树：

- **列表与导航**：面包屑进入子目录；目录行可 **打开**，文件名与大小列于表格。
- **预览与下载**：仅 **`.txt`**、**`.gif`**（扩展名大小写不敏感）支持 **预览** 与 **下载**；其它扩展名仅列名，无内容操作。
- **代理与存储：** 请求由调度中心代理转发至在线 Agent 的 `GET /api/files` 与 `GET /api/files/content`；**中心不落盘**，内容不经中心数据库归档。
- **根目录：** Agent 需设置环境变量 **`AGENT_FILES_ROOT`** 指向存在的本地目录；未配置或路径无效时 Agent 返回 503，中心 WebUI 提示错误。
- **大小限制：** 单文件读取上限 **20 MiB**；超出或非 txt/gif 扩展名返回相应错误（413/403 等）。
- **路径安全：** 相对路径不可逃逸出 `AGENT_FILES_ROOT`（规范化 + canonicalize 校验）。

**安全：** 文件 API 与 WebUI 同样 **无鉴权**（见上文「安全提示」），请勿在不可信网络暴露。

## 手工联调清单

1. **调度中心启动**：监听 `:26630`；`GET http://127.0.0.1:26630/` 返回 WebUI（200）；默认 `#/machines` 显示机台卡片。
2. **Agent 注册**：约 5 秒内，`GET http://127.0.0.1:26630/api/agents` 可见该 Agent 为 `online`，并带有 CPU、内存占用百分比；卡片与详情页状态一致。
3. **机台卡片 → 详情**：点击卡片进入 `#/agents/{id}`；**返回机台** 回到卡片网格。
4. **桌面截图**：在 Agent 详情点击 **截图**，弹窗显示主屏 PNG；点击 **历史** 可浏览已归档记录。
5. **文件浏览**：将 Agent 的 `AGENT_FILES_ROOT` 指向样例结果目录；在 Agent 详情点击 **文件**，浏览根下 `Log.txt` 与进入 `EyeDiagram/35` 预览 `CH1.gif`，并验证下载。
6. **已注册功能页**：打开 `#/functions`；按机台筛选；查看名称/**来源机台**/路径/入参；可 **修改** 名称、**删除** 模板。
7. **LabVIEW VI（需本机 LabVIEW + labview-runner-cli）**：
   - Agent：对 `Add.vi`（或任意测试 VI）执行 **查询参数** → 编辑 inputs → **试跑** → **注册到中心**；「中心全部功能」出现该项且可试跑；入参列可悬停查看。
   - 中心 `#/functions`：模板表可见刚注册项，**来源机台** 为注册 Agent。
   - Agent「序列」：左侧为中心全部功能，可添加其他机台注册的模板到本机队列并按序执行（本机须能访问对应 VI 路径）。
   - 覆盖 `AGENT_LABVIEW_CLI` / `AGENT_LABVIEW_GETINFO_VI` 后重启 Agent，`GET /api/labview/config` 与 WebUI 只读路径应反映新值。
8. **Shell 任务（API 仅）**：中心 WebUI 无「作业」界面；如需验证队列，使用 `POST /api/templates`、`POST /api/tasks` 等 API（见设计规格）。

## 测试

```powershell
cargo test --workspace
# 或分包：
cargo test -p agent
cargo test -p scheduler
```

自动化测试使用 mock/fake CLI，**不** 依赖本机 LabVIEW；需硬件或真实 CLI 的用例标有 `#[ignore]` 或仅作手工验收（见上文第 7 项）。

## 目录结构

```
crates/
  common/     共享类型与 API 模型
  scheduler/  调度中心服务 + WebUI
  agent/      Windows 执行节点 + WebUI
```
