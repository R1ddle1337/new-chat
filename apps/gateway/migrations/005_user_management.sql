ALTER TABLE users
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE users
ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_login_ip TEXT;

CREATE TABLE IF NOT EXISTS user_limits (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rpm_limit INTEGER,
  tpm_limit INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_limits_rpm_limit_positive CHECK (rpm_limit IS NULL OR rpm_limit > 0),
  CONSTRAINT user_limits_tpm_limit_positive CHECK (tpm_limit IS NULL OR tpm_limit > 0)
);

UPDATE users
SET status = 'active'
WHERE status IS NULL;
