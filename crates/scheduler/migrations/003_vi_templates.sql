CREATE TABLE IF NOT EXISTS vi_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  vi_path TEXT NOT NULL,
  cli_path TEXT NOT NULL,
  getinfo_path TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  show_front_panel INTEGER NOT NULL DEFAULT 0,
  timeout_secs INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
