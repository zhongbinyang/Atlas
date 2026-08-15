CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port BIGINT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL NOT NULL DEFAULT 0,
  memory_percent REAL NOT NULL DEFAULT 0,
  busy BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, ip, port)
);
