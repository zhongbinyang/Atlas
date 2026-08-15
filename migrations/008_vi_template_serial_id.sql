-- Upgrade legacy TEXT UUID primary keys to BIGSERIAL.
-- No-op when vi_templates.id is already bigint/integer (fresh 003 installs).
DO $$
DECLARE
  id_type text;
  fk_name text;
  has_rows boolean;
  max_id bigint;
BEGIN
  SELECT data_type INTO id_type
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'vi_templates'
    AND column_name = 'id';

  IF id_type IS NULL OR id_type IN ('bigint', 'integer', 'smallint') THEN
    RETURN;
  END IF;

  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = current_schema()
    AND tc.table_name = 'vi_run_queue_items'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'vi_template_id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vi_run_queue_items DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE vi_templates ADD COLUMN id_serial BIGINT;

  UPDATE vi_templates t
  SET id_serial = s.n
  FROM (
    SELECT id AS old_id,
           ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS n
    FROM vi_templates
  ) s
  WHERE t.id = s.old_id;

  CREATE SEQUENCE IF NOT EXISTS vi_templates_id_seq;

  SELECT COUNT(*) > 0, COALESCE(MAX(id_serial), 0)
  INTO has_rows, max_id
  FROM vi_templates;

  IF has_rows THEN
    PERFORM setval('vi_templates_id_seq', max_id, true);
  ELSE
    PERFORM setval('vi_templates_id_seq', 1, false);
  END IF;

  ALTER TABLE vi_run_queue_items ADD COLUMN vi_template_id_new BIGINT;

  UPDATE vi_run_queue_items q
  SET vi_template_id_new = t.id_serial
  FROM vi_templates t
  WHERE t.id = q.vi_template_id;

  ALTER TABLE vi_run_queue_items DROP COLUMN vi_template_id;
  ALTER TABLE vi_run_queue_items RENAME COLUMN vi_template_id_new TO vi_template_id;
  ALTER TABLE vi_run_queue_items ALTER COLUMN vi_template_id SET NOT NULL;

  ALTER TABLE vi_templates DROP CONSTRAINT vi_templates_pkey;
  ALTER TABLE vi_templates DROP COLUMN id;
  ALTER TABLE vi_templates RENAME COLUMN id_serial TO id;
  ALTER TABLE vi_templates ALTER COLUMN id SET DEFAULT nextval('vi_templates_id_seq');
  ALTER TABLE vi_templates ALTER COLUMN id SET NOT NULL;
  ALTER SEQUENCE vi_templates_id_seq OWNED BY vi_templates.id;
  ALTER TABLE vi_templates ADD PRIMARY KEY (id);

  ALTER TABLE vi_run_queue_items
    ADD CONSTRAINT vi_run_queue_items_vi_template_id_fkey
    FOREIGN KEY (vi_template_id) REFERENCES vi_templates(id);
END $$;
