# Design: 测试运行落本地 PostgreSQL

**日期：** 2026-08-15  
**状态：** 已批准  
**范围：** 机台通道终态回写 atlas-center 本地 Postgres；中心可按机台 / 时间 / 总结果 / SN 查询。

## 1. 目标

一次通道序列跑完后，结果进入中心本地 PostgreSQL。机台本机 `sequence_runs/*.json` 只当备份。中心重启或机台清掉日志后，这次运行仍然能查到。

成功标准：

- 机台跑完一条通道序列，中心库有对应 `test_runs` + `test_run_context` + `test_run_steps`。
- 机台重启或删除本机日志，中心记录仍在。
- 中心 `GET /api/test-runs` 可按机台、时间、总结果过滤；有 SN 时能按 SN 查。
- 中心 WebUI `#/runs` 能列出运行并打开逐步详情。
- 回写失败不改变操作员看到的序列 HTTP 结果（与现有文件日志失败策略一致）。

## 2. 非目标

- 不接 Camstar / MES / 外部报表库。
- 不加鉴权、TLS、API `/v1`。
- 不恢复机台运行页的 SN / 工单输入。
- 不落库进行中进度（仍走 `GET /api/sequence/run/progress`）。
- 不存整份有效变量表、不存 VI 原始 stdout。
- 不做良率看板、SPC、删除/改写历史、定时清理。
- 不改序列判定语义、通道模型、LabVIEW CLI。
- 不改本机 `sequence_runs` 文件格式；文件日志继续写。

## 3. 已锁定决策

| 主题 | 选择 |
|------|------|
| 数据源 | 仅中心本地 PostgreSQL |
| 粒度 | **一条 `test_runs` = 一个通道的一次终态**（不是一次多通道 HTTP 请求） |
| 写入时机 | 通道到达 `pass` / `fail` / `error` / `aborted` 后立刻 POST；不等兄弟通道 |
| 谁写库 | 机台进程 POST 中心；机台不连数据库 |
| 进行中状态 | 不写库 |
| 身份字段 | 独立 1:1 表 `test_run_context`；无 SN 也插空行 |
| 不可变 | 已写入的 run 不更新、不删除 |
| 幂等 | 机台在通道开工时生成 UUID；重复 POST 同一 `id` 返回已有行 |
| 回写失败 | 不影响序列 HTTP；打 warn；本机 JSON 仍在。第一期不建补报队列 |
| 时间戳 | TEXT RFC3339（与现表一致） |
| 机台 UI | 不改运行页 |
| 中心 UI | 新增 `#/runs` |

未选方案：按 HTTP 请求攒一批再写（通道独立开停会对不齐）；中心轮询 progress 落库（中心没有完整逐步 JSON，且会把归档和实时混在一起）。

## 4. 架构

```text
操作员开测
    │
    v
atlas-station 通道 worker 跑完
    │
    ├─ 本机 sequence_runs/*.json     （现有，保留）
    └─ POST /api/test-runs           （新增，best-effort）
              │
              v
        atlas-center:9080
              │
              v
        本地 PostgreSQL
          test_runs
          test_run_context
          test_run_steps
```

中心是唯一写库方。机台用已有 `center_url` + `http_client`，`agent_id` 用现有 `resolve_agent_id`（与注册/拉配置同一套）。

## 5. 数据模型

迁移：`atlas-center/migrations/028_test_runs.sql`。

### 5.1 `test_runs`

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | 机台生成的 UUID |
| `agent_id` | TEXT NULL | `REFERENCES agents(id) ON DELETE SET NULL` |
| `channel_index` | INTEGER NOT NULL | |
| `channel_name` | TEXT NOT NULL | 当时显示名快照 |
| `sequence_template_id` | BIGINT NULL | `REFERENCES sequence_templates(id) ON DELETE SET NULL` |
| `run_generation` | BIGINT NOT NULL | 机台 `TaskSlot` generation，仅供对照，不当全局键 |
| `overall` | TEXT NOT NULL | 通道结果：`pass` / `fail` / `error` / `aborted` |
| `stopped` | BOOLEAN NOT NULL | 与 `SequenceResponse.stopped` 相同 |
| `failed_at` | INTEGER NULL | 失败步骤 `position` |
| `elapsed_ms` | BIGINT NOT NULL | 通道总耗时 |
| `started_at` | TEXT NOT NULL | worker 开工，**UTC** RFC3339（`chrono::Utc::now().to_rfc3339()`） |
| `finished_at` | TEXT NOT NULL | worker 结束，UTC RFC3339 |
| `created_at` | TEXT NOT NULL | 中心落库时间，UTC RFC3339 |

