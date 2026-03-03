ALTER TABLE providers
ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE providers
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE providers
SET updated_at = COALESCE(updated_at, created_at, now())
WHERE updated_at IS NULL;
