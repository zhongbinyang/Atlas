-- Device and calibration must stay in separate tables.
-- Drop the short-lived merged table if a previous 033 created it.

DROP TABLE IF EXISTS agent_config_profiles;

CREATE TABLE IF NOT EXISTS agent_device_profiles (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_device_profiles_agent_id_idx
  ON agent_device_profiles (agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_device_profiles_one_active_idx
  ON agent_device_profiles (agent_id)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS agent_calibration_profiles (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_calibration_profiles_agent_id_idx
  ON agent_calibration_profiles (agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_calibration_profiles_one_active_idx
  ON agent_calibration_profiles (agent_id)
  WHERE is_active;

-- Existing TEXT setting_json columns (pre-merge installs) become JSONB.
-- Drop the TEXT default first; Postgres will not auto-cast '{}'::text to jsonb.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_device_profiles',
    'station_device_profiles',
    'agent_calibration_profiles',
    'station_calibration_profiles'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = t
        AND column_name = 'setting_json'
        AND data_type = 'text'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN setting_json DROP DEFAULT', t);
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN setting_json TYPE JSONB USING setting_json::jsonb',
        t
      );
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN setting_json SET DEFAULT %L::jsonb',
        t,
        '{}'
      );
    END IF;
  END LOOP;
END $$;