索引：

- `(finished_at DESC, id DESC)` — 默认列表
- `(agent_id, finished_at DESC)` — 按机台
- `(overall, finished_at DESC)` — 按结果

`overall` 存**通道**结果，不是站级聚合。站级 `fail`（任一通道 fail/error/aborted）只存在机台 HTTP 响应里，不单独建批次行。

### 5.2 `test_run_context`

与 `test_runs` 1:1，每次必插一行（字段可空串）。

| 列 | 类型 | 说明 |
|----|------|------|
| `test_run_id` | TEXT PK | `REFERENCES test_runs(id) ON DELETE CASCADE` |
| `sn` | TEXT NOT NULL DEFAULT `''` | 请求体或步骤输出解析到的 SN |
| `work_order` | TEXT NOT NULL DEFAULT `''` | |
| `product_pn` | TEXT NOT NULL DEFAULT `''` | 第一期恒为 `''` |
| `corner` | TEXT NOT NULL DEFAULT `''` | 第一期恒为 `''` |
| `hostname` | TEXT NOT NULL DEFAULT `''` | 机台 `AppState.hostname` |
| `config_revision` | BIGINT NULL | 有则写，没有则空 |
| `device_profile_id` | TEXT NOT NULL DEFAULT `''` | |
| `device_profile_name` | TEXT NOT NULL DEFAULT `''` | |
| `calibration_profile_id` | TEXT NOT NULL DEFAULT `''` | |
| `calibration_profile_name` | TEXT NOT NULL DEFAULT `''` | |

索引：`(sn)`，仅用于 SN 过滤。空串不参与「有 SN」语义：查询 `sn=X` 时用精确匹配，不把空串当通配。

第一期不从变量里猜 PN / 温度角。列先留着，避免以后再迁一次。

### 5.3 `test_run_steps`

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | BIGSERIAL PK | |
| `test_run_id` | TEXT NOT NULL | `REFERENCES test_runs(id) ON DELETE CASCADE` |
| `position` | INTEGER NOT NULL | 队列 position |
| `queue_item_id` | TEXT NOT NULL | |
| `template_id` | TEXT NOT NULL | |
| `template_source` | TEXT NOT NULL | `labview` / `general` |
| `name` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL | |
| `ok` | BOOLEAN NOT NULL | |
| `status` | TEXT NOT NULL | 步骤状态（`pass` / `fail` / `error` / `aborted` / `skipped` 等，与现网 `SequenceStepResult.status` 一致） |
| `elapsed_ms` | BIGINT NOT NULL | |
| `measured_json` | JSONB NULL | |
| `limits_json` | JSONB NULL | |
| `result_json` | JSONB NULL | |
| `error` | TEXT NULL | |
| `spec_template_id` | BIGINT NULL | 步骤当时引用，不建 FK（模板可删） |
| `spec_section` | TEXT NOT NULL DEFAULT `''` | 展开前的 section 字符串 |

唯一：`(test_run_id, position)`。  
索引：`(test_run_id, position)`。

不存逐步 `inputs`、不存 CLI 原始输出。`measured` / `limits` / `result` 与现有文件日志同形。

### 5.4 外键与删除

- 删机台：`test_runs.agent_id` 置空，历史行留下（`hostname` 仍在 context）。
- 删序列模板：`sequence_template_id` 置空。
- 删一次 run：只允许级联自 `test_runs`；第一期 API **不提供 DELETE**。

## 6. 写入路径

通道 worker 在 `channel_run` 里得出 `ChannelSequenceResponse` 之后，立刻 `tokio::spawn` POST 中心，然后才把该通道汇入站级响应。每个通道各写一次，不等待兄弟通道，也不等待 POST 返回。

本机 `write_sequence_run_log` **仍留在现有** `log_multi_channel_run`（按一次 HTTP 请求写一份多通道 JSON）。本规格不改文件日志时机或形状。

