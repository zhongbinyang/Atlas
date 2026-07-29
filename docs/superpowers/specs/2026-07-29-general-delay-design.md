# Design: Agent general page + delay function

Date: 2026-07-29

## Scope

1. Remove Agent「近期任务」UI and polling.
2. Add top-level tab **通用** beside VI / 序列.
3. First builtin: **Delay** (`kind=delay`), duration in **milliseconds**.

## Storage

- `vi_templates.kind TEXT NOT NULL DEFAULT 'labview'`
- Delay rows: `vi_path='__builtin__/delay'`, `inputs=[{"name":"delay_ms","className":"Digital","value":N}]`, empty cli/getinfo.
- Same register rules (name+inputs unique), serial id, origin_agent_id.

## Agent

- General page: name, delay_ms, 试跑 (sleep + busy slot), 注册到中心.
- List center templates filtered `kind=delay`.
- Sequence: all kinds; run branch on `kind` (delay → sleep, labview → CLI).

## Center

- `#/functions` show type column; filter unchanged (by origin).
