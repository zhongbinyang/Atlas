# Task 2 最终修复报告

日期：2026-07-29
修复基线：`60194ca91e263b6b5ba528e8072c7e46dc0bec8d`

## 范围

本次仅处理最终全分支审查的两个 Important：

1. VI/通用模板所有加载入口共享 latest generation，并同时受当前路由 guard 约束。
2. VI/通用与 sequence 模板加载全有或全无；HTTP、网络、JSON/格式错误保留最近成功
   数据和表格，只在现有消息区显示错误。

未处理 metrics Minor 建议，未修改 API、路由、按钮文案或视觉令牌。

## 审查核验

基线代码中：

- `fetchViTemplates` 只有来自 route 的调用带 guard；筛选、编辑/删除后的 reload
  互相独立，慢的旧请求能在新的筛选结果后写入 `viTemplates` 和表格。
- VI/通用加载遇到非 2xx 使用 `continue`，会把另一来源作为部分结果提交；网络或
  JSON 失败则 rejection。
- sequence 加载失败会用“加载失败”错误行替换最近成功表格。

审查反馈与实际调用链一致。

## TDD RED

### RED 1：共享 generation 与失败保留原语

先为期望的 `createLatestResourceLoader` 增加真实异步行为测试：

- 旧筛选后返回不得覆盖新筛选；
- route 与 filter 两种入口共享失效序列；
- commit 前必须再次检查 route guard；
- 先成功、后 HTTP 500 时只保留首次 commit；
- 先成功、后 JSON 解析失败时只保留首次 commit。

命令：

```powershell
node --test crates/scheduler/tests/dashboard_runtime.test.js
```

关键输出（exit 1）：

```text
tests 17
pass 12
fail 5
TypeError: createLatestResourceLoader is not a function
```

五个新测试均因生产原语尚不存在而按预期失败。

### RED 2：app.js 生产接线

先增加 Rust 静态保护，要求两个模板资源实际使用共享 loader、禁止 VI 部分提交、
禁止 sequence 错误行覆盖，并要求使用现有消息区。

命令：

```powershell
cargo test -p scheduler --test static_tokens
```

关键输出（exit 1）：

```text
test scheduler_dashboard_loads_self_scheduling_refresh_runtime ... FAILED
template resources must use shared latest-generation loaders
test result: FAILED. 1 passed; 1 failed
```

### RED 3：非 route 入口的当前路由 guard

自审时继续先加静态保护，要求无显式 token 的 VI/sequence reload 默认检查当前路由。

命令：

```powershell
cargo test -p scheduler --test static_tokens
```

关键输出（exit 1）：

```text
non-route VI reload entries must still require the functions route
test result: FAILED. 1 passed; 1 failed
```

## GREEN 实现

### `dashboard-runtime.js`

新增 `createLatestResourceLoader(options)`：

- 每次调用同步递增私有 generation；
- 所有调用共享同一 generation，无论调用来自 route、manual refresh、筛选或
  编辑/删除后的 reload；
- 异步 load settle 后，只有 generation 仍为最新且调用 guard 返回 true 才 commit；
- stale 成功和 stale 失败都不产生 UI 副作用；
- 当前调用失败只交给 `onError`，不调用 commit，并将 Promise 安全地 resolve 为
  `false`。

### `app.js`

- VI/通用加载拆为无副作用的 `requestViTemplates`：
  - 所需来源请求并行启动；
  - 任一 response 非 2xx 立即作为整个资源失败；
  - 每个 body 必须成功 JSON 解析且为数组；
  - 只有全部成功才返回合并结果。
- 单一 `loadViTemplates` 被全部 `fetchViTemplates` 调用共享，因此 route/manual、
  两个筛选、编辑后 reload、两类删除后 reload 共用 generation。
- 非 route 调用默认使用 `isFunctionsRoute`；route/manual 继续传入 route generation
  token。
