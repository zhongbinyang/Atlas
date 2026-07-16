# LabVIEW VI 注册 / 试跑 / 下发设计规格

**日期：** 2026-07-16  
**状态：** 已批准（待实现计划）  
**依赖：**

- `docs/superpowers/specs/2026-07-15-scheduler-agent-design.md`
- 外部工具：`labview-runner-cli`（说明见 `C:\Users\zhong\test06\README.md`）

**技术栈：** 现有 Rust workspace（Axum + SQLite + Windows Agent）；本机调用固定/可配置的 `labview-runner-cli.exe`。

## 1. 目标

在 Agent 与调度中心提供 LabVIEW VI 工作流：

1. 对目标 VI 执行 **inspect**（经 `labview-runner-cli`），展示参数 JSON，并允许编辑 inputs 的默认 `value`。
2. **试跑**（run）：本机或经中心代理，同步返回 outputs JSON。
3. **注册**到中心独立表 **`vi_templates`**（绑定来源/选定 Agent、VI 路径、inputs、前面板与超时选项）。
4. **下发**：按模板拼 CLI `run` 命令，进入现有任务队列，在绑定 Agent 上执行。

成功标准：

- Agent 页可对本地 VI 完成 inspect → 编辑 → 试跑 → 注册。
- 中心可选 Agent，代理 inspect/试跑/注册；列表可下发并在任务中看到结果。
- CLI / getinfo 路径可通过 Agent 环境变量配置；默认指向 `C:\labview-runner-cli\...`。

## 2. 非目标（YAGNI）

- 调度中心本机安装 LabVIEW 并直接跑 CLI（LabVIEW 仅在 Agent 机台）。
- 浏览器直连 Agent 做 LabVIEW（中心操作一律经中心代理）。
- 把 VI 模板塞进现有 shell `task_templates`（使用独立 `vi_templates`）。
- LabVIEW 工程管理、多 VI 工作流编排、鉴权/TLS。

## 3. 架构

### 3.1 Agent 本机配置

| 环境变量 | 默认值 |
|----------|--------|
| `AGENT_LABVIEW_CLI` | `C:\labview-runner-cli\labview-runner-cli.exe` |
| `AGENT_LABVIEW_GETINFO_VI` | `C:\labview-runner-cli\getinfo.vi` |

文件不存在或无法执行时，相关 API 返回明确错误（见 §6）。

### 3.2 数据流

```text
[Agent WebUI] 或 [中心 WebUI]
        │  选 Agent（仅中心）+ 粘贴 vi_path（绝对路径文本框）
        │  选项：show_front_panel、timeout_secs；编辑 inputs[].value
        ▼
中心代理（中心发起时） ──► Agent
  inspect / run
        │
        ▼
Agent 本机 labview-runner-cli
  --action inspect|run --getinfo <cfg> --vi <path> [--input ...] [...]
        │
        ▼
注册 ──► 中心 SQLite vi_templates
下发 ──► 中心 tasks 队列 ──► Agent 串行执行 shell（拼好的 CLI 命令行）
```

### 3.3 模块职责

| 单元 | 职责 |
|------|------|
| Agent `labview` | Spawn CLI；解析 stdout/stderr JSON；映射退出码 |
| Agent API | `/api/labview/inspect`、`/run`、`/config` |
| Scheduler 代理 | `/api/agents/{id}/labview/inspect|run` |
| Scheduler `vi_templates` | CRUD + `dispatch` 入队现有 tasks |
| Agent / 中心 WebUI | 路径、inspect、编辑、试跑、注册、列表下发 |

## 4. 数据模型

### 4.1 表 `vi_templates`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | 显示名；默认可用目标 VI 文件名 |
| `agent_id` | TEXT NOT NULL | 限定机台，FK `agents(id)` |
| `vi_path` | TEXT NOT NULL | 目标 VI 绝对路径 |
| `cli_path` | TEXT NOT NULL | 注册时快照的 CLI exe 路径 |
| `getinfo_path` | TEXT NOT NULL | 注册时快照的 getinfo 路径 |
| `inputs_json` | TEXT NOT NULL | JSON 数组：完整 inputs（含 `name`/`className`/`value`），以便保留类型信息 |
| `show_front_panel` | INTEGER NOT NULL | 0/1 |
| `timeout_secs` | INTEGER NULL | NULL = 不向 CLI 传 `--timeout` |
| `created_at` | TEXT NOT NULL | ISO-8601 |

迁移：新增 `00x_vi_templates.sql`（序号接在现有 migrations 之后）。

### 4.2 CLI `--input` 形态

从 `inputs_json` 抽出 `{ name: value, ... }` 对象，序列化为 CLI `--input` 参数（PowerShell/cmd 引号规则在拼命令时按 **cmd** shell 约定处理，与现有任务执行器一致）。

## 5. API

