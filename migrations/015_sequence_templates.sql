CREATE TABLE IF NOT EXISTS sequence_templates (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_template_steps (
  id BIGSERIAL PRIMARY KEY,
  sequence_template_id BIGINT NOT NULL REFERENCES sequence_templates(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  template_source TEXT NOT NULL,
  vi_template_id BIGINT,
  general_template_id BIGINT,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  fail_policy TEXT NOT NULL DEFAULT 'stop',
  limits_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  CHECK (
    (vi_template_id IS NOT NULL AND general_template_id IS NULL) OR
    (vi_template_id IS NULL AND general_template_id IS NOT NULL)
  ),
  FOREIGN KEY (vi_template_id) REFERENCES vi_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (general_template_id) REFERENCES general_templates(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sequence_template_steps_pos
  ON sequence_template_steps(sequence_template_id, position);
