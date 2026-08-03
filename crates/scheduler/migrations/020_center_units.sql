-- Global shared units catalog (one row for all agents).

CREATE TABLE IF NOT EXISTS center_units (
  id TEXT PRIMARY KEY,
  units_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
