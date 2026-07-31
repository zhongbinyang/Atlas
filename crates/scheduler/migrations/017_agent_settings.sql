CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  units_json TEXT NOT NULL DEFAULT '[]',
  variables_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
