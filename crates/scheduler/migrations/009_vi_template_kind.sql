ALTER TABLE vi_templates ADD COLUMN IF NOT EXISTS kind TEXT;
UPDATE vi_templates SET kind = 'labview' WHERE kind IS NULL OR kind = '';
ALTER TABLE vi_templates ALTER COLUMN kind SET DEFAULT 'labview';
ALTER TABLE vi_templates ALTER COLUMN kind SET NOT NULL;
