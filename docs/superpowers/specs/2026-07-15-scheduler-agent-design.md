# 调度中心与 Agent 服务设计规格

**日期：** 2026-07-15  
**状态：** 已批准（待实现计划）  
**技术栈：** Rust（Cargo workspace）、Axum、SQLite、Windows Agent  

## 1. 目标

构建两套可独立部署的单体服务：

1. **调度中心（scheduler）** — RESTful API + WebUI，端口 `26630`，SQLite 持久化；管理 Agent、任务模板与任务调度。
2. **Agent 服务（agent）** — RESTful API + WebUI，默认端口 `26631`；部署在产线 Windows 电脑上，向中心注册（电脑名 + IP），提供 CPU/内存状态，接收并串行执行任务。

成功标准：

- Agent 能自动注册到中心，中心看板可见在线状态、CPU 利用率、内存占用率。
- 用户可通过中心用**任务模板**或**临时命令**向指定 Agent 下发任务，查看终态与 stdout/stderr。
- 同一 Agent 任一时刻只执行一个任务；其余任务在中心排队。

## 2. 非目标（YAGNI）

- 身份鉴权 / TLS（假定可信内网；部署时自行限制绑定地址）
- Agent 多任务并发
- 指标历史曲线与长期时序库
- 跨 Agent 工作流编排、依赖图
- Linux Agent、macOS Agent
- 复杂重试策略（无限退避、死信队列 UI 等）

## 3. 架构

### 3.1 Workspace 结构

```text
Cargo.toml                    # workspace
crates/common/                # 共享 DTO、任务状态枚举、错误结构
crates/scheduler/             # 调度中心二进制
crates/agent/                 # Agent 二进制
```

### 3.2 通信模型

中心**主动**调用 Agent HTTP API（推送任务 / 拉取状态）。Agent 启动时主动向中心注册一次（及可选周期性续期）。

```text
[操作者 WebUI/API] --> scheduler:26630
                           |
                           | HTTP REST (注册 IP:26631)
                           v
                      agent:26631  <--> 本机子进程 / sysinfo
```

### 3.3 进程内分层

两端均采用单体分层，职责清晰：

| 层 | scheduler | agent |
|----|-----------|-------|
| `api` | REST 路由 | REST 路由 |
| `service` | registry / dispatcher / templates | register / executor / metrics |
| `store` | SQLite (SQLx) | 内存任务槽 + 近期结果缓存 |
| `web` | 嵌入静态前端 | 嵌入静态前端 |

`common` 提供双方共用的请求/响应类型与任务状态，避免协议漂移。

### 3.4 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| HTTP | Axum | 生态成熟，与 async Rust 契合 |
| DB | SQLx + SQLite | 单体部署、零外部依赖 |
| 指标 | sysinfo | Windows CPU/内存 |
| 前端 | 内嵌静态 HTML + fetch | 与 API 同端口，无独立前端构建链要求 |

## 4. 数据模型

### 4.1 调度中心 SQLite

**agents**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 电脑名称 |
| ip | TEXT | 可达 IP |
| port | INTEGER | 默认 26631 |
| status | TEXT | `online` / `offline` |
| cpu_percent | REAL | 最新快照 |
| memory_percent | REAL | 最新快照 |
| last_seen_at | TEXT | ISO-8601 |
| created_at | TEXT | ISO-8601 |

唯一性：以 `(name, ip, port)` upsert；同一物理机重复注册更新既有行。

**task_templates**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 模板名 |
| shell | TEXT | `cmd` 或 `powershell` |
| command | TEXT | 命令正文 |
| workdir | TEXT NULL | 工作目录 |
| timeout_secs | INTEGER | 默认 300 |
| created_at | TEXT | |

**tasks**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 中心任务 ID |
| agent_id | TEXT FK | 目标 Agent |
| source | TEXT | `template` / `ad_hoc` |
| template_id | TEXT NULL | 来源模板 |
| shell | TEXT | |
| command | TEXT | |
| workdir | TEXT NULL | |
| timeout_secs | INTEGER | |
| status | TEXT | 见状态机 |
| exit_code | INTEGER NULL | |
| stdout | TEXT | |
| stderr | TEXT | |
| agent_task_id | TEXT NULL | Agent 侧任务 ID |
| created_at | TEXT | |
| started_at | TEXT NULL | |
| finished_at | TEXT NULL | |

### 4.2 任务状态机

```text
queued --> dispatched --> running --> succeeded
                                  --> failed
                                  --> timeout
```

规则：

- 创建后为 `queued`。
- 中心成功向 Agent `POST /api/tasks` 后立即标为 `dispatched`，并写入 `agent_task_id`。
- 中心轮询到 Agent 返回 `running` 时将中心状态更新为 `running` 并写入 `started_at`（若尚未写入）。
- 终态：`succeeded`（exit 0）、`failed`（非 0 或启动失败）、`timeout`；写入 `finished_at`、`exit_code`、`stdout`、`stderr`。
- Agent 返回 `409 Busy` 或网络不可达：任务保持或回到 `queued`（清除 `agent_task_id`），由 dispatcher 稍后重试；不丢任务。
- `offline` 判定：对某 Agent 的一次 `GET /api/status` 失败（连接/超时/非 2xx）即将该 Agent 标为 `offline`；成功则 `online` 并刷新指标。

### 4.3 Agent 进程内状态

- 单槽执行器：空闲或占用一个 `agent_task_id`。
- 近期任务结果 Map，供中心 `GET /api/tasks/{id}`。
- 配置：`center_url`、`bind`、`port`（默认 26631）；电脑名与 IP 自动探测（IP 可配置覆盖）。

