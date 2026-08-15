-- Legacy upgrade path: older DBs had agent_id (current holder) and may lack origin_agent_id.
-- Safe to re-run after agent_id has already been dropped, and after 034 renamed
-- origin_agent_id → origin_station_id (do not add the old column back).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name IN ('origin_agent_id', 'origin_station_id')
  ) THEN
    ALTER TABLE vi_templates ADD COLUMN origin_agent_id TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'agent_id'
  ) THEN
    EXECUTE $u$
      UPDATE vi_templates
      SET origin_agent_id = agent_id
      WHERE origin_agent_id IS NULL OR origin_agent_id = ''
    $u$;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'agent_id'
  ) THEN
    EXECUTE $i$
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_templates_agent_vi_path
      ON vi_templates(agent_id, vi_path)
    $i$;
  END IF;
END $$;
