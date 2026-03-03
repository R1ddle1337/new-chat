CREATE TABLE IF NOT EXISTS provider_secrets (
  provider_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id BIGSERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);
CREATE INDEX IF NOT EXISTS idx_models_provider_enabled ON models(provider_id, enabled);

CREATE TABLE IF NOT EXISTS settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rpm_limit INTEGER NOT NULL,
  tpm_limit INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (id, rpm_limit, tpm_limit)
VALUES (1, 120, 120000)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.allowed_models') IS NOT NULL THEN
    INSERT INTO models (provider_id, model_id, public_id, display_name, enabled, created_at)
    SELECT
      am.provider_id,
      am.model_id,
      CASE
        WHEN model_count.cnt = 1 THEN am.model_id
        ELSE p.code || ':' || am.model_id
      END AS public_id,
      COALESCE(NULLIF(BTRIM(am.display_name), ''), am.model_id) AS display_name,
      am.enabled,
      am.created_at
    FROM allowed_models am
    JOIN providers p ON p.id = am.provider_id
    JOIN (
      SELECT model_id, COUNT(*) AS cnt
      FROM allowed_models
      GROUP BY model_id
    ) AS model_count ON model_count.model_id = am.model_id
    ON CONFLICT (provider_id, model_id) DO NOTHING;
  END IF;
END
$$;
