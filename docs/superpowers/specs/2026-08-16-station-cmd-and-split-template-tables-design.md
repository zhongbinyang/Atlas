# Design: 命令行步骤与四类功能分表

**日期：** 2026-08-16  
**状态：** 已批准  
**范围：** atlas-station 新增「命令行」页与 `kind=cmd` 序列步骤；atlas-center 将 REST 从 `general_templates` 迁出，并新增 `cmd_templates`。VI / 通用 / REST / 命令行各用独立表。

## 1. 目标

工程师在机台上试跑本机可执行文件，注册到中心后可加入序列。开测时该步在机台上 `CreateProcess`，用期望退出码判定（默认 0），不改现有 Pass/Fail 引擎。

成功标准：

- 顶栏 REST 与序列之间有「命令行」，路由 `#/cmd`。
- 可填程序路径、参数（一行一个）、可选工作目录、超时、期望退出码；试跑后能注册。
- 开测中（同一 `TaskSlot` 忙）不能试跑命令行。
- 序列「加入功能」能选到已注册命令行模板；执行结果含 `ok` / `exit_code` / `stdout` / `stderr`。
- 无 limits 时 `ok: false` → Fail（与 REST 相同挂钩）。
- 中心四张功能表：`vi_templates`、`general_templates`（仅 delay/version）、`rest_templates`、`cmd_templates`。
- 已有 `kind=rest` 的通用模板迁到 `rest_templates`，序列/队列外键改对，开测与中心列表不丢数据。
- JSON 字段名仍是 `agent_id`、`origin_agent_id`、`created_by_agent_id`。

## 2. 非目标

- 不把 delay 与 version 再拆成两张表。
- 不经 `cmd.exe /c` 跑整行命令，不做管道、重定向、stdin、自定义环境变量。
- 不改 `judge_limits` / Fail 策略语义；不恢复 SN/工单输入。
- 不加鉴权、TLS、`/v1`；不用 Camstar/MSSQL。
- 不改设备/校验分表；不重写历史 `docs/superpowers/*` 规格（可改 `docs/api.md`）。
- 第一期不做控制台代码页（GBK）转码。

## 3. 已锁定决策

| 主题 | 选择 |
|------|------|
| 产品形态 | 与 REST 同类：试跑 → 注册 → 序列一步 |
| 拉起方式 | 可执行文件 + 参数数组，直接 `CreateProcess` |
| 判定 | `expect_exit_code`（默认 0）；超时或退出码不符 → `ok: false` |
| 页面 | 顶栏「命令行」，`#/cmd`，已注册列表进抽屉 |
| 中心表 | 方案 A：四表；REST 迁出；CMD 新表 |
| `template_source` | `labview` \| `general` \| `rest` \| `cmd` \| `section` |
| 超时默认 | `timeout_ms = 60000` |
| 输出截断 | `stdout` / `stderr` 各最多 1MB |
| 编码 | UTF-8 有损解码 |

## 4. 命令行步骤

`kind = "cmd"`，`vi_path = "__builtin__/cmd"`（仅机台内部识别，与 REST 的 `__builtin__/rest` 同模式）。

**inputs（JSON object）：**

```json
{
  "program": "C:\\tools\\foo.exe",
  "args": ["-n", "2"],
  "cwd": "",
  "timeout_ms": 60000,
  "expect_exit_code": 0
}
```

- `program` 必填，禁止空、禁止内嵌 NUL。相对路径相对 `cwd`（若设）或机台进程目录。
- `args` 字符串数组；界面一行一个，空行丢弃。
- `cwd` 可空。
- 不在 `program`/`args` 里再套一层 shell。

**outputs（试跑与开测同一形状）：**

```json
{
  "ok": true,
  "kind": "cmd",
  "exit_code": 0,
  "timed_out": false,
  "elapsed_ms": 12,
  "stdout": "...",
  "stderr": "..."
}
```

失败时 `ok: false`，可带 `error`（启动失败、超时）。超时杀该子进程；不保证杀孙进程。`.bat`/`.cmd`：程序填 `cmd.exe`，参数 `/c` 与脚本路径。

**机台 HTTP（对本机 WebUI）：**

| 方法 | 路径 |
|------|------|
| POST | `/api/cmd/run` |
| POST | `/api/cmd/register` |
| GET | `/api/cmd/templates` |

