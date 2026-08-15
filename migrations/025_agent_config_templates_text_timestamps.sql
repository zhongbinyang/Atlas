-- Align timestamp columns with the rest of the schema (TEXT RFC3339 strings).
ALTER TABLE agent_config_templates
  ALTER COLUMN created_at TYPE TEXT USING created_at::text,
  ALTER COLUMN updated_at TYPE TEXT USING updated_at::text;
