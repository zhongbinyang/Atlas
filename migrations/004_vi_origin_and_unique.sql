-- Legacy upgrade path: older DBs had agent_id (current holder) and may lack origin_agent_id.
-- Safe to re-run after agent_id has already been dropped.
ALTER TABLE vi_templates ADD COLUMN IF NOT EXISTS origin_agent_id TEXT;

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

UPDATE vi_templates SET origin_agent_id = '' WHERE origin_agent_id IS NULL;
ALTER TABLE vi_templates ALTER COLUMN origin_agent_id SET DEFAULT '';
ALTER TABLE vi_templates ALTER COLUMN origin_agent_id SET NOT NULL;

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
