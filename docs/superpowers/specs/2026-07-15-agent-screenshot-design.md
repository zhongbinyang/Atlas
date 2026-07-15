# Agent 桌面截图（中心查看）设计规格

**日期：** 2026-07-15  
**状态：** 已批准（待实现计划）  
**依赖：** `docs/superpowers/specs/2026-07-15-scheduler-agent-design.md`  
**技术栈：** 现有 Rust workspace（Axum + SQLite + Windows Agent）

## 1. 目标

通过**调度中心 WebUI**，操作者可对某个已注册 Agent **按需**抓取其电脑**主显示器**当前画面，并在中心页面查看；**每一次成功的截图都永久归档**（磁盘文件 + SQLite 元数据），可按 Agent 回看历史。

成功标准：

- 中心 Agent 列表可一点即截，展示刚拍的主屏 PNG。
- 同 Agent 的历史截图可列出并打开；默认不做自动删除。
- 浏览器只访问中心（`:26630`），不直连 Agent。

## 2. 非目标（YAGNI）

- 自动定时刷新 / 准实时视频流
- 多显示器整屏拼接或选屏（仅主显示器）
- 截图自动清理（按数量/天数）
- 浏览器直连 Agent 取图
- 身份鉴权 / TLS（沿用现有内网信任模型）
- Agent 本机 WebUI 截图能力（首版不做；调试可直接调 Agent API）
- 远程键鼠控制

## 3. 架构

沿用中心主动调用 Agent 的模型：

```text
[中心 WebUI] --> scheduler:26630
                     |  POST /api/agents/{id}/screenshots
                     |  GET  http://{ip}:{port}/api/screenshot
                     v
                agent:26631 --> 主屏捕获 --> image/png
                     |
                     v
          落盘 data/screenshots/{agent_id}/{id}.png
          + INSERT screenshots 元数据
                     |
                     v
          WebUI: <img src="/api/screenshots/{id}/image">
```

### 3.1 模块边界

| 单元 | 职责 | 依赖 |
|------|------|------|
| agent `capture` | 捕获主显示器为 PNG 字节 | Windows API / 截图 crate |
| agent `GET /api/screenshot` | 暴露截图 HTTP | capture |
| scheduler screenshot service | 调 Agent、校验响应、写文件、写库 | reqwest、文件系统、SQLite |
| scheduler screenshot API | REST：触发 / 列表 / 元数据 / 图片 | service + store |
| scheduler WebUI | 截图按钮、弹层、历史列表 | 上述 API |

### 3.2 Windows 会话说明

截图需要可访问的交互桌面。若 Agent 运行在无法看到用户桌面的会话中（例如部分 Windows 服务场景），捕获可能失败；失败时返回明确错误，不写档案。

## 4. 数据模型

### 4.1 表 `screenshots`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PRIMARY KEY | UUID |
| agent_id | TEXT NOT NULL | FK → agents.id |
| file_path | TEXT NOT NULL | 相对于调度中心进程工作目录的路径，形如 `data/screenshots/{agent_id}/{id}.png` |
| content_type | TEXT NOT NULL | 固定 `image/png` |
| byte_size | INTEGER NOT NULL | 字节数 |
| width | INTEGER NULL | 可知则填 |
| height | INTEGER NULL | 可知则填 |
| created_at | TEXT NOT NULL | ISO-8601 |

索引：`(agent_id, created_at DESC)` 便于历史列表。

### 4.2 磁盘布局

```text
data/screenshots/{agent_id}/{screenshot_id}.png
```

永久保留；**无**自动清理任务。运维自行管理磁盘空间。README 中增加磁盘占用提示。

失败原子性：仅在文件写入成功后插入元数据；若插入失败则删除已写文件。不允许「只有元数据没有文件」或反向半成功状态进入列表。

## 5. API

### 5.1 Agent `:26631`

