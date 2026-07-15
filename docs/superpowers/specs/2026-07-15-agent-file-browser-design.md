# Agent 文件浏览（中心预览/下载）设计规格

**日期：** 2026-07-15  
**状态：** 已批准（待实现计划）  
**依赖：** `docs/superpowers/specs/2026-07-15-scheduler-agent-design.md`  
**参考样例结构：** 结果包目录形如 `GODT*(...)`，根下 `.txt`，子目录 `EyeDiagram/<n>/CH*.gif`

## 1. 目标

通过调度中心 WebUI，对指定 Agent **只读浏览**其配置根目录下的文件树，支持：

- 面包屑进入子目录（适配结果包子目录如 `EyeDiagram/35`）
- 预览与下载 **`.txt`**、**`.gif`**（扩展名大小写不敏感）
- 全部经中心代理；**中心不落盘归档**

成功标准：

- 配置 `AGENT_FILES_ROOT` 为样例类结果根后，中心可列出根下 txt、进入 `EyeDiagram/35` 预览 gif。
- 路径无法逃逸出根目录；非法扩展名不可取内容。
- Agent 离线时中心返回明确错误，浏览器不直连 Agent。

## 2. 非目标（YAGNI）

- 中心侧文件归档 / 同步整包
- 上传、删除、重命名、编辑
- `.md` / `.pdf` / `.png` 等其它格式预览（首版）
- 浏览器直连 Agent
- 鉴权 / TLS（沿用内网信任模型）
- Agent 本机 WebUI 文件管理（首版不做）

## 3. 架构

```text
[中心 WebUI「文件」] --> scheduler:26630
                              |  GET /api/agents/{id}/files?path=
                              |  GET /api/agents/{id}/files/content?path=
                              v
                         agent:26631
                              |  resolve under AGENT_FILES_ROOT
                              v
                         本地文件系统（只读）
```

### 3.1 模块

| 单元 | 职责 |
|------|------|
| agent `files` | 路径规范化与 jail、列目录、读文件 |
| agent API | `/api/files`、`/api/files/content` |
| scheduler 代理 | 转发字节流与 JSON；连接失败 → 503 |
| scheduler WebUI | 文件浏览器：面包屑、列表、预览、下载 |

### 3.2 启用条件

- Agent 环境变量 **`AGENT_FILES_ROOT`** 指向存在的目录。
- 未配置或路径无效：Agent 文件 API 返回 **503** + `ErrorBody`（例如 `"files root not configured"` / `"files root not found"`）。

## 4. 路径规则

