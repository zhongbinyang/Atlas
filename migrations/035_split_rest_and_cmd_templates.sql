-- Split REST (and future CMD) out of general_templates into dedicated tables.
-- Live general_templates uses origin_station_id (see 034_rename_agents_to_stations).
-- Order: create → copy → columns/FKs → drop old CHECK → remap → delete → new CHECKs.
-- Migrations re-run on every startup; steps are idempotent.

CREATE TABLE IF NOT EXISTS rest_templates (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'rest',
    inputs_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cmd_templates (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    origin_station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'cmd',
    inputs_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

INSERT INTO rest_templates (id, name, origin_station_id, kind, inputs_json, outputs_json, created_at)
SELECT g.id, g.name, g.origin_station_id, g.kind, g.inputs_json, g.outputs_json, g.created_at
FROM general_templates g
WHERE g.kind = 'rest'
  AND NOT EXISTS (SELECT 1 FROM rest_templates r WHERE r.id = g.id);

DO $$
DECLARE
  max_id bigint;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM rest_templates;
  IF max_id > 0 THEN
    PERFORM setval(pg_get_serial_sequence('rest_templates', 'id'), max_id, true);
  ELSE
    PERFORM setval(pg_get_serial_sequence('rest_templates', 'id'), 1, false);
  END IF;

  SELECT COALESCE(MAX(id), 0) INTO max_id FROM cmd_templates;
  IF max_id > 0 THEN
    PERFORM setval(pg_get_serial_sequence('cmd_templates', 'id'), max_id, true);
  ELSE
    PERFORM setval(pg_get_serial_sequence('cmd_templates', 'id'), 1, false);
  END IF;
END $$;

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS rest_template_id BIGINT;

ALTER TABLE vi_run_queue_items
  ADD COLUMN IF NOT EXISTS cmd_template_id BIGINT;

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS rest_template_id BIGINT;

ALTER TABLE sequence_template_steps
  ADD COLUMN IF NOT EXISTS cmd_template_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND constraint_name = 'vi_run_queue_items_rest_template_id_fkey'
  ) THEN
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_rest_template_id_fkey
      FOREIGN KEY (rest_template_id) REFERENCES rest_templates(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'vi_run_queue_items'
      AND constraint_name = 'vi_run_queue_items_cmd_template_id_fkey'
  ) THEN
    ALTER TABLE vi_run_queue_items
      ADD CONSTRAINT vi_run_queue_items_cmd_template_id_fkey
      FOREIGN KEY (cmd_template_id) REFERENCES cmd_templates(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_template_steps'
      AND constraint_name = 'sequence_template_steps_rest_template_id_fkey'
  ) THEN
    ALTER TABLE sequence_template_steps
      ADD CONSTRAINT sequence_template_steps_rest_template_id_fkey
      FOREIGN KEY (rest_template_id) REFERENCES rest_templates(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = current_schema()
      AND table_name = 'sequence_template_steps'
      AND constraint_name = 'sequence_template_steps_cmd_template_id_fkey'
  ) THEN
    ALTER TABLE sequence_template_steps
      ADD CONSTRAINT sequence_template_steps_cmd_template_id_fkey
      FOREIGN KEY (cmd_template_id) REFERENCES cmd_templates(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Old CHECK only allows section|general|labview; drop before remap to 'rest'.
ALTER TABLE vi_run_queue_items DROP CONSTRAINT IF EXISTS vi_run_queue_items_one_template_ck;
ALTER TABLE sequence_template_steps DROP CONSTRAINT IF EXISTS sequence_template_steps_one_template_ck;

UPDATE vi_run_queue_items q
SET template_source = 'rest',
    rest_template_id = q.general_template_id,
    general_template_id = NULL
WHERE q.general_template_id IN (SELECT id FROM rest_templates);

UPDATE sequence_template_steps s
SET template_source = 'rest',
    rest_template_id = s.general_template_id,
    general_template_id = NULL
WHERE s.general_template_id IN (SELECT id FROM rest_templates);

DELETE FROM general_templates WHERE kind = 'rest';

ALTER TABLE general_templates DROP CONSTRAINT IF EXISTS general_templates_kind_check;
ALTER TABLE general_templates
  ADD CONSTRAINT general_templates_kind_check CHECK (kind IN ('delay', 'version'));

ALTER TABLE vi_run_queue_items
  ADD CONSTRAINT vi_run_queue_items_one_template_ck
  CHECK (
    (template_source = 'section'
      AND vi_template_id IS NULL AND general_template_id IS NULL
      AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'general'
      AND general_template_id IS NOT NULL
      AND vi_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'labview'
      AND vi_template_id IS NOT NULL
      AND general_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'rest'
      AND rest_template_id IS NOT NULL
      AND vi_template_id IS NULL AND general_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'cmd'
      AND cmd_template_id IS NOT NULL
      AND vi_template_id IS NULL AND general_template_id IS NULL AND rest_template_id IS NULL)
  );

ALTER TABLE sequence_template_steps
  ADD CONSTRAINT sequence_template_steps_one_template_ck
  CHECK (
    (template_source = 'section'
      AND vi_template_id IS NULL AND general_template_id IS NULL
      AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'general'
      AND general_template_id IS NOT NULL
      AND vi_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'labview'
      AND vi_template_id IS NOT NULL
      AND general_template_id IS NULL AND rest_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'rest'
      AND rest_template_id IS NOT NULL
      AND vi_template_id IS NULL AND general_template_id IS NULL AND cmd_template_id IS NULL)
    OR (template_source = 'cmd'
      AND cmd_template_id IS NOT NULL
      AND vi_template_id IS NULL AND general_template_id IS NULL AND rest_template_id IS NULL)
  );
