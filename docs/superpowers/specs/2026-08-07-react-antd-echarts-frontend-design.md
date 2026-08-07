# ATLAS 前端统一为 React（Ant Design + ECharts）

**日期:** 2026-08-07  
**状态:** 已批准（待实现计划）  
**范围:** 调度中心（`:26630`）与测试机台 Agent（`:26631`）WebUI 全量重写；REST API 与业务语义不变

## 背景

两端 WebUI 现为 Axum 托管的静态 HTML/CSS/JS（`crates/*/static/`）。Agent `app.js` 体量很大，维护成本高。产品约定前端统一为 **React + Ant Design + ECharts**，并保留现有双进程端口部署。

此前规格（如 `2026-07-29-atlas-frontend-refresh-design.md`）明确「不上 React/Vite」；本规格**取代**该技术路线约束，视觉不再强制「光纤仪表面板」token，改为 Ant Design 默认企业风 + ATLAS 字标。

## 目标

1. 中心与 Agent WebUI 均为独立 React 应用，能力与现网主流程对等。
2. 技术栈统一：Vite + React + TypeScript + Ant Design 5 + ECharts（薄封装）。
3. 构建产物嵌入对应 Rust crate 的 `static/`，仍由现有端口提供。
4. 中文界面；顶栏保留 **ATLAS** 品牌字标与副标文案。
5. 可用 Ant Design `Layout` / `Menu` 微调导航分组，不删功能。

## 非目标

- 修改或新增业务 REST API
- 鉴权、i18n 框架、暗色主题
- 共享 UI / API 源码包（两端前端完全独立）
- 在 `build.rs` 中调用 npm；独立前端进程另起端口
- 本期上线具体图表页或遥测趋势 API（仅预留 ECharts 封装）
- History 路由模式（继续 hash，兼容书签）

## 方案选择

采用 **方案 1：独立 Vite 应用 + 构建拷贝到 `static/`**（相对编译期嵌入与并行双 UI 方案）。

## 工程架构

```text
frontend/
  scheduler/                 # 独立 package：Vite + React + TS + antd + echarts
  agent/                     # 独立 package：同上，不共享源码
scripts/
  build-frontend.ps1         # 分别 build，同步产物到 crates/*/static/
crates/scheduler/static/     # 仅构建产物 + favicon（移除旧 vanilla 入口）
crates/agent/static/         # 同上
```

### 约定

| 项 | 约定 |
|----|------|
| 语言 | TypeScript |
| UI | Ant Design 5 + `zh_CN` locale；默认主题 |
| 品牌 | 顶栏 ATLAS 字标 + 既有副标（中心 / 测试机台） |
| 图表 | 安装 `echarts` 与薄封装组件；本期可不挂图 |
| 开发 | 各 app Vite `proxy` → `127.0.0.1:26630` / `26631` |
| 生产 | 无独立前端进程；Axum `ServeDir` 托管 `static/` |
| 发布 | 先 `scripts/build-frontend.ps1`，再 `cargo` 构建/部署 |
| SPA | API 路由优先；未知静态路径回退 `index.html` |

## 路由、Layout、页面映射

两端均用 Ant Design `Layout`（顶栏品牌 + `Menu` + `Content`）。

### 调度中心（hash，兼容现网）

| 路由 | 菜单 | 页面 |
|------|------|------|
| `#/machines` | 机台 | 列表 / 筛选 / 卡片网格（与现网一致，可用 antd Card） |
| `#/agents/:id` | （详情） | 状态、截图、历史、文件；面包屑返回机台 |
| `#/functions` | 已注册功能 | VI / 通用 / REST 分栏 + 删除等现有能力 |
| `#/sequences` | 序列模板 | 列表与删除等现有能力 |
| `#/units` | 单位 | 单位表维护 |

### Agent（由页签改为 hash，便于深链）

| 路由 | 菜单 | 页面 |
|------|------|------|
| `#/vi` | VI | inspect / 试跑 / 注册 / 中心 VI 列表 |
| `#/general` | 通用 | 延迟试跑与注册 |
| `#/api` | REST | REST 试跑与注册 |
| `#/sequence` | 序列 | 页内 antd `Tabs`：**编排** \| **运行**（合并原两顶栏页签；默认编排） |
| `#/settings` | 配置 | 机台配置 / 单位变量等 |

顶栏右侧：机台信息（antd `Popover`）+「重新注册」。

## 数据流与状态

- 各端自建 `apiClient`（`fetch` 封装），同源调用现有 REST。
- 轮询间隔与现网一致（机台列表、Agent 状态等）。
- 页面级 React state / hooks；不引入 Redux。
- 反馈：antd `App.useApp()` 的 `message` / `modal` / `notification`。
- 复杂交互（序列拖拽、多通道运行、文件浏览等）用 antd 组件按现有语义重写，对齐 `docs/api.md` 与当前行为。

## 错误处理

- HTTP 非 2xx：解析错误文案 → `message.error`；表单用 Form rules。
- 离线机台：截图 / 文件等操作禁用（与现逻辑一致）。
- 长任务（VI 试跑、序列运行）：loading / 进度，防止重复提交。

## 测试与文档

- 前端：工具函数与 `apiClient` 可单测；页面以手工回归为主（本期不强制 E2E）。
- Rust：删除依赖旧 html/css/js 字符串内容的断言；改为检查产物存在、favicon、以及可测的 SPA 回退行为。
- README：补充 `frontend/*/npm install`、`scripts/build-frontend.ps1`、开发代理说明。

## 成功标准

1. 打开中心 / Agent 即为 React + Ant Design；顶栏可见 ATLAS。
2. 主流程可用：机台列表→详情；功能浏览/删除；单位；Agent 注册/试跑/序列编排与运行/配置。
3. 旧 vanilla `app.js` / `style.css` 不再作为运行时入口。
4. 与静态 UI 相关的 `cargo test` 通过；端口与双进程部署不变。
5. ECharts 封装可引用，无强制图表页。

## 实现提示

1. 先搭两端 Vite 骨架 + antd Layout 空壳 + 构建同步脚本 + Axum SPA 回退。
2. 按中心路由页逐页迁移，再迁 Agent（VI / 通用 / REST → 序列 → 配置）。
3. 每页对照现网与 `docs/api.md` 做手工回归后再删对应旧逻辑依赖。
4. 最后清理旧静态资源并更新 README / 静态相关测试。
