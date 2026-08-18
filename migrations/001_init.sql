CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port BIGINT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL NOT NULL DEFAULT 0,
  memory_percent REAL NOT NULL DEFAULT 0,
  busy BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (name, ip, port)
);

CREATE TABLE IF NOT EXISTS center_units (
  id TEXT PRIMARY KEY,
  units_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vi_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'labview',
  vi_path TEXT NOT NULL,
  cli_path TEXT NOT NULL,
  getinfo_path TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  show_front_panel BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_secs BIGINT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS general_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'delay',
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  CONSTRAINT general_templates_kind_check CHECK (kind IN ('delay', 'version'))
);

CREATE TABLE IF NOT EXISTS rest_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'rest',
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cmd_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'cmd',
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station_settings (
  station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  variables_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  array_expand_mode TEXT NOT NULL DEFAULT 'semicolon'
);

CREATE TABLE IF NOT EXISTS station_device_profiles (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS station_device_profiles_station_id_idx
  ON station_device_profiles (station_id);
CREATE UNIQUE INDEX IF NOT EXISTS station_device_profiles_one_active_idx
  ON station_device_profiles (station_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS station_calibration_profiles (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS station_calibration_profiles_station_id_idx
  ON station_calibration_profiles (station_id);
CREATE UNIQUE INDEX IF NOT EXISTS station_calibration_profiles_one_active_idx
  ON station_calibration_profiles (station_id) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS station_channels (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  channel_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  overlay_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS station_channels_station_index_uidx
  ON station_channels (station_id, channel_index);

CREATE TABLE IF NOT EXISTS station_config_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  created_by_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  config_json JSONB NOT NULL,
  created_at TEXT NOT NULL DEFAULT now(),
  updated_at TEXT NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_station_config_templates_updated
  ON station_config_templates (updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sequence_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_template_steps (
  id BIGSERIAL PRIMARY KEY,
  sequence_template_id BIGINT NOT NULL REFERENCES sequence_templates(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  template_source TEXT NOT NULL,
  vi_template_id BIGINT REFERENCES vi_templates(id) ON DELETE CASCADE,
  general_template_id BIGINT REFERENCES general_templates(id) ON DELETE CASCADE,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  fail_policy TEXT NOT NULL DEFAULT 'stop',
  limits_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  resources_json TEXT NOT NULL DEFAULT '[]',
  section_name TEXT NOT NULL DEFAULT '',
  rest_template_id BIGINT REFERENCES rest_templates(id) ON DELETE CASCADE,
  cmd_template_id BIGINT REFERENCES cmd_templates(id) ON DELETE CASCADE,
  CONSTRAINT sequence_template_steps_one_template_ck
    CHECK (
      (template_source = 'section'
        AND vi_template_id IS NULL AND general_template_id IS NULL
        AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'general'
        AND general_template_id IS NOT NULL
        AND vi_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'labview'
        AND vi_template_id IS NOT NULL
        AND general_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'rest'
        AND rest_template_id IS NOT NULL
        AND vi_template_id IS NULL AND general_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'cmd'
        AND cmd_template_id IS NOT NULL
        AND vi_template_id IS NULL AND general_template_id IS NULL AND rest_template_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_sequence_template_steps_pos
  ON sequence_template_steps (sequence_template_id, position);

CREATE TABLE IF NOT EXISTS spec_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  product_pn TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_filename TEXT NOT NULL DEFAULT '',
  spec_json JSONB NOT NULL,
  created_by_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spec_templates_updated
  ON spec_templates (updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vi_run_queue_items (
  id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  vi_template_id BIGINT REFERENCES vi_templates(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  fail_policy TEXT NOT NULL DEFAULT 'stop',
  limits_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  general_template_id BIGINT REFERENCES general_templates(id) ON DELETE CASCADE,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  template_source TEXT NOT NULL DEFAULT 'labview',
  resources_json TEXT NOT NULL DEFAULT '[]',
  spec_template_id BIGINT REFERENCES spec_templates(id) ON DELETE SET NULL,
  spec_section TEXT NOT NULL DEFAULT '',
  spec_metrics_json TEXT NOT NULL DEFAULT '[]',
  section_name TEXT NOT NULL DEFAULT '',
  rest_template_id BIGINT REFERENCES rest_templates(id) ON DELETE CASCADE,
  cmd_template_id BIGINT REFERENCES cmd_templates(id) ON DELETE CASCADE,
  CONSTRAINT vi_run_queue_items_one_template_ck
    CHECK (
      (template_source = 'section'
        AND vi_template_id IS NULL AND general_template_id IS NULL
        AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'general'
        AND general_template_id IS NOT NULL
        AND vi_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'labview'
        AND vi_template_id IS NOT NULL
        AND general_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'rest'
        AND rest_template_id IS NOT NULL
        AND vi_template_id IS NULL AND general_template_id IS NULL AND cmd_template_id IS NULL)
      OR (template_source = 'cmd'
        AND cmd_template_id IS NOT NULL
        AND vi_template_id IS NULL AND general_template_id IS NULL AND rest_template_id IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_vi_run_queue_station_pos
  ON vi_run_queue_items (station_id, position);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
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
  ON test_runs (overall, finished_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_station_finished
  ON test_runs (station_id, finished_at DESC, id DESC);

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
CREATE INDEX IF NOT EXISTS idx_test_run_context_sn
  ON test_run_context (sn);

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
