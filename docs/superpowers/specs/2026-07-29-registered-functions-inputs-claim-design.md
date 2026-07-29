# ATLAS 已注册功能：入参展示、中心只读、Agent 领取副本

**日期：** 2026-07-29  
**状态：** 已确认

## 背景

VI 模板注册时已将 `inputs` 写入中心 `inputs_json`，列表 API 已返回 `inputs`。列表 UI 未展示入参。中心「已注册功能」仍暴露重命名/分发/删除。Agent 仅能看到本机模板，无法浏览中心全部功能并复制到本机。

## 目标

1. **入参展示（中心 + Agent）**  
   - 「已注册功能」列表增加「入参」列。  
   - 单元格显示单行截断摘要；悬停弹出格式化 JSON 浮层（可滚动）。  
   - 不改注册 API / 存储模型。

2. **中心只读**  
   - `#/functions` 移除操作列及重命名 / 分发 / 删除 UI（含分发弹窗入口）。  
   - 保留机台筛选与只读列：名称、当前机台、来源机台、VI 路径、入参、超时。  
   - 中心 HTTP API 可暂留（Agent 领取仍依赖 `POST /api/vi-templates/{id}/distribute`）。

3. **Agent：本机列表 + 中心全部 + 加到本机（复制）**  
   - **本机已注册**：现有能力（试跑 / 重命名 / 加载到编辑区）+ 入参列。  
   - **中心全部功能**（新区块）：展示中心全部模板（无 `agent_id` 过滤）。  
   - **加到本机**：对非本机持有的模板，调用中心 **分发/复制**（`target_agent_id` = 本机）。  
     - 本机新建一条（新 `id`），**源机台与中心原记录保留**，源机可继续使用。  
     - 本机已持有（`agent_id` 等于本机）则显示「已在本机」，不提供按钮。  
   - 序列页左侧列表本次不改（仍仅本机）。

## 非目标

- 不改为转移（transfer）语义。  
- 不删除中心 distribute / PATCH / DELETE API。  
- 不在序列页展示「中心全部」。  
- 不引入鉴权。

## 架构

```
Agent WebUI
  ├─ 本机列表  ← GET /api/labview/registered-templates  (现有，按本机过滤)
  └─ 中心全部  ← GET /api/labview/all-templates         (新，代理中心全量)
       └─ 加到本机 ← POST /api/labview/templates/{id}/claim  (新，代理 distribute)

Center
  GET  /api/vi-templates                 (全量或 ?agent_id=)
  POST /api/vi-templates/{id}/distribute { target_agent_id }  (复制)
```

## Agent API

### `GET /api/labview/all-templates`

- 解析本机 `agent_id`（与现有 proxy 一致）。  
- 代理 `GET {center}/api/vi-templates`（无 filter）。  
- 透传状态码与 JSON 数组（`ViTemplateView`）。

### `POST /api/labview/templates/{id}/claim`

- 解析本机 `agent_id`。  
- 代理 `POST {center}/api/vi-templates/{id}/distribute`，body：`{ "target_agent_id": <本机 id> }`。  
- 透传结果（成功返回新模板；同源 400、未知 404 等与中心一致）。

`register.rs` 增加 `list_all_vi_templates`、`distribute_vi_template`（或等价命名）封装。

## UI / CSS

- 共享交互模式（两端各自实现小工具函数即可，不强抽共享包）：  
  - `formatInputsSummary(inputs)` → 单行 `JSON.stringify` 截断（约 48 字符 + `…`）。  
  - `formatInputsPretty(inputs)` → `JSON.stringify(…, null, 2)`。  
  - 单元格：`.inputs-cell` 内摘要文本；`mouseenter`/`mouseleave` 显示 `.inputs-popover`（`position: fixed` 或 absolute，`pre` + max-height ~40vh + overflow auto）。  
- 中心：去掉操作列与相关 JS；colspan 调整。  
- Agent：在「本机已注册」下增加「中心全部功能」表；操作列「加到本机」/「已在本机」。

## 测试

- Agent：`all-templates` 代理成功 / 中心不可达；`claim` 转发 body 含本机 `agent_id`；claim 同源错误透传。  
- 静态：中心 functions 表无操作按钮；Agent 两表渲染与入参悬停不强制自动化（手工验收）。  
- 现有 distribute 复制语义回归（scheduler 已有测试）。

## 验收

1. 注册带入参后，中心与 Agent 本机列表可见入参摘要，悬停见完整 JSON。  
2. 中心 `#/functions` 无重命名/分发/删除。  
3. Agent「中心全部」可见其他机台模板；「加到本机」后本机列表多一条新 id，源机台原记录仍在。  
4. 对本机已有项显示「已在本机」。
