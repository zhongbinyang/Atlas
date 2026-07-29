# ATLAS 前端焕新设计（光纤仪表面板）

**日期:** 2026-07-29  
**状态:** 待实现  
**范围:** 调度中心（scheduler）与测试机台 Agent 的静态 WebUI：品牌、视觉 token、布局；功能与 API 不变

## 背景

产品正式名为 **ATLAS 光模块测试监控系统**。当前 UI 为浅灰 + IBM Plex + 深蓝工控壳，品牌仍显示「调度中心 / 产线 Agent」，Agent 顶部状态区占纵向空间过大。需要统一为光纤仪表面板气质，并完成品牌化与布局收紧。

## 目标

1. 两端统一 **ATLAS** 品牌与同一套设计 token。
2. 视觉方向：**光纤仪表面板** — 冷钢灰底、青色激光强调、等宽数据、小圆角。
3. 中心保持 hash 路由；机台卡片 / 详情 / 已注册功能视觉升级。
4. Agent 顶部大 hero **压成单行状态条**，与中心详情同构；VI / 序列功能保留。
5. 继续 Axum 静态资源方案（方案 A），两端 `:root` 由 `static_tokens` 锁定。

## 非目标

- 不新增/不改业务 API 与分发「复制」语义
- 不上 React/Vite
- 不恢复中心 Shell「作业」UI
- 不改变 hash 路由与 Agent 页面分区（VI / 序列）

## 方案

**采用方案 A：共用 token + 静态壳层焕新。**

### 品牌

| 端 | 主品牌 | 副标 |
|----|--------|------|
| 中心 | ATLAS | 光模块测试监控 |
| Agent | ATLAS | 测试机台 |

导航仍为中文：机台 / 已注册功能；VI / 序列。

### 视觉 token

| Token | 用途 | 值 |
|-------|------|-----|
| `--bg` | 页面底 | `#dce4ec`（可叠加细网格） |
| `--surface` | 顶栏/条带 | `#eef3f7` |
| `--panel` | 面板 | `#f7fafc` |
| `--border` | 边框 | `#b7c4d0` |
| `--text` | 正文 | `#15202b` |
| `--muted` | 次要 | `#5c6b7a` |
| `--accent` | 激光青 | `#0a6e7a` |
| `--ok` | 在线/成功 | `#1a7f4b` |
| `--busy` | 忙碌 | `#b86a00` |
| `--err` | 错误/离线强调 | `#b33a2b` |
| `--radius` | 圆角 | `3px` |

**字体**

- 品牌：`Space Grotesk`
- 正文：`IBM Plex Sans`
- 数据：`IBM Plex Mono`

**签名元素：** 顶栏左侧青色竖光标 + ATLAS 字标（`prefers-reduced-motion` 时关闭呼吸动效）。

### 中心布局

- `#/machines`：卡片网格；左边状态色竖线；离线降权；整卡进详情
- `#/agents/{id}`：返回 + 名称；`.status-rail` 状态条；截图/历史/文件（离线禁用）
- `#/functions`：筛选 + 表格；分发弹层（复制文案、路径预填）不变

动效：卡片 hover、视图淡入、顶栏竖标轻呼吸（约 2–3 处）。

### Agent 布局

- 顶栏 ATLAS + 副标 + VI/序列 + 重新注册
- 原 hero 改为 `.status-rail`：主机名、IP、运行时间、CPU、内存、忙碌
- VI：CLI/GETINFO 紧凑只读条；工具行；参数表与已注册列功能不变
- 序列：双列表功能不变，面板视觉跟 token

### 技术约束

- 修改：`crates/scheduler/static/{index.html,style.css}`（及必要的 class 微调于 `app.js`）
- 修改：`crates/agent/static/{index.html,style.css}`（及必要的 class 微调于 `app.js`）
- 更新：`crates/scheduler/tests/static_tokens.rs` 的 expected hex
- 更新 README 中 WebUI 品牌表述（若仍写「调度中心」为唯一产品名）

## 成功标准

1. 打开中心/Agent 顶栏一眼可见 **ATLAS**。
2. 两端 `:root` 一致且 `static_tokens` 通过。
3. Agent 首屏纵向空间明显减少（状态条替代大指标卡）。
4. 现有流程可用：机台卡片→详情、功能重命名/分发、Agent 注册/试跑/序列。
5. 窄屏可用；尊重 `prefers-reduced-motion`。

## 实现提示

- 先改两端 `:root` + 字体链接 + 顶栏品牌 HTML，再改布局 class，最后动效。
- Agent `style.css` 当前有多余空行，焕新时可顺手压紧，但保持与 scheduler token 块一致。
