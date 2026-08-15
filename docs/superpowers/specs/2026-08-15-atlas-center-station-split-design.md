# Design: 拆分为 atlas-center 与 atlas-station

**日期：** 2026-08-15  
**状态：** 已批准（待实现）  
**范围：** 把当前 Atlas 单体仓库拆成两个独立 git 项目，并调整默认端口与配置归属。

## 1. 目标

把现有 Cargo workspace（`scheduler` + `agent` + `common`）拆成两个可独立克隆、构建、发版的 git 仓库：

1. **atlas-center** — 测试机台编排中心。配置唯一源。默认端口 **9080**。
2. **atlas-station** — 产线 Windows 机台运行时。只执行、只消费中心已解析的配置。默认端口 **9090**。

成功标准：

- 两个仓库没有 path 依赖，也不再有第三个共享 crate / 共享前端包。
- Spec、设备、校验配置的解析、存储、导入与编辑都只在 atlas-center。
- atlas-station 启动后向 `http://<center>:9080` 注册，拉取已启用配置并跑序列。
- 现有 REST 路径保持不变；第一期不加 `/v1`。
- 本地目录为 `C:\Users\zhong\git\atlas-center` 与 `C:\Users\zhong\git\atlas-station`。
- GitHub：`zhongbinyang/Atlas` 改名为 `atlas-center`，新建 `atlas-station`。

## 2. 非目标

- 不做 `git filter-repo` 双份历史。
- 不把 `crates/common` 做成第三个仓库或 crates.io 包。
- 第一期不改环境变量名（仍用 `SCHEDULER_*` / `AGENT_*`）。
- 第一期不加鉴权、TLS、API 版本前缀。
- 不把 PostgreSQL 或 `docker-compose` 放进 atlas-station。
- 不在拆仓同时改序列执行语义、通道模型或 LabVIEW CLI 行为。
- 不保留旧 `Atlas` 仓库继续并行开发。

## 3. 已锁定决策

| 主题 | 选择 |
|------|------|
| 仓库 / 产品名 | `atlas-center`（中心）、`atlas-station`（机台） |
| 品牌 | WebUI 顶栏仍为 **ATLAS** |
| 默认端口 | 中心 **9080**，机台 **9090** |
| 配置归属 | Spec / 设备 / 校验全部在中心 |
| 共享代码 | 取消 `crates/common` 与 `frontend/shared` |
| 协议 | HTTP REST；中心 `docs/api.md` 为唯一契约 |
| API 版本 | 第一期不引入 `/v1` |
| Git 手法 | 现仓库改名为 atlas-center；机台新建空仓 + 一次初始提交 |
| 包结构 | 每个仓库一个 Cargo 包，不再 workspace |
| 二进制 / crate 名 | `atlas-center`、`atlas-station` |
| 环境变量名 | 第一期保持 `SCHEDULER_*` / `AGENT_*`，只改默认端口 |
| 机台配置 UI | 导入和编辑在中心；机台「配置」页收成只读/精简 |

## 4. 架构

### 4.1 运行时

```text
操作者 WebUI/API
        │
        v
 atlas-center:9080  ──HTTP──►  atlas-station:9090
        │                         │
   PostgreSQL                本机 LabVIEW / REST / Delay
   Spec / 设备 / 校验         变量展开 + Pass/Fail 判定
   功能 / 序列 / 单位
```

中心主动巡检机台状态。机台启动时向中心注册（电脑名 + 广告 IP + 端口 9090），之后按需拉取配置、模板、队列与 Spec JSON。

### 4.2 仓库内部结构

**atlas-center**（由当前仓库演变，单包）：

```text
Cargo.toml                 # package name = atlas-center
src/                       # 现 crates/scheduler + 吸收的 common
frontend/                  # 现 frontend/scheduler + specIni.ts
static/                    # 前端构建产物
docs/api.md                # 协议唯一出处
docker-compose.yml
scripts/                   # 仅中心：前端构建、DB 同步
```

