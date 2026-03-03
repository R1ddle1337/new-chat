ALTER TABLE users
ADD COLUMN IF NOT EXISTS ban_expires_at TIMESTAMPTZ;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_seen_ip TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_seen_ua TEXT;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS abuse_event_counters (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dimension, window_start),
  CONSTRAINT abuse_event_counters_value_non_negative CHECK (value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_abuse_event_counters_lookup
ON abuse_event_counters(user_id, dimension, window_start DESC);

CREATE INDEX IF NOT EXISTS idx_abuse_event_counters_window_start
ON abuse_event_counters(window_start);

CREATE TABLE IF NOT EXISTS abuse_user_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  anomaly_score INTEGER NOT NULL DEFAULT 0,
  last_rule_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  throttle_expires_at TIMESTAMPTZ,
  throttle_rpm_limit INTEGER,
  throttle_tpm_limit INTEGER,
  throttle_reason TEXT,
  admin_throttle_expires_at TIMESTAMPTZ,
  admin_throttle_rpm_limit INTEGER,
  admin_throttle_tpm_limit INTEGER,
  last_action TEXT,
  last_action_at TIMESTAMPTZ,
  last_action_metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT abuse_user_state_throttle_rpm_positive CHECK (throttle_rpm_limit IS NULL OR throttle_rpm_limit > 0),
  CONSTRAINT abuse_user_state_throttle_tpm_positive CHECK (throttle_tpm_limit IS NULL OR throttle_tpm_limit > 0),
  CONSTRAINT abuse_user_state_admin_throttle_rpm_positive CHECK (admin_throttle_rpm_limit IS NULL OR admin_throttle_rpm_limit > 0),
  CONSTRAINT abuse_user_state_admin_throttle_tpm_positive CHECK (admin_throttle_tpm_limit IS NULL OR admin_throttle_tpm_limit > 0)
);

CREATE INDEX IF NOT EXISTS idx_abuse_user_state_score
ON abuse_user_state(anomaly_score DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_abuse_type_created_at
ON audit_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created_at
ON audit_events(user_id, created_at DESC);

UPDATE users
SET last_seen_ip = COALESCE(last_seen_ip, last_login_ip),
    last_seen_at = COALESCE(last_seen_at, last_login_at)
WHERE last_seen_ip IS NULL
   OR last_seen_at IS NULL;
