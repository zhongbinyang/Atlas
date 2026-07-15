# 调度中心 + Agent

Rust 工作区：中心 **调度服务**（端口 **26630**）与 Windows **Agent** 节点（端口 **26631**）。调度中心用 SQLite 保存 Agent、任务模板与任务，轮询 Agent 状态并下发 shell 命令。两端均提供中文 WebUI 与 REST API。

WebUI 采用「产线工控清爽」壳层：调度中心默认「机台」视图，「作业」含模板与任务；两端共享同一套 CSS 设计令牌。

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
| `SCHEDULER_DATABASE_URL` | `sqlite:data/scheduler.db` | SQLite 连接串 |
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
| `AGENT_ADVERTISE_IP` | 自动探测 | 向调度中心注册的 IP |
| `AGENT_HOSTNAME` | 系统计算机名 | 向调度中心注册的电脑名称 |
| `AGENT_FILES_ROOT` | *（可选）* | 只读文件浏览根目录（绝对路径推荐）；未配置或无效时文件 API 返回 503 |

## 运行

先构建一次：

```powershell
cargo build --release
```

**终端 A — 调度中心：**

```powershell
$env:SCHEDULER_DATABASE_URL = "sqlite:data/scheduler.db"
cargo run -p scheduler
```

浏览器打开 `http://127.0.0.1:26630` 进入调度中心 WebUI。

**终端 B — Agent（Windows）：**

```powershell
$env:AGENT_CENTER_URL = "http://127.0.0.1:26630"
cargo run -p agent
```

浏览器打开 `http://127.0.0.1:26631` 进入 Agent WebUI。

## 调度行为

调度中心在每个调度周期内，对同一 Agent **最多下发一条**排队任务。排队任务按 **FIFO**（`created_at` 升序）处理。Agent 忙碌时，后续任务保持 `queued`；若直接向 Agent 提交第二条任务，Agent 会返回 HTTP 409。

**执行中途 Agent 重启：** 若任务处于 `dispatched` 或 `running` 时 Agent 重启，调度中心恢复时可能在 Agent 侧找不到该任务（例如 HTTP 404 或其他非成功响应）。中心任务会被重新入队，之后可能再次执行。对有副作用或耗时较长的命令请按此风险设计。

## 桌面截图

调度中心 WebUI 的 Agent 列表提供 **截图** / **历史** 操作：

- **截图**：调度中心代理请求在线 Agent 的 `GET /api/screenshot`，捕获成功后归档并弹窗预览 PNG。
- **历史**：分页查看该 Agent 已归档截图（时间、大小、查看）。

**捕获范围：** Agent 仅截取 **主显示器**（primary monitor）；多显示器环境下非主屏内容不会出现在截图中。

**代理与存储：** 截图由调度中心代为调用 Agent，PNG 永久保存在 `data/screenshots/{agent_id}/{id}.png`（可用环境变量 `SCHEDULER_SCREENSHOT_DIR` 更改根目录）。元数据写入 SQLite `screenshots` 表。单张图片上限 20 MiB；非 PNG 或 Agent 不可达时返回相应错误（502/503/404）。

**磁盘风险：** 截图文件 **不会自动清理**，`data/screenshots/` 目录会随使用 **持续增长**，请自行定期删除旧文件或迁移存储。

**安全：** 截图 API 与 WebUI 同样 **无鉴权**（见上文「安全提示」），请勿在不可信网络暴露。

## 文件浏览

调度中心 WebUI 的 Agent 列表提供 **文件** 操作，只读浏览 Agent 配置根目录下的文件树：

- **列表与导航**：面包屑进入子目录；目录行可 **打开**，文件名与大小列于表格。
- **预览与下载**：仅 **`.txt`**、**`.gif`**（扩展名大小写不敏感）支持 **预览** 与 **下载**；其它扩展名仅列名，无内容操作。
- **代理与存储：** 请求由调度中心代理转发至在线 Agent 的 `GET /api/files` 与 `GET /api/files/content`；**中心不落盘**，内容不经 SQLite 归档。
- **根目录：** Agent 需设置环境变量 **`AGENT_FILES_ROOT`** 指向存在的本地目录；未配置或路径无效时 Agent 返回 503，中心 WebUI 提示错误。
- **大小限制：** 单文件读取上限 **20 MiB**；超出或非 txt/gif 扩展名返回相应错误（413/403 等）。
- **路径安全：** 相对路径不可逃逸出 `AGENT_FILES_ROOT`（规范化 + canonicalize 校验）。

**安全：** 文件 API 与 WebUI 同样 **无鉴权**（见上文「安全提示」），请勿在不可信网络暴露。

## 手工联调清单

1. **调度中心启动**：监听 `:26630`；`GET http://127.0.0.1:26630/` 返回 WebUI（200）。
2. **Agent 注册**：约 5 秒内，`GET http://127.0.0.1:26630/api/agents` 可见该 Agent 为 `online`，并带有 CPU、内存占用百分比。
3. **创建任务模板**：通过 WebUI 或 `POST /api/templates`。
4. **模板任务**：按该模板为 Agent 创建任务，状态最终变为 `succeeded`。
5. **临时任务**：提交 `cmd` / `echo ok`，状态变为 `succeeded`。
6. **忙碌排队**：先下发长任务（如 `ping -n 8 127.0.0.1`），立刻再提交一条短任务；第二条在第一条完成前保持 `queued`，之后再成功。
7. **桌面截图**：在 Agent 列表点击 **截图**，弹窗显示主屏 PNG；点击 **历史** 可浏览已归档记录。
8. **文件浏览**：将 Agent 的 `AGENT_FILES_ROOT` 指向样例结果目录；在 Agent 列表点击 **文件**，浏览根下 `Log.txt` 与进入 `EyeDiagram/35` 预览 `CH1.gif`，并验证下载。

## 测试

```powershell
cargo test --workspace
```

## 目录结构

```
crates/
  common/     共享类型与 API 模型
  scheduler/  调度中心服务 + WebUI
  agent/      Windows 执行节点 + WebUI
```
