-- Section header rows in run-queue and sequence templates.
-- template_source='section': both template FKs NULL; section_name + collapsed used for UI.

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS section_name TEXT NOT NULL DEFAULT '';

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS template_source TEXT NOT NULL DEFAULT 'labview';

UPDATE vi_run_queue_items
SET template_source = 'general'
WHERE general_template_id IS NOT NULL;

UPDATE vi_run_queue_items
SET template_source = 'labview'
WHERE vi_template_id IS NOT NULL AND general_template_id IS NULL;

ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_check;
ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_one_template_ck;

UPDATE vi_run_queue_items
SET template_source = 'section'
WHERE template_source = 'group';

ALTER TABLE vi_run_queue_items
  ADD CONSTRAINT vi_run_queue_items_one_template_ck
  CHECK (
    (
      template_source = 'section'
      AND vi_template_id IS NULL
      AND general_template_id IS NULL
    )
    OR (
      template_source = 'general'
      AND vi_template_id IS NULL
      AND general_template_id IS NOT NULL
    )
    OR (
      template_source = 'labview'
      AND vi_template_id IS NOT NULL
      AND general_template_id IS NULL
    )
  );

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS section_name TEXT NOT NULL DEFAULT '';

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_check;
ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_one_template_ck;

UPDATE sequence_template_steps
SET template_source = 'section'
WHERE template_source = 'group';

ALTER TABLE sequence_template_steps
  ADD CONSTRAINT sequence_template_steps_one_template_ck
  CHECK (
    (
      template_source = 'section'
      AND vi_template_id IS NULL
      AND general_template_id IS NULL
    )
    OR (
      template_source = 'general'
      AND vi_template_id IS NULL
      AND general_template_id IS NOT NULL
    )
    OR (
      template_source = 'labview'
      AND vi_template_id IS NOT NULL
      AND general_template_id IS NULL
    )
  );
