# Phase 2 Task 3 report — Agent VI 阶段式工作台

## RED evidence

- `node --test crates/agent/tests/workbench_runtime.test.js`
  - 首轮按预期失败：`Cannot find module '../static/workbench-runtime.js'`，证明独立
    runtime 尚不存在。
- `cargo test -p agent --test static_ui`
  - 首轮 3 个既有测试通过，新增 4 个测试按预期失败：缺少阶段轨、试跑结果区、
    注册后续操作/中心搜索以及 runtime 脚本。
- `node --test --test-name-pattern "successful run without a valid name" crates/agent/tests/workbench_runtime.test.js`
  - 删除未直接覆盖的名称分支实现后，按预期得到
    `actual ready_to_register / expected ready_to_run`；恢复最小条件判断后通过。
- `node --test --test-name-pattern "empty state only permits" crates/agent/tests/workbench_runtime.test.js`
  - 自评发现 `empty` 状态仍允许高级设置，新增测试按预期得到
    `advancedDisabled false !== true`；收紧该状态后通过。
- `cargo test -p agent --test static_ui vi_workbench_exposes_staged_and_accessible_controls`
  - 自评发现 disabled 按钮只有不可靠的 `title` 原因，新静态断言按预期失败；
    添加常驻操作原因状态行后通过。

## GREEN evidence

- `node --test crates/agent/tests/workbench_runtime.test.js`: 8 passed, 0 failed。
- `cargo test -p agent`: 65 Agent unit tests + 7 static UI tests passed，0 failed。
- `node --check crates/agent/static/workbench-runtime.js` 和
  `node --check crates/agent/static/app.js`: passed。
- `git diff --check`: passed。
- `.tmp/phase2-task3-ui-check.py`（Playwright + 系统 Chrome）：
  390 / 768 / 1440 三个宽度无页面级横向溢出；查询、试跑、注册、中心搜索、
  路径失效和模板加载交互均通过，浏览器 console 无错误。

## Changed files

- `crates/agent/static/workbench-runtime.js`
- `crates/agent/static/app.js`
- `crates/agent/static/index.html`
- `crates/agent/static/style.css`
- `crates/agent/tests/workbench_runtime.test.js`
- `crates/agent/tests/workbench_app_behavior.test.js`
- `crates/agent/tests/static_ui.rs`
- `.superpowers/sdd/phase2-task-3-report.md`

## Commit

`HEAD` — `feat(agent): add staged VI workbench`

## Self-review

- runtime 单独管理 `empty`、`ready_to_inspect`、`inspecting`、`ready_to_run`、
  `running`、`ready_to_register`、`registering`、`registered` 八态及控件条件，
  不访问 DOM/网络，可直接由 Node 测试。
- 路径 `input` 以规范化值和已查询路径比较并立即清除 schema、试跑结果及注册态；
  只有 `blur` 写回规范化路径和默认名称，不触发请求。
- 每个异步动作先由 runtime 原子进入 busy 状态；重复点击或跨动作提交返回 `false`，
  DOM 同步禁用对应输入、按钮和高级设置。
- 查询成功显示入参/出参数量；试跑成功显示摘要、折叠原始 JSON 和复制动作；注册
  成功显示“查看已注册功能”和“继续编辑副本”。
- 中心 VI 搜索对名称、ID、来源机台和路径做大小写无关的客户端匹配；模板加载直接
  进入 `ready_to_run`。
- 查询、试跑、注册仍使用原有 URL 和 body 字段；未修改 Rust API。
- 修改只落在 Agent VI 工作台区段；移动端样式和 focus 样式均限定在
  `#page-workbench`，没有改造 Scheduler、序列或通用工作台。
- 阶段轨是唯一新增强调结构，继续使用现有冷灰、青色、绿色令牌；无框架、新依赖或
  外部字体。

## Concerns

- `cargo test -p agent` 全部通过，但仓库既有 Rust `unused`、`dead_code` 和
  `non_snake_case` warning 仍会输出；本任务未触及对应 Rust 代码。
