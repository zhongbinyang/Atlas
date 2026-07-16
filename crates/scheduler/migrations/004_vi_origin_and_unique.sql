ALTER TABLE vi_templates ADD COLUMN origin_agent_id TEXT;
UPDATE vi_templates SET origin_agent_id = agent_id WHERE origin_agent_id IS NULL OR origin_agent_id = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_vi_templates_agent_vi_path ON vi_templates(agent_id, vi_path);
