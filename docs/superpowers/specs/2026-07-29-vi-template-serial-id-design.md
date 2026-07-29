# Design: VI template auto-increment integer ID

Date: 2026-07-29

## Decision

Replace `vi_templates.id` UUID (`TEXT`) with PostgreSQL `BIGSERIAL` (`BIGINT`). Queue foreign keys follow. No parallel display column.

## Schema

- `vi_templates.id BIGSERIAL PRIMARY KEY`
- `vi_run_queue_items.vi_template_id BIGINT` → FK `vi_templates(id)`
- Migration `008`: if `id` is still `text`, remap rows by `created_at, id`, rewrite queue refs, drop TEXT pk
- Deleted IDs are not reused (sequence continues)

## API / UI

- JSON `id` / `vi_template_id` are numbers
- Path params `/api/vi-templates/{id}` parse as `i64`
- Center `#/functions`, Agent「中心全部功能」, Agent「执行序列」left list: leftmost **ID** column
