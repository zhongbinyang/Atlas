ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS general_template_id BIGINT;

ALTER TABLE vi_run_queue_items
  ALTER COLUMN vi_template_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND constraint_name = 'vi_run_queue_items_general_template_id_fkey'
  ) THEN
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_general_template_id_fkey
      FOREIGN KEY (general_template_id) REFERENCES general_templates(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND constraint_name = 'vi_run_queue_items_one_template_ck'
  ) THEN
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_one_template_ck
      CHECK (
        (vi_template_id IS NOT NULL AND general_template_id IS NULL) OR
        (vi_template_id IS NULL AND general_template_id IS NOT NULL)
      );
  END IF;
END $$;
