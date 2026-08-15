-- Rename the machine registry and its dependent tables/columns.
-- JSON/API field names can stay agent_id; SQL uses station_*.
--
-- Migrations re-run every startup. After the first rename, 001/017/019/…
-- CREATE IF NOT EXISTS the old names again (empty leftovers). Prefer the
-- table that already has rows; if both are empty, keep station_*.

DO $$
DECLARE
  old_n BIGINT;
  new_n BIGINT;
BEGIN
  IF to_regclass('agents') IS NOT NULL AND to_regclass('stations') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agents' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM stations' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE stations CASCADE;
      ALTER TABLE agents RENAME TO stations;
    ELSE
      DROP TABLE agents CASCADE;
    END IF;
  ELSIF to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE agents RENAME TO stations;
  END IF;

  IF to_regclass('agent_settings') IS NOT NULL AND to_regclass('station_settings') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agent_settings' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM station_settings' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE station_settings CASCADE;
      ALTER TABLE agent_settings RENAME TO station_settings;
    ELSE
      DROP TABLE agent_settings CASCADE;
    END IF;
  ELSIF to_regclass('agent_settings') IS NOT NULL THEN
    ALTER TABLE agent_settings RENAME TO station_settings;
  END IF;

  IF to_regclass('agent_device_profiles') IS NOT NULL AND to_regclass('station_device_profiles') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agent_device_profiles' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM station_device_profiles' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE station_device_profiles CASCADE;
      ALTER TABLE agent_device_profiles RENAME TO station_device_profiles;
    ELSE
      DROP TABLE agent_device_profiles CASCADE;
    END IF;
  ELSIF to_regclass('agent_device_profiles') IS NOT NULL THEN
    ALTER TABLE agent_device_profiles RENAME TO station_device_profiles;
  END IF;

  IF to_regclass('agent_calibration_profiles') IS NOT NULL AND to_regclass('station_calibration_profiles') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agent_calibration_profiles' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM station_calibration_profiles' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE station_calibration_profiles CASCADE;
      ALTER TABLE agent_calibration_profiles RENAME TO station_calibration_profiles;
    ELSE
      DROP TABLE agent_calibration_profiles CASCADE;
    END IF;
  ELSIF to_regclass('agent_calibration_profiles') IS NOT NULL THEN
    ALTER TABLE agent_calibration_profiles RENAME TO station_calibration_profiles;
  END IF;

  IF to_regclass('agent_channels') IS NOT NULL AND to_regclass('station_channels') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agent_channels' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM station_channels' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE station_channels CASCADE;
      ALTER TABLE agent_channels RENAME TO station_channels;
    ELSE
      DROP TABLE agent_channels CASCADE;
    END IF;
  ELSIF to_regclass('agent_channels') IS NOT NULL THEN
    ALTER TABLE agent_channels RENAME TO station_channels;
  END IF;

  IF to_regclass('agent_config_templates') IS NOT NULL AND to_regclass('station_config_templates') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM agent_config_templates' INTO old_n;
    EXECUTE 'SELECT COUNT(*) FROM station_config_templates' INTO new_n;
    IF old_n > 0 AND new_n = 0 THEN
      DROP TABLE station_config_templates CASCADE;
      ALTER TABLE agent_config_templates RENAME TO station_config_templates;
    ELSE
      DROP TABLE agent_config_templates CASCADE;
    END IF;
  ELSIF to_regclass('agent_config_templates') IS NOT NULL THEN
    ALTER TABLE agent_config_templates RENAME TO station_config_templates;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_settings' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE station_settings RENAME COLUMN agent_id TO station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_device_profiles' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE station_device_profiles RENAME COLUMN agent_id TO station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_calibration_profiles' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE station_calibration_profiles RENAME COLUMN agent_id TO station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_channels' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE station_channels RENAME COLUMN agent_id TO station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_config_templates' AND column_name = 'source_agent_id'
  ) THEN
    ALTER TABLE station_config_templates RENAME COLUMN source_agent_id TO source_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'station_config_templates' AND column_name = 'created_by_agent_id'
  ) THEN
    ALTER TABLE station_config_templates RENAME COLUMN created_by_agent_id TO created_by_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'vi_templates' AND column_name = 'origin_agent_id'
  ) THEN
    ALTER TABLE vi_templates RENAME COLUMN origin_agent_id TO origin_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'general_templates' AND column_name = 'origin_agent_id'
  ) THEN
    ALTER TABLE general_templates RENAME COLUMN origin_agent_id TO origin_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'sequence_templates' AND column_name = 'created_by_agent_id'
  ) THEN
    ALTER TABLE sequence_templates RENAME COLUMN created_by_agent_id TO created_by_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'spec_templates' AND column_name = 'created_by_agent_id'
  ) THEN
    ALTER TABLE spec_templates RENAME COLUMN created_by_agent_id TO created_by_station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'vi_run_queue_items' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE vi_run_queue_items RENAME COLUMN agent_id TO station_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'test_runs' AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE test_runs RENAME COLUMN agent_id TO station_id;
  END IF;
END $$;

ALTER INDEX IF EXISTS agent_device_profiles_agent_id_idx
  RENAME TO station_device_profiles_station_id_idx;
ALTER INDEX IF EXISTS agent_device_profiles_one_active_idx
  RENAME TO station_device_profiles_one_active_idx;
ALTER INDEX IF EXISTS agent_calibration_profiles_agent_id_idx
  RENAME TO station_calibration_profiles_station_id_idx;
ALTER INDEX IF EXISTS agent_calibration_profiles_one_active_idx
  RENAME TO station_calibration_profiles_one_active_idx;
ALTER INDEX IF EXISTS agent_channels_agent_index_uidx
  RENAME TO station_channels_station_index_uidx;
ALTER INDEX IF EXISTS idx_test_runs_agent_finished
  RENAME TO idx_test_runs_station_finished;
ALTER INDEX IF EXISTS idx_agent_config_templates_updated
  RENAME TO idx_station_config_templates_updated;
ALTER INDEX IF EXISTS idx_vi_run_queue_agent_pos
  RENAME TO idx_vi_run_queue_station_pos;