## 5. API

### 5.1 调度中心 `:26630`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/register` | 注册/续期：`name`, `ip`, `port` |
| GET | `/api/agents` | 列表（状态 + CPU/内存） |
| GET | `/api/agents/{id}` | 详情 |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/templates` | 创建模板 |
| GET | `/api/templates/{id}` | 模板详情 |
| PUT | `/api/templates/{id}` | 更新模板 |
| DELETE | `/api/templates/{id}` | 删除模板 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 创建任务：`agent_id` + `template_id` **或** ad-hoc 字段 |
| GET | `/api/tasks/{id}` | 任务详情（含输出） |
| GET | `/api/health` | 健康检查 |
| GET | `/`, `/assets/*` | WebUI |

### 5.2 Agent `:26631`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | hostname, ip, cpu_percent, memory_percent, busy（执行槽是否占用）, uptime |
| POST | `/api/tasks` | 接收任务；忙碌则 409 |
| GET | `/api/tasks/{id}` | 本地任务状态与输出 |
| GET | `/api/tasks` | 近期任务列表 |
| GET | `/api/health` | 健康检查 |
| GET | `/`, `/assets/*` | WebUI |

### 5.3 主数据流

1. **注册：** Agent 启动 → `POST {center}/api/agents/register` → upsert `agents`。
2. **巡检：** 中心每 **5s** 对已知 Agent `GET /api/status`；成功更新指标与 `last_seen_at`/`online`；失败标 `offline`。
3. **下发：** 用户创建任务 → `queued` → dispatcher 选择目标 Agent 在线且不忙 → `POST` Agent `/api/tasks` → 记录 `agent_task_id`。
4. **回收：** 中心每 **1s** 轮询运行中任务对应的 Agent `GET /api/tasks/{agent_task_id}`，直到终态后写回 SQLite。

默认值：任务超时 **300s**；默认 shell **`cmd`**（可改为 `powershell`）。

## 6. WebUI

中文界面，同端口嵌入，实用内网工具风格。

**调度中心：**

- Agent 列表：电脑名、IP、在线、CPU%、内存%、是否忙碌
- 模板 CRUD
- 任务创建（模板或临时命令）与列表/详情（状态、退出码、stdout/stderr）

**Agent：**

- 本机 CPU/内存与忙碌状态
- 近期任务与输出（只读为主）
- 「向中心重新注册」操作

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| 注册/创建缺少必填字段 | HTTP 400 + 明确 JSON 错误信息 |
| Agent 忙碌 | Agent 409；中心任务保持 queued，周期性重试下发 |
| 巡检/下发网络失败 | 日志；Agent offline；下发失败则任务回 queued |
| 命令超时 | Agent 终止子进程 → timeout；中心同步 |
| 子进程无法启动 | failed，stderr 记录原因 |
| SQLite 故障 | HTTP 500；记录日志；不静默丢弃已写入任务 |

## 8. 测试计划

- **common：** 状态枚举与 JSON 序列化单测
- **scheduler store：** SQLite 仓储单测（注册 upsert、任务状态更新）
- **scheduler dispatcher：** 对 mock Agent HTTP 的集成测试（下发、409 重试、结果回收）
- **agent executor：** 短命命令测成功 / 非零退出 / 超时（Windows）
- **手工联调：** 两进程：注册 → 看板指标 → 模板任务 → ad-hoc 任务

## 9. 配置

**scheduler**

- `bind` / `port`（默认 `0.0.0.0:26630`）
- `database_url`（默认 `sqlite:data/scheduler.db`）
- `poll_status_interval_secs`（默认 5）
- `poll_task_interval_secs`（默认 1）

**agent**

- `bind` / `port`（默认 `0.0.0.0:26631`）
- `center_url`（必填，如 `http://192.168.1.10:26630`）
- `advertise_ip`（可选，覆盖自动探测）
- `hostname`（可选，覆盖电脑名）

配置来源：以**环境变量**为主（例如 `SCHEDULER_PORT`、`AGENT_CENTER_URL`）；可选同目录 `config.toml` 覆盖默认值。两者都缺省时使用本文默认值。

## 10. 组件边界（可独立理解/测试）

| 单元 | 职责 | 对外接口 | 依赖 |
|------|------|----------|------|
| common | 共享类型 | Rust 类型 | 无 |
| scheduler registry | Agent 注册与巡检更新 | service API | SQLite |
| scheduler dispatcher | 排队、下发、回收 | service API | registry、reqwest→Agent |
| scheduler templates/tasks API | CRUD | HTTP | SQLite |
| agent metrics | CPU/内存 | status DTO | sysinfo |
| agent executor | 串行执行命令 | tasks API | Windows 进程 |
| agent registrar | 启动注册/手动重注册 | HTTP client | center_url |

## 11. 决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 产品范围 | 真正任务调度（监控 + 模板 + ad-hoc） | 用户选定 |
| Agent OS | 仅 Windows | 产线场景 |
| 通信 | 中心主动调 Agent | 用户选定；内网可达 |
| 鉴权 | 无（v1） | 用户选定；文档强调内网 |
| 并发 | Agent 串行单任务 | 避免产线脚本互抢 |
| 工程结构 | Cargo workspace + common | 共享协议、两边单体部署 |
| HTTP 框架 | Axum | 一致、可维护 |
| Agent 端口 | 26631 | 与 26630 相邻 |
