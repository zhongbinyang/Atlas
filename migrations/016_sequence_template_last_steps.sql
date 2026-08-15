-- Remove last-run result storage (superseded by agent sequence run logs).
DROP TABLE IF EXISTS sequence_template_last_steps;

ALTER TABLE sequence_templates DROP COLUMN IF EXISTS last_run_overall;
ALTER TABLE sequence_templates DROP COLUMN IF EXISTS last_run_sn;
ALTER TABLE sequence_templates DROP COLUMN IF EXISTS last_run_work_order;
ALTER TABLE sequence_templates DROP COLUMN IF EXISTS last_run_at;
