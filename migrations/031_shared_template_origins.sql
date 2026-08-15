-- Shared function templates keep surviving after a station is deleted.
-- Live run-queue rows still follow the template they reference.
-- Works before and after 034 (origin_agent_id → origin_station_id).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'origin_agent_id'
  ) THEN
    UPDATE vi_templates SET origin_agent_id = NULL WHERE origin_agent_id = '';
    ALTER TABLE vi_templates ALTER COLUMN origin_agent_id DROP DEFAULT;
    ALTER TABLE vi_templates ALTER COLUMN origin_agent_id DROP NOT NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'origin_station_id'
  ) THEN
    UPDATE vi_templates SET origin_station_id = NULL WHERE origin_station_id = '';
    ALTER TABLE vi_templates ALTER COLUMN origin_station_id DROP DEFAULT;
    ALTER TABLE vi_templates ALTER COLUMN origin_station_id DROP NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'vi_templates'
      AND c.contype = 'f'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%origin_agent_id%'
        OR pg_get_constraintdef(c.oid) ILIKE '%origin_station_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE vi_templates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'origin_agent_id'
  ) AND to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE vi_templates
      ADD CONSTRAINT vi_templates_origin_agent_id_fkey
      FOREIGN KEY (origin_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'origin_station_id'
  ) AND to_regclass('stations') IS NOT NULL THEN
    ALTER TABLE vi_templates
      ADD CONSTRAINT vi_templates_origin_station_id_fkey
      FOREIGN KEY (origin_station_id) REFERENCES stations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'general_templates'
      AND column_name = 'origin_agent_id'
  ) THEN
    ALTER TABLE general_templates ALTER COLUMN origin_agent_id DROP NOT NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'general_templates'
      AND column_name = 'origin_station_id'
  ) THEN
    ALTER TABLE general_templates ALTER COLUMN origin_station_id DROP NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'general_templates'
      AND c.contype = 'f'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%origin_agent_id%'
        OR pg_get_constraintdef(c.oid) ILIKE '%origin_station_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE general_templates DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'general_templates'
      AND column_name = 'origin_agent_id'
  ) AND to_regclass('agents') IS NOT NULL THEN
    ALTER TABLE general_templates
      ADD CONSTRAINT general_templates_origin_agent_id_fkey
      FOREIGN KEY (origin_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'general_templates'
      AND column_name = 'origin_station_id'
  ) AND to_regclass('stations') IS NOT NULL THEN
    ALTER TABLE general_templates
      ADD CONSTRAINT general_templates_origin_station_id_fkey
      FOREIGN KEY (origin_station_id) REFERENCES stations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()
      AND t.relname = 'vi_run_queue_items'
      AND c.contype = 'f'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%vi_template_id%'
        OR pg_get_constraintdef(c.oid) ILIKE '%general_template_id%'
      )
  LOOP
    EXECUTE format('ALTER TABLE vi_run_queue_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE vi_run_queue_items
  ADD CONSTRAINT vi_run_queue_items_vi_template_id_fkey
  FOREIGN KEY (vi_template_id) REFERENCES vi_templates(id) ON DELETE CASCADE;

ALTER TABLE vi_run_queue_items
  ADD CONSTRAINT vi_run_queue_items_general_template_id_fkey
  FOREIGN KEY (general_template_id) REFERENCES general_templates(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'vi_templates'
      AND column_name = 'show_front_panel'
      AND data_type IN ('bigint', 'integer', 'numeric', 'smallint')
  ) THEN
    ALTER TABLE vi_templates ALTER COLUMN show_front_panel DROP DEFAULT;
    ALTER TABLE vi_templates ALTER COLUMN show_front_panel TYPE BOOLEAN USING (show_front_panel <> 0);
    ALTER TABLE vi_templates ALTER COLUMN show_front_panel SET DEFAULT FALSE;
    ALTER TABLE vi_templates ALTER COLUMN show_front_panel SET NOT NULL;
  END IF;
END $$;
