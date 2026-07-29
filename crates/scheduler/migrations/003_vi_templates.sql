CREATE TABLE IF NOT EXISTS vi_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  origin_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'labview',
  vi_path TEXT NOT NULL,
  cli_path TEXT NOT NULL,
  getinfo_path TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL DEFAULT '[]',
  show_front_panel BIGINT NOT NULL DEFAULT 0,
  timeout_secs BIGINT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(origin_agent_id) REFERENCES agents(id)
);