注册经中心 `POST /api/cmd-templates`。列表经 `GET /api/cmd-templates`。试跑走 `TaskSlot`（与 delay/REST 试跑相同，`busy` 则 409）。

**页面：** 工作台 + 试跑输出；页头「已注册命令」在「刷新」左边，抽屉宽 720，点「加载」填回并关闭。文案与 REST 抽屉同一套交互。

## 5. 中心分表与迁移

现有：`vi_templates`；`general_templates` 含 delay、version、**rest**。

新增与 `general_templates` 同形状：

- `rest_templates`
- `cmd_templates`

`general_templates` 迁移后只允许 `kind IN ('delay','version')`（可用 CHECK）。

**队列 / 序列步骤**（`vi_run_queue_items`、`sequence_template_steps`）：

- 增加可空 `rest_template_id`、`cmd_template_id`，FK `ON DELETE CASCADE`。
- 普通步骤恰好一个功能外键非空：`vi_template_id` | `general_template_id` | `rest_template_id` | `cmd_template_id`。
- `template_source='section'`：四个外键全空。

迁移步骤（单条 SQL 迁移文件，例如 `035_split_rest_and_cmd_templates.sql`）：

1. `CREATE TABLE rest_templates` / `cmd_templates`（列同 `general_templates`）。
2. `INSERT INTO rest_templates SELECT * FROM general_templates WHERE kind = 'rest'`（保留 `id`）。
3. 加列 `rest_template_id`、`cmd_template_id`。
4. 把原 `general_template_id` 指向 rest 行的步骤/队列：`template_source='rest'`，`rest_template_id=<原 id>`，`general_template_id=NULL`。
5. `DELETE FROM general_templates WHERE kind = 'rest'`。
6. 换 CHECK 约束。

中心 API：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/rest-templates` | 替代 rest 走 general |
| GET/DELETE | `/api/rest-templates/{id}` | 与 `general-templates/{id}` 相同：读一条、中心页可删 |
| GET/POST | `/api/cmd-templates` | 新建 |
| GET/DELETE | `/api/cmd-templates/{id}` | 同上 |

`POST /api/general-templates` 若 `kind=rest` 或 `kind=cmd` → `400`，引导走新路由。`GET /api/general-templates` 不再返回 rest 行。

`docs/api.md` 更新上述路由；历史 spec 不改。

## 6. 序列与机台执行

- 序列编辑拉目录：现有 VI 列表 + `GET /api/general-templates` + `GET /api/rest-templates` + `GET /api/cmd-templates`（机台可继续用代理路径，但 rest/cmd 不再出现在 general 列表里）。抽屉分类：全部 / VI / 通用 / REST / 命令行。
- `run_one_step`：`cmd` → `run_command_from_inputs`；`rest` 仍走现有 REST 执行（数据来自 rest 表）。
- 队列 PUT 体带 `template_source` 与对应 `*_template_id`（JSON 名保持 `agent_id` 风格的现有字段；新增 `rest_template_id`、`cmd_template_id`）。
- 展开：`program`/`args`/`cwd` 对 `${vars}` 用与 REST 相同的 **Lenient** 展开。

## 7. 测试

中心：

- 迁移后：原 rest 模板能在 `rest_templates` 按旧 id 读到；`general_templates` 无 rest；指向它的序列步骤 `template_source=rest`。
- `POST /api/cmd-templates` 成功；`POST /api/general-templates` `kind=rest` 失败。
- CHECK：不能同时填两个功能外键。

机台：

- 纯函数：解析 inputs、期望退出码、截断 1MB、识别 `kind=cmd`。
- 单测用假进程或短命令（Windows `cmd.exe /c echo` 仅作可选集成；CI 不强制真 NSIS）。
- 前端：按钮文案「命令行」「已注册命令」；旧底表标题不出现。

## 8. 实现落点

| 仓库 | 内容 |
|------|------|
| atlas-center | 迁移、`rest_templates`/`cmd_templates` store、API、`docs/api.md`、序列/队列读写 |
| atlas-station | `src/cmd.rs`、API、`run_one_step`、Cmd 页、序列目录分类、注册代理 |

两端仓库各存一份本 spec：`docs/superpowers/specs/2026-08-16-station-cmd-and-split-template-tables-design.md`。
