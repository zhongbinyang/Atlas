CREATE TABLE IF NOT EXISTS spec_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  product_pn TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_filename TEXT NOT NULL DEFAULT '',
  spec_json JSONB NOT NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spec_templates_updated
  ON spec_templates (updated_at DESC, id DESC);
