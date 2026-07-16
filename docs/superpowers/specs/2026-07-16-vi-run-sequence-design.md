# Agent VI 选定序列执行设计规格

**日期：** 2026-07-16  
**状态：** 已批准（待实现计划）  
**依赖：**

- `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`
- `docs/superpowers/specs/2026-07-16-vi-list-and-distribute-design.md`（本机已注册列表）

**技术栈：** 现有 Rust workspace（Axum + SQLite + Windows Agent）；无新运行时依赖。

## 1. 目标

在 Agent WebUI 增加独立页面，支持：

1. **左列表**：本机已注册 VI 功能（数据源同现有 registered-templates）。
2. **右列表**：选定功能（有序）；可从左侧添加（允许同一模板多次）、拖拽排序、上移/下移、移除。
3. **持久化**：选定顺序存调度中心，按 Agent 各一份。
4. **按序执行**：服务端串行调用现有 LabVIEW `run`；**遇错立即停止**；返回逐步结果。

成功标准：

- Agent 新页可编排并保存队列；刷新后右侧顺序仍在。
- 「按序执行」按保存顺序跑完或在首个失败步停下，并标明已完成/失败步。
- 执行期间 Agent busy，与 shell 任务互斥（409）。

## 2. 非目标（YAGNI）

- 调度中心 WebUI 编辑/查看该队列。
- 将序列入队现有 `tasks` 作业表。
- 在序列页逐步修改 inputs / 前面板 / 超时（一律用模板注册快照）。
- 取消进行中的序列、跨 Agent 混排、浏览器侧 for 循环执行（关页会断）。

## 3. 架构

### 3.1 数据流

```text
Agent「序列」页
  左 ← GET /api/labview/registered-templates
  右 ↔ GET/PUT /api/labview/run-queue  → 中心 /api/agents/{id}/vi-run-queue
按序执行 → POST /api/labview/run-sequence
  → busy 槽 → 按序 labview run → 遇错停 → 逐步 JSON 结果
```

### 3.2 模块职责

| 单元 | 职责 |
|------|------|
| 中心表 `vi_run_queue_items` | 每 Agent 有序队列行 |
| 中心 API | GET/PUT 整表替换；删模板级联 |
| Agent 代理 | run-queue 读写；run-sequence 编排 |
| Agent WebUI | 双列表页 + 拖拽/调序 + 执行进度 |

## 4. 数据模型

表名：`vi_run_queue_items`（迁移序号接现有 migrations）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 队列行 UUID（同模板可多行） |
| `agent_id` | TEXT NOT NULL | FK `agents(id)` |
| `vi_template_id` | TEXT NOT NULL | FK `vi_templates(id)` |
| `position` | INTEGER NOT NULL | 从 0 起的顺序 |
| `created_at` | TEXT NOT NULL | ISO-8601 |

约束：

- `UNIQUE(agent_id, position)`（或 PUT 时重写全部 position，避免空洞）。
- 入队时 `vi_templates.agent_id` 必须等于队列 `agent_id`。
- 删除 `vi_templates` 行时：**级联删除**引用该模板的队列行。

## 5. API

### 5.1 中心

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agents/{id}/vi-run-queue` | 按 `position` 升序；含 `id`、`vi_template_id`、`position`、模板 `name`/`vi_path` |
| `PUT` | `/api/agents/{id}/vi-run-queue` | 整表替换 |

**PUT body：**

```json
{
  "items": [
    { "vi_template_id": "uuid-a" },
    { "vi_template_id": "uuid-a" },
    { "vi_template_id": "uuid-b" }
  ]
}
```

- 顺序 = 数组下标；服务端生成新行 `id` 与 `position`。
- 任一项模板不属于该 Agent 或不存在 → **400**，整单拒绝（不部分写入）。
- Agent 不存在 → **404**。

### 5.2 Agent

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` / `PUT` | `/api/labview/run-queue` | `resolve_agent_id` 后代理中心 |
| `POST` | `/api/labview/run-sequence` | 读取**当前中心队列**并串行执行（本版不要求 body 覆盖列表） |

**`run-sequence`：**

1. `busy` → **409** `agent is busy`。
2. 占用与 shell 任务相同的 busy 槽，整段序列期间 busy；结束（成功或失败停）后释放。
3. 按队列顺序加载模板字段，调用现有 LabVIEW run。
4. 任一步失败 → 停止；后续不跑。
5. 空队列 → **400**。

**成功/中停响应：**

```json
{
  "stopped": true,
  "failed_at": 1,
  "steps": [
    {
      "position": 0,
      "queue_item_id": "...",
      "template_id": "...",
      "name": "...",
      "ok": true,
      "result": {}
    },
    {
      "position": 1,
      "queue_item_id": "...",
      "template_id": "...",
      "name": "...",
      "ok": false,
      "error": "..."
    }
  ]
}
```

全部成功：`stopped: false`，`failed_at: null`，每步 `ok: true`。  
HTTP：整段跑完或中停均 **200**（由 `stopped`/`steps` 表达成败）；仅空队列/busy/中心错误用 4xx/5xx。

超时：每步使用该模板的 `timeout_secs`（与单次试跑一致）。

## 6. UI（Agent）

- 顶栏增加页面切换（例如「VI」工作台 / 「序列」）。
- **左**：已注册功能 +「添加」。
- **右**：选定列表；拖拽排序；上移/下移；移除。
- 每次增删/调序后 **自动 PUT**；失败提示并尽量回滚本地状态。
- 「按序执行」：调用 `run-sequence`；执行中禁用编辑与重复点击；逐步标 pending/running/ok/fail。
- 结果区展示逐步摘要（失败 error；成功可折叠 JSON）。

现有 VI 工作台与已注册单条试跑保留。

## 7. 错误处理

| 情况 | 行为 |
|------|------|
| resolve / 中心失败 | 明确错误文案 |
| PUT 非法模板 | 400，不落库 |
| busy | 409 |
| 空队列执行 | 400 或前端禁用 |
| 步失败 | 停；返回已完成步 + 失败步 |

## 8. 测试要点

- 中心：PUT 替换与顺序；归属校验；删模板级联。
- Agent：queue 代理；`run-sequence` 全成功；第 2 步失败则第 3 步不执行；busy → 409；空队列 → 400。
- UI：页切换与双列表结构；自动保存触发点（可测 JS 契约或手工）。

## 9. 实现备注

- 复用 `resolve_agent_id`、`registered-templates`、`labview` run 与 `task_slot` busy。
- 拖拽可用原生 HTML5 DnD 或轻量实现；上移/下移必做，保证无拖拽环境可用。
