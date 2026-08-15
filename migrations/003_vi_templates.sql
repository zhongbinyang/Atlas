CREATE TABLE IF NOT EXISTS vi_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
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
