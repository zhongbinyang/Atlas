CREATE TABLE IF NOT EXISTS general_templates (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    origin_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'delay',
    inputs_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