吸收进 `src/` 的 common 内容：`spec_ini`、设备/校验档相关类型、单位/变量默认值、中心需要的请求/响应 DTO、`ErrorBody`。

**atlas-station**（新建仓库，单包）：

```text
Cargo.toml                 # package name = atlas-station
src/                       # 现 crates/agent + 本地 DTO
frontend/                  # 现 frontend/agent
static/
docs/                      # 机台部署与本机 API
scripts/                   # 仅机台前端构建
```

station 的 DTO 只覆盖它实际调用或暴露的字段（注册、状态、队列、设置快照、Spec 已解析 JSON）。字段名与 JSON 形状必须与中心 `docs/api.md` 一致，但代码各自维护。

### 4.3 从前单体迁出的归属

| 现路径 | 去向 |
|--------|------|
| `crates/scheduler/**` | atlas-center `src/` |
| `crates/common/src/spec_ini.rs` | atlas-center only |
| `crates/common/src/agent_settings.rs` | atlas-center 为源；station 只留反序列化所需的最小结构 |
| `crates/common/src/types.rs` / `error.rs` | 按调用方拆到两边，不共享源文件 |
| `crates/agent/**` | atlas-station `src/` |
| `frontend/scheduler/**` | atlas-center `frontend/` |
| `frontend/shared/specIni.ts` | atlas-center `frontend/` |
| `frontend/shared/formatError.ts` / `uiCopy.ts` | 各仓各留需要的副本 |
| `frontend/agent/**` | atlas-station `frontend/` |
| `docker-compose.yml`、`scripts/sync-atlas-db.ps1` | atlas-center |
| `docs/api.md` | atlas-center；station README 链到中心文档或摘录本机 API |
| 历史 `docs/superpowers/**` | 留在 atlas-center |

## 5. 配置归属与数据流

中心是唯一配置源。三类配置的含义：

| 名称 | 中心资产 | 机台运行时 |
|------|----------|------------|
| Spec 配置 | `spec_templates` + Spec INI 解析与上传页 | 按步骤引用拉取已解析 section，合并手写 `limits_json` 后判定 |
| 设备配置 | `agent_device_profiles` + Device INI 导入 | 只使用当前启用档，flatten 为 `${Section_Key}` |
| 校验配置 | `agent_calibration_profiles` + Calibration INI 导入 | 只使用当前启用档，同样 flatten 进变量；不在机台保存 INI 原文 |

数据流：

```text
上传/编辑 INI 或模板
  → atlas-center 解析并写入 PostgreSQL

atlas-station 启动或打开序列
  → GET 已启用设备档 / 校验档 / 引用到的 Spec
  → 本机展开变量、跑步骤、判定 Pass/Fail
  → 不写回配置源，不保存 INI 原文作为主数据
```

机台 WebUI「配置」页第一期改为只读或精简：展示本机启用档名称、通道、本机路径（LabVIEW CLI 等）。导入、新建、编辑、激活都在中心「机台配置」与「Spec 模板」。

## 6. 通信契约

- 协议以 atlas-center 的 `docs/api.md` 为准。
- 第一期保持现有路径，例如 `POST /api/agents/register`、`GET /api/status`、配置与模板 CRUD。
- 默认连接：
  - 中心：`http://127.0.0.1:9080`
  - 机台：`http://127.0.0.1:9090`
  - `AGENT_CENTER_URL` 示例改为 `http://127.0.0.1:9080`
- 前端 dev 代理：中心 `5173 → 9080`，机台 `5174 → 9090`。
- 两边独立发版。不兼容时先改中心文档，再升 station。
- 错误体继续用现有 `{ "error": "..." }` 形状；两边各自实现，不共享 crate。

## 7. 端口与环境变量

| 变量 | 新默认值 | 说明 |
|------|----------|------|
| `SCHEDULER_BIND` | `0.0.0.0` | 不变 |
| `SCHEDULER_PORT` | **9080** | 原 26630 |
| `SCHEDULER_DATABASE_URL` | 原默认不变 | 仅中心 |
| `AGENT_CENTER_URL` | 必填 | 示例改为 `:9080` |
| `AGENT_BIND` | `0.0.0.0` | 不变 |
| `AGENT_PORT` | **9090** | 原 26631 |

