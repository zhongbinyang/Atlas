CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  channel_index INTEGER NOT NULL,
  channel_name TEXT NOT NULL,
  sequence_template_id BIGINT REFERENCES sequence_templates(id) ON DELETE SET NULL,
  run_generation BIGINT NOT NULL,
  overall TEXT NOT NULL,
  stopped BOOLEAN NOT NULL,
  failed_at INTEGER,
  elapsed_ms BIGINT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_runs_finished
  ON test_runs (finished_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_overall_finished
  ON test_runs (overall, finished_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'test_runs'
      AND column_name = 'agent_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_test_runs_agent_finished
      ON test_runs (agent_id, finished_at DESC);
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'test_runs'
      AND column_name = 'station_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_test_runs_station_finished
      ON test_runs (station_id, finished_at DESC);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS test_run_context (
  test_run_id TEXT PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
  sn TEXT NOT NULL DEFAULT '',
  work_order TEXT NOT NULL DEFAULT '',
  product_pn TEXT NOT NULL DEFAULT '',
  corner TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  config_revision BIGINT,
  device_profile_id TEXT NOT NULL DEFAULT '',
  device_profile_name TEXT NOT NULL DEFAULT '',
  calibration_profile_id TEXT NOT NULL DEFAULT '',
  calibration_profile_name TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_test_run_context_sn ON test_run_context (sn);

CREATE TABLE IF NOT EXISTS test_run_steps (
  id BIGSERIAL PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  queue_item_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_source TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  elapsed_ms BIGINT NOT NULL,
  measured_json JSONB,
  limits_json JSONB,
  result_json JSONB,
  error TEXT,
  spec_template_id BIGINT,
  spec_section TEXT NOT NULL DEFAULT '',
  UNIQUE (test_run_id, position)
);

CREATE INDEX IF NOT EXISTS idx_test_run_steps_run_pos
  ON test_run_steps (test_run_id, position);
