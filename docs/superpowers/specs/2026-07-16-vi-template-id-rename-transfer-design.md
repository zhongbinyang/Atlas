# VI 模板按 id 管理 / 改名 / 分发挪机设计规格

**日期：** 2026-07-16  
**状态：** 已批准（待实现计划）  
**依赖：**

- `docs/superpowers/specs/2026-07-16-labview-vi-templates-design.md`
- `docs/superpowers/specs/2026-07-16-vi-list-and-distribute-design.md`
- `docs/superpowers/specs/2026-07-16-vi-run-sequence-design.md`

**技术栈：** 现有 Rust workspace（Axum + SQLite + Windows Agent）。

## 1. 目标

支持「同一 VI 路径、不同入参」注册为多条独立功能，并用名称区分；支持在 Agent 与中心 **按 id 重命名**；分发时 **保留同一模板 id**，将归属机台改为目标 Agent（挪机，非复制）。

成功标准：

- 同机对同一 `vi_path` 可注册多条（不同 id、不同 name/inputs）。
- Agent 与中心均可将模板改名为非空显示名。
- 分发后：行 `id` 不变，`agent_id` 变为目标机；源机列表不再出现该模板；源机运行队列中对该 id 的引用被清除。

## 2. 非目标（YAGNI）

- 同一 `id` 在多台 Agent 上各持一份（复制语义）。
- 以 `(agent_id, name)` 或 `(agent_id, vi_path)` 作为唯一约束。
- 分发后自动把模板加入目标机 `vi_run_queue_items`。
- 中心多选目标一次分发（一次只挪到一台）。

## 3. 架构与数据流

```text
注册 → 始终 INSERT 新 id（name 必填）
改名 → PATCH /api/vi-templates/{id}（Agent 代理或中心直连）
分发 → UPDATE 同行 agent_id（+ 目标 cli/getinfo）；删源机队列引用
```

### 3.1 Schema 变更

迁移（例：`006_vi_template_drop_path_unique.sql`）：

- `DROP INDEX IF EXISTS idx_vi_templates_agent_vi_path`（或当前唯一索引名）。
- 不再引入路径/名称唯一索引；主键仍为 `id`。

### 3.2 注册语义变更

- `POST /api/vi-templates`：**始终新建**，不再按 `(agent_id, vi_path)` upsert。
- 请求 `name`：**必填**（trim 后非空）；400 if missing。
- `origin_agent_id`：新建时 = `agent_id`。
- 删除 `upsert_vi_template` 的路径冲突更新路径，或改为仅 insert；分发改用「按 id 更新归属」专用方法。

### 3.3 分发语义变更

原：目标机按 `vi_path` upsert 出**新 id**。  
新：

1. 校验源模板、目标 Agent 存在。  
2. `UPDATE vi_templates`：`agent_id = target`；`cli_path`/`getinfo_path` 取目标机当前 labview config；`vi_path` 可用请求覆盖否则保留；`name`/inputs/选项保留；**`id`、`origin_agent_id` 不变**。  
3. `DELETE FROM vi_run_queue_items WHERE vi_template_id = ?`（清除任意机台上对该 id 的队列引用；实际上源机有引用）。  
4. 请求体改为单目标：

```json
{ "target_agent_id": "uuid", "vi_path": null }
```

- 若 `target_agent_id ==` 当前 `agent_id` → 400 或 skipped。  
- 中心 WebUI：分发面板改为单选一个 Agent；文案提示源机将失去该模板。

### 3.4 改名 / 更新 API

**中心：** `PATCH /api/vi-templates/{id}`

```json
{
  "name": "可选新名称",
  "inputs": null,
  "show_front_panel": null,
  "timeout_secs": null
}
```

- 至少提供一个字段；`name` 若出现则必须非空。  
- 404 if 不存在。  
- 不修改 `id` / `agent_id` / `origin_agent_id` / `vi_path`（路径改用分发覆盖或另议；本规格 PATCH 不改 `vi_path`）。

**Agent：** `PATCH /api/labview/templates/{id}` → `resolve` 后转发中心；可选校验模板当前 `agent_id` 为本机（推荐：仅本机可改，否则 404/403）。

## 4. UI

### 4.1 Agent

- 注册表单：名称输入（必填），默认可填 VI 文件名 stem，可改。  
- 已注册列表：「重命名」→ PATCH。  
- 序列页左侧随名称刷新。

### 4.2 中心

- VI 模板表：「重命名」。  
- 「分发」：单选目标机 + 可选路径；确认文案说明挪机。

## 5. 错误处理

| 情况 | 行为 |
|------|------|
| 注册缺 name | 400 |
| PATCH 空 name | 400 |
| 分发目标不存在 / 源不存在 | 404 |
| 分发到自己 | 400 |
| 目标 labview config 失败 | 502/error，不改归属 |

## 6. 测试要点

- 同机同路径两次 POST → 两行不同 id。  
- PATCH 改名成功；空名失败。  
- 分发：id 不变，`agent_id` 变；源 list 无该 id；源队列无引用。  
- Agent 代理 PATCH / 注册带 name。  
- 旧「路径 upsert / 多目标 distribute」测试改为新语义。

## 7. 实现备注

- `upsert_vi_template_distribute`（按路径）删除或替换为 `transfer_vi_template(id, target_agent_id, …)`。  
- 中心分发 UI 与 API 同步改为单目标，避免静默只处理第一项。  
- README：说明同路径可多注册；分发为挪机非复制。