| 方法 | 路径 | 成功 | 失败 |
|------|------|------|------|
| GET | `/api/screenshot` | `200`，`Content-Type: image/png`，body 为 PNG | `4xx/5xx` + JSON `ErrorBody` |

约束：

- 仅主显示器。
- 建议单次响应体上限由中心侧强制（见下）；Agent 侧正常桌面分辨率 PNG 即可。

### 5.2 调度中心 `:26630`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/{id}/screenshots` | 拉取并归档；返回截图元数据 JSON |
| GET | `/api/agents/{id}/screenshots` | 该 Agent 历史，按 `created_at` 降序 |
| GET | `/api/screenshots/{id}` | 单条元数据 |
| GET | `/api/screenshots/{id}/image` | PNG 文件流，`Content-Type: image/png` |

**POST 行为：**

1. 查 Agent；不存在 → 404。
2. `GET http://{ip}:{port}/api/screenshot`（使用现有带超时的 HTTP client）。
3. 非 2xx 或非 PNG / 空 body / 超过 **20 MiB** → 502（或 503 若连接失败），**不落盘、不写库**。
4. 写文件 → INSERT 元数据 → 返回 JSON（含 `id`、`agent_id`、`byte_size`、`created_at`、`width`/`height` 若有）。

**列表分页（首版）：**

- 支持查询参数 `?limit=50&offset=0`（默认 `limit=50`，`offset=0`；`limit` 上限 200）。响应体固定为 `{ "items": [ ...元数据... ], "total": N }`，其中 `total` 为该 Agent 截图总数。

## 6. WebUI

扩展调度中心现有「Agent 列表」：

- 列操作：**截图**、**历史**。
- **截图**：调用 POST → 弹层显示 `/api/screenshots/{id}/image`；错误用中文提示。
- **历史**：展示时间、大小；点击打开大图（同一 `.../image` 路径）。条数多时用分页参数拉取。

文案与界面语言：中文。样式延续现有实用内网工具页，不引入营销站视觉。

## 7. 错误处理

| 场景 | HTTP | 行为 |
|------|------|------|
| Agent 不存在 | 404 | ErrorBody |
| Agent 不可达 / 超时 | 503 | 不归档 |
| Agent 返回错误或无效图像 | 502 | 不归档 |
| 超过 20 MiB | 502 | 不归档 |
| 磁盘写入失败 | 500 | 不保留孤儿文件/元数据 |
| 元数据存在但文件丢失 | 404 on image | ErrorBody 或简短说明 |

日志：scheduler 记录 agent_id、错误原因；不记录完整图像 body。

## 8. 测试计划

- **Agent capture：** Windows 环境可跑真实主屏 smoke；无桌面 CI 使用 `#[cfg(windows)]` 或 `ignore`，并用注入/假实现测 API 包装层若可行。
- **Scheduler：** mock Agent 返回固定小 PNG → 断言文件存在、表记录、`GET .../image` 字节一致；Agent 500/超时 → 无新文件、无新行。
- **手工：** 双进程 → 中心截图可见主屏 → 再截一张 → 历史 ≥ 2。

## 9. 配置与文档

- 截图根目录默认：`data/screenshots`（可用环境变量 `SCHEDULER_SCREENSHOT_DIR` 覆盖，可选）。
- 响应体上限固定 **20 MiB**（常量即可，无需配置）。
- 更新中文 `README.md`：说明截图能力、永久归档与磁盘增长风险、仅主屏、中心代理。

## 10. 决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 交互 | 按需，非自动刷新 | 用户选定 |
| 显示器 | 仅主屏 | 用户选定 |
| 存档 | 每次成功永久保留 | 用户选定；磁盘自管 |
| 传输路径 | 中心代理 | 与现网模型一致；浏览器不直连产线机 |
| 存储形态 | 文件 + SQLite 元数据 | 避免 BLOB 撑爆数据库 |
| 图像格式 | PNG | 无损、实现简单 |
| Agent 本机 UI | 首版不做 | YAGNI |
