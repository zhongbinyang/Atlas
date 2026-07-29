# Atlas 第一批可靠性与前端体验优化实施计划

## 目标

面向测试机台操作人员，保持现有 Atlas “运行态仪表盘”的视觉语言，在不改变业务 API 和部署方式的前提下，先解决三个已复现的问题：

1. Agent 状态接口因同步采样而产生约 200 ms 的固定阻塞。
2. 调度中心每 2 秒重建页面并重复请求，导致焦点和点击状态丢失。
3. Agent 序列页在小屏下横向溢出，固定执行栏遮挡内容。

## 前端方向

- 色彩：沿用雾蓝 `#dce4ec`、面板白 `#f7fafc`、青绿 `#0a6e7a`、成功绿 `#1a7f4b`、告警橙 `#b86a00`、错误红 `#b33a2b`。
- 字体：沿用 Space Grotesk 品牌字、IBM Plex Sans 正文、IBM Plex Mono 数据。
- 布局：桌面端维持高密度双栏和固定执行工具条；移动端改为单栏、内容内执行工具条。
- 识别点：保留紧凑的状态轨道和工业仪表感；动态刷新只更新数据，不让控制元素“闪断”。

## 全局约束

- 本批次不实现认证与鉴权。
- 不改变现有 HTTP API 的路径、字段或状态码。
- 不引入 React、Vue 等前端框架或新的包管理流程。
- 调度中心机台状态的可见页刷新间隔保持 2000 ms。
- 自动刷新不得重叠；页面隐藏时暂停，重新可见时立即刷新。
- 自动刷新不得重建未变化的 Agent 卡片或详情操作按钮，键盘焦点应保持。
- 手动“刷新”仍应刷新当前路由所需的完整数据。
- 请求失败时保留最近一次成功数据，不用空内容覆盖页面。
- 640 px 及以下序列页不得产生页面级横向滚动，执行栏不得遮挡内容。
- 所有行为变更遵循测试先行：先观察预期失败，再写最小实现并观察通过。

## Task 1：Agent 指标后台采样

### 范围

- 修改 `crates/agent/src/metrics.rs`、`crates/agent/src/api.rs`、`crates/agent/src/main.rs` 以及覆盖它们的测试。
- 将 CPU/内存采样从 `/api/status` 请求路径移到后台任务。
- `AppState` 保存最新的轻量指标快照；状态处理器只读取快照。
- 后台任务每 2000 ms 更新一次快照，运行时的等待使用 Tokio 定时器，不在异步请求线程执行 `std::thread::sleep`。
- 首次快照允许为默认值，首次后台采样完成后更新；API 响应结构保持不变。

### TDD 与验收

1. 先新增一个状态接口延迟回归测试，当前实现因 200 ms 同步等待而失败；阈值设为 150 ms。
2. 实现缓存后，测试应通过，并验证响应中的 CPU/内存来自预置快照。
3. 运行 `cargo test -p agent metrics`、状态接口相关测试，以及 `cargo test -p agent`。
4. 运行 `cargo fmt --check` 和 `cargo clippy -p agent --all-targets -- -D warnings`；若仓库既有警告阻止 `-D warnings`，报告并至少保证没有新增警告。

## Task 2：调度中心稳定自动刷新

### 范围

- 修改 `crates/scheduler/static/index.html`、`app.js`，可新增一个职责单一、可独立测试的浏览器运行时脚本及 Node 测试。
- 用自调度 `setTimeout` 控制器替代 `setInterval`：
  - 前一次刷新结束后才安排下一次；
  - `document.hidden === true` 时不请求；
  - `visibilitychange` 回到可见时立即刷新。
- 自动刷新只更新机台列表或 Agent 详情的动态状态；功能模板和序列模板只在首次进入、路由切换或手动刷新时完整加载。
- 对 `/api/agents` 的并发调用做复用或去重，避免自动刷新、路由切换和手动刷新叠加。
- Agent 列表按 `agent.id` 增量协调：
  - 已存在卡片复用同一 DOM 节点；
  - 新 Agent 创建节点；
  - 离开列表的 Agent 删除节点；
  - 顺序与最新数据一致。
- Agent 详情状态字段增量更新；指标变化时不得重建操作按钮。
- 保持现有路由、按钮行为、文案和视觉令牌。

### TDD 与验收

1. 先为刷新控制器写 Node 内置测试，覆盖“不重叠”和“隐藏暂停/恢复立即刷新”，并观察因模块缺失或行为缺失产生的预期失败。
2. 先为 keyed DOM 协调器写测试，证明同 key 节点身份保持、移除失效节点且顺序正确，再接入页面。
3. 运行 `node --test` 对新增测试文件执行验证。
4. 更新 Rust 静态资源测试，确认页面加载新脚本且旧的 `setInterval(refreshCurrent, POLL_MS)` 不再存在。
5. 运行 `cargo test -p scheduler`。

## Task 3：Agent 序列页小屏适配与控件标注

### 范围

- 修改 `crates/agent/static/style.css`、`index.html` 及静态 UI 测试。
- `.seq-col` 设置 `min-width: 0`，让表格只在自己的 `.table-scroll` 容器内横向滚动。
- 在 640 px 及以下：
  - `.seq-columns` 保持单栏；
  - `#page-sequence` 取消为固定栏预留的底部空白；
  - `.seq-run-bar-fixed` 改为文档流内的普通执行栏；
  - SN、工单输入和状态区域可以收缩或换行，不扩大页面宽度。
- 为序列页搜索框和类型筛选提供可访问名称，优先使用不改变视觉布局的 `aria-label`。
- 不改变桌面端固定执行栏，不改变现有颜色、字体和按钮语义。

### TDD 与验收

1. 先新增静态 UI 测试，检查小屏安全规则和可访问名称，观察当前样式下的预期失败。
2. 写最小 HTML/CSS 改动使测试通过。
3. 运行 `cargo test -p agent --test static_ui`（若测试目标命名不同，以实际目标为准）和 `cargo test -p agent`。
4. 使用 Chromium 在 390×844 与桌面视口检查：
   - `document.documentElement.scrollWidth <= clientWidth`；
   - 执行栏在移动端不覆盖队列/模板内容；
   - 桌面端仍固定在底部；
   - 控制台无新增错误。

## 集成验证

- 运行 `cargo fmt --check`。
- 运行 `cargo test --workspace`。
- 运行 `cargo build --workspace`。
- 使用 Chromium 验证调度中心：
  - 连续观察至少两个刷新周期，请求不重叠；
  - 隐藏页面期间不继续轮询；
  - 聚焦详情操作按钮时刷新不丢失焦点；
  - Agent 卡片 DOM 节点在纯指标更新时保持身份。
- 对整个分支做最终代码审查，修复所有 Critical/Important 问题后再交付。
