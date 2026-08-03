# ATLAS API 接口汇总

**无鉴权。** 仅限可信内网。路由以各服务 `crates/*/src/api.rs` 的 `router()` 为准。

| 服务 | 默认基址 | 代码 |
|------|----------|------|
| **调度中心** | `http://127.0.0.1:26630` | `crates/scheduler` |
| **Agent** | `http://127.0.0.1:26631` | `crates/agent` |

两套 API **独立**（不同主机）。下文按服务分章。

### 使用方图例

| 标记 | 含义 |
|------|------|
| **中心 WebUI** | `crates/scheduler/static` 页面有直接调用 |
| **Agent WebUI** | `crates/agent/static` 页面有直接调用 |
| **未使用** | 两端 WebUI 均未调用（可能仍被 Agent↔中心 **服务端** 代理使用，见备注） |

通用约定：JSON 为主；`/api/health` 返回纯文本 `ok`；错误体常见 `{ "error": "..." }`。

---

# 第一部分：调度中心 API

**基址：** `http://127.0.0.1:26630`  
**可调用的 WebUI：** 仅 **中心 WebUI**（Agent 浏览器不会直接打中心地址）。

## 1.1 接口一览与使用方

| 方法 | 路径 | 使用方 | 备注 |
|------|------|--------|------|
| GET | `/api/health` | **未使用** | |
| POST | `/api/agents/register` | **未使用** | Agent 进程注册/心跳 |
| GET | `/api/agents` | **中心 WebUI** | 机台列表 / 详情数据源 |
| GET | `/api/agents/{id}` | **未使用** | |
| GET | `/api/vi-templates` | **中心 WebUI** | 已注册功能 · VI |
| POST | `/api/vi-templates` | **未使用** | Agent 注册 VI 时代理写入 |
| GET | `/api/vi-templates/{id}` | **未使用** | |
| PATCH | `/api/vi-templates/{id}` | **未使用** | Agent `PATCH /api/labview/templates/{id}` 代理 |
| DELETE | `/api/vi-templates/{id}` | **中心 WebUI** | 已注册功能 · 删除 |
| GET | `/api/general-templates` | **中心 WebUI** | 已注册功能 · 通用 |
| POST | `/api/general-templates` | **未使用** | Agent 注册 Delay/REST 时代理写入 |
| GET | `/api/general-templates/{id}` | **未使用** | |
| DELETE | `/api/general-templates/{id}` | **中心 WebUI** | 已注册功能 · 删除 |
| GET | `/api/sequence-templates` | **中心 WebUI** | 序列模板列表 |
| POST | `/api/sequence-templates` | **未使用** | Agent 保存序列模板时代理 |
| GET | `/api/sequence-templates/{id}` | **未使用** | |
| DELETE | `/api/sequence-templates/{id}` | **中心 WebUI** | 序列模板 · 删除 |
| POST | `/api/sequence-templates/{id}/load-to-agent` | **未使用** | Agent `.../load` 代理 |
| GET | `/api/agents/{id}/run-queue` | **未使用** | Agent `run-queue` GET 代理 |
| PUT | `/api/agents/{id}/run-queue` | **未使用** | Agent `run-queue` PUT 代理 |
| GET | `/api/agents/{id}/settings` | **未使用** | Agent `/api/settings` GET 代理 |
| PUT | `/api/agents/{id}/settings` | **未使用** | Agent `/api/settings` PUT 代理 |

## 1.2 健康检查

**GET** `/api/health` → 文本 `ok` · 使用方：**未使用**

## 1.3 机台

**POST** `/api/agents/register` · 使用方：**未使用**（Agent 进程）

```json
{ "name": "LINE-01", "ip": "192.168.1.10", "port": 26631 }
```

**GET** `/api/agents` · 使用方：**中心 WebUI**  
**GET** `/api/agents/{id}` · 使用方：**未使用**

响应字段：`id`, `name`, `ip`, `port`, `status`, `cpu_percent`, `memory_percent`, `busy`, `last_seen_at?`, `created_at`

## 1.4 VI 模板

**GET** `/api/vi-templates` · 使用方：**中心 WebUI**  
Query：`agent_id?` · `kind?`

**POST** `/api/vi-templates` · 使用方：**未使用**（Agent 注册代理）

| 字段 | 说明 |
|------|------|
| `agent_id` | 来源机台 ID |
| `name` | 显示名称 |
| `vi_path` · `cli_path` · `getinfo_path` | 绝对路径 |
| `inputs` | 数组（必填） |
| `outputs` | 数组，默认 `[]` |
| `kind` | 默认 `labview` |
| `show_front_panel` | bool |
| `timeout_secs` | 可选 |

**GET** `/api/vi-templates/{id}` · 使用方：**未使用**  
**PATCH** `/api/vi-templates/{id}` · 使用方：**未使用** — `name?` · `inputs?` · `show_front_panel?` · `timeout_secs?`  
**DELETE** `/api/vi-templates/{id}` · 使用方：**中心 WebUI** → `204`

## 1.5 通用模板

**GET** `/api/general-templates` · 使用方：**中心 WebUI**  
Query：`agent_id?` · `kind?`

