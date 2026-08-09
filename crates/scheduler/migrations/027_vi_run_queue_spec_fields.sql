ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_template_id BIGINT REFERENCES spec_templates(id) ON DELETE SET NULL;
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_section TEXT NOT NULL DEFAULT '';
ALTER TABLE vi_run_queue_items ADD COLUMN IF NOT EXISTS spec_metrics_json TEXT NOT NULL DEFAULT '[]';
