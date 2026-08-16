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

UPDATE vi_run_queue_items
SET template_source = 'section'
WHERE template_source = 'group';

-- After 035, rest/cmd rows exist and the wider CHECK is already installed.
-- Re-adding this narrower CHECK on every startup would fail (and dropping it
-- would leave a window without a constraint until 035 re-applies).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND column_name = 'rest_template_id'
  ) THEN
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_check;
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_one_template_ck;
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
  END IF;
END $$;

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS section_name TEXT NOT NULL DEFAULT '';

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE sequence_template_steps
SET template_source = 'section'
WHERE template_source = 'group';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_template_steps'
      AND column_name = 'rest_template_id'
  ) THEN
    ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_check;
    ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_one_template_ck;
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
  END IF;
END $$;
