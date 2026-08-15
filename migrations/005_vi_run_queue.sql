CREATE TABLE IF NOT EXISTS vi_run_queue_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  vi_template_id BIGINT,
  general_template_id BIGINT,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  position BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (vi_template_id IS NOT NULL AND general_template_id IS NULL) OR
    (vi_template_id IS NULL AND general_template_id IS NOT NULL)
  ),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(vi_template_id) REFERENCES vi_templates(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_run_queue_agent_pos
  ON vi_run_queue_items(agent_id, position);
