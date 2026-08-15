-- Align timestamp columns with the rest of the schema (TEXT RFC3339 strings).
DO $$
BEGIN
  IF to_regclass('agent_config_templates') IS NOT NULL THEN
    ALTER TABLE agent_config_templates
      ALTER COLUMN created_at TYPE TEXT USING created_at::text,
      ALTER COLUMN updated_at TYPE TEXT USING updated_at::text;
  END IF;
  IF to_regclass('station_config_templates') IS NOT NULL THEN
    ALTER TABLE station_config_templates
      ALTER COLUMN created_at TYPE TEXT USING created_at::text,
      ALTER COLUMN updated_at TYPE TEXT USING updated_at::text;
  END IF;
END $$;