```text
通道 worker 结束
  → 取出开工时生成的 run_id
  → 组 payload
  → spawn POST {center}/api/test-runs
  → 2xx / 同 id 已存在的 200：结束
  → 网络/5xx/400：warn，不建补报队列
```

`run_id` 在通道 **admission 成功时**生成（与 `run_generation` 同时），这样中止/失败/panic 转 error 也能用同一 id 落库。panic 汇成 `overall=error`、`steps=[]` 的行也要 POST。

机台组包时：

- `agent_id`：`resolve_agent_id`；失败则这次不写库并 warn（没有稳定机台键就不要插孤儿行）。
- `sn` / `work_order`：该通道 `SequenceResponse` 上的值，缺则 `''`。
- `started_at` / `finished_at`：该 worker 的 UTC RFC3339。
- `sequence_template_id`：本次 `POST /api/sequence/run` 带来的值，可空。
- 设备/校验档：若本次通道解析结果里已有 id/name 就写入；没有则空串。第一期允许全空，不为此去中心再拉一遍配置。
- 步骤：`steps_log_json` 现有字段 + 队列项上的 `spec_template_id` / `spec_section`。

回写与操作员 HTTP 解耦：POST 中心放在不阻塞 `POST /api/sequence/run` 成功路径的 best-effort 调用里（可 `tokio::spawn`；进程退出前不要求 join）。单测用注入的 persist 钩子断言「调用了 / 失败也被吞掉」。

## 7. API

协议补进中心 `docs/api.md`。第一期不加 `/v1`。

### 7.1 `POST /api/test-runs` · 使用方：**Agent 进程**

Body：

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "agent_id": "…",
  "channel_index": 0,
  "channel_name": "CH0",
  "sequence_template_id": 12,
  "run_generation": 42,
  "overall": "pass",
  "stopped": false,
  "failed_at": null,
  "elapsed_ms": 1234,
  "started_at": "2026-08-15T14:00:00+00:00",
  "finished_at": "2026-08-15T14:01:02+00:00",
  "context": {
    "sn": "SN001",
    "work_order": "WO-1",
    "product_pn": "",
    "corner": "",
    "hostname": "ATE01",
    "config_revision": 3,
    "device_profile_id": "",
    "device_profile_name": "",
    "calibration_profile_id": "",
    "calibration_profile_name": ""
  },
  "steps": [
    {
      "position": 1,
      "queue_item_id": "q-1",
      "template_id": "12",
      "template_source": "labview",
      "name": "TX_AP",
      "kind": "labview",
      "ok": true,
      "status": "pass",
      "elapsed_ms": 100,
      "measured": { "TX_AP": 1.2 },
      "limits": [{ "output": "TX_AP", "min": -2, "max": 4 }],
      "result": { "TX_AP": "pass" },
      "error": null,
      "spec_template_id": 1,
      "spec_section": "FMT_HT"
    }
  ]
}
```

校验：

| 条件 | 响应 |
|------|------|
| `id` 非空且可作主键 | 否则 400 |
| `overall` 为 `pass` / `fail` / `error` / `aborted` | 否则 400 |
| `channel_index` ≥ 0 | 否则 400 |
| `started_at` / `finished_at` 非空 | 否则 400 |
| `agent_id` 在 `agents` 中不存在 | 400（不要插悬挂 FK） |
| `sequence_template_id` 指向不存在模板 | 当作 `null` 写入，不 400 |
| 同 `id` 已存在 | **200** + 已有完整资源（不覆盖） |
| 写入成功 | **201** + 完整资源（含 steps、context） |

`context` 可省略，视为全空默认。`steps` 可空数组（例如 worker panic）。

机台无对应 GET/代理页。中心 WebUI 不调用 POST。

### 7.2 `GET /api/test-runs` · 使用方：**中心 WebUI**

Query：

| 参数 | 含义 |
|------|------|
| `agent_id` | 精确 |
| `overall` | 精确 |
| `sn` | 精确匹配 `test_run_context.sn`；空参数忽略，不匹配空串 |
| `from` | `finished_at` ≥ 此字符串；调用方应传 UTC RFC3339（与库内格式一致，按 TEXT 比较） |
| `to` | `finished_at` ≤ 此字符串；同上 |
| `limit` | 默认 100，最大 200 |
| `offset` | 默认 0 |

排序：`finished_at DESC, id DESC`。

列表项不含 `steps`，含 context 摘要（`sn` / `work_order` / `hostname`）：

```json
{
  "items": [
    {
      "id": "…",
      "agent_id": "…",
      "channel_index": 0,
      "channel_name": "CH0",
      "sequence_template_id": 12,
      "overall": "pass",
      "elapsed_ms": 1234,
      "started_at": "…",
      "finished_at": "…",
      "sn": "SN001",
      "work_order": "WO-1",
      "hostname": "ATE01"
    }
  ],
  "total": 1
}
```

`total` 为过滤后的总行数，供分页。

### 7.3 `GET /api/test-runs/{id}` · 使用方：**中心 WebUI**

返回 POST 成功时的完整资源（run + context + 按 `position` 排序的 steps）。不存在 → 404。

第一期无 PATCH / DELETE。

## 8. 中心 WebUI

路由 `#/runs`，顶栏「运行」放在「序列模板」和「机台配置」之间。

