CREATE TABLE IF NOT EXISTS agent_config_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  config_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_config_templates_updated
  ON agent_config_templates (updated_at DESC, id DESC);
