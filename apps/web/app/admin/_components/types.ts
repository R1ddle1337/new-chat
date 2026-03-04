export type MePayload = {
  is_admin: boolean;
};

export type ProviderItem = {
  id: number;
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
  has_secret: boolean;
  secret_updated_at: string | null;
};

export type ImportedModelItem = {
  model_id: string;
  display_name: string;
  owned_by: string | null;
  already_added: boolean;
  existing_public_id: string | null;
  existing_enabled: boolean | null;
};

export type ModelItem = {
  id: number;
  provider: string;
  provider_id: number;
  model_id: string;
  public_id: string;
  display_name: string;
  enabled: boolean;
  created_at: string;
};

export type ModelDraft = {
  display_name: string;
  enabled: boolean;
};

export type ProviderDraft = {
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
};

export type CreateProviderDraft = ProviderDraft & {
  api_key: string;
};

export type RateLimitsPayload = {
  rpm_limit: number;
  tpm_limit: number;
  updated_at: string;
};

export type AbuseRuleHit = {
  rule: string;
  score: number;
  value: number;
  threshold: number;
  window_seconds: number;
};

export type AdminUserItem = {
  id: string;
  email: string;
  status: 'active' | 'banned';
  ban_expires_at: string | null;
  deleted_at: string | null;
  deleted_reason: string | null;
  created_at: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  last_seen_ip: string | null;
  last_seen_ua: string | null;
  last_seen_at: string | null;
  rpm_override: number | null;
  tpm_override: number | null;
  rpm_effective: number;
  tpm_effective: number;
  throttle_source: 'none' | 'auto' | 'admin';
  throttle_expires_at: string | null;
  throttle_rpm_limit: number | null;
  throttle_tpm_limit: number | null;
  anomaly_score: number;
  last_rule_hits: AbuseRuleHit[];
  last_action: string | null;
  last_action_at: string | null;
};

export type UserLimitDraft = {
  rpm_limit: string;
  tpm_limit: string;
};

export type SuspiciousUserItem = {
  id: string;
  email: string;
  status: 'active' | 'banned';
  ban_expires_at: string | null;
  last_seen_ip: string | null;
  last_seen_ua: string | null;
  last_seen_at: string | null;
  anomaly_score: number;
  last_rule_hits: AbuseRuleHit[];
  throttle_source: 'none' | 'auto' | 'admin';
  throttle_expires_at: string | null;
  throttle_rpm_limit: number | null;
  throttle_tpm_limit: number | null;
  last_action: string | null;
  last_action_at: string | null;
};

export type ThrottleOverrideDraft = {
  rpm_limit: string;
  tpm_limit: string;
  duration_minutes: string;
};

export type AbuseEventItem = {
  id: string;
  event_type: string;
  ip: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AdminThreadItem = {
  id: string;
  title: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  msg_count: number;
};

export type AdminMessageAttachment = {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_url: string;
};

export type AdminThreadMessageItem = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments: AdminMessageAttachment[];
};
