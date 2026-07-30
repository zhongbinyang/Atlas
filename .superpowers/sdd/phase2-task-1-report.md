# Phase 2 Task 1 report

## RED

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - 预期失败：新增的三个用例因 `createDialogController` 与
    `createToastController` 尚未实现而失败（20 passed, 3 failed）。
- `cargo test -p scheduler --test static_tokens; cargo test -p agent --test static_ui`
  - 预期失败：Scheduler/Agent 页面仍引用 `fonts.googleapis.com`（两个测试
    各 2 passed, 1 failed）。
- 审查发现嵌套对话框焦点问题后，再次执行
  `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - 预期失败：替换对话框的关闭回调未收到 `replaced` 原因（24 passed,
    1 failed），原父对话框的隐藏触发控件会获得焦点。
- 随后执行 `cargo test -p scheduler --test static_tokens`
  - 预期失败：历史截图的“查看”按钮没有声明关闭截图后应恢复历史对话框
    （2 passed, 1 failed）。

## GREEN

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`：25 passed。
- `cargo test -p scheduler`：62 unit/integration tests passed；其中静态 UI
  测试为 3 passed。
- `cargo test -p agent --test static_ui`：3 passed。
- `node --check crates/scheduler/static/dashboard-runtime.js` 与
  `node --check crates/scheduler/static/app.js`：通过。
- `git diff --check`：通过。

## 修改文件

- `crates/scheduler/static/index.html`
- `crates/scheduler/static/style.css`
- `crates/scheduler/static/app.js`
- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/static/favicon.svg`
- `crates/scheduler/tests/dashboard_runtime.test.js`
- `crates/scheduler/tests/static_tokens.rs`
- `crates/agent/static/index.html`
- `crates/agent/static/style.css`
- `crates/agent/static/favicon.svg`
- `crates/agent/tests/static_ui.rs`

## Commit

实现提交：`f52f34415e59ffd6977ac27dfe5e166f6c668a22`

## 自评

- Toast 独立于已有 operation/load 消息，默认 4000 ms，悬停或焦点停留时暂停。
- 统一控制器覆盖截图、历史、文件、预览和自定义删除确认；含标题关联、模态
  语义、首个控件聚焦、Tab 循环、Esc、触发控件恢复和单一打开限制。
- 文件预览和历史截图作为嵌套流时会恢复父对话框，避免焦点落到已隐藏控件。
- 已移除 Scheduler/Agent Google Fonts，使用系统字体栈及同目录 SVG favicon；
  未改变 HTTP API。

## 顾虑

- 未执行浏览器端到端手工测试；关键键盘和嵌套流已由 Node 控制器测试及静态
  回归断言覆盖。
- Rust 测试输出仍有仓库既有的 unused/dead-code 警告；本任务未引入新的 Rust
  生产代码。