- sequence 使用独立的单一 `loadSequenceTemplates`，同样只在 2xx + 合法数组后
  commit；非 route reload 默认使用 `isSequencesRoute`。
- 失败通过 `vi-templates-msg` / `sequence-templates-msg` 显示
  `加载失败: ...`，不改数组和表格。
- 成功 commit 会清除此前的 error 消息；已有“已删除/已修改”等成功消息不被
  无条件清除。

### 静态接线保护

Rust 测试确认：

- app.js 至少创建两个 latest resource loader；
- VI/sequence 非 route reload 使用对应当前路由 guard；
- 不存在 `if (!resp.ok) continue;` 的部分提交；
- 不存在 sequence 加载错误行覆写；
- 两类错误均使用既有消息区。

## GREEN 关键结果

Node 行为测试：

```text
✔ latest resource loader prevents an older filter response from replacing a newer response
✔ latest resource loader shares invalidation across route and filter entry points
✔ latest resource loader checks the route guard before committing
✔ resource loader retains the last commit after an HTTP 500 failure
✔ resource loader retains the last commit after JSON parsing fails
tests 17
pass 17
fail 0
```

Rust 静态接线：

```text
running 2 tests
test scheduler_and_agent_share_design_tokens ... ok
test scheduler_dashboard_loads_self_scheduling_refresh_runtime ... ok
test result: ok. 2 passed; 0 failed
```

## 最终验证命令与结果

```powershell
node --test crates/scheduler/tests/dashboard_runtime.test.js
node --check crates/scheduler/static/dashboard-runtime.js
node --check crates/scheduler/static/app.js
cargo test -p scheduler --test static_tokens
cargo test -p scheduler
git diff --check
```

结果：

- Node 行为测试：17 passed，0 failed。
- 两份 JavaScript 语法检查：exit 0。
- Rust 静态资源测试：2 passed，0 failed。
- scheduler：62 个单元测试 + 2 个静态资源测试通过，0 failed。
- `git diff --check`：exit 0。

## 本次修复文件

- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/static/app.js`
- `crates/scheduler/tests/dashboard_runtime.test.js`
- `crates/scheduler/tests/static_tokens.rs`
- `.superpowers/sdd/final-fix-report.md`

## 自审

- 所有 `fetchViTemplates` 调用都进入同一个 `loadViTemplates` generation 序列。
- route/manual 传入 route token；筛选、编辑/删除 reload 默认检查 functions 路由。
- sequence 的 route/delete reload 同样共享 loader 并检查 sequences 路由。
- resource loader 在 load 完成后才同时检查 generation 与 guard，旧响应无法 commit。
- VI/通用请求在局部数组中完成全部解析，失败前不会写 `viTemplates` 或 DOM。
- sequence 失败不写 `sequenceTemplates`，也不调用 `renderSequenceTemplates`。
- stale 失败不会覆盖新结果的消息状态；当前失败只更新消息区。
- 成功后仅清除 `.err` 消息，不破坏现有成功操作提示。
- 没有修改 Agent 移动端文件或 metrics 逻辑。

## 顾虑

- `cargo test -p scheduler` 仍输出仓库既有 unused/dead-code warnings；本次没有新增
  Rust 生产代码。
- 仓库范围外 Rust fmt 基线差异仍存在；本次修改的 Rust 测试文件已单独通过
  `rustfmt --check`。

---

## 最终消息所有权修复（2026-07-29）

### 问题核验

提交 `83d5362` 中，VI/通用与 sequence loader 的 `onError`、成功后的
`clearLoadError` 仍直接操作原 operation 消息元素：

- 操作成功后 reload 失败会把“已修改/已删除”覆盖成“加载失败”；
- 操作校验/请求失败后，较早 loader 成功会按 `.err` 清掉操作失败事实；
- sequence 删除存在同样的交错时序问题。

### RED

先增加 `createMessageChannel` 期望行为测试，使用独立假 DOM 元素真实执行交错：

- VI 编辑成功、VI/通用删除成功、sequence 删除成功与 reload 失败同时保留；
- 名称校验、修改失败、删除失败、sequence 删除失败不会被 loader 成功清除；
- 成功 reload 只清除自身资源 load error，不影响 operation 或另一资源。

命令：

```powershell
node --test crates/scheduler/tests/dashboard_runtime.test.js
```

关键输出（exit 1）：

```text
tests 20
pass 17
fail 3
TypeError: createMessageChannel is not a function
```

同时先更新 Rust 生产接线保护，要求 HTML 中存在两个独立 load 元素，app.js
为四个元素分别创建通道，且 loader 只使用 load 通道。

```powershell
cargo test -p scheduler --test static_tokens
```

关键输出（exit 1）：

```text
test scheduler_dashboard_loads_self_scheduling_refresh_runtime ... FAILED
VI load failures must not overwrite operation messages
test result: FAILED. 1 passed; 1 failed
```

### GREEN 实现

- `dashboard-runtime.js` 新增 `createMessageChannel(element)`：
  - `show(text, ok)` 只写所属元素；
  - `clearError()` 只在所属元素当前为 `.err` 时清空并恢复中性 `.msg`。
- `index.html` 新增：
  - `vi-templates-load-msg`
  - `sequence-templates-load-msg`
  两者只复用现有 `.msg` 视觉类，没有改动文案或视觉令牌。
- `app.js` 建立四个独立所有者：
  - `viTemplateOperationMessages` → 原 `vi-templates-msg`
  - `viTemplateLoadMessages` → 新 `vi-templates-load-msg`
  - `sequenceTemplateOperationMessages` → 原 `sequence-templates-msg`
  - `sequenceTemplateLoadMessages` → 新 `sequence-templates-load-msg`
- 编辑/删除/校验继续经原 `showViTemplatesMsg` /
  `showSequenceTemplatesMsg` 写 operation 通道。
- 两个 resource loader 的 commit/onError 仅调用各自 load 通道的
  `clearError()` / `show()`。

### GREEN 关键输出

```text
✔ operation success and reload failure remain visible in separate channels
✔ successful reload does not clear operation validation or failure
✔ successful reload clears only its own resource load error
tests 20
pass 20
fail 0
```

Rust 接线：

```text
running 2 tests
test scheduler_and_agent_share_design_tokens ... ok
test scheduler_dashboard_loads_self_scheduling_refresh_runtime ... ok
test result: ok. 2 passed; 0 failed
```

### 本轮验证

```powershell
node --test crates/scheduler/tests/dashboard_runtime.test.js
node --check crates/scheduler/static/dashboard-runtime.js
node --check crates/scheduler/static/app.js
cargo test -p scheduler --test static_tokens
cargo test -p scheduler
git diff --check
```

结果：

- Node：20 passed，0 failed。
- JavaScript 语法：两份均 exit 0。
- Rust 静态资源：2 passed，0 failed。
- scheduler：62 个单元测试 + 2 个静态资源测试通过，0 failed。
- `git diff --check`：exit 0。

### 本轮文件与自审

- `.superpowers/sdd/final-fix-report.md`
- `crates/scheduler/static/dashboard-runtime.js`
- `crates/scheduler/static/app.js`
- `crates/scheduler/static/index.html`
- `crates/scheduler/tests/dashboard_runtime.test.js`
- `crates/scheduler/tests/static_tokens.rs`

自审确认：

- `rg` 显示 operation helper 只调用 operation 通道；
- loader commit/onError 只调用对应 load 通道；
- 不存在 `clearLoadError` 或 loader 调用 operation helper 的遗留路径；
- 两个资源的 load 通道彼此独立；
- API、路由、按钮文案、视觉令牌与 metrics 均未改动。

顾虑仍只有仓库既有 Rust warnings 与范围外 fmt 基线差异。
