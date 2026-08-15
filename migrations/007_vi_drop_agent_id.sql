-- Remove "current agent" holder; templates are center-global with origin only.
ALTER TABLE vi_templates DROP COLUMN IF EXISTS agent_id;