- 查询参数 `path`：相对根目录；空或缺省表示根。
- URL 编码传输。
- 规范化步骤（实现必须按此顺序写死）：
  1. 将 `\` 替换为 `/`；去掉首尾 `/`。
  2. 若为绝对路径（含盘符前缀如 `C:` 或以 `/` 开头的绝对含义在 Windows join 前检测）→ **400**。
  3. 按 `/` 分段，任一节为 `..` 或 `.` 之外的空段规则：拒绝含 `..` 的段 → **400**；忽略单独的 `.` 段。
  4. `FILES_ROOT.join(relative)`，再 `canonicalize`；结果必须以 canonicalize 后的 `FILES_ROOT` 为前缀，否则 **400**。
- 列表可返回任意子目录与其中文件名（含非 txt/gif）。
- **取内容**仅允许扩展名为 `txt` 或 `gif`（比较时小写）；否则 **403**。

## 5. API

### 5.1 Agent `:26631`

#### `GET /api/files?path=`

成功 `200` JSON：

```json
{
  "path": "EyeDiagram/35",
  "entries": [
    { "name": "CH1.gif", "kind": "file", "size": 260851, "ext": "gif" },
    { "name": "subdir", "kind": "dir" }
  ]
}
```

规则：

- `path` 指向非目录 → **400**
- 不存在 → **404**
- 排序：目录在前，然后按 `name` 大小写不敏感字典序
- `ext` 仅存在于 `kind=file`（无点后缀则空字符串或省略；写死为 **小写无点**，无后缀则 `""`）
- `size` 为字节数，`dir` 可省略 `size`

#### `GET /api/files/content?path=&download=`

- `download` 缺省/`0`：预览；`1`：`Content-Disposition: attachment; filename="<name>"`
- `.txt`：`Content-Type: text/plain; charset=utf-8`，正文为文件字节按 **UTF-8 lossy**（`String::from_utf8_lossy`）再编码为 UTF-8 响应；或直接发送原字节并标 UTF-8——写死为：**原文件字节原样返回，Content-Type 声明 utf-8**（浏览器按字节解码；避免二次转码破坏）。空文件合法。
- `.gif`：`Content-Type: image/gif`，原样字节。
- 文件大小 **> 20 MiB**（`20 * 1024 * 1024`）→ **413** + `ErrorBody`
- 不允许的扩展名 → **403**
- 不存在 → **404**
- 路径非法 → **400**

### 5.2 调度中心 `:26630`

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | `/api/agents/{id}/files?path=` | 查 Agent；转发至 Agent 同路径查询；透传状态码与 body |
| GET | `/api/agents/{id}/files/content?path=&download=` | 同上，透传响应头中的 Content-Type / Content-Disposition |

- Agent 不存在 → **404**
- HTTP 客户端连接/超时失败 → **503** + `ErrorBody`（不伪造 Agent 内容）
- 使用现有带超时的 `reqwest::Client`（与截图一致）

## 6. WebUI

调度中心 Agent 列表增加 **文件**：

- 面包屑导航：`根` 与各级 `path` 段
- 表格：名称、类型（目录/文件）、大小；目录可点击进入；文件行：
  - `txt` / `gif`：**预览**、**下载**
  - 其它扩展名：无预览/下载按钮（仍显示名称）
- 预览弹层：
  - txt：`<pre>` 加载 content API（非 download）
  - gif：`<img src=".../files/content?path=...">`
- 下载：`.../files/content?path=...&download=1`（可用新窗口或 `<a download>`）

语言：中文。样式：延续现有内网工具页。

## 7. 错误处理摘要

| 场景 | Agent | 中心 |
|------|-------|------|
| 未配置/无效根 | 503 | 透传 |
| 路径非法/逃逸 | 400 | 透传 |
| 不存在 | 404 | 透传 |
| 扩展名不允许 | 403 | 透传 |
| 文件过大 | 413 | 透传 |
| Agent 不可达 | — | 503 |

日志：记录 agent_id、相对 path、错误原因；不记录完整文件 body。

## 8. 测试计划

- **Agent files 单元/集成（临时目录）：**
  - 列出根与子目录（含 EyeDiagram 式嵌套）
  - 读取样例大小的 txt/gif fixture
  - `path=../escape` → 400
  - `path` 指向 `.pdf` 取 content → 403
  - 超大文件 → 413（可用截断夹具或 mock metadata，也可用略大于上限的临时文件）
- **Scheduler：** mock Agent 代理 JSON 与字节；unreachable → 503
- **手工：** `AGENT_FILES_ROOT` 指向样例文件夹 → 中心预览 `Log.txt` 与 `EyeDiagram/35/CH1.gif` 并下载

## 9. 配置与文档

- Agent：`AGENT_FILES_ROOT`（绝对路径推荐）
- 更新中文 README：文件浏览能力、仅 txt/gif、根目录配置、不归档、路径限制

## 10. 决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 根目录 | Agent 配置 | 用户选定 |
| 浏览方式 | 面包屑目录树 | 用户选定 |
| 格式 | 仅 txt/gif | 用户选定（对齐样例） |
| 传输 | 中心实时代理、不落盘 | 用户选定 |
| 非目标格式 | 列表可见无打开 | 兼顾可见性与 YAGNI |
| 大小上限 | 20 MiB | 与截图一致 |