- Playwright Python 包的 bundled Chromium 未安装；响应式/交互验收改用本机
  Chrome，并通过路由 fixture 提供静态资源和 API 响应。
- 请求的内部只读 reviewer 超时且在提交前停止；controller 已知会并将执行正式
  独立评审。

## Formal review fixes

### RED

- `node --test crates/agent/tests/workbench_app_behavior.test.js`
  - 1 test failed, 0 passed。
  - 失败为 `lv-msg.hidden` 的 `actual false / expected true`，证明路径失效清除了
    schema 和试跑结果，但旧“参数已加载/已注册”成功消息仍可见。
- `cargo test -p agent --test static_ui vi_runtime_loads_before_the_application_and_has_mobile_layout_rules`
  - 1 test failed, 0 passed。
  - 失败原因为 VI shrink/action 规则没有 `#page-workbench` 作用域；测试同时禁止
    `.lv-toolbar > *`、`.lv-actions`、`.lv-actions button` 三个裸选择器。

### GREEN

- `node --test crates/agent/tests/workbench_runtime.test.js crates/agent/tests/workbench_app_behavior.test.js`
  - 9 passed, 0 failed（8 个 runtime 状态测试 + 1 个真实 `app.js` 函数体 DOM
    行为测试）。
- `cargo test -p agent --test static_ui`
  - 7 passed, 0 failed。
- `cargo test -p agent`
  - 65 Agent unit tests + 7 static UI tests passed，0 failed。
- `node --check crates/agent/static/workbench-runtime.js` 和
  `node --check crates/agent/static/app.js`
  - 2 passed，0 failed。
- `git diff --check`
  - passed。

### Changes

- 路径真正失效时，`clearLvSchemasAndResults()` 现在调用既有 `hideLvMsg()`，
  清除旧成功消息；规范化结果仍等于已查询路径时不会进入失效清理。
- `.lv-toolbar > *`、`.lv-actions` 与移动端 `.lv-actions button` 全部收紧为
  `#page-workbench ...`，不再影响通用工作台。
- 新增 `crates/agent/tests/workbench_app_behavior.test.js`，执行从产品
  `app.js` 提取的实际清理函数并断言 DOM 结果。
- `static_ui.rs` 要求 VI toolbar 和 mobile action 覆盖使用工作台作用域，同时保留
  通用工作台依赖的共享 action 基础规则。

### Follow-up commit

`HEAD` — `fix(agent): address VI workbench review`

## Formal re-review CSS scope fix

### RED

- `cargo test -p agent --test static_ui vi_runtime_loads_before_the_application_and_has_mobile_layout_rules`
  - 收紧测试的首次尝试因子串匹配误命中 scoped selector 而意外通过，未作为 RED
    证据；测试改为要求行首精确裸规则后重新运行。
  - 精确测试得到 0 passed、1 failed，失败消息为
    `the shared action layout used by the general workbench must remain available`，
    证明 Base 的共享 `.lv-actions` flex/wrap/gap 被错误收紧。

### GREEN

- 同一 targeted 静态测试：1 passed、0 failed。
- `node --test crates/agent/tests/workbench_runtime.test.js crates/agent/tests/workbench_app_behavior.test.js`：
  9 passed、0 failed。
- `cargo test -p agent --test static_ui`：7 passed、0 failed。
- `cargo test -p agent`：65 Agent unit tests + 7 static UI tests passed，0 failed。
- 两个 `node --check` 命令：2 passed、0 failed。
- `git diff --check`：passed。

### Changes

- 恢复 Base 共享 `.lv-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }`，
  让通用工作台继续获得原布局。
- 仅本 Task 新增的 mobile `.lv-actions` / `.lv-actions button` 覆盖保留
  `#page-workbench` 前缀。
- 静态测试仅在 `mobile_rules` 内禁止裸 action selector，并断言共享基础规则存在；
  `.lv-toolbar > *` 仍要求全局 scoped。
- Changed files 列表补入
  `crates/agent/tests/workbench_app_behavior.test.js`。

### Follow-up commit

`HEAD` — `fix(agent): preserve shared action layout`
