-- Drop unused breakpoint columns. Saved sequence steps follow the
-- function template they reference (same as the live run queue).

ALTER TABLE vi_run_queue_items DROP COLUMN IF EXISTS breakpoint;
ALTER TABLE sequence_template_steps DROP COLUMN IF EXISTS breakpoint;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'sequence_template_steps'
      AND c.contype = 'f'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%vi_template_id%'
        OR pg_get_constraintdef(c.oid) ILIKE '%general_template_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE sequence_template_steps DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE sequence_template_steps
  ADD CONSTRAINT sequence_template_steps_vi_template_id_fkey
  FOREIGN KEY (vi_template_id) REFERENCES vi_templates(id) ON DELETE CASCADE;

ALTER TABLE sequence_template_steps
  ADD CONSTRAINT sequence_template_steps_general_template_id_fkey
  FOREIGN KEY (general_template_id) REFERENCES general_templates(id) ON DELETE CASCADE;
