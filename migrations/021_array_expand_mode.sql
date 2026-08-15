-- Per-agent preference for how JSON arrays flatten into ${Var}.
-- semicolon = "4.58;4.5;4.6" (legacy INI multi-value)
-- json = "[4.58,4.5,4.6]" (raw JSON)

DO $$
BEGIN
  IF to_regclass('agent_settings') IS NOT NULL THEN
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS array_expand_mode TEXT NOT NULL DEFAULT 'semicolon';
  END IF;
  IF to_regclass('station_settings') IS NOT NULL THEN
    ALTER TABLE station_settings
      ADD COLUMN IF NOT EXISTS array_expand_mode TEXT NOT NULL DEFAULT 'semicolon';
  END IF;
END $$;
