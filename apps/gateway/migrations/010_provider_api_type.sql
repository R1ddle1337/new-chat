ALTER TABLE providers
ADD COLUMN IF NOT EXISTS api_type TEXT;

UPDATE providers
SET api_type = 'openai_responses'
WHERE api_type IS NULL
   OR BTRIM(api_type) = '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'providers_api_type_check'
      AND conrelid = 'providers'::regclass
  ) THEN
    ALTER TABLE providers DROP CONSTRAINT providers_api_type_check;
  END IF;

  ALTER TABLE providers
  ADD CONSTRAINT providers_api_type_check
  CHECK (api_type IN ('openai_chat', 'openai_responses', 'anthropic_messages'));
END
$$;

ALTER TABLE providers
ALTER COLUMN api_type SET NOT NULL;
