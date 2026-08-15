-- Per-agent device and calibration setting profiles (multi-profile, one active each).

CREATE TABLE IF NOT EXISTS agent_device_profiles (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json TEXT NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_device_profiles_agent_id_idx
  ON agent_device_profiles (agent_id);

-- At most one active device profile per agent.
CREATE UNIQUE INDEX IF NOT EXISTS agent_device_profiles_one_active_idx
  ON agent_device_profiles (agent_id)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS agent_calibration_profiles (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  setting_json TEXT NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  source_filename TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_calibration_profiles_agent_id_idx
  ON agent_calibration_profiles (agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_calibration_profiles_one_active_idx
  ON agent_calibration_profiles (agent_id)
  WHERE is_active;
