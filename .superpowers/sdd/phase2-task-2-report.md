# Phase 2 Task 2 report — 调度中心机台遥测控制带

## RED evidence

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`
  - 新增的 5 个遥测测试按预期失败：`getAgentTelemetry is not a function`、
    `formatAgentHeartbeat is not a function`；其余 26 个既有测试通过。
- `cargo test -p scheduler --test static_tokens`
  - 新增静态测试按预期失败：页面尚未包含 `id="machine-telemetry"`；其余 3 个测试通过。

## GREEN evidence

- `node --test crates/scheduler/tests/dashboard_runtime.test.js`: 32 passed, 0 failed。
- `cargo test -p scheduler`: 62 scheduler unit tests + 4 static tests passed, 0 failed。
- `node --check crates/scheduler/static/app.js` and
  `node --check crates/scheduler/static/dashboard-runtime.js`: passed。
- `git diff --check`: passed。

## Changed files

- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/static/app.js`
- `crates/scheduler/static/index.html`
- `crates/scheduler/static/style.css`
- `crates/scheduler/tests/dashboard_runtime.test.js`
- `crates/scheduler/tests/static_tokens.rs`
- `.superpowers/sdd/phase2-task-2-report.md`

## Commit

`HEAD` — `feat(scheduler): add machine telemetry controls`

## Self-review

- 摘要由最后一次成功的 `agents` 数组派生；没有新增请求，且失败响应不会更新时间。
- 搜索、状态/异常筛选和四种排序均只处理副本，不改变 `agents` 原始顺序。
- 结果继续走 Agent ID keyed reconcile；回归测试覆盖刷新时过滤条件不变及匹配卡片节点复用。
- 详情页以“最后心跳”显示相对时间和本地时间；无效值显示 `—`。
- 控制带具备关联 label、两类空状态，并在 640 px 下切换为单列多行布局。

## Concerns

- `cargo test -p scheduler` 通过，但仓库既有 Rust `unused` / `dead_code` warning 仍会输出；本任务未触及相关代码。