**POST** `/api/general-templates` · 使用方：**未使用**（Agent 注册代理）  
**GET** `/api/general-templates/{id}` · 使用方：**未使用**  
**DELETE** `/api/general-templates/{id}` · 使用方：**中心 WebUI** → `204`

## 1.6 序列模板

**GET** `/api/sequence-templates` · 使用方：**中心 WebUI**  
**POST** `/api/sequence-templates` · 使用方：**未使用** — `{ "agent_id", "name", "note?" }`  
**GET** `/api/sequence-templates/{id}` · 使用方：**未使用**  
**DELETE** `/api/sequence-templates/{id}` · 使用方：**中心 WebUI** → `204`  
**POST** `/api/sequence-templates/{id}/load-to-agent` · 使用方：**未使用** — `{ "agent_id" }`

`steps[]`：`position` · `template_source` · `vi_template_id?` · `general_template_id?` · `inputs` · `enabled` · `breakpoint` · `fail_policy` · `limits` · `note`

## 1.7 执行队列

**GET** `/api/agents/{id}/run-queue` · 使用方：**未使用**（Agent 队列代理）  
**PUT** `/api/agents/{id}/run-queue` · 使用方：**未使用**（Agent 队列代理）

`items[]` 每项：

| 字段 | 说明 |
|------|------|
| `template_source` | `labview`（默认）或 `general` |
| `vi_template_id` / `general_template_id` | 按来源选用 |
| `inputs` | 步骤入参覆盖 |
| `enabled` | 默认 `true` |
| `breakpoint` | 执行前暂停 |
| `fail_policy` | `stop`（默认）/ `continue` |
| `limits` | Spec 数组，默认 `[]` |
| `note` | 备注 |

### Spec（`limits` 元素）

| `op` | 含义 | 主要字段 |
|------|------|----------|
| `range`（默认） | 数值区间 | `output` · `min` · `max` · `unit?` |
| `eq` | 等于 | `output` · `expect`（或 `min`） |
| `ne` | 不等于 | 同上 |
| `in` | 属于集合 | `expect` 为列表或逗号分隔 |

变量：`${Name}`。

## 1.8 机台设置

**GET** `/api/agents/{id}/settings` · 使用方：**未使用**（Agent settings 代理）  
**PUT** `/api/agents/{id}/settings` · 使用方：**未使用**（Agent settings 代理）

```json
{
  "units": [{ "symbol": "dBm", "description": "功率" }],
  "variables": [{ "name": "SN_PREFIX", "value": "A", "description": "" }]
}
```

---

# 第二部分：Agent API

**基址：** `http://127.0.0.1:26631`  
**可调用的 WebUI：** 仅 **Agent WebUI**（中心浏览器不会直接打 Agent 的业务页接口；中心详情也不再调 Agent）。

## 2.1 接口一览与使用方

| 方法 | 路径 | 使用方 | 备注 |
|------|------|--------|------|
| GET | `/api/health` | **未使用** | |
| GET | `/api/status` | **Agent WebUI** | 顶栏状态 / busy |
| POST | `/api/slot/force-release` | **Agent WebUI** | 强制空闲 |
| POST | `/api/register-now` | **Agent WebUI** | 重新注册 |
| GET | `/api/labview/config` | **Agent WebUI** | VI 页路径展示 |
| POST | `/api/labview/inspect` | **Agent WebUI** | 查询参数 |
| POST | `/api/labview/run` | **Agent WebUI** | 试跑 |
| POST | `/api/labview/register-template` | **Agent WebUI** | 注册到中心 |
| GET | `/api/labview/registered-templates` | **未使用** | |
| GET | `/api/labview/all-templates` | **Agent WebUI** | 中心 VI 列表 / 序列左侧 |
| GET | `/api/labview/agent-id` | **未使用** | |
| PATCH | `/api/labview/templates/{id}` | **未使用** | |
| GET | `/api/sequence/run-queue` | **Agent WebUI** | 序列队列 |
| PUT | `/api/sequence/run-queue` | **Agent WebUI** | 保存队列 |
| POST | `/api/sequence/run` | **Agent WebUI** | 开始执行 |
| GET | `/api/sequence/run/progress` | **Agent WebUI** | 执行进度轮询 |
| POST | `/api/sequence/run/continue` | **Agent WebUI** | 断点继续 |
| POST | `/api/sequence/run/abort` | **Agent WebUI** | 断点中止 |
| GET | `/api/sequence-templates` | **Agent WebUI** | 中心序列模板 |
| POST | `/api/sequence-templates` | **Agent WebUI** | 保存为模板 |
| POST | `/api/sequence-templates/{id}/load` | **Agent WebUI** | 加载到队列 |
| GET | `/api/settings` | **Agent WebUI** | 配置页 |
| PUT | `/api/settings` | **Agent WebUI** | 配置页保存 |
| POST | `/api/general/delay/run` | **Agent WebUI** | 通用 · Delay 试跑 |
| POST | `/api/general/delay/register-template` | **Agent WebUI** | 通用 · 注册 Delay |
| GET | `/api/general/delay/templates` | **未使用** | |
| POST | `/api/general/rest/run` | **Agent WebUI** | API · 试跑 |
| POST | `/api/general/rest/register-template` | **Agent WebUI** | API · 注册 |
| GET | `/api/general/rest/templates` | **Agent WebUI** | API · 模板列表 |
| GET | `/api/general/all-templates` | **Agent WebUI** | 序列左侧通用列表等 |

