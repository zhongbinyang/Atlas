-- Group header rows in run-queue and sequence templates.
-- template_source='group': both template FKs NULL; title + collapsed used for UI.

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

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

ALTER TABLE vi_run_queue_items
  ADD CONSTRAINT vi_run_queue_items_one_template_ck
  CHECK (
    (
      template_source = 'group'
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
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_check;
ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_one_template_ck;

ALTER TABLE sequence_template_steps
  ADD CONSTRAINT sequence_template_steps_one_template_ck
  CHECK (
    (
      template_source = 'group'
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
