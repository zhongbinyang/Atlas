CREATE TABLE IF NOT EXISTS sequence_template_last_steps (
  id BIGSERIAL PRIMARY KEY,
  sequence_template_id BIGINT NOT NULL REFERENCES sequence_templates(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  template_source TEXT NOT NULL,
  vi_template_id BIGINT,
  general_template_id BIGINT,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  ok BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT '',
  measured_json TEXT,
  limits_json TEXT,
  result_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sequence_template_last_steps_pos
  ON sequence_template_last_steps(sequence_template_id, position);
