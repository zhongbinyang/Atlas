ALTER TABLE vi_templates ADD COLUMN IF NOT EXISTS outputs_json TEXT;
UPDATE vi_templates SET outputs_json = '[]' WHERE outputs_json IS NULL;
ALTER TABLE vi_templates ALTER COLUMN outputs_json SET DEFAULT '[]';
ALTER TABLE vi_templates ALTER COLUMN outputs_json SET NOT NULL;
