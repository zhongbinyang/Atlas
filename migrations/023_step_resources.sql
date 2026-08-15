ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS resources_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS resources_json TEXT NOT NULL DEFAULT '[]';
