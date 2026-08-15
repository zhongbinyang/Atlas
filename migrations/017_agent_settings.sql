CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  variables_json TEXT NOT NULL DEFAULT '[]',
  array_expand_mode TEXT NOT NULL DEFAULT 'semicolon',
  updated_at TEXT NOT NULL
);
