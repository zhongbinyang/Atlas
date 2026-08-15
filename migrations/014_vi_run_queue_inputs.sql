ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS inputs_json TEXT;

UPDATE vi_run_queue_items q
SET inputs_json = COALESCE(v.inputs_json, '[]')
FROM vi_templates v
WHERE q.inputs_json IS NULL
  AND q.vi_template_id IS NOT NULL
  AND v.id = q.vi_template_id;

UPDATE vi_run_queue_items q
SET inputs_json = COALESCE(g.inputs_json, '[]')
FROM general_templates g
WHERE q.inputs_json IS NULL
  AND q.general_template_id IS NOT NULL
  AND g.id = q.general_template_id;

UPDATE vi_run_queue_items
SET inputs_json = '[]'
WHERE inputs_json IS NULL;

ALTER TABLE vi_run_queue_items
  ALTER COLUMN inputs_json SET DEFAULT '[]';

ALTER TABLE vi_run_queue_items
  ALTER COLUMN inputs_json SET NOT NULL;