代码、README、前端代理、手工联调清单中的旧端口全部替换。不保留 26630/26631 回退开关。

## 8. Git 与仓库操作

推荐手法（已选）：

1. 当前 `C:\Users\zhong\git\Atlas` 演变为 atlas-center：删掉 agent 树，吸收 common，改包名与端口，更新 README。
2. GitHub 将 `zhongbinyang/Atlas` rename 为 `atlas-center`（旧 URL 由 GitHub 跳转）。
3. 本地目录改名为 `C:\Users\zhong\git\atlas-center`。
4. 新建 `C:\Users\zhong\git\atlas-station` 与 GitHub `zhongbinyang/atlas-station`。
5. 把机台代码与精简 DTO 拷入新仓，做一次初始提交。不迁移逐提交历史。

不采用：Atlas 只读归档再开两个空仓；也不用 `git filter-repo`。

拆仓后旧单体不再接受功能提交。中心 README 首页写明两个仓库名、端口和 `AGENT_CENTER_URL`。

## 9. 错误处理

| 情况 | 行为 |
|------|------|
| 机台连不上中心 | 注册失败，机台 WebUI 明确报错；不降级为本地配置主库 |
| 中心连不上机台 | 巡检标 `offline`（现有行为），配置仍可在中心编辑 |
| Spec / 设备 / 校验 INI 非法 | 中心上传/保存 API 返回 4xx，不写入；机台看不到半份配置 |
| 机台拉取到的 JSON 缺字段 | 按 `docs/api.md` 视为契约破坏：记录错误并拒绝使用该档，不猜默认业务值 |
| 两边 DTO 漂移 | 以中心文档为准；用契约测试（见下）尽早发现 |

## 10. 测试

每个仓库自己跑测试，不再有 workspace 级 `cargo test --workspace`。

**atlas-center**

- 吸收进来的 Spec INI 解析单测随代码迁入。
- 现有 scheduler API / store 测试更新端口与 crate 名。
- 前端 Spec 上传预览测试随 `specIni.ts` 迁入。

**atlas-station**

- 现有 agent 序列、limits、settings 测试迁入。
- 删除对 `common` path 的依赖；DTO 与判定逻辑的测试留在本仓。
- 不把 Spec INI 原文解析测试带进 station。

**跨仓**

- 第一期不做独立契约仓库。中心改 API 时必须同步改 `docs/api.md`。
- 手工联调：中心 `:9080` 起库 → 机台 `AGENT_CENTER_URL=http://127.0.0.1:9080` 注册 → 中心导入 Spec/设备/校验 → 机台跑一条带 Spec 的序列。

## 11. 拆分顺序

实现时按这个顺序，避免两边同时处于不可运行状态：

1. 在当前仓库落地设计文档（本文）。
2. 先把当前仓库改成可独立构建的 atlas-center：吸收 common、去掉 agent 成员、端口改 9080、前端只留中心。
3. 从改名前的树取出 agent 侧文件，初始化 atlas-station：本地 DTO、端口 9090、前端只留机台、配置页只读/精简。
4. 两边 README / `docs/api.md` / 环境变量默认值对齐。
5. GitHub rename + 新建仓库 + 推送。
6. 手工联调清单走通后再删本机旧 `Atlas` 目录名。

第 2、3 步可以在同一工作区用拷贝完成，但提交必须落在各自仓库。

## 12. 风险与约束

- 机台配置编辑从 Agent 页挪到中心后，产线操作习惯会变；第一期中心「机台配置」必须能完成导入、激活、查看，不能只留只读摘要。
- 取消 shared crate 后，字段改名必须先改中心文档再改两边代码，否则运行时才爆。
- GitHub rename 会影响已有 clone 的 `origin` URL；本地执行 `git remote set-url` 即可。
- 未提交的本地改动（静态资源、logs）不带进新仓。
