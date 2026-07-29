CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_screenshots_agent_created
  ON screenshots(agent_id, created_at DESC);