## 2.2 健康检查

**GET** `/api/health` → 文本 `ok` · 使用方：**未使用**

## 2.3 状态与注册

**GET** `/api/status` · 使用方：**Agent WebUI**

| 字段 | 说明 |
|------|------|
| `hostname` · `ip` | 注册身份 |
| `cpu_percent` · `memory_percent` | 资源占用 |
| `busy` · `uptime_secs` | 是否忙碌 / 运行秒数 |
| `busy_reason` · `busy_message` | 如 `sequence` · `delay` · `rest` |
| `can_continue` · `can_abort` · `can_force_release` | 断点 / 强制释放 |
| `pause_before_position` · `pause_step_name` | 断点位置 |
| `log_dir` | 日志根目录 |

**POST** `/api/slot/force-release` · 使用方：**Agent WebUI** → `{ "ok", "released", "message" }`  
**POST** `/api/register-now` · 使用方：**Agent WebUI** → `{ "ok": true }`

忙碌冲突：**409**，含 `error: "agent is busy"` 及 `can_*` 等。

## 2.4 LabVIEW

**GET** `/api/labview/config` · 使用方：**Agent WebUI** → `{ "cli_path", "getinfo_path" }`

**POST** `/api/labview/inspect` · 使用方：**Agent WebUI**

```json
{ "vi_path": "C:\\path\\Add.vi" }
```

**POST** `/api/labview/run` · 使用方：**Agent WebUI**

```json
{
  "vi_path": "C:\\path\\Add.vi",
  "inputs": [{ "name": "a", "className": "Numeric", "value": 1 }],
  "show_front_panel": false,
  "timeout_secs": 60
}
```

**POST** `/api/labview/register-template` · 使用方：**Agent WebUI**  
`vi_path` · `name`（必填）· `inputs?` · `outputs?` · `show_front_panel?` · `timeout_secs?`

**GET** `/api/labview/registered-templates` · 使用方：**未使用**  
**GET** `/api/labview/all-templates` · 使用方：**Agent WebUI**  
**GET** `/api/labview/agent-id` · 使用方：**未使用**  
**PATCH** `/api/labview/templates/{id}` · 使用方：**未使用**

## 2.5 执行队列

**GET** `/api/sequence/run-queue` · 使用方：**Agent WebUI**  
**PUT** `/api/sequence/run-queue` · 使用方：**Agent WebUI**  
Body 形状见第一部分 1.7。

## 2.6 序列执行

**POST** `/api/sequence/run` · 使用方：**Agent WebUI**

```json
{ "sn": "SN001", "work_order": "WO-1", "sequence_template_id": 12 }
```

响应：`overall` · `stopped` · `failed_at?` · `steps[]` · `sn?` · `work_order?` · `pause?`

**GET** `/api/sequence/run/progress` · 使用方：**Agent WebUI**  
**POST** `/api/sequence/run/continue` · 使用方：**Agent WebUI**  
**POST** `/api/sequence/run/abort` · 使用方：**Agent WebUI**

## 2.7 序列模板

**GET** `/api/sequence-templates` · 使用方：**Agent WebUI**  
**POST** `/api/sequence-templates` · 使用方：**Agent WebUI** — `{ "name", "note?" }`  
**POST** `/api/sequence-templates/{id}/load` · 使用方：**Agent WebUI**

## 2.8 本机设置

**GET** `/api/settings` · 使用方：**Agent WebUI**  
**PUT** `/api/settings` · 使用方：**Agent WebUI**  
Body 见第一部分 1.8。

配置页支持从旧测控 `Device_CFG.ini` **本地导入**地址类变量（白名单键 → `{Section}_{Key}`），合并进编辑区后经 `PUT /api/settings` 持久化。Agent 运行时不读取磁盘 INI。

## 2.9 Delay

**POST** `/api/general/delay/run` · 使用方：**Agent WebUI** — `{ "delay_ms": 200 }`  
**POST** `/api/general/delay/register-template` · 使用方：**Agent WebUI** — `{ "name", "delay_ms" }`  
**GET** `/api/general/delay/templates` · 使用方：**未使用**

## 2.10 REST

**POST** `/api/general/rest/run` · 使用方：**Agent WebUI**

| 字段 | 说明 |
|------|------|
| `url` | 必填 |
| `method` | 默认 GET |
| `headers` | 多行 `Key: Value` |
| `body` | 请求体 |
| `timeout_ms` | 超时 |
| `expect_status` | 期望状态码 |

**POST** `/api/general/rest/register-template` · 使用方：**Agent WebUI**  
**GET** `/api/general/rest/templates` · 使用方：**Agent WebUI**  
**GET** `/api/general/all-templates` · 使用方：**Agent WebUI**
