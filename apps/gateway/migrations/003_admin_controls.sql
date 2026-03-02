ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE providers
ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS allowed_models (
  id BIGSERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_allowed_models_provider_enabled
ON allowed_models(provider_id, enabled);

CREATE INDEX IF NOT EXISTS idx_allowed_models_enabled
ON allowed_models(enabled);

INSERT INTO providers (code, name, base_url)
VALUES
  ('openai', 'OpenAI', 'https://api.openai.com/v1'),
  ('grok2api', 'Grok2API', 'https://gapi.lyxnb.de5.net/v1')
ON CONFLICT (code) DO NOTHING;
