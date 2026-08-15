-- Drop unused scheduler leftovers and tighten station-owned FKs.
-- Works before and after 034 (agents → stations, agent_id → station_id).

DROP TABLE IF EXISTS screenshots;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS task_templates;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND column_name = 'agent_id'
  ) AND to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_agent_id_fkey;
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_station_id_fkey;
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND column_name = 'station_id'
  ) AND to_regclass('stations') IS NOT NULL THEN
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_agent_id_fkey;
    ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_station_id_fkey;
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_station_id_fkey
      FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agents'
      AND column_name = 'busy'
      AND data_type IN ('bigint', 'integer', 'numeric', 'smallint')
  ) THEN
    ALTER TABLE agents ALTER COLUMN busy DROP DEFAULT;
    ALTER TABLE agents ALTER COLUMN busy TYPE BOOLEAN USING (busy <> 0);
    ALTER TABLE agents ALTER COLUMN busy SET DEFAULT FALSE;
    ALTER TABLE agents ALTER COLUMN busy SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'stations'
      AND column_name = 'busy'
      AND data_type IN ('bigint', 'integer', 'numeric', 'smallint')
  ) THEN
    ALTER TABLE stations ALTER COLUMN busy DROP DEFAULT;
    ALTER TABLE stations ALTER COLUMN busy TYPE BOOLEAN USING (busy <> 0);
    ALTER TABLE stations ALTER COLUMN busy SET DEFAULT FALSE;
    ALTER TABLE stations ALTER COLUMN busy SET NOT NULL;
  END IF;
END $$;

ALTER TABLE IF EXISTS agent_settings DROP COLUMN IF EXISTS units_json;
ALTER TABLE IF EXISTS station_settings DROP COLUMN IF EXISTS units_json;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_templates'
      AND column_name = 'created_by_agent_id'
  ) AND to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE sequence_templates ALTER COLUMN created_by_agent_id DROP NOT NULL;
    ALTER TABLE sequence_templates DROP CONSTRAINT IF EXISTS sequence_templates_created_by_agent_id_fkey;
    ALTER TABLE sequence_templates DROP CONSTRAINT IF EXISTS sequence_templates_created_by_station_id_fkey;
    ALTER TABLE sequence_templates
      ADD CONSTRAINT sequence_templates_created_by_agent_id_fkey
      FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_templates'
      AND column_name = 'created_by_station_id'
  ) AND to_regclass('stations') IS NOT NULL THEN
    ALTER TABLE sequence_templates ALTER COLUMN created_by_station_id DROP NOT NULL;
    ALTER TABLE sequence_templates DROP CONSTRAINT IF EXISTS sequence_templates_created_by_agent_id_fkey;
    ALTER TABLE sequence_templates DROP CONSTRAINT IF EXISTS sequence_templates_created_by_station_id_fkey;
    ALTER TABLE sequence_templates
      ADD CONSTRAINT sequence_templates_created_by_station_id_fkey
      FOREIGN KEY (created_by_station_id) REFERENCES stations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('agent_config_templates') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agent_config_templates'
         AND column_name = 'created_by_agent_id'
     )
     AND to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE agent_config_templates ALTER COLUMN created_by_agent_id DROP NOT NULL;
    ALTER TABLE agent_config_templates DROP CONSTRAINT IF EXISTS agent_config_templates_created_by_agent_id_fkey;
    ALTER TABLE agent_config_templates
      ADD CONSTRAINT agent_config_templates_created_by_agent_id_fkey
      FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  ELSIF to_regclass('station_config_templates') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'station_config_templates'
         AND column_name = 'created_by_station_id'
     )
     AND to_regclass('stations') IS NOT NULL THEN
    ALTER TABLE station_config_templates ALTER COLUMN created_by_station_id DROP NOT NULL;
    ALTER TABLE station_config_templates DROP CONSTRAINT IF EXISTS agent_config_templates_created_by_agent_id_fkey;
    ALTER TABLE station_config_templates DROP CONSTRAINT IF EXISTS station_config_templates_created_by_station_id_fkey;
    ALTER TABLE station_config_templates
      ADD CONSTRAINT station_config_templates_created_by_station_id_fkey
      FOREIGN KEY (created_by_station_id) REFERENCES stations(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP INDEX IF EXISTS agent_channels_agent_id_idx;
