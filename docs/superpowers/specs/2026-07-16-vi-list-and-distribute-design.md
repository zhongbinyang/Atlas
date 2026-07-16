# VI 功能列表与跨 Agent 分发设计规格

**日期：** 2026-07-16  
**状态：** 已批准（待实现计划）  
**依赖：**

- `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`（既有 VI 注册 / 试跑）
- 现有中心 `vi_templates` 表与 Agent LabVIEW 试跑代理

**技术栈：** 现有 Rust workspace（Axum + SQLite + Windows Agent）；不新增运行时依赖。

## 1. 目标

在「注册到中心 + 试跑」之上增强：

1. **Agent**：展示本机已注册的 VI 功能列表，选中一条即可试跑（或加载到编辑区后再跑）。
2. **调度中心**：模板列表能清楚区分 **当前绑定机台** 与 **首次注册来源机台**。
3. **分发**：中心可将某模板复制到其他 Agent（不入作业任务队列）；默认沿用 `vi_path`，可选手动覆盖；目标机同 `vi_path` 则覆盖更新。

成功标准：

- Agent WebUI 能从中心拉取「仅本机」模板列表并执行试跑。
- 中心列表同时显示来源机台与当前机台名称。
- 中心可对模板多选目标 Agent 执行分发，结果按目标返回 created/updated/error。

## 2. 非目标（YAGNI）

- 不恢复 VI → `tasks` 队列下发（作业下发已移除）。
- 不同步 / 拷贝 `.vi` 文件到目标机。
- 不做「一次分发、每机不同路径」；单次分发最多一个可选统一 `vi_path`。
- 不引入独立「功能目录 + 绑定」双表模型。
- 不分发历史审计表（仅保留固定 `origin_agent_id`）。

## 3. 架构

### 3.1 数据流

```text
[注册]
  Agent 或中心 → POST /api/vi-templates
  origin_agent_id := agent_id（新建）；覆盖时不改 origin_agent_id

[Agent 本机列表]
  Agent WebUI → resolve_agent_id → GET {center}/api/vi-templates?agent_id={self}
  选中 → 本机 POST /api/labview/run（模板字段）

[中心分发]
  POST /api/vi-templates/{id}/distribute
    → 对每个 target：upsert (agent_id, vi_path)
    → origin_agent_id 始终等于源模板的 origin_agent_id
    → cli_path/getinfo_path 取目标机当前 labview config
```

### 3.2 模块职责

| 单元 | 职责 |
|------|------|
| 迁移 `004_*` | `origin_agent_id`、唯一索引 `(agent_id, vi_path)`、回填 |
| Scheduler store | 列表（含 agent 名）、按 agent 过滤、upsert、distribute |
| Scheduler API | query `agent_id`、`POST .../distribute`；注册覆盖语义 |
| Agent WebUI | 本机已注册列表 + 试跑 / 加载 |
| 中心 WebUI | 来源/机台列、分发面板 |

## 4. 数据模型

扩展 `vi_templates`（新迁移，序号接现有 migrations）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `origin_agent_id` | TEXT NOT NULL | 首次注册来源；FK `agents(id)`；分发/覆盖不修改 |
| `agent_id` | TEXT NOT NULL | 当前绑定机台（试跑归属） |
| 其余 | 不变 | `name`、`vi_path`、`cli_path`、`getinfo_path`、`inputs_json`、`show_front_panel`、`timeout_secs`、`created_at` |

行为：

- 唯一约束：`UNIQUE(agent_id, vi_path)`（normalize 后的路径；与现有 `normalize_fs_path` 一致后再写入）。
- 已有行回填：`origin_agent_id = agent_id`。
- 列表视图额外返回：`agent_name`、`origin_agent_name`（join `agents`；缺失时用短 id 或「未知」）。

分发 / 覆盖写入时：

- 从源复制：`name`、`inputs_json`、`show_front_panel`、`timeout_secs`，以及最终 `vi_path`（源路径或请求覆盖值）。
- `origin_agent_id`：等于**源模板**的 `origin_agent_id`（不是目标、也不改成操作者）。
- `cli_path` / `getinfo_path`：写入**目标 Agent** 当时 `GET .../labview/config` 的值；拉失败则该目标失败、不落库。

注册 `POST /api/vi-templates`：若同机同 `vi_path` 已存在 → 覆盖业务字段，**不重置**已有 `origin_agent_id`。

## 5. API

### 5.1 中心

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/vi-templates` | 全量；含 `origin_agent_id` 与名称字段 |
| `GET` | `/api/vi-templates?agent_id=` | 仅该机绑定模板 |
| `POST` | `/api/vi-templates` | 注册；同路径覆盖（见 §4） |
| `POST` | `/api/vi-templates/{id}/distribute` | 分发 |
| 现有 | `GET/DELETE /api/vi-templates/{id}`、LabVIEW 代理 | 保留 |

**分发请求：**

```json
{
  "target_agent_ids": ["uuid-a", "uuid-b"],
  "vi_path": null
}
```

- `vi_path`：省略或 `null` → 各目标使用源模板路径；有值 → 所有目标统一用该路径（经 `normalize_fs_path`）。
- 源机台出现在 `target_agent_ids` 中 → 该项 `skipped`（或从列表排除），不报整单失败。
- 响应：

```json
{
  "results": [
    { "agent_id": "...", "status": "created", "template_id": "..." },
    { "agent_id": "...", "status": "updated", "template_id": "..." },
    { "agent_id": "...", "status": "error", "error": "..." },
    { "agent_id": "...", "status": "skipped", "error": "source agent" }
  ]
}
```

部分失败不回滚已成功项。HTTP：源模板不存在 → 404；请求体非法 → 400；有任一目标处理则 200（由 `results` 表达成败）。

### 5.2 Agent

- 不新增本地持久化。
- 列表：WebUI（或薄封装 API）使用已有 `resolve_agent_id` + 中心 `GET /api/vi-templates?agent_id=`。
- 试跑：本机 `POST /api/labview/run`，body 来自所选模板字段。

## 6. UI

### 6.1 中心 VI 页

- 模板表列：名称、**当前机台**、**来源机台**、路径、超时、操作。
- 操作：试跑、**分发**、删除。
- 分发面板：多选目标 Agent（排除当前 `agent_id`）、可选路径覆盖、提交后展示逐台结果。
- 可选：按机台筛选（对齐 query）。

### 6.2 Agent VI 页

- 「已注册功能」：本机模板列表。
- 行操作：试跑；可选「加载到编辑区」再改 inputs 后试跑。
- 中心不可达或无法解析本机 `agent_id`：明确错误提示，不假装空成功。

## 7. 错误处理

| 情况 | 行为 |
|------|------|
| 分发目标 Agent 不存在 | 该项 `error` |
| 目标 labview config 失败 | 该项 `error`，不写库 |
| 同机同路径 | UPDATE；保留 `origin_agent_id` |
| Agent 拉列表失败 | UI 展示错误 |

## 8. 测试要点

- 迁移回填与 `UNIQUE(agent_id, vi_path)`。
- distribute：created / updated / 保留 origin / skipped 源机 / 部分失败。
- `GET ?agent_id=` 过滤正确。
- 注册同路径覆盖不重置 origin。
- Agent：能按 self id 过滤；试跑使用模板字段（API 或现有 run 契约即可）。

## 9. 实现备注

- Agent 侧已有 `resolve_agent_id`（`crates/agent/src/register.rs`），列表拉取应复用，无需新的身份协议。
- 路径写入前统一 `normalize_fs_path`，与现有注册行为一致。