### 5.1 Agent `:26631`

#### `GET /api/labview/config`

```json
{
  "cli_path": "C:\\labview-runner-cli\\labview-runner-cli.exe",
  "getinfo_path": "C:\\labview-runner-cli\\getinfo.vi"
}
```

#### `POST /api/labview/inspect`

请求：`{ "vi_path": "C:\\...\\Add.vi" }`  
成功：透传 CLI stdout 的 inspect JSON（含 `action`/`inputs`/`outputs`）。  
失败：见 §6。

#### `POST /api/labview/run`

请求：

```json
{
  "vi_path": "C:\\...\\Add.vi",
  "inputs": [ { "name": "a", "className": "Digital", "value": 3.0 } ],
  "show_front_panel": false,
  "timeout_secs": null
}
```

成功：透传 CLI stdout 的 run JSON（`outputs`）。  
`inputs` 也可接受已是 `name→value` 的对象；服务端统一转成 CLI `--input`。

### 5.2 Scheduler `:26630`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/agents/{id}/labview/inspect` | 代理 inspect；Agent 离线 → 503 |
| `POST` | `/api/agents/{id}/labview/run` | 代理试跑（同步等待 Agent） |
| `GET` | `/api/vi-templates` | 列表 |
| `POST` | `/api/vi-templates` | 注册（见下） |
| `GET` | `/api/vi-templates/{id}` | 详情 |
| `DELETE` | `/api/vi-templates/{id}` | 删除 |
| `POST` | `/api/vi-templates/{id}/dispatch` | 入队任务 |

#### `POST /api/vi-templates` body

```json
{
  "name": "Add",
  "agent_id": "<uuid>",
  "vi_path": "C:\\...\\Add.vi",
  "getinfo_path": "C:\\labview-runner-cli\\getinfo.vi",
  "inputs": [ ],
  "show_front_panel": false,
  "timeout_secs": null
}
```

`getinfo_path` 可省略：中心可先问 Agent config，或要求客户端传入；**推荐客户端传入当前 Agent config 快照**，避免中心猜测。

#### `dispatch` 行为

1. 读模板，确认 `agent_id` 存在。
2. 拼 cmd 命令行，例如：

```text
"C:\labview-runner-cli\labview-runner-cli.exe" --action run --getinfo "..." --vi "..." --input "{...}"
```

（若 `show_front_panel` / `timeout_secs` 有值则追加对应 flag。）  
`cli_path` / `getinfo_path` 均用模板快照，避免 Agent 事后改环境变量导致旧模板命令漂移。

3. `CreateTask`：`agent_id` = 模板机台，`shell` = `cmd`，`command` = 上式，`timeout_secs` = 模板超时或默认 300（任务层超时与 CLI `--timeout` 可同时存在：任务层防止永久挂起）。
4. 返回创建的 task 视图。

**Agent 本机注册时的 `agent_id`：** Agent 调用中心 `POST /api/vi-templates` 前，须已知本机在中心的 id（启动注册响应或 `GET` 中心按 name/ip/port 查找）。若尚无 id，先执行现有 `register-now` / 中心注册，再注册 VI 模板。

## 6. 错误处理

| 情况 | HTTP / 行为 |
|------|-------------|
| `vi_path` / CLI / getinfo 缺失 | 400 或 404；CLI exit 3 → 文件不存在 |
| CLI 非 0，stderr 为错误 JSON | 4xx/5xx + body 含 `error.kind` / `message`（透传或包装） |
| COM / LabVIEW 激活失败 | 502/503 |
| 中心代理时 Agent 不可达 | 503 |
| 未知 `agent_id` | 400 |
| `--input` 非法 | 400 或 CLI exit 2 |

## 7. WebUI

### 7.1 Agent

- 区块「VI」：config 只读、VI 路径文本框、查询参数、inputs 表格（name/className 只读，value 可编辑）、前面板勾选、超时输入、试跑、注册到中心。
- 路径用手填/粘贴绝对路径（不用浏览器 file input 当路径来源）。

### 7.2 中心

- 分区「VI」（或作业下子区）：选 Agent、路径与选项；代理 inspect/试跑/注册。
- 模板列表：名称、机台、路径；试跑、下发、删除。
- 下发后提示查看「作业」任务列表中的 stdout/stderr。

视觉：沿用现有工控清爽令牌与壳层，不另开设计体系。

## 8. 测试要点

- Agent：mock 或集成（有 LabVIEW 时）inspect/run 退出码与 JSON 解析。
- 中心：代理失败映射；`vi_templates` CRUD；dispatch 产生的 task.command 含正确 flag 与 input JSON。
- UI：手动验收见 §1 成功标准。

## 9. 实现边界

- 实现前另写 `docs/superpowers/plans/2026-07-16-labview-vi-templates.md`。
- README 在实现后补充环境变量与「VI」功能说明。