**列表：** 结束时间、机台名（`agent_id` 解析不到则显示 hostname / id）、通道、总结果、SN、耗时。筛选：机台、总结果、SN。默认最近 100 条。

**详情：** 点行进入 `#/runs/{id}`。头里展示通道、总结果、时间、SN/工单（空则显示「—」）。表列与机台通道详情同语义：步骤、状态、实测、限值、耗时、错误。不提供重跑、中止、改队列。

机台 WebUI 不增加「已上传中心」标记。

## 9. 错误处理

| 情况 | 行为 |
|------|------|
| 中心不可达 / 超时 | 机台 warn；序列 HTTP 仍返回通道结果；本机 JSON 已写 |
| `resolve_agent_id` 失败 | 不 POST；warn |
| POST 400（除未知模板被吞掉外） | warn；不重试 |
| 同 id 再 POST | 200，当作成功 |
| 列表/详情查库失败 | 中心 API 500 + `{ "error": "…" }` |
| 历史行的 `agent_id` 已空 | 列表用 `hostname` 或 `—` |

## 10. 测试

**中心 store / API**

- 插入 run + context + 多步 → GET 详情字段一致。
- 同 id 第二次 POST → 200，steps 不被覆盖。
- 非法 `overall` / 空 id / 未知 `agent_id` → 400。
- 未知 `sequence_template_id` → 仍 201，该列 null。
- 列表：`agent_id` / `overall` / `sn` / 时间窗过滤正确；`sn` 空参数不返回 `sn=''` 的「误匹配」。
- `total` 与过滤一致。

**机台**

- 通道终态会调用 persist（注入钩子），payload 含该通道 `channel_index` / `overall` / steps。
- persist 返回错误时，`POST /api/sequence/run` 仍 200 且通道结果不变。
- worker panic 转 `error` 后仍尝试 persist（`steps=[]`）。

**前端**

- `#/runs` 出现在顶栏；列表渲染筛选后的摘要。
- 详情页展示逐步状态；缺 SN 显示「—」。

## 11. 文档

- `docs/api.md` §0.3 表清单加上三张表；新增 §1.x / 使用方标记。
- 中心 README：运行结果落库；本机 JSON 仍是备份。
- 机台 README：一句「终态会 POST 中心 `/api/test-runs`，失败不影响开测结果」。

## 12. 分期

| 阶段 | 内容 | 完成标志 |
|------|------|----------|
| **P0** | 迁移 + store + POST/GET API + 机台终态回写 | `cargo test`；手工：跑一通道 → `GET /api/test-runs` 看得到 |
| **P1** | 中心 `#/runs` 列表与详情 | 浏览器能按机台/结果/SN 查到刚跑的那次 |

P0 可先不改前端。P1 不改写入契约。

## 13. 风险

- 通道并行时会并发 POST；用 UUID 主键，不要用 `(agent_id, channel_index, finished_at)` 当唯一键。
- `run_generation` 在机台重启后会重计，不能当全局幂等键。
- 回写异步时，操作员刷新中心可能比机台结果页晚几百毫秒。接受，不为此改成同步挡开测。
- 旧 `sequence_runs` 文件不会回灌。只保证本功能上线之后的运行进库。
