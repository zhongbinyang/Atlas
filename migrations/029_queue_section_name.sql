-- Replace leftover group-era column `title` with `section_name`.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND column_name = 'title'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'vi_run_queue_items'
        AND column_name = 'section_name'
    ) THEN
      UPDATE vi_run_queue_items
      SET section_name = title
      WHERE section_name = '' AND title <> '';
      ALTER TABLE vi_run_queue_items DROP COLUMN title;
    ELSE
      ALTER TABLE vi_run_queue_items RENAME COLUMN title TO section_name;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_template_steps'
      AND column_name = 'title'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'sequence_template_steps'
        AND column_name = 'section_name'
    ) THEN
      UPDATE sequence_template_steps
      SET section_name = title
      WHERE section_name = '' AND title <> '';
      ALTER TABLE sequence_template_steps DROP COLUMN title;
    ELSE
      ALTER TABLE sequence_template_steps RENAME COLUMN title TO section_name;
    END IF;
  END IF;
END $$;
