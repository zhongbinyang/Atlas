CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port BIGINT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL NOT NULL DEFAULT 0,
  memory_percent REAL NOT NULL DEFAULT 0,
  busy BIGINT NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(name, ip, port)
);

CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  shell TEXT NOT NULL,
  command TEXT NOT NULL,
  workdir TEXT,
  timeout_secs BIGINT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  template_id TEXT,
  shell TEXT NOT NULL,
  command TEXT NOT NULL,
  workdir TEXT,
  timeout_secs BIGINT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  agent_task_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);
