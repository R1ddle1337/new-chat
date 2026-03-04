import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { runMigrations } from './migrations';
import { createOAuthRegistry } from './oauth';

type DbUser = {
  id: string;
  email: string;
  is_admin: boolean;
  default_model: string | null;
  status: string;
  ban_expires_at: string | null;
};

type ProviderRow = {
  id: number;
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
};

type ProviderSecretRow = {
  provider_id: number;
  encrypted_api_key: string;
  iv: string;
  tag: string;
  key_version: number;
  updated_at: string;
};

type UploadedFileRow = {
  id: string;
  bucket: string;
  object_key: string;
  mime_type: string;
};

type StoredFileRow = {
  id: string;
  filename: string;
  mime_type: string;
};

type AttachmentFileRow = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

type ModelCatalogRow = {
  id: number;
  provider_id: number;
  provider_code: string;
  provider_base_url: string;
  model_id: string;
  public_id: string;
  display_name: string;
  enabled: boolean;
  created_at: string;
};

type RateLimitSettings = {
  rpm_limit: number;
  tpm_limit: number;
  updated_at: string;
};

type UserLimitRow = {
  rpm_limit: number | null;
  tpm_limit: number | null;
};

type BaseUserRateLimits = {
  rpm_override: number | null;
  tpm_override: number | null;
  rpm_effective: number;
  tpm_effective: number;
};

type EffectiveUserRateLimits = {
  rpm_override: number | null;
  tpm_override: number | null;
  rpm_effective: number;
  tpm_effective: number;
  throttle_source: 'none' | 'auto' | 'admin';
  throttle_expires_at: string | null;
  throttle_rpm_limit: number | null;
  throttle_tpm_limit: number | null;
};

type AbuseUserStateRow = {
  user_id: string;
  anomaly_score: number;
  last_rule_hits: unknown;
  throttle_expires_at: string | null;
  throttle_rpm_limit: number | null;
  throttle_tpm_limit: number | null;
  throttle_reason: string | null;
  admin_throttle_expires_at: string | null;
  admin_throttle_rpm_limit: number | null;
  admin_throttle_tpm_limit: number | null;
  last_action: string | null;
  last_action_at: string | null;
  last_action_metadata: unknown;
};

type AbuseRuleHit = {
  rule: string;
  score: number;
  value: number;
  threshold: number;
  window_seconds: number;
  detail?: Record<string, unknown>;
};

type ActiveThrottleState = {
  source: 'none' | 'auto' | 'admin';
  expires_at: string | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
};

type AbuseEvaluationResult = {
  score: number;
  ruleHits: AbuseRuleHit[];
  action: 'none' | 'throttle' | 'ban';
  ban_expires_at: string | null;
};

type StreamLease = {
  key: string;
  token: string;
};

type UpstreamModelItem = {
  id: string;
  owned_by?: string;
  raw?: Record<string, unknown>;
};

type ThreadContextMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

type MessageCursor = {
  createdAt: string;
  id: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: DbUser;
    sessionId?: string;
    effectiveRateLimits?: EffectiveUserRateLimits;
  }
}

const truthyEnvValues = new Set(['1', 'true', 'yes', 'on']);

function parseEnvToggle(rawValue: string | undefined): boolean {
  if (typeof rawValue !== 'string') {
    return false;
  }

  return truthyEnvValues.has(rawValue.trim().toLowerCase());
}

const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/newchat',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? 'nc_session',
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 7),
  authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? 30),
  minioEndpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  minioPort: Number(process.env.MINIO_PORT ?? 9000),
  minioUseSsl: process.env.MINIO_USE_SSL === 'true',
  minioAccessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  minioSecretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  minioBucket: process.env.MINIO_BUCKET ?? 'uploads',
  keyEncryptionKey: process.env.KEY_ENCRYPTION_KEY ?? '',
  secureCookies: process.env.SECURE_COOKIES === 'true',
  adminEmail: (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase(),
  oauthGoogleClientId: (process.env.OAUTH_GOOGLE_CLIENT_ID ?? '').trim(),
  oauthGoogleClientSecret: (process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? '').trim(),
  oauthGoogleRedirectUri: (process.env.OAUTH_GOOGLE_REDIRECT_URI ?? '').trim(),
  disablePasswordRegister: parseEnvToggle(process.env.DISABLE_PASSWORD_REGISTER),
  disablePasswordLogin: parseEnvToggle(process.env.DISABLE_PASSWORD_LOGIN),
  abuseThrottleDurationMinutes: Number(process.env.ABUSE_THROTTLE_DURATION_MINUTES ?? 20),
  abuseBanDurationMinutes: Number(process.env.ABUSE_TEMP_BAN_DURATION_MINUTES ?? 60),
  abuseThrottleScoreThreshold: Number(process.env.ABUSE_THROTTLE_SCORE_THRESHOLD ?? 55),
  abuseBanScoreThreshold: Number(process.env.ABUSE_BAN_SCORE_THRESHOLD ?? 95),
  abuseStreamConcurrencyLimit: Number(process.env.ABUSE_STREAM_CONCURRENCY_LIMIT ?? 2),
  telegramAlertWebhookUrl: (process.env.TELEGRAM_ALERT_WEBHOOK_URL ?? '').trim(),
};

if (!config.keyEncryptionKey) {
  throw new Error('KEY_ENCRYPTION_KEY is required');
}

function deriveAesKey(input: string): Buffer {
  const raw = Buffer.from(input, 'utf8');
  if (raw.length === 32) {
    return raw;
  }

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return Buffer.from(input, 'hex');
  }

  try {
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // ignore
  }

  return crypto.createHash('sha256').update(input).digest();
}

const aesKey = deriveAesKey(config.keyEncryptionKey);

const pool = new Pool({ connectionString: config.databaseUrl });
const redis = new Redis(config.redisUrl);
const minio = new MinioClient({
  endPoint: config.minioEndpoint,
  port: config.minioPort,
  useSSL: config.minioUseSsl,
  accessKey: config.minioAccessKey,
  secretKey: config.minioSecretKey,
});

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 20 * 1024 * 1024,
});

const oauthRegistry = createOAuthRegistry({
  redis,
  secureCookies: config.secureCookies,
  google: {
    clientId: config.oauthGoogleClientId,
    clientSecret: config.oauthGoogleClientSecret,
    redirectUri: config.oauthGoogleRedirectUri,
  },
});

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RAW_CONTENT_JSON_BYTES = 200 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const TPM_WINDOW_MS = RATE_LIMIT_WINDOW_SECONDS * 1000;
const TPM_COUNTER_TTL_SECONDS = RATE_LIMIT_WINDOW_SECONDS * 3;
const RATE_LIMIT_SETTINGS_CACHE_TTL_MS = 5000;
const THREAD_CONTEXT_MAX_MESSAGES = 30;
const THREAD_CONTEXT_MAX_TOKENS = 8000;
const ABUSE_COUNTER_WINDOW_SECONDS = 60;
const ABUSE_COUNTER_TTL_SECONDS = 60 * 60 * 24 * 2;
const ABUSE_MULTI_ACCOUNT_WINDOW_SECONDS = 15 * 60;
const ABUSE_IP_UA_CHURN_WINDOW_SECONDS = 15 * 60;
const ABUSE_ERROR_WINDOW_SECONDS = 5 * 60;
const ABUSE_LOGIN_FAIL_WINDOW_SECONDS = 10 * 60;
const ABUSE_RPM_WINDOW_SECONDS = 60;
const ABUSE_TPM_WINDOW_SECONDS = 60;
const ABUSE_STREAM_REJECT_WINDOW_SECONDS = 10 * 60;
const STREAM_SESSION_TTL_SECONDS = 2 * 60 * 60;
const STREAM_LEASE_ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
local active = redis.call('ZCARD', KEYS[1])
if active >= tonumber(ARGV[1]) then
  return {0, active}
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return {1, active + 1}
`;

let rateLimitSettingsCache:
  | {
      value: RateLimitSettings;
      expires_at: number;
    }
  | null = null;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLoginErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'oauth_failed';
}

function redirectToLoginError(reply: FastifyReply, errorCode: string): void {
  const normalizedError = normalizeLoginErrorCode(errorCode);
  reply.redirect(`/login?error=${encodeURIComponent(normalizedError)}`);
}

function isConfiguredAdminEmail(email: string): boolean {
  return Boolean(config.adminEmail) && normalizeEmail(email) === config.adminEmail;
}

function normalizeProviderCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim().toLowerCase();
  if (!candidate) {
    return null;
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)) {
    return null;
  }

  return candidate;
}

function normalizeProviderName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim();
  if (!candidate || candidate.length > 120) {
    return null;
  }

  return candidate;
}

function normalizeProviderBaseUrl(raw: string): string | null {
  const candidate = raw.trim();
  if (!candidate) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return null;
  }

  if (!parsed.hostname) {
    return null;
  }

  if (parsed.search || parsed.hash) {
    return null;
  }

  const cleanedPath = parsed.pathname.replace(/\/+$/, '');
  const pathname = cleanedPath ? cleanedPath : '';
  return `${parsed.origin}${pathname}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (error as { code?: unknown }).code === '23505';
}

function encryptApiKey(plainText: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptApiKey(encrypted: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function jsonBigintSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function trySerializeJson(value: unknown): { json: string | null; error?: string } {
  try {
    const serialized = JSON.stringify(value, jsonBigintSafeReplacer);
    if (typeof serialized !== 'string') {
      return { json: null, error: 'JSON.stringify returned undefined' };
    }
    return { json: serialized };
  } catch (error) {
    return {
      json: null,
      error: error instanceof Error ? error.message : 'Unknown serialization error',
    };
  }
}

function serializeRawContentForStorage(rawContent: unknown): string | null {
  if (typeof rawContent === 'undefined') {
    return null;
  }

  let normalized: unknown = rawContent;
  if (typeof rawContent === 'string') {
    try {
      normalized = JSON.parse(rawContent);
    } catch {
      normalized = { type: 'string', value: rawContent };
    }
  }

  const serialized = trySerializeJson(normalized);
  if (!serialized.json) {
    const fallback = trySerializeJson({
      type: 'unserializable',
      note: serialized.error ?? 'Unable to stringify raw_content',
    });
    return (
      fallback.json ??
      '{"type":"unserializable","note":"Unable to stringify raw_content"}'
    );
  }

  const sizeBytes = Buffer.byteLength(serialized.json, 'utf8');
  if (sizeBytes > MAX_RAW_CONTENT_JSON_BYTES) {
    const truncated = trySerializeJson({
      type: 'truncated',
      note: `raw_content exceeded ${MAX_RAW_CONTENT_JSON_BYTES} byte limit`,
      original_size_bytes: sizeBytes,
    });
    return (
      truncated.json ??
      '{"type":"truncated","note":"raw_content exceeded storage limit"}'
    );
  }

  return serialized.json;
}

function getClientIp(request: FastifyRequest): string {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0]!.trim();
  }
  return request.ip;
}

function getClientUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers['user-agent'];
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  return value.length <= 256 ? value : value.slice(0, 256);
}

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditMetadata(item));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('key') ||
        lower.includes('prompt') ||
        lower.includes('input') ||
        lower.includes('message') ||
        lower.includes('content') ||
        lower.includes('authorization')
      ) {
        continue;
      }
      result[key] = sanitizeAuditMetadata(raw);
    }
    return result;
  }

  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 200)}...`;
  }

  return value;
}

async function writeAuditEvent(params: {
  eventType: string;
  request: FastifyRequest;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const metadata = (sanitizeAuditMetadata(params.metadata ?? {}) ?? {}) as Record<string, unknown>;
  const userId = params.userId ?? null;
  const ip = getClientIp(params.request);

  app.log.info({
    event: 'audit',
    eventType: params.eventType,
    userId,
    ip,
    metadata,
  });

  await pool.query(
    'INSERT INTO audit_events (user_id, event_type, ip, metadata) VALUES ($1, $2, $3, $4)',
    [userId, params.eventType, ip, metadata],
  );
}

async function sendAbuseAlert(payload: Record<string, unknown>): Promise<void> {
  const sanitized = (sanitizeAuditMetadata(payload) ?? {}) as Record<string, unknown>;

  app.log.warn({
    event: 'abuse_alert',
    prefix: '[ABUSE_ALERT]',
    payload: sanitized,
  });

  if (!config.telegramAlertWebhookUrl) {
    return;
  }

  try {
    const response = await fetch(config.telegramAlertWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: '[ABUSE_ALERT]',
        payload: sanitized,
      }),
    });

    if (!response.ok) {
      app.log.warn(
        { status: response.status },
        'Failed to send abuse alert webhook',
      );
    }
  } catch (error) {
    app.log.warn({ err: error }, 'Failed to send abuse alert webhook');
  }
}

async function checkRateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  if (max <= 0) {
    return false;
  }

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }
  return current <= max;
}

async function loadRateLimitSettings(options?: { force?: boolean }): Promise<RateLimitSettings> {
  const force = options?.force ?? false;
  const now = Date.now();
  if (!force && rateLimitSettingsCache && rateLimitSettingsCache.expires_at > now) {
    return rateLimitSettingsCache.value;
  }

  const result = await pool.query<RateLimitSettings>(
    'SELECT rpm_limit, tpm_limit, updated_at FROM settings WHERE id = 1',
  );

  let row = result.rows[0];
  if (!row) {
    const inserted = await pool.query<RateLimitSettings>(
      `INSERT INTO settings (id, rpm_limit, tpm_limit)
       VALUES (1, 120, 120000)
       ON CONFLICT (id) DO UPDATE
         SET rpm_limit = settings.rpm_limit
       RETURNING rpm_limit, tpm_limit, updated_at`,
    );
    row = inserted.rows[0]!;
  }

  rateLimitSettingsCache = {
    value: row,
    expires_at: now + RATE_LIMIT_SETTINGS_CACHE_TTL_MS,
  };

  return row;
}

function resolveEffectiveRateLimit(overrideLimit: number | null, fallbackLimit: number): number {
  if (typeof overrideLimit === 'number' && Number.isInteger(overrideLimit) && overrideLimit > 0) {
    return overrideLimit;
  }
  return fallbackLimit;
}

async function loadBaseRateLimitsForUser(userId: string): Promise<BaseUserRateLimits> {
  const [settings, overrideResult] = await Promise.all([
    loadRateLimitSettings(),
    pool.query<UserLimitRow>(
      `SELECT rpm_limit, tpm_limit
       FROM user_limits
       WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const override = overrideResult.rowCount ? overrideResult.rows[0]! : null;
  const rpmOverride = override?.rpm_limit ?? null;
  const tpmOverride = override?.tpm_limit ?? null;

  return {
    rpm_override: rpmOverride,
    tpm_override: tpmOverride,
    rpm_effective: resolveEffectiveRateLimit(rpmOverride, settings.rpm_limit),
    tpm_effective: resolveEffectiveRateLimit(tpmOverride, settings.tpm_limit),
  };
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function isFutureTimestamp(value: string | null, nowMs = Date.now()): boolean {
  const parsed = parseTimestampMs(value);
  return parsed !== null && parsed > nowMs;
}

function hasActiveBan(user: DbUser, nowMs = Date.now()): boolean {
  if (user.status !== 'banned') {
    return false;
  }

  if (!user.ban_expires_at) {
    return true;
  }

  return isFutureTimestamp(user.ban_expires_at, nowMs);
}

async function maybeLiftExpiredBan(user: DbUser): Promise<DbUser> {
  if (user.status !== 'banned' || !user.ban_expires_at) {
    return user;
  }

  const expiresAtMs = parseTimestampMs(user.ban_expires_at);
  if (expiresAtMs === null || expiresAtMs > Date.now()) {
    return user;
  }

  const lifted = await pool.query<DbUser>(
    `UPDATE users
     SET status = 'active',
         banned_at = NULL,
         ban_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
     RETURNING id, email, is_admin, default_model, status, ban_expires_at`,
    [user.id],
  );

  if (!lifted.rowCount) {
    return {
      ...user,
      status: 'active',
      ban_expires_at: null,
    };
  }

  return lifted.rows[0]!;
}

async function loadAbuseUserState(userId: string): Promise<AbuseUserStateRow | null> {
  const result = await pool.query<AbuseUserStateRow>(
    `SELECT user_id,
            anomaly_score,
            last_rule_hits,
            throttle_expires_at,
            throttle_rpm_limit,
            throttle_tpm_limit,
            throttle_reason,
            admin_throttle_expires_at,
            admin_throttle_rpm_limit,
            admin_throttle_tpm_limit,
            last_action,
            last_action_at,
            last_action_metadata
     FROM abuse_user_state
     WHERE user_id = $1`,
    [userId],
  );
  return result.rowCount ? result.rows[0]! : null;
}

function getActiveThrottleFromState(
  state: AbuseUserStateRow | null,
  nowMs = Date.now(),
): ActiveThrottleState {
  if (!state) {
    return {
      source: 'none',
      expires_at: null,
      rpm_limit: null,
      tpm_limit: null,
    };
  }

  const hasAdminThrottle =
    isFutureTimestamp(state.admin_throttle_expires_at, nowMs) &&
    ((state.admin_throttle_rpm_limit ?? null) !== null ||
      (state.admin_throttle_tpm_limit ?? null) !== null);
  if (hasAdminThrottle) {
    return {
      source: 'admin',
      expires_at: state.admin_throttle_expires_at,
      rpm_limit: state.admin_throttle_rpm_limit,
      tpm_limit: state.admin_throttle_tpm_limit,
    };
  }

  const hasAutoThrottle =
    isFutureTimestamp(state.throttle_expires_at, nowMs) &&
    ((state.throttle_rpm_limit ?? null) !== null || (state.throttle_tpm_limit ?? null) !== null);
  if (hasAutoThrottle) {
    return {
      source: 'auto',
      expires_at: state.throttle_expires_at,
      rpm_limit: state.throttle_rpm_limit,
      tpm_limit: state.throttle_tpm_limit,
    };
  }

  return {
    source: 'none',
    expires_at: null,
    rpm_limit: null,
    tpm_limit: null,
  };
}

async function loadEffectiveRateLimitsForUser(userId: string): Promise<EffectiveUserRateLimits> {
  const [baseLimits, abuseState] = await Promise.all([
    loadBaseRateLimitsForUser(userId),
    loadAbuseUserState(userId),
  ]);
  const throttle = getActiveThrottleFromState(abuseState);

  let rpmEffective = baseLimits.rpm_effective;
  let tpmEffective = baseLimits.tpm_effective;

  if (typeof throttle.rpm_limit === 'number' && throttle.rpm_limit > 0) {
    rpmEffective = Math.min(rpmEffective, throttle.rpm_limit);
  }

  if (typeof throttle.tpm_limit === 'number' && throttle.tpm_limit > 0) {
    tpmEffective = Math.min(tpmEffective, throttle.tpm_limit);
  }

  return {
    rpm_override: baseLimits.rpm_override,
    tpm_override: baseLimits.tpm_override,
    rpm_effective: rpmEffective,
    tpm_effective: tpmEffective,
    throttle_source: throttle.source,
    throttle_expires_at: throttle.expires_at,
    throttle_rpm_limit: throttle.rpm_limit,
    throttle_tpm_limit: throttle.tpm_limit,
  };
}

function toSafeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function getAbuseCounterWindowStartIso(nowMs = Date.now()): string {
  const roundedMs = Math.floor(nowMs / (ABUSE_COUNTER_WINDOW_SECONDS * 1000))
    * ABUSE_COUNTER_WINDOW_SECONDS
    * 1000;
  return new Date(roundedMs).toISOString();
}

async function maybeCleanupAbuseCounters(): Promise<void> {
  const acquired = await redis.set(
    'abuse:counters:cleanup:v1',
    '1',
    'EX',
    60 * 60,
    'NX',
  );
  if (!acquired) {
    return;
  }

  await pool.query(
    `DELETE FROM abuse_event_counters
     WHERE window_start < now() - ($1::integer * interval '1 second')`,
    [ABUSE_COUNTER_TTL_SECONDS],
  );
}

async function incrementAbuseCounter(
  userId: string,
  dimension: string,
  value = 1,
  nowMs = Date.now(),
): Promise<void> {
  const normalized = toSafeInteger(value);
  if (normalized <= 0 || !dimension.trim()) {
    return;
  }

  const windowStartIso = getAbuseCounterWindowStartIso(nowMs);
  await pool.query(
    `INSERT INTO abuse_event_counters (user_id, dimension, window_start, value, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, dimension, window_start) DO UPDATE
       SET value = abuse_event_counters.value + EXCLUDED.value,
           updated_at = now()`,
    [userId, dimension, windowStartIso, normalized],
  );
}

async function incrementAbuseCounters(
  userId: string,
  entries: Array<{ dimension: string; value: number }>,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const nowMs = Date.now();
  for (const entry of entries) {
    await incrementAbuseCounter(userId, entry.dimension, entry.value, nowMs);
  }

  await maybeCleanupAbuseCounters();
}

async function loadAbuseCounterTotals(
  userId: string,
  dimensions: string[],
  windowSeconds: number,
): Promise<Record<string, number>> {
  const cutoffIso = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await pool.query<{ dimension: string; total: string }>(
    `SELECT dimension, COALESCE(SUM(value), 0)::bigint::text AS total
     FROM abuse_event_counters
     WHERE user_id = $1
       AND dimension = ANY($2::text[])
       AND window_start >= $3::timestamptz
     GROUP BY dimension`,
    [userId, dimensions, cutoffIso],
  );

  const totals: Record<string, number> = {};
  for (const dimension of dimensions) {
    totals[dimension] = 0;
  }

  for (const row of result.rows) {
    totals[row.dimension] = toSafeInteger(row.total);
  }

  return totals;
}

async function countDistinctAbuseDimensions(
  userId: string,
  dimensionPrefix: string,
  windowSeconds: number,
): Promise<number> {
  const cutoffIso = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT dimension)::bigint::text AS count
     FROM abuse_event_counters
     WHERE user_id = $1
       AND dimension LIKE $2
       AND window_start >= $3::timestamptz`,
    [userId, `${dimensionPrefix}%`, cutoffIso],
  );

  return toSafeInteger(result.rows[0]?.count);
}

async function countRecentUsersForIp(ip: string | null, windowSeconds: number): Promise<number> {
  if (!ip) {
    return 0;
  }

  const cutoffIso = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::bigint::text AS count
     FROM users
     WHERE last_seen_ip = $1
       AND last_seen_at IS NOT NULL
       AND last_seen_at >= $2::timestamptz`,
    [ip, cutoffIso],
  );

  return toSafeInteger(result.rows[0]?.count);
}

async function touchUserLastSeen(userId: string, ip: string, userAgent: string | null): Promise<void> {
  await pool.query(
    `UPDATE users
     SET last_seen_ip = $2,
         last_seen_ua = $3,
         last_seen_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [userId, ip, userAgent],
  );
}

function buildAutoThrottleLimits(baseLimits: BaseUserRateLimits): {
  rpm_limit: number;
  tpm_limit: number;
} {
  const rpm = Math.max(5, Math.floor(baseLimits.rpm_effective * 0.35));
  const tpm = Math.max(1000, Math.floor(baseLimits.tpm_effective * 0.35));
  return {
    rpm_limit: Math.min(baseLimits.rpm_effective, rpm),
    tpm_limit: Math.min(baseLimits.tpm_effective, tpm),
  };
}

async function ensureAbuseStateRow(
  userId: string,
  score: number,
  ruleHits: AbuseRuleHit[],
): Promise<void> {
  await pool.query(
    `INSERT INTO abuse_user_state (user_id, anomaly_score, last_rule_hits, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET anomaly_score = EXCLUDED.anomaly_score,
           last_rule_hits = EXCLUDED.last_rule_hits,
           updated_at = now()`,
    [userId, score, JSON.stringify(ruleHits)],
  );
}

async function applyAutoThrottle(params: {
  userId: string;
  score: number;
  ruleHits: AbuseRuleHit[];
  rpmLimit: number;
  tpmLimit: number;
}): Promise<string> {
  const result = await pool.query<{ throttle_expires_at: string }>(
    `INSERT INTO abuse_user_state (
       user_id,
       anomaly_score,
       last_rule_hits,
       throttle_expires_at,
       throttle_rpm_limit,
       throttle_tpm_limit,
       throttle_reason,
       last_action,
       last_action_at,
       last_action_metadata,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3::jsonb,
       now() + ($4::integer * interval '1 minute'),
       $5,
       $6,
       'auto_anomaly_score',
       'abuse.action.throttle_auto',
       now(),
       $7::jsonb,
       now()
     )
     ON CONFLICT (user_id) DO UPDATE
       SET anomaly_score = EXCLUDED.anomaly_score,
           last_rule_hits = EXCLUDED.last_rule_hits,
           throttle_expires_at = GREATEST(
             COALESCE(abuse_user_state.throttle_expires_at, to_timestamp(0)),
             now() + ($4::integer * interval '1 minute')
           ),
           throttle_rpm_limit = EXCLUDED.throttle_rpm_limit,
           throttle_tpm_limit = EXCLUDED.throttle_tpm_limit,
           throttle_reason = EXCLUDED.throttle_reason,
           last_action = EXCLUDED.last_action,
           last_action_at = now(),
           last_action_metadata = EXCLUDED.last_action_metadata,
           updated_at = now()
     RETURNING throttle_expires_at`,
    [
      params.userId,
      params.score,
      JSON.stringify(params.ruleHits),
      config.abuseThrottleDurationMinutes,
      params.rpmLimit,
      params.tpmLimit,
      JSON.stringify({
        score: params.score,
        rpm_limit: params.rpmLimit,
        tpm_limit: params.tpmLimit,
        duration_minutes: config.abuseThrottleDurationMinutes,
      }),
    ],
  );

  return result.rows[0]?.throttle_expires_at ?? new Date().toISOString();
}

async function applyAutoTempBan(params: {
  userId: string;
  score: number;
  ruleHits: AbuseRuleHit[];
}): Promise<string> {
  const banResult = await pool.query<{ ban_expires_at: string }>(
    `UPDATE users
     SET status = 'banned',
         banned_at = COALESCE(banned_at, now()),
         ban_expires_at = now() + ($2::integer * interval '1 minute'),
         updated_at = now()
     WHERE id = $1
     RETURNING ban_expires_at`,
    [params.userId, config.abuseBanDurationMinutes],
  );

  const banExpiresAt = banResult.rows[0]?.ban_expires_at ?? new Date().toISOString();

  await pool.query(
    `INSERT INTO abuse_user_state (
       user_id,
       anomaly_score,
       last_rule_hits,
       last_action,
       last_action_at,
       last_action_metadata,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3::jsonb,
       'abuse.action.temp_ban_auto',
       now(),
       $4::jsonb,
       now()
     )
     ON CONFLICT (user_id) DO UPDATE
       SET anomaly_score = EXCLUDED.anomaly_score,
           last_rule_hits = EXCLUDED.last_rule_hits,
           last_action = EXCLUDED.last_action,
           last_action_at = now(),
           last_action_metadata = EXCLUDED.last_action_metadata,
           updated_at = now()`,
    [
      params.userId,
      params.score,
      JSON.stringify(params.ruleHits),
      JSON.stringify({
        score: params.score,
        ban_expires_at: banExpiresAt,
        duration_minutes: config.abuseBanDurationMinutes,
      }),
    ],
  );

  return banExpiresAt;
}

function pushRuleHit(
  target: AbuseRuleHit[],
  params: {
    rule: string;
    score: number;
    value: number;
    threshold: number;
    windowSeconds: number;
    detail?: Record<string, unknown>;
  },
): number {
  target.push({
    rule: params.rule,
    score: params.score,
    value: params.value,
    threshold: params.threshold,
    window_seconds: params.windowSeconds,
    detail: params.detail,
  });
  return params.score;
}

async function evaluateUserAbuseAndMaybeAct(params: {
  request: FastifyRequest;
  user: DbUser;
  currentIp: string | null;
  currentUa: string | null;
}): Promise<AbuseEvaluationResult> {
  const userId = params.user.id;
  const [baseLimits, abuseState, rpmTotals, tpmTotals, errorTotals, loginTotals, streamTotals] =
    await Promise.all([
      loadBaseRateLimitsForUser(userId),
      loadAbuseUserState(userId),
      loadAbuseCounterTotals(userId, ['request_total'], ABUSE_RPM_WINDOW_SECONDS),
      loadAbuseCounterTotals(userId, ['tpm_tokens'], ABUSE_TPM_WINDOW_SECONDS),
      loadAbuseCounterTotals(
        userId,
        ['request_total', 'request_error', 'request_429'],
        ABUSE_ERROR_WINDOW_SECONDS,
      ),
      loadAbuseCounterTotals(userId, ['auth_login_fail'], ABUSE_LOGIN_FAIL_WINDOW_SECONDS),
      loadAbuseCounterTotals(
        userId,
        ['stream_concurrency_rejected'],
        ABUSE_STREAM_REJECT_WINDOW_SECONDS,
      ),
    ]);

  const [distinctIpCount, distinctUaCount, sharedIpUsers] = await Promise.all([
    countDistinctAbuseDimensions(userId, 'seen_ip:', ABUSE_IP_UA_CHURN_WINDOW_SECONDS),
    countDistinctAbuseDimensions(userId, 'seen_ua:', ABUSE_IP_UA_CHURN_WINDOW_SECONDS),
    countRecentUsersForIp(params.currentIp, ABUSE_MULTI_ACCOUNT_WINDOW_SECONDS),
  ]);

  const ruleHits: AbuseRuleHit[] = [];
  let score = 0;

  const rpm1m = rpmTotals.request_total ?? 0;
  const rpmSpikeThreshold = Math.max(12, Math.ceil(baseLimits.rpm_effective * 1.4));
  if (rpm1m >= rpmSpikeThreshold) {
    score += pushRuleHit(ruleHits, {
      rule: 'rpm_spike',
      score: rpm1m >= Math.max(20, Math.ceil(baseLimits.rpm_effective * 2)) ? 40 : 25,
      value: rpm1m,
      threshold: rpmSpikeThreshold,
      windowSeconds: ABUSE_RPM_WINDOW_SECONDS,
      detail: { rpm_limit_effective: baseLimits.rpm_effective },
    });
  }

  const tpm1m = tpmTotals.tpm_tokens ?? 0;
  const tpmSpikeThreshold = Math.max(1000, Math.ceil(baseLimits.tpm_effective * 1.25));
  if (tpm1m >= tpmSpikeThreshold) {
    score += pushRuleHit(ruleHits, {
      rule: 'tpm_spike',
      score: tpm1m >= Math.max(3000, Math.ceil(baseLimits.tpm_effective * 1.8)) ? 45 : 30,
      value: tpm1m,
      threshold: tpmSpikeThreshold,
      windowSeconds: ABUSE_TPM_WINDOW_SECONDS,
      detail: { tpm_limit_effective: baseLimits.tpm_effective },
    });
  }

  const loginFails = loginTotals.auth_login_fail ?? 0;
  if (loginFails >= 6) {
    score += pushRuleHit(ruleHits, {
      rule: 'login_bruteforce',
      score: loginFails >= 10 ? 65 : 45,
      value: loginFails,
      threshold: 6,
      windowSeconds: ABUSE_LOGIN_FAIL_WINDOW_SECONDS,
    });
  }

  const streamRejected = streamTotals.stream_concurrency_rejected ?? 0;
  if (streamRejected >= 2) {
    score += pushRuleHit(ruleHits, {
      rule: 'stream_concurrency_abuse',
      score: streamRejected >= 5 ? 45 : 25,
      value: streamRejected,
      threshold: 2,
      windowSeconds: ABUSE_STREAM_REJECT_WINDOW_SECONDS,
      detail: { concurrency_cap: config.abuseStreamConcurrencyLimit },
    });
  }

  if (distinctIpCount >= 4 || distinctUaCount >= 4) {
    score += pushRuleHit(ruleHits, {
      rule: 'ip_ua_churn',
      score: distinctIpCount >= 6 || distinctUaCount >= 6 ? 35 : 20,
      value: Math.max(distinctIpCount, distinctUaCount),
      threshold: 4,
      windowSeconds: ABUSE_IP_UA_CHURN_WINDOW_SECONDS,
      detail: {
        distinct_ip_count: distinctIpCount,
        distinct_ua_count: distinctUaCount,
      },
    });
  }

  if (sharedIpUsers >= 4) {
    score += pushRuleHit(ruleHits, {
      rule: 'multi_account_ip_cluster',
      score: sharedIpUsers >= 7 ? 40 : 25,
      value: sharedIpUsers,
      threshold: 4,
      windowSeconds: ABUSE_MULTI_ACCOUNT_WINDOW_SECONDS,
      detail: { ip: params.currentIp },
    });
  }

  const errorCount = errorTotals.request_error ?? 0;
  const errorWindowRequests = errorTotals.request_total ?? 0;
  const burst429 = errorTotals.request_429 ?? 0;
  if (burst429 >= 6) {
    score += pushRuleHit(ruleHits, {
      rule: '429_burst',
      score: burst429 >= 12 ? 35 : 20,
      value: burst429,
      threshold: 6,
      windowSeconds: ABUSE_ERROR_WINDOW_SECONDS,
    });
  }
  if (errorCount >= 8 || (errorWindowRequests >= 8 && errorCount / errorWindowRequests >= 0.45)) {
    score += pushRuleHit(ruleHits, {
      rule: 'high_error_rate',
      score:
        errorCount >= 15 || (errorWindowRequests >= 12 && errorCount / errorWindowRequests >= 0.6)
          ? 35
          : 20,
      value: errorCount,
      threshold: 8,
      windowSeconds: ABUSE_ERROR_WINDOW_SECONDS,
      detail: {
        request_count: errorWindowRequests,
      },
    });
  }

  await ensureAbuseStateRow(userId, score, ruleHits);

  const activeThrottle = getActiveThrottleFromState(abuseState);
  let action: AbuseEvaluationResult['action'] = 'none';
  let banExpiresAt: string | null = params.user.ban_expires_at;

  if (!hasActiveBan(params.user) && score >= config.abuseBanScoreThreshold) {
    const hasActiveIntermediateThrottle = activeThrottle.source !== 'none';
    if (hasActiveIntermediateThrottle) {
      banExpiresAt = await applyAutoTempBan({
        userId,
        score,
        ruleHits,
      });
      action = 'ban';

      await writeAuditEvent({
        eventType: 'abuse.action.temp_ban_auto',
        request: params.request,
        userId,
        metadata: {
          score,
          ban_expires_at: banExpiresAt,
          rule_hits: ruleHits,
        },
      });

      await sendAbuseAlert({
        user_id: userId,
        email: params.user.email,
        action: 'temp_ban_auto',
        score,
        ban_expires_at: banExpiresAt,
        ip: params.currentIp,
        ua: params.currentUa,
      });
    }
  }

  if (action === 'none' && !hasActiveBan(params.user) && score >= config.abuseThrottleScoreThreshold) {
    const throttleLimits = buildAutoThrottleLimits(baseLimits);
    const throttleExpiresAt = await applyAutoThrottle({
      userId,
      score,
      ruleHits,
      rpmLimit: throttleLimits.rpm_limit,
      tpmLimit: throttleLimits.tpm_limit,
    });
    action = 'throttle';

    await writeAuditEvent({
      eventType: 'abuse.action.throttle_auto',
      request: params.request,
      userId,
      metadata: {
        score,
        throttle_expires_at: throttleExpiresAt,
        rpm_limit: throttleLimits.rpm_limit,
        tpm_limit: throttleLimits.tpm_limit,
        rule_hits: ruleHits,
      },
    });

    await sendAbuseAlert({
      user_id: userId,
      email: params.user.email,
      action: 'throttle_auto',
      score,
      throttle_expires_at: throttleExpiresAt,
      rpm_limit: throttleLimits.rpm_limit,
      tpm_limit: throttleLimits.tpm_limit,
      ip: params.currentIp,
      ua: params.currentUa,
    });
  }

  return {
    score,
    ruleHits,
    action,
    ban_expires_at: banExpiresAt,
  };
}

async function authRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = (request.body ?? {}) as { email?: unknown };
  const normalizedEmail = typeof body.email === 'string' ? normalizeEmail(body.email) : 'unknown';
  const clientIp = getClientIp(request);
  const userAgent = getClientUserAgent(request);

  let limit = config.authRateLimitPerMinute;
  let matchedUser: DbUser | null = null;
  if (normalizedEmail !== 'unknown') {
    const userResult = await pool.query<DbUser>(
      `SELECT id, email, is_admin, default_model, status, ban_expires_at
       FROM users
       WHERE email = $1`,
      [normalizedEmail],
    );
    matchedUser = userResult.rowCount ? userResult.rows[0]! : null;
  }

  if (matchedUser) {
    matchedUser = await maybeLiftExpiredBan(matchedUser);
    if (hasActiveBan(matchedUser)) {
      reply.code(403).send({
        error: 'Account banned',
        ban_expires_at: matchedUser.ban_expires_at,
      });
      return;
    }

    const abuseState = await loadAbuseUserState(matchedUser.id);
    const throttle = getActiveThrottleFromState(abuseState);
    if (throttle.source !== 'none') {
      const throttledAuthLimit = Math.max(
        2,
        Math.floor((throttle.rpm_limit ?? config.authRateLimitPerMinute) / 4),
      );
      limit = Math.min(limit, throttledAuthLimit);
    }

    await incrementAbuseCounters(matchedUser.id, [
      { dimension: 'auth_attempt', value: 1 },
      { dimension: `seen_ip:${shortHash(clientIp)}`, value: 1 },
      { dimension: `seen_ua:${shortHash(userAgent ?? 'unknown')}`, value: 1 },
    ]);
  }

  const key = `ratelimit:auth:${clientIp}:${normalizedEmail}`;
  const allowed = await checkRateLimit(key, limit, RATE_LIMIT_WINDOW_SECONDS);
  if (!allowed) {
    if (matchedUser) {
      await incrementAbuseCounters(matchedUser.id, [{ dimension: 'request_429', value: 1 }]);
    }
    reply.code(429).send({ error: 'Too many authentication attempts' });
    return;
  }
}

async function v1RateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.authUser) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const effectiveRateLimits = await loadEffectiveRateLimitsForUser(request.authUser.id);
  request.effectiveRateLimits = effectiveRateLimits;
  const key = `ratelimit:v1:rpm:${request.authUser.id}`;
  const allowed = await checkRateLimit(
    key,
    effectiveRateLimits.rpm_effective,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!allowed) {
    await incrementAbuseCounters(request.authUser.id, [{ dimension: 'request_429', value: 1 }]);
    await evaluateUserAbuseAndMaybeAct({
      request,
      user: request.authUser,
      currentIp: getClientIp(request),
      currentUa: getClientUserAgent(request),
    });
    reply.code(429).send({ error: 'Rate limit exceeded (RPM)' });
    return;
  }
}

async function recordAuthenticatedActivityAndEvaluateAbuse(
  request: FastifyRequest,
  user: DbUser,
): Promise<AbuseEvaluationResult> {
  const ip = getClientIp(request);
  const ua = getClientUserAgent(request);

  await Promise.all([
    touchUserLastSeen(user.id, ip, ua),
    incrementAbuseCounters(user.id, [
      { dimension: 'request_total', value: 1 },
      { dimension: `seen_ip:${shortHash(ip)}`, value: 1 },
      { dimension: `seen_ua:${shortHash(ua ?? 'unknown')}`, value: 1 },
    ]),
  ]);

  return evaluateUserAbuseAndMaybeAct({
    request,
    user,
    currentIp: ip,
    currentUa: ua,
  });
}

function estimateTokensFromText(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function estimateTokensFromUnknown(value: unknown): number {
  if (typeof value === 'undefined' || value === null) {
    return 0;
  }

  if (typeof value === 'string') {
    return estimateTokensFromText(value);
  }

  const serialized = trySerializeJson(value);
  if (!serialized.json) {
    return 0;
  }

  return estimateTokensFromText(serialized.json);
}

function parseTokenUsageMember(member: string): number {
  const [tokenPart] = member.split('|');
  const parsed = Number.parseInt(tokenPart ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function normalizeTokenAmount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

async function getTpmUsageInWindow(userId: string, nowMs = Date.now()): Promise<number> {
  const key = `ratelimit:v1:tpm:${userId}`;
  const cutoff = nowMs - TPM_WINDOW_MS;

  await redis.zremrangebyscore(key, '-inf', cutoff);
  const members = await redis.zrangebyscore(key, cutoff, '+inf');

  let used = 0;
  for (const member of members) {
    used += parseTokenUsageMember(member);
  }

  return used;
}

async function addTpmUsageEvent(userId: string, tokens: number, nowMs = Date.now()): Promise<void> {
  const normalized = normalizeTokenAmount(tokens);
  if (normalized <= 0) {
    return;
  }

  const key = `ratelimit:v1:tpm:${userId}`;
  const member = `${normalized}|${nowMs}|${crypto.randomUUID()}`;

  await redis.zadd(key, nowMs, member);
  await redis.expire(key, TPM_COUNTER_TTL_SECONDS);
  await incrementAbuseCounter(userId, 'tpm_tokens', normalized, nowMs);
}

async function reserveTpmUsage(params: {
  userId: string;
  tokens: number;
  limit: number;
}): Promise<{ allowed: true; used: number } | { allowed: false; used: number }> {
  const normalizedTokens = normalizeTokenAmount(params.tokens);
  const nowMs = Date.now();
  const used = await getTpmUsageInWindow(params.userId, nowMs);

  if (used + normalizedTokens > params.limit) {
    return { allowed: false, used };
  }

  await addTpmUsageEvent(params.userId, normalizedTokens, nowMs);
  return { allowed: true, used };
}

async function acquireUserStreamLease(
  userId: string,
): Promise<{ allowed: true; lease: StreamLease; active: number } | { allowed: false; active: number }> {
  const key = `abuse:stream:active:${userId}`;
  const token = crypto.randomUUID();
  const nowMs = Date.now();
  const cutoffMs = nowMs - STREAM_SESSION_TTL_SECONDS * 1000;

  const raw = await redis.eval(
    STREAM_LEASE_ACQUIRE_LUA,
    1,
    key,
    String(config.abuseStreamConcurrencyLimit),
    String(nowMs),
    String(cutoffMs),
    token,
    String(STREAM_SESSION_TTL_SECONDS),
  );

  const result = Array.isArray(raw) ? raw : [0, 0];
  const allowed = toSafeInteger(result[0]) === 1;
  const active = toSafeInteger(result[1]);
  if (!allowed) {
    return { allowed: false, active };
  }

  return {
    allowed: true,
    active,
    lease: {
      key,
      token,
    },
  };
}

async function releaseUserStreamLease(lease: StreamLease | null): Promise<void> {
  if (!lease) {
    return;
  }

  await redis.zrem(lease.key, lease.token);
}

function parseNumberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractUsageTotalTokens(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const usageRecord = usage as Record<string, unknown>;
  const totalTokens = parseNumberField(usageRecord.total_tokens);
  if (totalTokens !== null) {
    return normalizeTokenAmount(totalTokens);
  }

  const promptTokens =
    parseNumberField(usageRecord.prompt_tokens) ?? parseNumberField(usageRecord.input_tokens);
  const completionTokens =
    parseNumberField(usageRecord.completion_tokens) ?? parseNumberField(usageRecord.output_tokens);

  if (promptTokens === null && completionTokens === null) {
    return null;
  }

  return normalizeTokenAmount((promptTokens ?? 0) + (completionTokens ?? 0));
}

function defaultDisplayNameForModelId(modelId: string): string {
  return modelId.trim();
}

function normalizePublicModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim();
  if (!candidate) {
    return null;
  }

  return candidate;
}

async function resolveUniquePublicId(params: {
  desiredPublicId: string;
  providerCode: string;
  modelId: string;
}): Promise<string> {
  const desired = params.desiredPublicId.trim();
  const fallbackBase = `${params.providerCode}:${params.modelId}`.trim();

  const candidates: string[] = [];
  if (desired) {
    candidates.push(desired);
  }
  if (fallbackBase && !candidates.includes(fallbackBase)) {
    candidates.push(fallbackBase);
  }

  let suffix = 2;
  while (candidates.length < 100) {
    const candidate = `${fallbackBase}-${suffix}`;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
    suffix += 1;
  }

  for (const candidate of candidates) {
    const existing = await pool.query<{ id: number }>('SELECT id FROM models WHERE public_id = $1', [
      candidate,
    ]);
    if (!existing.rowCount) {
      return candidate;
    }
  }

  return `${fallbackBase}-${crypto.randomUUID()}`;
}

async function createSession(reply: FastifyReply, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await redis.setex(`session:${sessionId}`, config.sessionTtlSeconds, userId);
  reply.setCookie(config.sessionCookieName, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    maxAge: config.sessionTtlSeconds,
  });
  return sessionId;
}

async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = request.cookies[config.sessionCookieName];
  if (sessionId) {
    await redis.del(`session:${sessionId}`);
  }
  reply.clearCookie(config.sessionCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
  });
}

async function revokeUserSessions(userId: string): Promise<number> {
  let cursor = '0';
  let revoked = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 200);
    cursor = nextCursor;

    if (!keys.length) {
      continue;
    }

    const values = await redis.mget(...keys);
    const toDelete: string[] = [];

    for (let index = 0; index < keys.length; index += 1) {
      if (values[index] === userId) {
        toDelete.push(keys[index]!);
      }
    }

    if (toDelete.length) {
      revoked += await redis.del(...toDelete);
    }
  } while (cursor !== '0');

  return revoked;
}

async function recordSuccessfulLogin(
  userId: string,
  clientIp: string,
  userAgent: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE users
     SET last_login_at = now(),
         last_login_ip = $2,
         last_seen_ip = $2,
         last_seen_ua = $3,
         last_seen_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [userId, clientIp, userAgent],
  );
}

async function getUserById(userId: string): Promise<DbUser | null> {
  const result = await pool.query<DbUser>(
    'SELECT id, email, is_admin, default_model, status, ban_expires_at FROM users WHERE id = $1',
    [userId],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function getUserByEmail(email: string): Promise<DbUser | null> {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query<DbUser>(
    'SELECT id, email, is_admin, default_model, status, ban_expires_at FROM users WHERE email = $1',
    [normalizedEmail],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function getUserByIdentity(
  provider: string,
  providerSubject: string,
): Promise<DbUser | null> {
  const result = await pool.query<DbUser>(
    `SELECT u.id, u.email, u.is_admin, u.default_model, u.status, u.ban_expires_at
     FROM user_identities ui
     JOIN users u ON u.id = ui.user_id
     WHERE ui.provider = $1
       AND ui.provider_subject = $2`,
    [provider, providerSubject],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function createOAuthUser(params: {
  email: string;
  clientIp: string;
  clientUa: string | null;
}): Promise<DbUser> {
  const normalizedEmail = normalizeEmail(params.email);
  const randomSecret = crypto.randomBytes(48).toString('base64url');
  const passwordHash = await bcrypt.hash(randomSecret, 12);
  const isAdmin = isConfiguredAdminEmail(normalizedEmail);

  try {
    const created = await pool.query<DbUser>(
      `INSERT INTO users (
         email,
         password_hash,
         is_admin,
         last_login_at,
         last_login_ip,
         last_seen_ip,
         last_seen_ua,
         last_seen_at
       )
       VALUES ($1, $2, $3, now(), $4, $4, $5, now())
       RETURNING id, email, is_admin, default_model, status, ban_expires_at`,
      [normalizedEmail, passwordHash, isAdmin, params.clientIp, params.clientUa],
    );
    return created.rows[0]!;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const existing = await getUserByEmail(normalizedEmail);
    if (!existing) {
      throw error;
    }
    return existing;
  }
}

async function resolveOAuthUser(params: {
  provider: string;
  providerSubject: string;
  email: string;
  clientIp: string;
  clientUa: string | null;
}): Promise<DbUser> {
  const normalizedEmail = normalizeEmail(params.email);
  const byIdentity = await getUserByIdentity(params.provider, params.providerSubject);
  if (byIdentity) {
    return byIdentity;
  }

  const byEmail = await getUserByEmail(normalizedEmail);
  if (byEmail) {
    return byEmail;
  }

  return createOAuthUser({
    email: normalizedEmail,
    clientIp: params.clientIp,
    clientUa: params.clientUa,
  });
}

async function upsertUserIdentity(params: {
  userId: string;
  provider: string;
  providerSubject: string;
  email: string;
  emailVerified: boolean;
}): Promise<void> {
  const normalizedEmail = normalizeEmail(params.email);
  await pool.query(
    `INSERT INTO user_identities (
       user_id,
       provider,
       provider_subject,
       email,
       email_verified,
       last_login_at
     )
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, provider_subject)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       email = EXCLUDED.email,
       email_verified = EXCLUDED.email_verified,
       last_login_at = now()`,
    [
      params.userId,
      params.provider,
      params.providerSubject,
      normalizedEmail,
      params.emailVerified,
    ],
  );
}

async function getProviderByCode(code: string): Promise<ProviderRow | null> {
  const result = await pool.query<ProviderRow>(
    'SELECT id, code, name, base_url, enabled FROM providers WHERE code = $1',
    [code],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function getProviderById(providerId: number): Promise<ProviderRow | null> {
  const result = await pool.query<ProviderRow>(
    'SELECT id, code, name, base_url, enabled FROM providers WHERE id = $1',
    [providerId],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function getAllProviders(): Promise<ProviderRow[]> {
  const result = await pool.query<ProviderRow>(
    'SELECT id, code, name, base_url, enabled FROM providers ORDER BY id ASC',
  );
  return result.rows;
}

async function getProviderSecret(providerId: number): Promise<string | null> {
  const result = await pool.query<ProviderSecretRow>(
    `SELECT provider_id, encrypted_api_key, iv, tag, key_version, updated_at
     FROM provider_secrets
     WHERE provider_id = $1`,
    [providerId],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0]!;
  return decryptApiKey(row.encrypted_api_key, row.iv, row.tag);
}

async function listCatalogModels(params?: { includeDisabled?: boolean }): Promise<ModelCatalogRow[]> {
  const includeDisabled = params?.includeDisabled ?? false;
  const result = await pool.query<ModelCatalogRow>(
    `SELECT m.id,
            m.provider_id,
            p.code AS provider_code,
            p.base_url AS provider_base_url,
            m.model_id,
            m.public_id,
            m.display_name,
            m.enabled,
            m.created_at
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE ($1::boolean = true OR (m.enabled = true AND p.enabled = true))
     ORDER BY m.display_name ASC, m.public_id ASC`,
    [includeDisabled],
  );
  return result.rows;
}

async function findCatalogModelByPublicId(
  publicId: string,
  options?: { includeDisabled?: boolean },
): Promise<ModelCatalogRow | null> {
  const normalizedPublicId = publicId.trim();
  if (!normalizedPublicId) {
    return null;
  }

  const includeDisabled = options?.includeDisabled ?? false;
  const result = await pool.query<ModelCatalogRow>(
    `SELECT m.id,
            m.provider_id,
            p.code AS provider_code,
            p.base_url AS provider_base_url,
            m.model_id,
            m.public_id,
            m.display_name,
            m.enabled,
            m.created_at
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.public_id = $1
       AND ($2::boolean = true OR (m.enabled = true AND p.enabled = true))`,
    [normalizedPublicId, includeDisabled],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function syncUserAdminBootstrapFlag(user: DbUser): Promise<DbUser> {
  if (!isConfiguredAdminEmail(user.email) || user.is_admin) {
    return user;
  }

  const updated = await pool.query<DbUser>(
    `UPDATE users
     SET is_admin = true,
         updated_at = now()
     WHERE id = $1
     RETURNING id, email, is_admin, default_model, status, ban_expires_at`,
    [user.id],
  );

  return updated.rowCount ? updated.rows[0]! : { ...user, is_admin: true };
}

async function resolveModelForRequest(params: {
  user: DbUser;
  requestedPublicModelId?: string;
}): Promise<ModelCatalogRow> {
  const modelPublicId = (params.requestedPublicModelId ?? params.user.default_model ?? '').trim();
  if (!modelPublicId) {
    throw new Error('model is required');
  }

  const model = await findCatalogModelByPublicId(modelPublicId, { includeDisabled: false });
  if (!model) {
    throw new Error(`Model "${modelPublicId}" is not published`);
  }

  return model;
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = parseNumberField(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseUserStatus(value: unknown): 'active' | 'banned' | null {
  if (value === 'active' || value === 'banned') {
    return value;
  }
  return null;
}

function parseNullablePositiveInteger(value: unknown): number | null | 'invalid' {
  if (value === null) {
    return null;
  }

  const positiveInteger = toPositiveInteger(value);
  if (positiveInteger === null) {
    return 'invalid';
  }

  return positiveInteger;
}

const threadTitleSentenceBoundary = /[.!?]\s/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseMessageCursor(value: unknown): MessageCursor | null | 'invalid' {
  if (typeof value === 'undefined') {
    return null;
  }

  if (typeof value !== 'string') {
    return 'invalid';
  }

  const cursor = value.trim();
  if (!cursor) {
    return 'invalid';
  }

  const separatorIndex = cursor.indexOf('|');
  if (separatorIndex <= 0) {
    return 'invalid';
  }

  const createdAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (!createdAt || !uuidPattern.test(id)) {
    return 'invalid';
  }

  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return 'invalid';
  }

  return { createdAt: new Date(createdAtMs).toISOString(), id };
}

function buildMessageCursor(value: MessageCursor): string {
  return `${value.createdAt}|${value.id}`;
}

function deriveThreadTitleFromText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  const boundaryMatch = threadTitleSentenceBoundary.exec(cleaned);
  let candidate =
    boundaryMatch && boundaryMatch.index >= 0
      ? cleaned.slice(0, boundaryMatch.index + 1)
      : cleaned;

  candidate = candidate.replace(/\s+/g, ' ').trim();
  if (!candidate) {
    return null;
  }

  if (candidate.length <= 60) {
    return candidate;
  }

  return `${candidate.slice(0, 57).trimEnd()}...`;
}

async function maybeAutoRenameThread(params: {
  threadId: string;
  userId: string;
  sourceText: string;
}): Promise<void> {
  const title = deriveThreadTitleFromText(params.sourceText);
  if (!title) {
    return;
  }

  await pool.query(
    `UPDATE threads
     SET title = $3,
         updated_at = now()
     WHERE id = $1
       AND user_id = $2
       AND title = 'New chat'`,
    [params.threadId, params.userId, title],
  );
}

function collectFileIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFileIds(item, ids);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const maybeFileId =
    typeof record.file_id === 'string'
      ? record.file_id
      : typeof record.fileId === 'string'
        ? record.fileId
        : null;

  if (maybeFileId && uuidPattern.test(maybeFileId)) {
    ids.add(maybeFileId);
  }

  for (const nested of Object.values(record)) {
    collectFileIds(nested, ids);
  }
}

function extractFileIdsFromRawContent(rawContent: unknown): string[] {
  const ids = new Set<string>();
  collectFileIds(rawContent, ids);
  return Array.from(ids);
}

function extractTextFromResponsesInput(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }

  if (!Array.isArray(input)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const content = (item as Record<string, unknown>).content;
    if (typeof content === 'string') {
      chunks.push(content);
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (record.type === 'input_text' && typeof record.text === 'string') {
        chunks.push(record.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractTextFromChatMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of messages) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const message = item as Record<string, unknown>;
    if (message.role !== 'user') {
      continue;
    }

    if (typeof message.content === 'string') {
      chunks.push(message.content);
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        const record = part as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') {
          chunks.push(record.text);
        }
      }
    }
  }

  return chunks.join('\n').trim();
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function loadImageDataUrl(userId: string, fileId: string): Promise<string> {
  const result = await pool.query<UploadedFileRow>(
    `SELECT id, bucket, object_key, mime_type
     FROM files
     WHERE id = $1 AND user_id = $2`,
    [fileId, userId],
  );

  if (!result.rowCount) {
    throw new Error(`Unknown file: ${fileId}`);
  }

  const file = result.rows[0]!;
  const objectStream = (await minio.getObject(file.bucket, file.object_key)) as Readable;
  const buffer = await streamToBuffer(objectStream);
  return `data:${file.mime_type};base64,${buffer.toString('base64')}`;
}

async function hydrateResponsesInput(input: unknown, userId: string): Promise<unknown> {
  if (Array.isArray(input)) {
    const hydrated = [];
    for (const entry of input) {
      hydrated.push(await hydrateResponsesInput(entry, userId));
    }
    return hydrated;
  }

  if (!input || typeof input !== 'object') {
    return input;
  }

  const record = input as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const nextContent: unknown[] = [];
    for (const part of record.content) {
      if (!part || typeof part !== 'object') {
        nextContent.push(part);
        continue;
      }

      const imagePart = part as Record<string, unknown>;
      if (imagePart.type === 'input_image') {
        const fileId =
          typeof imagePart.file_id === 'string'
            ? imagePart.file_id
            : typeof imagePart.fileId === 'string'
              ? imagePart.fileId
              : null;

        if (fileId) {
          const dataUrl = await loadImageDataUrl(userId, fileId);
          nextContent.push({ type: 'input_image', image_url: dataUrl });
          continue;
        }
      }

      nextContent.push(part);
    }

    return {
      ...record,
      content: nextContent,
    };
  }

  return record;
}

async function hydrateChatMessages(messages: unknown, userId: string): Promise<unknown> {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const hydrated: unknown[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      hydrated.push(raw);
      continue;
    }

    const message = raw as Record<string, unknown>;
    if (!Array.isArray(message.content)) {
      hydrated.push(message);
      continue;
    }

    const contentParts: unknown[] = [];
    for (const part of message.content) {
      if (!part || typeof part !== 'object') {
        contentParts.push(part);
        continue;
      }

      const record = part as Record<string, unknown>;
      const fileId =
        typeof record.file_id === 'string'
          ? record.file_id
          : typeof record.fileId === 'string'
            ? record.fileId
            : null;

      if (fileId && (record.type === 'image_file' || record.type === 'input_image')) {
        const dataUrl = await loadImageDataUrl(userId, fileId);
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: dataUrl,
          },
        });
        continue;
      }

      contentParts.push(record);
    }

    hydrated.push({
      ...message,
      content: contentParts,
    });
  }

  return hydrated;
}

function extractAssistantTextFromResponses(responseBody: unknown): string {
  if (!responseBody || typeof responseBody !== 'object') {
    return '';
  }

  const payload = responseBody as Record<string, unknown>;
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return '';
  }

  const chunks: string[] = [];
  for (const outputItem of payload.output) {
    if (!outputItem || typeof outputItem !== 'object') {
      continue;
    }

    const item = outputItem as Record<string, unknown>;
    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (!part || typeof part !== 'object') {
        continue;
      }

      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') {
        chunks.push(record.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractAssistantTextFromChatCompletions(responseBody: unknown): string {
  if (!responseBody || typeof responseBody !== 'object') {
    return '';
  }

  const payload = responseBody as Record<string, unknown>;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }

  const firstChoice = choices[0] as Record<string, unknown>;
  const message = firstChoice.message as Record<string, unknown> | undefined;
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    const chunks: string[] = [];
    for (const part of message.content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') {
        chunks.push(record.text);
      }
    }
    return chunks.join('\n').trim();
  }

  return '';
}

function findSseBoundary(input: string): { index: number; length: number } | null {
  const idxLf = input.indexOf('\n\n');
  const idxCrLf = input.indexOf('\r\n\r\n');

  if (idxLf === -1 && idxCrLf === -1) {
    return null;
  }

  if (idxLf === -1) {
    return { index: idxCrLf, length: 4 };
  }

  if (idxCrLf === -1) {
    return { index: idxLf, length: 2 };
  }

  if (idxLf < idxCrLf) {
    return { index: idxLf, length: 2 };
  }

  return { index: idxCrLf, length: 4 };
}

function parseSseAssistantDelta(params: {
  streamKind: 'responses' | 'chat';
  buffer: string;
}): { remaining: string; assistantDelta: string } {
  let remaining = params.buffer;
  let assistantDelta = '';

  while (true) {
    const boundary = findSseBoundary(remaining);
    if (!boundary) {
      break;
    }

    const block = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary.length);

    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const eventData = dataLines.join('\n');
    if (!eventData || eventData === '[DONE]') {
      continue;
    }

    try {
      const parsed = JSON.parse(eventData) as Record<string, unknown>;
      if (params.streamKind === 'responses') {
        if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
          assistantDelta += parsed.delta;
        }
      } else {
        const choices = parsed.choices;
        if (!Array.isArray(choices) || choices.length === 0) {
          continue;
        }
        const first = choices[0] as Record<string, unknown>;
        const delta = first.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.content === 'string') {
          assistantDelta += delta.content;
        }
      }
    } catch {
      continue;
    }
  }

  return { remaining, assistantDelta };
}

async function getOrCreateThread(params: {
  userId: string;
  threadId?: string;
  providerId: number;
  model?: string;
}): Promise<string> {
  if (params.threadId) {
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
      [params.threadId, params.userId],
    );

    if (!existing.rowCount) {
      throw new Error('Thread not found');
    }

    await pool.query(
      `UPDATE threads
       SET provider_id = $3,
           model = COALESCE($4, model),
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [params.threadId, params.userId, params.providerId, params.model ?? null],
    );

    return params.threadId;
  }

  const result = await pool.query<{ id: string }>(
    `INSERT INTO threads (user_id, title, provider_id, model)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.userId, 'New chat', params.providerId, params.model ?? null],
  );
  return result.rows[0]!.id;
}

function normalizeStoredThreadRole(value: string): ThreadContextMessage['role'] | null {
  if (value === 'user' || value === 'assistant' || value === 'system') {
    return value;
  }
  return null;
}

async function loadRecentThreadContextMessages(params: {
  threadId: string;
  userId: string;
  maxMessages?: number;
  maxTokens?: number;
}): Promise<{ messages: ThreadContextMessage[]; tokenEstimate: number }> {
  const maxMessages = params.maxMessages ?? THREAD_CONTEXT_MAX_MESSAGES;
  const maxTokens = params.maxTokens ?? THREAD_CONTEXT_MAX_TOKENS;

  if (maxMessages <= 0 || maxTokens <= 0) {
    return { messages: [], tokenEstimate: 0 };
  }

  const result = await pool.query<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>(
    `SELECT id, role, content, created_at
     FROM messages
     WHERE thread_id = $1
       AND user_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [params.threadId, params.userId, maxMessages],
  );

  const selectedDescending: ThreadContextMessage[] = [];
  let tokenEstimate = 0;

  for (const row of result.rows) {
    const normalizedRole = normalizeStoredThreadRole(row.role);
    if (!normalizedRole) {
      continue;
    }

    if (!row.content.trim()) {
      continue;
    }

    const rowTokens = estimateTokensFromText(row.content);
    if (rowTokens <= 0) {
      continue;
    }

    if (tokenEstimate + rowTokens > maxTokens) {
      break;
    }

    selectedDescending.push({
      role: normalizedRole,
      content: row.content,
    });
    tokenEstimate += rowTokens;
  }

  return {
    messages: selectedDescending.reverse(),
    tokenEstimate,
  };
}

function buildResponsesHistoryInputFromThreadMessages(messages: ThreadContextMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    const contentType = message.role === 'assistant' ? 'output_text' : 'input_text';
    input.push({
      role: message.role,
      content: [{ type: contentType, text: message.content }],
    });
  }

  return input;
}

function buildChatHistoryMessagesFromThreadMessages(messages: ThreadContextMessage[]): unknown[] {
  const historyMessages: unknown[] = [];

  for (const message of messages) {
    historyMessages.push({
      role: message.role,
      content: message.content,
    });
  }

  return historyMessages;
}

function normalizeResponsesInputForPrepend(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return [...input];
  }

  if (typeof input === 'string') {
    return [
      {
        role: 'user',
        content: [{ type: 'input_text', text: input }],
      },
    ];
  }

  if (typeof input === 'undefined' || input === null) {
    return [];
  }

  return [input];
}

async function persistMessage(params: {
  threadId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  rawContent?: unknown;
}): Promise<void> {
  if (!params.content.trim()) {
    return;
  }

  const rawContentJson = serializeRawContentForStorage(params.rawContent);
  const insertSql = `INSERT INTO messages (thread_id, user_id, role, content, raw_content)
     VALUES ($1, $2, $3, $4, $5::jsonb)`;

  try {
    await pool.query(insertSql, [
      params.threadId,
      params.userId,
      params.role,
      params.content,
      rawContentJson,
    ]);
  } catch (error) {
    if (rawContentJson === null) {
      throw error;
    }

    app.log.warn(
      { err: error, threadId: params.threadId, userId: params.userId, role: params.role },
      'Failed to persist raw_content. Retrying message insert with null raw_content.',
    );

    await pool.query(insertSql, [
      params.threadId,
      params.userId,
      params.role,
      params.content,
      null,
    ]);
  }

  await pool.query('UPDATE threads SET updated_at = now() WHERE id = $1 AND user_id = $2', [
    params.threadId,
    params.userId,
  ]);
}

async function ensureBucketExists(): Promise<void> {
  const exists = await minio.bucketExists(config.minioBucket);
  if (!exists) {
    await minio.makeBucket(config.minioBucket, 'us-east-1');
  }
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = request.cookies[config.sessionCookieName];
  if (!sessionId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const userId = await redis.get(`session:${sessionId}`);
  if (!userId) {
    reply.code(401).send({ error: 'Session expired' });
    return;
  }

  const user = await getUserById(userId);
  if (!user) {
    await redis.del(`session:${sessionId}`);
    reply.code(401).send({ error: 'User not found' });
    return;
  }

  const maybeUnbanned = await maybeLiftExpiredBan(user);
  const syncedUser = await syncUserAdminBootstrapFlag(maybeUnbanned);
  if (hasActiveBan(syncedUser)) {
    await redis.del(`session:${sessionId}`);
    reply.clearCookie(config.sessionCookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
    });

    await writeAuditEvent({
      eventType: 'auth.session_blocked',
      request,
      userId: syncedUser.id,
      metadata: {
        reason: 'account_banned',
        ban_expires_at: syncedUser.ban_expires_at,
      },
    });

    reply.code(403).send({
      error: 'Account banned',
      ban_expires_at: syncedUser.ban_expires_at,
    });
    return;
  }

  request.sessionId = sessionId;
  request.authUser = syncedUser;

  const evaluation = await recordAuthenticatedActivityAndEvaluateAbuse(request, syncedUser);
  if (evaluation.action === 'ban') {
    await redis.del(`session:${sessionId}`);
    reply.clearCookie(config.sessionCookieName, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
    });

    await writeAuditEvent({
      eventType: 'auth.session_blocked',
      request,
      userId: syncedUser.id,
      metadata: {
        reason: 'auto_temp_ban',
        ban_expires_at: evaluation.ban_expires_at,
      },
    });

    reply.code(403).send({
      error: 'Account banned',
      ban_expires_at: evaluation.ban_expires_at,
    });
    return;
  }
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.authUser;
  if (!user || !user.is_admin) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error;
  }

  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string' && nested.message.trim()) {
      return nested.message;
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  return fallback;
}

function normalizeUpstreamModels(payload: unknown): UpstreamModelItem[] {
  let source: unknown[] = [];
  if (Array.isArray(payload)) {
    source = payload;
  } else if (payload && typeof payload === 'object') {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      source = data;
    }
  }

  const models: UpstreamModelItem[] = [];
  const seen = new Set<string>();

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) {
      continue;
    }

    const normalized: UpstreamModelItem = { id, raw: record };
    if (typeof record.owned_by === 'string' && record.owned_by.trim()) {
      normalized.owned_by = record.owned_by.trim();
    }

    models.push(normalized);
    seen.add(id);
  }

  return models;
}

async function setupServer(): Promise<void> {
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
    },
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!stateChangingMethods.has(request.method)) {
      return;
    }

    const origin = request.headers.origin;
    if (!origin || origin !== config.appOrigin) {
      await writeAuditEvent({
        eventType: 'security.origin_blocked',
        request,
        userId: request.authUser?.id ?? null,
        metadata: {
          origin: origin ?? null,
          path: request.url,
          method: request.method,
        },
      });

      reply.code(403).send({ error: 'Invalid origin' });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/auth/methods', async () => {
    return {
      password_login_enabled: !config.disablePasswordLogin,
      password_register_enabled: !config.disablePasswordRegister,
      oauth_providers: oauthRegistry.listConfiguredProviders(),
    };
  });

  app.get('/auth/oauth/providers', async () => {
    return { data: oauthRegistry.listConfiguredProviders() };
  });

  app.get('/auth/oauth/:provider/start', async (request, reply) => {
    const routeParams = request.params as { provider?: unknown };
    const provider = typeof routeParams.provider === 'string' ? routeParams.provider : '';

    const started = await oauthRegistry.startAuth(provider, request, reply);
    if (!started.ok) {
      await writeAuditEvent({
        eventType: 'auth.oauth_start_failed',
        request,
        metadata: {
          provider,
          reason: started.error,
        },
      });
      redirectToLoginError(reply, started.error);
    }
  });

  app.get('/auth/oauth/:provider/callback', async (request, reply) => {
    const routeParams = request.params as { provider?: unknown };
    const provider = typeof routeParams.provider === 'string' ? routeParams.provider : '';

    try {
      const callback = await oauthRegistry.handleCallback(provider, request, reply);
      if (!callback.ok) {
        await writeAuditEvent({
          eventType: 'auth.oauth_login_failed',
          request,
          metadata: {
            provider,
            reason: callback.error,
          },
        });
        redirectToLoginError(reply, callback.error);
        return;
      }

      const clientIp = getClientIp(request);
      const clientUa = getClientUserAgent(request);
      const normalizedEmail = normalizeEmail(callback.identity.email);
      const emailDomain = normalizedEmail.split('@')[1] ?? null;

      const resolvedUser = await resolveOAuthUser({
        provider: callback.identity.provider,
        providerSubject: callback.identity.providerSubject,
        email: normalizedEmail,
        clientIp,
        clientUa,
      });

      await upsertUserIdentity({
        userId: resolvedUser.id,
        provider: callback.identity.provider,
        providerSubject: callback.identity.providerSubject,
        email: normalizedEmail,
        emailVerified: callback.identity.emailVerified,
      });

      const maybeUnbanned = await maybeLiftExpiredBan(resolvedUser);
      const syncedUser = await syncUserAdminBootstrapFlag(maybeUnbanned);
      if (hasActiveBan(syncedUser)) {
        await writeAuditEvent({
          eventType: 'auth.oauth_login_blocked',
          request,
          userId: syncedUser.id,
          metadata: {
            provider: callback.identity.provider,
            reason: 'account_banned',
            ban_expires_at: syncedUser.ban_expires_at,
          },
        });
        redirectToLoginError(reply, 'account_banned');
        return;
      }

      await recordSuccessfulLogin(syncedUser.id, clientIp, clientUa);
      await incrementAbuseCounters(syncedUser.id, [
        { dimension: 'auth_login_success', value: 1 },
        { dimension: `seen_ip:${shortHash(clientIp)}`, value: 1 },
        { dimension: `seen_ua:${shortHash(clientUa ?? 'unknown')}`, value: 1 },
      ]);
      await createSession(reply, syncedUser.id);

      await writeAuditEvent({
        eventType: 'auth.oauth_login_success',
        request,
        userId: syncedUser.id,
        metadata: {
          provider: callback.identity.provider,
          email_domain: emailDomain,
        },
      });

      reply.redirect('/chat');
    } catch (error) {
      app.log.error({ err: error, provider }, 'OAuth callback failed');
      await writeAuditEvent({
        eventType: 'auth.oauth_login_failed',
        request,
        metadata: {
          provider,
          reason: error instanceof Error ? normalizeLoginErrorCode(error.message) : 'oauth_failed',
        },
      });
      redirectToLoginError(reply, 'oauth_failed');
    }
  });

  app.post('/auth/register', { preHandler: [authRateLimit] }, async (request, reply) => {
    if (config.disablePasswordRegister) {
      await writeAuditEvent({
        eventType: 'auth.password_register_disabled',
        request,
        metadata: {},
      });
      reply.code(404).send({ error: 'Not found' });
      return;
    }

    const body = request.body as { email?: unknown; password?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const clientIp = getClientIp(request);
    const clientUa = getClientUserAgent(request);

    if (!email || password.length < 8) {
      await writeAuditEvent({
        eventType: 'auth.register_failed',
        request,
        metadata: { reason: 'validation_failed', email_present: Boolean(email) },
      });
      reply.code(400).send({ error: 'Email and password (min 8 chars) are required' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const isAdmin = isConfiguredAdminEmail(email);
    try {
      const created = await pool.query<DbUser>(
        `INSERT INTO users (
           email,
           password_hash,
           is_admin,
           last_login_at,
           last_login_ip,
           last_seen_ip,
           last_seen_ua,
           last_seen_at
         )
         VALUES ($1, $2, $3, now(), $4, $4, $5, now())
         RETURNING id, email, is_admin, default_model, status, ban_expires_at`,
        [email, passwordHash, isAdmin, clientIp, clientUa],
      );
      const user = created.rows[0]!;
      await createSession(reply, user.id);

      await writeAuditEvent({
        eventType: 'auth.register_success',
        request,
        userId: user.id,
        metadata: { email_domain: email.split('@')[1] ?? null },
      });

      reply.send({
        id: user.id,
        email: user.email,
        is_admin: user.is_admin,
        default_model: user.default_model,
      });
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        await writeAuditEvent({
          eventType: 'auth.register_failed',
          request,
          metadata: { reason: 'email_exists' },
        });
        reply.code(409).send({ error: 'Email already exists' });
        return;
      }
      throw error;
    }
  });

  app.post('/auth/login', { preHandler: [authRateLimit] }, async (request, reply) => {
    if (config.disablePasswordLogin) {
      await writeAuditEvent({
        eventType: 'auth.password_login_disabled',
        request,
        metadata: {},
      });
      reply.code(404).send({ error: 'Not found' });
      return;
    }

    const body = request.body as { email?: unknown; password?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const clientIp = getClientIp(request);
    const clientUa = getClientUserAgent(request);

    if (!email || !password) {
      reply.code(400).send({ error: 'Email and password are required' });
      return;
    }

    const userResult = await pool.query<DbUser & { password_hash: string }>(
      `SELECT id, email, password_hash, is_admin, default_model, status, ban_expires_at
       FROM users
       WHERE email = $1`,
      [email],
    );

    if (!userResult.rowCount) {
      await writeAuditEvent({
        eventType: 'auth.login_failed',
        request,
        metadata: { reason: 'invalid_credentials' },
      });
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    const user = userResult.rows[0]!;
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      await incrementAbuseCounters(user.id, [
        { dimension: 'auth_login_fail', value: 1 },
        { dimension: 'request_error', value: 1 },
        { dimension: `seen_ip:${shortHash(clientIp)}`, value: 1 },
        { dimension: `seen_ua:${shortHash(clientUa ?? 'unknown')}`, value: 1 },
      ]);
      await writeAuditEvent({
        eventType: 'auth.login_failed',
        request,
        userId: user.id,
        metadata: { reason: 'invalid_credentials' },
      });

      await evaluateUserAbuseAndMaybeAct({
        request,
        user,
        currentIp: clientIp,
        currentUa: clientUa,
      });
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    const maybeUnbanned = await maybeLiftExpiredBan(user);
    const syncedUser = await syncUserAdminBootstrapFlag(maybeUnbanned);
    if (hasActiveBan(syncedUser)) {
      await writeAuditEvent({
        eventType: 'auth.login_blocked',
        request,
        userId: syncedUser.id,
        metadata: {
          reason: 'account_banned',
          ban_expires_at: syncedUser.ban_expires_at,
        },
      });
      reply.code(403).send({
        error: 'Account banned',
        ban_expires_at: syncedUser.ban_expires_at,
      });
      return;
    }

    await recordSuccessfulLogin(syncedUser.id, clientIp, clientUa);
    await incrementAbuseCounters(syncedUser.id, [
      { dimension: 'auth_login_success', value: 1 },
      { dimension: `seen_ip:${shortHash(clientIp)}`, value: 1 },
      { dimension: `seen_ua:${shortHash(clientUa ?? 'unknown')}`, value: 1 },
    ]);
    await createSession(reply, syncedUser.id);

    await writeAuditEvent({
      eventType: 'auth.login_success',
      request,
      userId: syncedUser.id,
      metadata: {},
    });

    reply.send({
      id: syncedUser.id,
      email: syncedUser.email,
      is_admin: syncedUser.is_admin,
      default_model: syncedUser.default_model,
    });
  });

  app.post('/auth/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = request.authUser?.id ?? null;
    await destroySession(request, reply);

    await writeAuditEvent({
      eventType: 'auth.logout',
      request,
      userId,
      metadata: {},
    });

    reply.send({ ok: true });
  });

  app.get('/me', { preHandler: [requireAuth] }, async (request) => {
    const user = request.authUser!;
    return {
      id: user.id,
      email: user.email,
      is_admin: user.is_admin,
      default_model: user.default_model,
    };
  });

  app.get('/me/threads', { preHandler: [requireAuth] }, async (request) => {
    const user = request.authUser!;
    const result = await pool.query<{
      id: string;
      title: string;
      model: string | null;
      updated_at: string;
      created_at: string;
    }>(
      `SELECT id, title, model, updated_at, created_at
       FROM threads
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [user.id],
    );
    return { data: result.rows };
  });

  app.post('/me/threads', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const defaultModel =
      user.default_model !== null
        ? await findCatalogModelByPublicId(user.default_model, { includeDisabled: false })
        : null;

    const created = await pool.query<{
      id: string;
      title: string;
      model: string | null;
      updated_at: string;
      created_at: string;
    }>(
      `INSERT INTO threads (user_id, title, provider_id, model)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, model, updated_at, created_at`,
      [user.id, 'New chat', defaultModel?.provider_id ?? null, user.default_model],
    );

    const thread = created.rows[0]!;

    await writeAuditEvent({
      eventType: 'threads.created',
      request,
      userId: user.id,
      metadata: {
        thread_id: thread.id,
      },
    });

    reply.code(201).send({ data: thread });
  });

  app.patch('/me/threads/:threadId', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { threadId: string };
    const body = (request.body ?? {}) as { title?: unknown };
    const title =
      typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';

    if (!title) {
      reply.code(400).send({ error: 'title is required' });
      return;
    }

    if (title.length > 120) {
      reply.code(400).send({ error: 'title must be 120 characters or fewer' });
      return;
    }

    const updated = await pool.query<{
      id: string;
      title: string;
      model: string | null;
      updated_at: string;
      created_at: string;
    }>(
      `UPDATE threads
       SET title = $3,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, title, model, updated_at, created_at`,
      [params.threadId, user.id, title],
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'Thread not found' });
      return;
    }

    await writeAuditEvent({
      eventType: 'threads.renamed',
      request,
      userId: user.id,
      metadata: {
        thread_id: params.threadId,
      },
    });

    reply.send({ data: updated.rows[0] });
  });

  app.delete('/me/threads/:threadId', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { threadId: string };

    const deleted = await pool.query<{ id: string }>(
      `DELETE FROM threads
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [params.threadId, user.id],
    );

    if (!deleted.rowCount) {
      reply.code(404).send({ error: 'Thread not found' });
      return;
    }

    await writeAuditEvent({
      eventType: 'threads.deleted',
      request,
      userId: user.id,
      metadata: {
        thread_id: params.threadId,
      },
    });

    reply.send({ ok: true });
  });

  app.get('/me/threads/:threadId/messages', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { threadId: string };

    const threadCheck = await pool.query<{ id: string }>(
      'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
      [params.threadId, user.id],
    );

    if (!threadCheck.rowCount) {
      reply.code(404).send({ error: 'Thread not found' });
      return;
    }

    const messages = await pool.query<{
      id: string;
      role: string;
      content: string;
      created_at: string;
      raw_content: unknown;
    }>(
      `SELECT id, role, content, created_at, raw_content
       FROM messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [params.threadId],
    );

    const attachmentIds = new Set<string>();
    const attachmentIdsByMessage = new Map<string, string[]>();
    for (const message of messages.rows) {
      const ids = extractFileIdsFromRawContent(message.raw_content);
      attachmentIdsByMessage.set(message.id, ids);
      for (const id of ids) {
        attachmentIds.add(id);
      }
    }

    let filesById = new Map<string, StoredFileRow>();
    if (attachmentIds.size > 0) {
      const files = await pool.query<StoredFileRow>(
        `SELECT id, filename, mime_type
         FROM files
         WHERE user_id = $1
           AND id = ANY($2::uuid[])`,
        [user.id, Array.from(attachmentIds)],
      );

      filesById = new Map(files.rows.map((file) => [file.id, file]));
    }

    reply.send({
      data: messages.rows.map((message) => {
        const attachments = (attachmentIdsByMessage.get(message.id) ?? [])
          .map((fileId) => {
            const file = filesById.get(fileId);
            if (!file) {
              return null;
            }
            return {
              file_id: file.id,
              filename: file.filename,
              mime_type: file.mime_type,
              content_url: `/api/v1/files/${file.id}/content`,
            };
          })
          .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);

        return {
          id: message.id,
          role: message.role,
          content: message.content,
          created_at: message.created_at,
          attachments,
        };
      }),
    });
  });

  app.put('/me/model', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as { model?: unknown };
    const modelPublicId = normalizePublicModelId(body.model);

    if (body.model !== null && typeof body.model !== 'undefined' && !modelPublicId) {
      reply.code(400).send({ error: 'model must be a non-empty string or null' });
      return;
    }

    if (modelPublicId) {
      const model = await findCatalogModelByPublicId(modelPublicId, { includeDisabled: false });
      if (!model) {
        reply.code(400).send({ error: `Model "${modelPublicId}" is not published` });
        return;
      }
    }

    await pool.query(
      `UPDATE users
       SET default_model = $2,
           updated_at = now()
       WHERE id = $1`,
      [user.id, modelPublicId],
    );

    await writeAuditEvent({
      eventType: 'profile.default_model_updated',
      request,
      userId: user.id,
      metadata: { has_model: Boolean(modelPublicId) },
    });

    reply.send({ ok: true, default_model: modelPublicId });
  });

  app.get('/admin/providers', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const providers = await pool.query<
      ProviderRow & {
        has_secret: boolean;
        secret_updated_at: string | null;
      }
    >(
      `SELECT p.id,
              p.code,
              p.name,
              p.base_url,
              p.enabled,
              (ps.provider_id IS NOT NULL) AS has_secret,
              ps.updated_at AS secret_updated_at
       FROM providers p
       LEFT JOIN provider_secrets ps ON ps.provider_id = p.id
       ORDER BY p.id ASC`,
    );

    return {
      data: providers.rows.map((provider) => ({
        id: provider.id,
        code: provider.code,
        name: provider.name,
        base_url: provider.base_url,
        enabled: provider.enabled,
        has_secret: provider.has_secret,
        secret_updated_at: provider.secret_updated_at,
      })),
    };
  });

  app.post('/admin/providers', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as {
      code?: unknown;
      name?: unknown;
      base_url?: unknown;
      enabled?: unknown;
    };

    const code = normalizeProviderCode(body.code);
    if (!code) {
      reply.code(400).send({ error: 'code must be 1-64 chars: lowercase letters, numbers, "_" or "-"' });
      return;
    }

    const name = normalizeProviderName(body.name);
    if (!name) {
      reply.code(400).send({ error: 'name must be a non-empty string (max 120 chars)' });
      return;
    }

    if (typeof body.base_url !== 'string') {
      reply.code(400).send({ error: 'base_url must be a string' });
      return;
    }

    const normalizedBaseUrl = normalizeProviderBaseUrl(body.base_url);
    if (!normalizedBaseUrl) {
      reply.code(400).send({
        error: 'base_url must be a valid http(s) URL without query string or fragment',
      });
      return;
    }

    if (typeof body.enabled !== 'undefined' && typeof body.enabled !== 'boolean') {
      reply.code(400).send({ error: 'enabled must be a boolean' });
      return;
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

    let inserted: { rows: ProviderRow[]; rowCount: number | null };
    try {
      inserted = await pool.query<ProviderRow>(
        `INSERT INTO providers (code, name, base_url, enabled, updated_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id, code, name, base_url, enabled`,
        [code, name, normalizedBaseUrl, enabled],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        reply.code(409).send({ error: `Provider code "${code}" already exists` });
        return;
      }
      throw error;
    }

    const provider = inserted.rows[0]!;

    await writeAuditEvent({
      eventType: 'admin.providers.created',
      request,
      userId: user.id,
      metadata: { provider_id: provider.id, provider: provider.code, enabled: provider.enabled },
    });

    reply.code(201).send({
      data: {
        id: provider.id,
        code: provider.code,
        name: provider.name,
        base_url: provider.base_url,
        enabled: provider.enabled,
        has_secret: false,
        secret_updated_at: null,
      },
    });
  });

  app.patch('/admin/providers/:id', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as {
      code?: unknown;
      name?: unknown;
      base_url?: unknown;
      enabled?: unknown;
    };
    const id = Number(params.id);

    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400).send({ error: 'provider id must be a positive integer' });
      return;
    }

    const updates: string[] = [];
    const values: Array<string | number | boolean> = [id];
    const updatedFields: string[] = [];

    if (Object.prototype.hasOwnProperty.call(body, 'code')) {
      const code = normalizeProviderCode(body.code);
      if (!code) {
        reply
          .code(400)
          .send({ error: 'code must be 1-64 chars: lowercase letters, numbers, "_" or "-"' });
        return;
      }
      updates.push(`code = $${values.length + 1}`);
      values.push(code);
      updatedFields.push('code');
    }

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const name = normalizeProviderName(body.name);
      if (!name) {
        reply.code(400).send({ error: 'name must be a non-empty string (max 120 chars)' });
        return;
      }
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
      updatedFields.push('name');
    }

    if (Object.prototype.hasOwnProperty.call(body, 'base_url')) {
      if (typeof body.base_url !== 'string') {
        reply.code(400).send({ error: 'base_url must be a string' });
        return;
      }

      const normalizedBaseUrl = normalizeProviderBaseUrl(body.base_url);
      if (!normalizedBaseUrl) {
        reply.code(400).send({
          error: 'base_url must be a valid http(s) URL without query string or fragment',
        });
        return;
      }

      updates.push(`base_url = $${values.length + 1}`);
      values.push(normalizedBaseUrl);
      updatedFields.push('base_url');
    }

    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      if (typeof body.enabled !== 'boolean') {
        reply.code(400).send({ error: 'enabled must be a boolean' });
        return;
      }

      updates.push(`enabled = $${values.length + 1}`);
      values.push(body.enabled);
      updatedFields.push('enabled');
    }

    if (updates.length === 0) {
      reply.code(400).send({ error: 'At least one of code, name, base_url, enabled must be provided' });
      return;
    }

    updates.push('updated_at = now()');

    let updated: { rows: ProviderRow[]; rowCount: number | null };
    try {
      updated = await pool.query<ProviderRow>(
        `UPDATE providers
         SET ${updates.join(', ')}
         WHERE id = $1
         RETURNING id, code, name, base_url, enabled`,
        values,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        reply.code(409).send({ error: 'Provider code already exists' });
        return;
      }
      throw error;
    }

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'Provider not found' });
      return;
    }

    const provider = updated.rows[0]!;
    await writeAuditEvent({
      eventType: 'admin.providers.updated',
      request,
      userId: user.id,
      metadata: { provider_id: provider.id, provider: provider.code, updated_fields: updatedFields },
    });

    reply.send({
      data: {
        id: provider.id,
        code: provider.code,
        name: provider.name,
        base_url: provider.base_url,
        enabled: provider.enabled,
      },
    });
  });

  const saveProviderSecret = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.authUser!;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { api_key?: unknown; apiKey?: unknown };
    const id = Number(params.id);

    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400).send({ error: 'provider id must be a positive integer' });
      return;
    }

    const apiKeyValue =
      typeof body.api_key === 'string'
        ? body.api_key.trim()
        : typeof body.apiKey === 'string'
          ? body.apiKey.trim()
          : '';
    if (!apiKeyValue) {
      reply.code(400).send({ error: 'api_key is required' });
      return;
    }

    const provider = await getProviderById(id);
    if (!provider) {
      reply.code(404).send({ error: 'Provider not found' });
      return;
    }

    const encrypted = encryptApiKey(apiKeyValue);
    await pool.query(
      `INSERT INTO provider_secrets (provider_id, encrypted_api_key, iv, tag, key_version, updated_at)
       VALUES ($1, $2, $3, $4, 1, now())
       ON CONFLICT (provider_id) DO UPDATE
         SET encrypted_api_key = EXCLUDED.encrypted_api_key,
             iv = EXCLUDED.iv,
             tag = EXCLUDED.tag,
             key_version = provider_secrets.key_version + 1,
             updated_at = now()`,
      [provider.id, encrypted.encrypted, encrypted.iv, encrypted.authTag],
    );

    await writeAuditEvent({
      eventType: 'admin.providers.secret_updated',
      request,
      userId: user.id,
      metadata: { provider_id: provider.id, provider: provider.code },
    });

    reply.send({ ok: true });
  };

  app.post('/admin/providers/:id/secret', { preHandler: [requireAuth, requireAdmin] }, saveProviderSecret);
  app.put('/admin/providers/:id/secret', { preHandler: [requireAuth, requireAdmin] }, saveProviderSecret);

  app.post('/admin/models/import', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as { provider_id?: unknown };
    const providerId = toPositiveInteger(body.provider_id);

    if (!providerId) {
      reply.code(400).send({ error: 'provider_id is required and must be a positive integer' });
      return;
    }

    const provider = await getProviderById(providerId);
    if (!provider) {
      reply.code(404).send({ error: 'Provider not found' });
      return;
    }

    const apiKey = await getProviderSecret(provider.id);
    if (!apiKey) {
      reply.code(400).send({ error: `Provider secret is not configured for "${provider.code}"` });
      return;
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${provider.base_url}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (error) {
      reply.code(502).send({
        error: `Failed to reach upstream /models for "${provider.code}": ${
          error instanceof Error ? error.message : 'Unknown network error'
        }`,
      });
      return;
    }

    const upstreamText = await upstreamResponse.text();
    let upstreamPayload: unknown = null;
    if (upstreamText) {
      try {
        upstreamPayload = JSON.parse(upstreamText);
      } catch {
        upstreamPayload = null;
      }
    }

    if (!upstreamResponse.ok) {
      const fallback = `Upstream /models request failed with status ${upstreamResponse.status}`;
      const message = extractErrorMessage(upstreamPayload, fallback);
      reply.code(502).send({
        error: `Provider "${provider.code}" returned ${upstreamResponse.status}: ${message}`,
      });
      return;
    }

    if (!upstreamPayload) {
      reply.code(502).send({
        error: `Provider "${provider.code}" returned a non-JSON /models response.`,
      });
      return;
    }

    const importedModels = normalizeUpstreamModels(upstreamPayload);
    const existingModelsResult = await pool.query<{
      model_id: string;
      public_id: string;
      enabled: boolean;
    }>(
      `SELECT model_id, public_id, enabled
       FROM models
       WHERE provider_id = $1`,
      [provider.id],
    );
    const existingByModelId = new Map(
      existingModelsResult.rows.map((row) => [row.model_id, row]),
    );

    await writeAuditEvent({
      eventType: 'admin.models.imported',
      request,
      userId: user.id,
      metadata: {
        provider_id: provider.id,
        provider: provider.code,
        upstream_count: importedModels.length,
      },
    });

    reply.send({
      provider_id: provider.id,
      provider: provider.code,
      data: importedModels.map((model) => {
        const existing = existingByModelId.get(model.id);
        return {
          model_id: model.id,
          display_name: defaultDisplayNameForModelId(model.id),
          owned_by: model.owned_by ?? null,
          already_added: Boolean(existing),
          existing_public_id: existing?.public_id ?? null,
          existing_enabled: existing?.enabled ?? null,
        };
      }),
    });
  });

  app.get('/admin/models', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const models = await listCatalogModels({ includeDisabled: true });
    return {
      data: models.map((model) => ({
        id: model.id,
        provider_id: model.provider_id,
        provider: model.provider_code,
        model_id: model.model_id,
        public_id: model.public_id,
        display_name: model.display_name,
        enabled: model.enabled,
        created_at: model.created_at,
      })),
    };
  });

  app.post('/admin/models/bulk', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as {
      provider_id?: unknown;
      models?: unknown;
      model_ids?: unknown;
      enabled?: unknown;
    };

    const providerId = toPositiveInteger(body.provider_id);
    if (!providerId) {
      reply.code(400).send({ error: 'provider_id is required and must be a positive integer' });
      return;
    }

    const provider = await getProviderById(providerId);
    if (!provider) {
      reply.code(404).send({ error: 'Provider not found' });
      return;
    }

    const requestedEnabled = typeof body.enabled === 'boolean' ? body.enabled : true;
    const sourceItems = Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.model_ids)
        ? body.model_ids
        : null;

    if (!sourceItems) {
      reply.code(400).send({ error: 'models must be an array' });
      return;
    }

    const normalizedItems: Array<{
      model_id: string;
      public_id: string;
      display_name: string;
      enabled: boolean;
    }> = [];
    const seenModelIds = new Set<string>();

    for (const item of sourceItems) {
      if (typeof item === 'string') {
        const modelId = item.trim();
        if (!modelId || seenModelIds.has(modelId)) {
          continue;
        }

        seenModelIds.add(modelId);
        normalizedItems.push({
          model_id: modelId,
          public_id: modelId,
          display_name: defaultDisplayNameForModelId(modelId),
          enabled: requestedEnabled,
        });
        continue;
      }

      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const modelId = typeof record.model_id === 'string' ? record.model_id.trim() : '';
      if (!modelId || seenModelIds.has(modelId)) {
        continue;
      }

      const publicId = normalizePublicModelId(record.public_id) ?? modelId;
      const displayName =
        typeof record.display_name === 'string' && record.display_name.trim()
          ? record.display_name.trim()
          : defaultDisplayNameForModelId(modelId);
      const enabled = typeof record.enabled === 'boolean' ? record.enabled : requestedEnabled;

      seenModelIds.add(modelId);
      normalizedItems.push({
        model_id: modelId,
        public_id: publicId,
        display_name: displayName,
        enabled,
      });
    }

    if (normalizedItems.length === 0) {
      reply.code(400).send({ error: 'models must include at least one valid model_id' });
      return;
    }

    const createdRows: Array<{ id: number; model_id: string; public_id: string }> = [];

    for (const item of normalizedItems) {
      const publicId = await resolveUniquePublicId({
        desiredPublicId: item.public_id,
        providerCode: provider.code,
        modelId: item.model_id,
      });

      try {
        const created = await pool.query<{ id: number; model_id: string; public_id: string }>(
          `INSERT INTO models (provider_id, model_id, public_id, display_name, enabled)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider_id, model_id) DO NOTHING
           RETURNING id, model_id, public_id`,
          [provider.id, item.model_id, publicId, item.display_name, item.enabled],
        );
        if (created.rowCount) {
          createdRows.push(created.rows[0]!);
        }
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError.code !== '23505') {
          throw error;
        }
      }
    }

    await writeAuditEvent({
      eventType: 'admin.models.bulk_created',
      request,
      userId: user.id,
      metadata: {
        provider_id: provider.id,
        provider: provider.code,
        requested_count: normalizedItems.length,
        created_count: createdRows.length,
      },
    });

    reply.send({
      provider_id: provider.id,
      provider: provider.code,
      requested_count: normalizedItems.length,
      created_count: createdRows.length,
      created: createdRows,
    });
  });

  app.patch('/admin/models/:id', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as {
      display_name?: unknown;
      enabled?: unknown;
    };

    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400).send({ error: 'id must be a positive integer' });
      return;
    }

    const updateParts: string[] = [];
    const values: Array<string | boolean | number> = [id];

    if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      if (typeof body.display_name !== 'string' || !body.display_name.trim()) {
        reply.code(400).send({ error: 'display_name must be a non-empty string' });
        return;
      }
      updateParts.push(`display_name = $${values.length + 1}`);
      values.push(body.display_name.trim());
    }

    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      if (typeof body.enabled !== 'boolean') {
        reply.code(400).send({ error: 'enabled must be a boolean' });
        return;
      }
      updateParts.push(`enabled = $${values.length + 1}`);
      values.push(body.enabled);
    }

    if (updateParts.length === 0) {
      reply.code(400).send({ error: 'At least one of display_name or enabled is required' });
      return;
    }

    const updated = await pool.query<ModelCatalogRow>(
      `UPDATE models m
       SET ${updateParts.join(', ')}
       FROM providers p
       WHERE m.id = $1
         AND p.id = m.provider_id
       RETURNING m.id,
                 m.provider_id,
                 p.code AS provider_code,
                 p.base_url AS provider_base_url,
                 m.model_id,
                 m.public_id,
                 m.display_name,
                 m.enabled,
                 m.created_at`,
      values,
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'Model not found' });
      return;
    }

    const model = updated.rows[0]!;
    await writeAuditEvent({
      eventType: 'admin.models.updated',
      request,
      userId: user.id,
      metadata: {
        model_id: model.model_id,
        public_id: model.public_id,
        provider: model.provider_code,
      },
    });

    reply.send({
      data: {
        id: model.id,
        provider_id: model.provider_id,
        provider: model.provider_code,
        model_id: model.model_id,
        public_id: model.public_id,
        display_name: model.display_name,
        enabled: model.enabled,
        created_at: model.created_at,
      },
    });
  });

  app.delete('/admin/models/:id', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { id: string };

    const id = toPositiveInteger(params.id);
    if (!id) {
      reply.code(400).send({ error: 'id must be a positive integer' });
      return;
    }

    const deleted = await pool.query<{
      id: number;
      public_id: string;
      provider_code: string;
      model_id: string;
      display_name: string;
      enabled: boolean;
    }>(
      `DELETE FROM models m
       USING providers p
       WHERE m.id = $1
         AND p.id = m.provider_id
       RETURNING m.id,
                 m.public_id,
                 p.code AS provider_code,
                 m.model_id,
                 m.display_name,
                 m.enabled`,
      [id],
    );

    if (!deleted.rowCount) {
      reply.code(404).send({ error: 'Model not found' });
      return;
    }

    const model = deleted.rows[0]!;
    await writeAuditEvent({
      eventType: 'admin.models.deleted',
      request,
      userId: user.id,
      metadata: {
        id: model.id,
        model_id: model.model_id,
        public_id: model.public_id,
        provider: model.provider_code,
      },
    });

    reply.send({
      data: {
        id: model.id,
        public_id: model.public_id,
        provider_code: model.provider_code,
        model_id: model.model_id,
        display_name: model.display_name,
        enabled: model.enabled,
      },
    });
  });

  app.get('/admin/rate-limits', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const settings = await loadRateLimitSettings();
    return {
      data: {
        rpm_limit: settings.rpm_limit,
        tpm_limit: settings.tpm_limit,
        updated_at: settings.updated_at,
      },
    };
  });

  app.put('/admin/rate-limits', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as { rpm_limit?: unknown; tpm_limit?: unknown };

    const rpmLimit = toPositiveInteger(body.rpm_limit);
    const tpmLimit = toPositiveInteger(body.tpm_limit);

    if (!rpmLimit || !tpmLimit) {
      reply.code(400).send({ error: 'rpm_limit and tpm_limit must be positive integers' });
      return;
    }

    const updated = await pool.query<RateLimitSettings>(
      `INSERT INTO settings (id, rpm_limit, tpm_limit, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET rpm_limit = EXCLUDED.rpm_limit,
             tpm_limit = EXCLUDED.tpm_limit,
             updated_at = now()
       RETURNING rpm_limit, tpm_limit, updated_at`,
      [rpmLimit, tpmLimit],
    );

    const settings = updated.rows[0]!;
    rateLimitSettingsCache = {
      value: settings,
      expires_at: Date.now() + RATE_LIMIT_SETTINGS_CACHE_TTL_MS,
    };

    await writeAuditEvent({
      eventType: 'admin.rate_limits.updated',
      request,
      userId: user.id,
      metadata: {
        rpm_limit: settings.rpm_limit,
        tpm_limit: settings.tpm_limit,
      },
    });

    reply.send({
      data: {
        rpm_limit: settings.rpm_limit,
        tpm_limit: settings.tpm_limit,
        updated_at: settings.updated_at,
      },
    });
  });

  app.get('/admin/users', { preHandler: [requireAuth, requireAdmin] }, async (request) => {
    const user = request.authUser!;
    const queryParams = (request.query ?? {}) as { query?: unknown };
    const query = typeof queryParams.query === 'string' ? queryParams.query.trim() : '';

    const users = await pool.query<{
      id: string;
      email: string;
      status: string;
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
      anomaly_score: number | null;
      last_rule_hits: unknown;
      throttle_expires_at: string | null;
      throttle_rpm_limit: number | null;
      throttle_tpm_limit: number | null;
      admin_throttle_expires_at: string | null;
      admin_throttle_rpm_limit: number | null;
      admin_throttle_tpm_limit: number | null;
      last_action: string | null;
      last_action_at: string | null;
    }>(
      `SELECT u.id,
              u.email,
              u.status,
              u.ban_expires_at,
              u.deleted_at,
              u.deleted_reason,
              u.created_at,
              u.last_login_at,
              u.last_login_ip,
              u.last_seen_ip,
              u.last_seen_ua,
              u.last_seen_at,
              ul.rpm_limit AS rpm_override,
              ul.tpm_limit AS tpm_override,
              aus.anomaly_score,
              aus.last_rule_hits,
              aus.throttle_expires_at,
              aus.throttle_rpm_limit,
              aus.throttle_tpm_limit,
              aus.admin_throttle_expires_at,
              aus.admin_throttle_rpm_limit,
              aus.admin_throttle_tpm_limit,
              aus.last_action,
              aus.last_action_at
       FROM users u
       LEFT JOIN user_limits ul ON ul.user_id = u.id
       LEFT JOIN abuse_user_state aus ON aus.user_id = u.id
       WHERE ($1::text = '' OR u.email ILIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC
       LIMIT 200`,
      [query],
    );

    await writeAuditEvent({
      eventType: 'admin.users.listed',
      request,
      userId: user.id,
      metadata: {
        query: query || null,
        result_count: users.rows.length,
      },
    });

    const rows = await Promise.all(
      users.rows.map(async (entry) => {
        const status = parseUserStatus(entry.status) ?? 'active';
        const effectiveRateLimits = await loadEffectiveRateLimitsForUser(entry.id);
        return {
          id: entry.id,
          email: entry.email,
          status,
          ban_expires_at: entry.ban_expires_at,
          deleted_at: entry.deleted_at,
          deleted_reason: entry.deleted_reason,
          created_at: entry.created_at,
          last_login_at: entry.last_login_at,
          last_login_ip: entry.last_login_ip,
          last_seen_ip: entry.last_seen_ip,
          last_seen_ua: entry.last_seen_ua,
          last_seen_at: entry.last_seen_at,
          rpm_override: effectiveRateLimits.rpm_override,
          tpm_override: effectiveRateLimits.tpm_override,
          rpm_effective: effectiveRateLimits.rpm_effective,
          tpm_effective: effectiveRateLimits.tpm_effective,
          throttle_source: effectiveRateLimits.throttle_source,
          throttle_expires_at: effectiveRateLimits.throttle_expires_at,
          throttle_rpm_limit: effectiveRateLimits.throttle_rpm_limit,
          throttle_tpm_limit: effectiveRateLimits.throttle_tpm_limit,
          anomaly_score: entry.anomaly_score ?? 0,
          last_rule_hits: Array.isArray(entry.last_rule_hits) ? entry.last_rule_hits : [],
          last_action: entry.last_action,
          last_action_at: entry.last_action_at,
        };
      }),
    );

    return {
      data: rows,
    };
  });

  app.patch('/admin/users/:id', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: unknown };

    if (!uuidPattern.test(params.id)) {
      reply.code(400).send({ error: 'id must be a valid UUID' });
      return;
    }

    const status = parseUserStatus(body.status);
    if (!status) {
      reply.code(400).send({ error: 'status must be one of: active, banned' });
      return;
    }

    const existingUser = await pool.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM users
       WHERE id = $1`,
      [params.id],
    );

    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const previousStatus = parseUserStatus(existingUser.rows[0]!.status) ?? existingUser.rows[0]!.status;

    const updated = await pool.query<{
      id: string;
      email: string;
      status: string;
      created_at: string;
      last_login_at: string | null;
      last_login_ip: string | null;
      banned_at: string | null;
      ban_expires_at: string | null;
    }>(
      `UPDATE users
       SET status = $2,
           banned_at = CASE WHEN $2 = 'banned' THEN COALESCE(banned_at, now()) ELSE NULL END,
           ban_expires_at = NULL,
           deleted_at = CASE WHEN $2 = 'active' THEN NULL ELSE deleted_at END,
           deleted_reason = CASE WHEN $2 = 'active' THEN NULL ELSE deleted_reason END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, email, status, created_at, last_login_at, last_login_ip, banned_at, ban_expires_at`,
      [params.id, status],
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    if (status === 'active') {
      await pool.query(
        `INSERT INTO abuse_user_state (
           user_id,
           last_action,
           last_action_at,
           last_action_metadata,
           updated_at
         )
         VALUES ($1, 'admin.users.unbanned', now(), $2::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE
           SET last_action = EXCLUDED.last_action,
               last_action_at = now(),
               last_action_metadata = EXCLUDED.last_action_metadata,
               updated_at = now()`,
        [
          params.id,
          JSON.stringify({
            admin_user_id: admin.id,
            previous_status: previousStatus,
          }),
        ],
      );
    }

    await writeAuditEvent({
      eventType: 'admin.users.status_updated',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.id,
        previous_status: previousStatus,
        status,
      },
    });

    const target = updated.rows[0]!;
    reply.send({
      data: {
        id: target.id,
        email: target.email,
        status: parseUserStatus(target.status) ?? status,
        ban_expires_at: target.ban_expires_at,
        created_at: target.created_at,
        last_login_at: target.last_login_at,
        last_login_ip: target.last_login_ip,
      },
    });
  });

  app.post('/admin/users/:userId/delete', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { userId: string };

    if (!uuidPattern.test(params.userId)) {
      reply.code(400).send({ error: 'userId must be a valid UUID' });
      return;
    }

    if (params.userId === admin.id) {
      reply.code(400).send({ error: 'Cannot delete your own account' });
      return;
    }

    const existingUser = await pool.query<{
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
      deleted_reason: string | null;
    }>(
      `SELECT id, email, status, deleted_at, deleted_reason
       FROM users
       WHERE id = $1`,
      [params.userId],
    );

    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const previous = existingUser.rows[0]!;
    const previousStatus = parseUserStatus(previous.status) ?? previous.status;
    const updated = await pool.query<{
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
      deleted_reason: string | null;
      ban_expires_at: string | null;
    }>(
      `UPDATE users
       SET status = 'banned',
           banned_at = COALESCE(banned_at, now()),
           ban_expires_at = NULL,
           deleted_at = now(),
           deleted_reason = 'admin_delete',
           updated_at = now()
       WHERE id = $1
       RETURNING id, email, status, deleted_at, deleted_reason, ban_expires_at`,
      [params.userId],
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const revokedSessionCount = await revokeUserSessions(params.userId);
    await pool.query(
      `INSERT INTO abuse_user_state (
         user_id,
         last_action,
         last_action_at,
         last_action_metadata,
         updated_at
       )
       VALUES ($1, 'admin.users.deleted', now(), $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET last_action = EXCLUDED.last_action,
             last_action_at = now(),
             last_action_metadata = EXCLUDED.last_action_metadata,
             updated_at = now()`,
      [
        params.userId,
        JSON.stringify({
          admin_user_id: admin.id,
          previous_status: previousStatus,
          revoked_session_count: revokedSessionCount,
        }),
      ],
    );

    await writeAuditEvent({
      eventType: 'admin.users.deleted',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.userId,
        previous_status: previousStatus,
        previous_deleted_at: previous.deleted_at,
        revoked_session_count: revokedSessionCount,
      },
    });

    const target = updated.rows[0]!;
    reply.send({
      data: {
        id: target.id,
        email: target.email,
        status: parseUserStatus(target.status) ?? 'banned',
        deleted_at: target.deleted_at,
        deleted_reason: target.deleted_reason,
        revoked_session_count: revokedSessionCount,
      },
    });
  });

  app.post('/admin/users/:userId/restore', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { userId: string };

    if (!uuidPattern.test(params.userId)) {
      reply.code(400).send({ error: 'userId must be a valid UUID' });
      return;
    }

    const existingUser = await pool.query<{
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
    }>(
      `SELECT id, email, status, deleted_at
       FROM users
       WHERE id = $1`,
      [params.userId],
    );

    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const previous = existingUser.rows[0]!;
    const previousStatus = parseUserStatus(previous.status) ?? previous.status;
    const updated = await pool.query<{
      id: string;
      email: string;
      status: string;
      deleted_at: string | null;
      deleted_reason: string | null;
      ban_expires_at: string | null;
    }>(
      `UPDATE users
       SET status = 'active',
           banned_at = NULL,
           ban_expires_at = NULL,
           deleted_at = NULL,
           deleted_reason = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING id, email, status, deleted_at, deleted_reason, ban_expires_at`,
      [params.userId],
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    await pool.query(
      `INSERT INTO abuse_user_state (
         user_id,
         last_action,
         last_action_at,
         last_action_metadata,
         updated_at
       )
       VALUES ($1, 'admin.users.restored', now(), $2::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE
         SET last_action = EXCLUDED.last_action,
             last_action_at = now(),
             last_action_metadata = EXCLUDED.last_action_metadata,
             updated_at = now()`,
      [
        params.userId,
        JSON.stringify({
          admin_user_id: admin.id,
          previous_status: previousStatus,
          previous_deleted_at: previous.deleted_at,
        }),
      ],
    );

    await writeAuditEvent({
      eventType: 'admin.users.restored',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.userId,
        previous_status: previousStatus,
        previous_deleted_at: previous.deleted_at,
      },
    });

    const target = updated.rows[0]!;
    reply.send({
      data: {
        id: target.id,
        email: target.email,
        status: parseUserStatus(target.status) ?? 'active',
        deleted_at: target.deleted_at,
        deleted_reason: target.deleted_reason,
      },
    });
  });

  app.get('/admin/users/:userId/threads', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { userId: string };

    if (!uuidPattern.test(params.userId)) {
      reply.code(400).send({ error: 'userId must be a valid UUID' });
      return;
    }

    const existingUser = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [params.userId]);
    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const threads = await pool.query<{
      id: string;
      title: string;
      model: string | null;
      created_at: string;
      updated_at: string;
      msg_count: string;
    }>(
      `SELECT t.id,
              t.title,
              t.model,
              t.created_at,
              t.updated_at,
              COALESCE(COUNT(m.id), 0)::bigint::text AS msg_count
       FROM threads t
       LEFT JOIN messages m ON m.thread_id = t.id
       WHERE t.user_id = $1
       GROUP BY t.id, t.title, t.model, t.created_at, t.updated_at
       ORDER BY t.updated_at DESC
       LIMIT 200`,
      [params.userId],
    );

    await writeAuditEvent({
      eventType: 'admin.users.threads_viewed',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.userId,
        result_count: threads.rows.length,
      },
    });

    reply.send({
      data: threads.rows.map((thread) => ({
        id: thread.id,
        title: thread.title,
        model: thread.model,
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        msg_count: Number.parseInt(thread.msg_count, 10) || 0,
      })),
    });
  });

  app.get(
    '/admin/users/:userId/threads/:threadId/messages',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const admin = request.authUser!;
      const params = request.params as { userId: string; threadId: string };
      const queryParams = (request.query ?? {}) as { limit?: unknown; cursor?: unknown };
      const limit = Math.min(200, Math.max(1, toPositiveInteger(queryParams.limit) ?? 100));
      const cursor = parseMessageCursor(queryParams.cursor);

      if (!uuidPattern.test(params.userId)) {
        reply.code(400).send({ error: 'userId must be a valid UUID' });
        return;
      }

      if (!uuidPattern.test(params.threadId)) {
        reply.code(400).send({ error: 'threadId must be a valid UUID' });
        return;
      }

      if (cursor === 'invalid') {
        reply.code(400).send({ error: 'cursor must be a valid message cursor' });
        return;
      }

      const existingUser = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [params.userId]);
      if (!existingUser.rowCount) {
        reply.code(404).send({ error: 'User not found' });
        return;
      }

      const threadCheck = await pool.query<{ id: string }>(
        'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
        [params.threadId, params.userId],
      );
      if (!threadCheck.rowCount) {
        reply.code(404).send({ error: 'Thread not found' });
        return;
      }

      const messages = await pool.query<{
        id: string;
        role: string;
        content: string;
        created_at: string;
        raw_content: unknown;
      }>(
        `SELECT m.id, m.role, m.content, m.created_at, m.raw_content
         FROM messages m
         WHERE m.thread_id = $1
           AND m.user_id = $2
           AND (
             $3::timestamptz IS NULL
             OR m.created_at > $3::timestamptz
             OR (m.created_at = $3::timestamptz AND m.id > $4::uuid)
           )
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT $5`,
        [params.threadId, params.userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );

      const hasMore = messages.rows.length > limit;
      const pageRows = hasMore ? messages.rows.slice(0, limit) : messages.rows;
      const attachmentIds = new Set<string>();
      const attachmentIdsByMessage = new Map<string, string[]>();
      for (const message of pageRows) {
        const ids = extractFileIdsFromRawContent(message.raw_content);
        attachmentIdsByMessage.set(message.id, ids);
        for (const id of ids) {
          attachmentIds.add(id);
        }
      }

      let filesById = new Map<string, AttachmentFileRow>();
      if (attachmentIds.size > 0) {
        const files = await pool.query<AttachmentFileRow>(
          `SELECT id, filename, mime_type, size_bytes
           FROM files
           WHERE user_id = $1
             AND id = ANY($2::uuid[])`,
          [params.userId, Array.from(attachmentIds)],
        );
        filesById = new Map(files.rows.map((file) => [file.id, file]));
      }

      const items = pageRows.map((message) => {
        const attachments = (attachmentIdsByMessage.get(message.id) ?? [])
          .map((fileId) => {
            const file = filesById.get(fileId);
            if (!file) {
              return null;
            }

            return {
              file_id: file.id,
              filename: file.filename,
              mime_type: file.mime_type,
              size_bytes: file.size_bytes,
              content_url: `/api/admin/users/${params.userId}/files/${file.id}/content`,
            };
          })
          .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null);

        return {
          id: message.id,
          role: message.role,
          content: message.content,
          created_at: message.created_at,
          attachments,
        };
      });

      const nextCursor =
        hasMore && pageRows.length
          ? buildMessageCursor({
              createdAt: pageRows[pageRows.length - 1]!.created_at,
              id: pageRows[pageRows.length - 1]!.id,
            })
          : null;

      const attachmentCount = items.reduce((sum, item) => sum + item.attachments.length, 0);
      await writeAuditEvent({
        eventType: 'admin.users.messages_viewed',
        request,
        userId: admin.id,
        metadata: {
          target_user_id: params.userId,
          thread_id: params.threadId,
          limit,
          result_count: items.length,
          attachment_count: attachmentCount,
          has_more: hasMore,
        },
      });

      reply.send({
        data: items,
        paging: {
          limit,
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      });
    },
  );

  app.get(
    '/admin/users/:userId/files/:fileId/content',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const admin = request.authUser!;
      const params = request.params as { userId: string; fileId: string };

      if (!uuidPattern.test(params.userId)) {
        reply.code(400).send({ error: 'userId must be a valid UUID' });
        return;
      }

      if (!uuidPattern.test(params.fileId)) {
        reply.code(400).send({ error: 'fileId must be a valid UUID' });
        return;
      }

      const fileResult = await pool.query<UploadedFileRow>(
        `SELECT id, bucket, object_key, mime_type
         FROM files
         WHERE id = $1 AND user_id = $2`,
        [params.fileId, params.userId],
      );

      if (!fileResult.rowCount) {
        reply.code(404).send({ error: 'File not found' });
        return;
      }

      await writeAuditEvent({
        eventType: 'admin.users.file_viewed',
        request,
        userId: admin.id,
        metadata: {
          target_user_id: params.userId,
          file_id: params.fileId,
        },
      });

      const file = fileResult.rows[0]!;
      const stream = (await minio.getObject(file.bucket, file.object_key)) as Readable;

      reply.header('Content-Type', file.mime_type);
      reply.header('Cache-Control', 'private, max-age=300');
      reply.send(stream);
    },
  );

  app.put('/admin/users/:id/limits', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { rpm_limit?: unknown; tpm_limit?: unknown };

    if (!uuidPattern.test(params.id)) {
      reply.code(400).send({ error: 'id must be a valid UUID' });
      return;
    }

    const hasRpmLimit = Object.prototype.hasOwnProperty.call(body, 'rpm_limit');
    const hasTpmLimit = Object.prototype.hasOwnProperty.call(body, 'tpm_limit');
    if (!hasRpmLimit || !hasTpmLimit) {
      reply.code(400).send({ error: 'rpm_limit and tpm_limit are both required (number or null)' });
      return;
    }

    const rpmLimit = parseNullablePositiveInteger(body.rpm_limit);
    const tpmLimit = parseNullablePositiveInteger(body.tpm_limit);
    if (rpmLimit === 'invalid' || tpmLimit === 'invalid') {
      reply.code(400).send({ error: 'rpm_limit and tpm_limit must be positive integers or null' });
      return;
    }

    const existingUser = await pool.query<{ id: string }>(
      `SELECT id
       FROM users
       WHERE id = $1`,
      [params.id],
    );
    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    if (rpmLimit === null && tpmLimit === null) {
      await pool.query('DELETE FROM user_limits WHERE user_id = $1', [params.id]);
    } else {
      await pool.query(
        `INSERT INTO user_limits (user_id, rpm_limit, tpm_limit, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
           SET rpm_limit = EXCLUDED.rpm_limit,
               tpm_limit = EXCLUDED.tpm_limit,
               updated_at = now()`,
        [params.id, rpmLimit, tpmLimit],
      );
    }

    const settings = await loadRateLimitSettings();
    const rpmOverride = rpmLimit;
    const tpmOverride = tpmLimit;
    const rpmEffective = resolveEffectiveRateLimit(rpmOverride, settings.rpm_limit);
    const tpmEffective = resolveEffectiveRateLimit(tpmOverride, settings.tpm_limit);

    await writeAuditEvent({
      eventType: 'admin.users.limits_updated',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.id,
        rpm_limit: rpmOverride,
        tpm_limit: tpmOverride,
        rpm_effective: rpmEffective,
        tpm_effective: tpmEffective,
      },
    });

    reply.send({
      data: {
        user_id: params.id,
        rpm_override: rpmOverride,
        tpm_override: tpmOverride,
        rpm_effective: rpmEffective,
        tpm_effective: tpmEffective,
      },
    });
  });

  app.get('/admin/abuse/suspicious', { preHandler: [requireAuth, requireAdmin] }, async (request) => {
    const admin = request.authUser!;
    const queryParams = (request.query ?? {}) as { query?: unknown };
    const query = typeof queryParams.query === 'string' ? queryParams.query.trim() : '';

    const suspicious = await pool.query<{
      id: string;
      email: string;
      status: string;
      ban_expires_at: string | null;
      last_seen_ip: string | null;
      last_seen_ua: string | null;
      last_seen_at: string | null;
      anomaly_score: number | null;
      last_rule_hits: unknown;
      throttle_expires_at: string | null;
      throttle_rpm_limit: number | null;
      throttle_tpm_limit: number | null;
      admin_throttle_expires_at: string | null;
      admin_throttle_rpm_limit: number | null;
      admin_throttle_tpm_limit: number | null;
      last_action: string | null;
      last_action_at: string | null;
    }>(
      `SELECT u.id,
              u.email,
              u.status,
              u.ban_expires_at,
              u.last_seen_ip,
              u.last_seen_ua,
              u.last_seen_at,
              aus.anomaly_score,
              aus.last_rule_hits,
              aus.throttle_expires_at,
              aus.throttle_rpm_limit,
              aus.throttle_tpm_limit,
              aus.admin_throttle_expires_at,
              aus.admin_throttle_rpm_limit,
              aus.admin_throttle_tpm_limit,
              aus.last_action,
              aus.last_action_at
       FROM users u
       LEFT JOIN abuse_user_state aus ON aus.user_id = u.id
       WHERE ($1::text = '' OR u.email ILIKE '%' || $1 || '%')
         AND (
           COALESCE(aus.anomaly_score, 0) > 0
           OR (u.status = 'banned' AND (u.ban_expires_at IS NULL OR u.ban_expires_at > now()))
           OR (aus.throttle_expires_at IS NOT NULL AND aus.throttle_expires_at > now())
           OR (aus.admin_throttle_expires_at IS NOT NULL AND aus.admin_throttle_expires_at > now())
         )
       ORDER BY COALESCE(aus.anomaly_score, 0) DESC,
                COALESCE(aus.last_action_at, u.last_seen_at, u.created_at) DESC
       LIMIT 200`,
      [query],
    );

    await writeAuditEvent({
      eventType: 'admin.abuse.suspicious_listed',
      request,
      userId: admin.id,
      metadata: {
        query: query || null,
        result_count: suspicious.rows.length,
      },
    });

    const nowMs = Date.now();
    return {
      data: suspicious.rows.map((entry) => {
        let throttleSource: 'none' | 'auto' | 'admin' = 'none';
        let throttleExpiresAt: string | null = null;
        let throttleRpmLimit: number | null = null;
        let throttleTpmLimit: number | null = null;

        if (
          isFutureTimestamp(entry.admin_throttle_expires_at, nowMs) &&
          (entry.admin_throttle_rpm_limit !== null || entry.admin_throttle_tpm_limit !== null)
        ) {
          throttleSource = 'admin';
          throttleExpiresAt = entry.admin_throttle_expires_at;
          throttleRpmLimit = entry.admin_throttle_rpm_limit;
          throttleTpmLimit = entry.admin_throttle_tpm_limit;
        } else if (
          isFutureTimestamp(entry.throttle_expires_at, nowMs) &&
          (entry.throttle_rpm_limit !== null || entry.throttle_tpm_limit !== null)
        ) {
          throttleSource = 'auto';
          throttleExpiresAt = entry.throttle_expires_at;
          throttleRpmLimit = entry.throttle_rpm_limit;
          throttleTpmLimit = entry.throttle_tpm_limit;
        }

        return {
          id: entry.id,
          email: entry.email,
          status: parseUserStatus(entry.status) ?? 'active',
          ban_expires_at: entry.ban_expires_at,
          last_seen_ip: entry.last_seen_ip,
          last_seen_ua: entry.last_seen_ua,
          last_seen_at: entry.last_seen_at,
          anomaly_score: entry.anomaly_score ?? 0,
          last_rule_hits: Array.isArray(entry.last_rule_hits) ? entry.last_rule_hits : [],
          throttle_source: throttleSource,
          throttle_expires_at: throttleExpiresAt,
          throttle_rpm_limit: throttleRpmLimit,
          throttle_tpm_limit: throttleTpmLimit,
          last_action: entry.last_action,
          last_action_at: entry.last_action_at,
        };
      }),
    };
  });

  app.put(
    '/admin/users/:id/throttle-override',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const admin = request.authUser!;
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as {
        rpm_limit?: unknown;
        tpm_limit?: unknown;
        duration_minutes?: unknown;
      };

      if (!uuidPattern.test(params.id)) {
        reply.code(400).send({ error: 'id must be a valid UUID' });
        return;
      }

      const rpmLimit = toPositiveInteger(body.rpm_limit);
      const tpmLimit = toPositiveInteger(body.tpm_limit);
      const durationMinutes = toPositiveInteger(body.duration_minutes);
      if (!rpmLimit || !tpmLimit || !durationMinutes) {
        reply.code(400).send({
          error: 'rpm_limit, tpm_limit, and duration_minutes must be positive integers',
        });
        return;
      }

      const existingUser = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [params.id]);
      if (!existingUser.rowCount) {
        reply.code(404).send({ error: 'User not found' });
        return;
      }

      const updated = await pool.query<{ admin_throttle_expires_at: string }>(
        `INSERT INTO abuse_user_state (
           user_id,
           admin_throttle_expires_at,
           admin_throttle_rpm_limit,
           admin_throttle_tpm_limit,
           last_action,
           last_action_at,
           last_action_metadata,
           updated_at
         )
         VALUES (
           $1,
           now() + ($2::integer * interval '1 minute'),
           $3,
           $4,
           'admin.users.throttle_override_set',
           now(),
           $5::jsonb,
           now()
         )
         ON CONFLICT (user_id) DO UPDATE
           SET admin_throttle_expires_at = now() + ($2::integer * interval '1 minute'),
               admin_throttle_rpm_limit = EXCLUDED.admin_throttle_rpm_limit,
               admin_throttle_tpm_limit = EXCLUDED.admin_throttle_tpm_limit,
               last_action = EXCLUDED.last_action,
               last_action_at = now(),
               last_action_metadata = EXCLUDED.last_action_metadata,
               updated_at = now()
         RETURNING admin_throttle_expires_at`,
        [
          params.id,
          durationMinutes,
          rpmLimit,
          tpmLimit,
          JSON.stringify({
            admin_user_id: admin.id,
            duration_minutes: durationMinutes,
            rpm_limit: rpmLimit,
            tpm_limit: tpmLimit,
          }),
        ],
      );

      const throttleExpiresAt = updated.rows[0]?.admin_throttle_expires_at ?? null;
      await writeAuditEvent({
        eventType: 'admin.users.throttle_override_set',
        request,
        userId: admin.id,
        metadata: {
          target_user_id: params.id,
          rpm_limit: rpmLimit,
          tpm_limit: tpmLimit,
          duration_minutes: durationMinutes,
          throttle_expires_at: throttleExpiresAt,
        },
      });

      reply.send({
        data: {
          user_id: params.id,
          throttle_source: 'admin',
          throttle_expires_at: throttleExpiresAt,
          throttle_rpm_limit: rpmLimit,
          throttle_tpm_limit: tpmLimit,
        },
      });
    },
  );

  app.delete(
    '/admin/users/:id/throttle-override',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const admin = request.authUser!;
      const params = request.params as { id: string };

      if (!uuidPattern.test(params.id)) {
        reply.code(400).send({ error: 'id must be a valid UUID' });
        return;
      }

      const existingUser = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [params.id]);
      if (!existingUser.rowCount) {
        reply.code(404).send({ error: 'User not found' });
        return;
      }

      await pool.query(
        `INSERT INTO abuse_user_state (
           user_id,
           admin_throttle_expires_at,
           admin_throttle_rpm_limit,
           admin_throttle_tpm_limit,
           last_action,
           last_action_at,
           last_action_metadata,
           updated_at
         )
         VALUES (
           $1,
           NULL,
           NULL,
           NULL,
           'admin.users.throttle_override_cleared',
           now(),
           $2::jsonb,
           now()
         )
         ON CONFLICT (user_id) DO UPDATE
           SET admin_throttle_expires_at = NULL,
               admin_throttle_rpm_limit = NULL,
               admin_throttle_tpm_limit = NULL,
               last_action = EXCLUDED.last_action,
               last_action_at = now(),
               last_action_metadata = EXCLUDED.last_action_metadata,
               updated_at = now()`,
        [
          params.id,
          JSON.stringify({
            admin_user_id: admin.id,
          }),
        ],
      );

      await writeAuditEvent({
        eventType: 'admin.users.throttle_override_cleared',
        request,
        userId: admin.id,
        metadata: {
          target_user_id: params.id,
        },
      });

      reply.send({
        data: {
          user_id: params.id,
          throttle_source: 'none',
          throttle_expires_at: null,
        },
      });
    },
  );

  app.get('/admin/users/:id/abuse-events', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const admin = request.authUser!;
    const params = request.params as { id: string };
    const queryParams = (request.query ?? {}) as { limit?: unknown };
    const limitCandidate = toPositiveInteger(queryParams.limit);
    const limit = Math.min(200, Math.max(1, limitCandidate ?? 40));

    if (!uuidPattern.test(params.id)) {
      reply.code(400).send({ error: 'id must be a valid UUID' });
      return;
    }

    const existingUser = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [params.id]);
    if (!existingUser.rowCount) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const events = await pool.query<{
      id: string;
      event_type: string;
      ip: string | null;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT id::text, event_type, ip, metadata, created_at
       FROM audit_events
       WHERE user_id = $1
         AND (
           event_type LIKE 'abuse.%'
           OR event_type LIKE 'auth.%'
           OR event_type LIKE 'upstream.%'
           OR event_type = 'security.origin_blocked'
           OR event_type LIKE 'admin.users.%'
         )
       ORDER BY created_at DESC
       LIMIT $2`,
      [params.id, limit],
    );

    await writeAuditEvent({
      eventType: 'admin.users.abuse_events_viewed',
      request,
      userId: admin.id,
      metadata: {
        target_user_id: params.id,
        limit,
        result_count: events.rows.length,
      },
    });

    reply.send({
      data: events.rows.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        ip: event.ip,
        metadata: event.metadata ?? {},
        created_at: event.created_at,
      })),
    });
  });

  app.get('/v1/models', { preHandler: [requireAuth, v1RateLimit] }, async (_request, reply) => {
    const models = await listCatalogModels({ includeDisabled: false });
    reply.send({
      object: 'list',
      data: models.map((entry) => ({
        id: entry.public_id,
        object: 'model',
        display_name: entry.display_name,
      })),
    });
  });

  app.post('/v1/files', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const user = request.authUser!;
    const file = await request.file();

    if (!file) {
      reply.code(400).send({ error: 'No file provided' });
      return;
    }

    if (!file.mimetype.startsWith('image/')) {
      reply.code(400).send({ error: 'Only image uploads are supported' });
      return;
    }

    const buffer = await file.toBuffer();
    const objectKey = `${user.id}/${crypto.randomUUID()}-${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    await minio.putObject(config.minioBucket, objectKey, buffer, buffer.length, {
      'Content-Type': file.mimetype,
    });

    const insert = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO files (user_id, bucket, object_key, filename, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [user.id, config.minioBucket, objectKey, file.filename, file.mimetype, buffer.length],
    );

    const record = insert.rows[0]!;

    await writeAuditEvent({
      eventType: 'files.uploaded',
      request,
      userId: user.id,
      metadata: {
        mime_type: file.mimetype,
        size_bytes: buffer.length,
      },
    });

    reply.send({
      id: record.id,
      object: 'file',
      bytes: buffer.length,
      created_at: Math.floor(new Date(record.created_at).getTime() / 1000),
      filename: file.filename,
      purpose: 'vision',
    });
  });

  app.get('/v1/files/:fileId/content', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const user = request.authUser!;
    const params = request.params as { fileId: string };

    const fileResult = await pool.query<UploadedFileRow>(
      `SELECT id, bucket, object_key, mime_type
       FROM files
       WHERE id = $1 AND user_id = $2`,
      [params.fileId, user.id],
    );

    if (!fileResult.rowCount) {
      reply.code(404).send({ error: 'File not found' });
      return;
    }

    const file = fileResult.rows[0]!;
    const stream = (await minio.getObject(file.bucket, file.object_key)) as Readable;

    reply.header('Content-Type', file.mime_type);
    reply.header('Cache-Control', 'private, max-age=300');
    reply.send(stream);
  });

  app.post('/v1/responses', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const user = request.authUser!;
    const requestBody = { ...((request.body ?? {}) as Record<string, unknown>) };

    const threadId =
      typeof requestBody.thread_id === 'string'
        ? (requestBody.thread_id as string)
        : typeof requestBody.threadId === 'string'
          ? (requestBody.threadId as string)
          : undefined;

    if (Object.prototype.hasOwnProperty.call(requestBody, 'provider')) {
      reply.code(400).send({ error: 'provider override is not supported. Use model public_id only.' });
      return;
    }

    delete requestBody.thread_id;
    delete requestBody.threadId;

    let selectedModel: ModelCatalogRow;
    try {
      selectedModel = await resolveModelForRequest({
        user,
        requestedPublicModelId: normalizePublicModelId(requestBody.model) ?? undefined,
      });
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid model selection' });
      return;
    }

    const apiKey = await getProviderSecret(selectedModel.provider_id);
    if (!apiKey) {
      reply.code(503).send({
        error: `Provider "${selectedModel.provider_code}" is missing a configured platform API key`,
      });
      return;
    }

    const currentInput = requestBody.input;
    const inputTokenEstimate = estimateTokensFromUnknown(currentInput);
    const effectiveRateLimits =
      request.effectiveRateLimits ?? (await loadEffectiveRateLimitsForUser(user.id));
    const tpmReservation = await reserveTpmUsage({
      userId: user.id,
      tokens: inputTokenEstimate,
      limit: effectiveRateLimits.tpm_effective,
    });
    if (!tpmReservation.allowed) {
      await incrementAbuseCounters(user.id, [{ dimension: 'request_429', value: 1 }]);
      await evaluateUserAbuseAndMaybeAct({
        request,
        user,
        currentIp: getClientIp(request),
        currentUa: getClientUserAgent(request),
      });
      reply.code(429).send({ error: 'Rate limit exceeded (TPM)' });
      return;
    }

    requestBody.model = selectedModel.model_id;

    const hydratedCurrentInput = await hydrateResponsesInput(currentInput, user.id);
    const userPrompt = extractTextFromResponsesInput(hydratedCurrentInput);
    const effectiveModel = selectedModel.public_id;

    const targetThreadId = await getOrCreateThread({
      userId: user.id,
      threadId,
      providerId: selectedModel.provider_id,
      model: effectiveModel,
    });

    const threadContext = await loadRecentThreadContextMessages({
      threadId: targetThreadId,
      userId: user.id,
    });
    const responseHistoryInput = buildResponsesHistoryInputFromThreadMessages(threadContext.messages);
    const contextMessagesUsed = responseHistoryInput.length;

    requestBody.input =
      contextMessagesUsed > 0
        ? [...responseHistoryInput, ...normalizeResponsesInputForPrepend(hydratedCurrentInput)]
        : hydratedCurrentInput;
    reply.header('X-Context-Messages-Used', String(contextMessagesUsed));

    app.log.debug(
      {
        endpoint: '/responses',
        userId: user.id,
        threadId: targetThreadId,
        historyItemsUsed: contextMessagesUsed,
        historyTokensEstimate: threadContext.tokenEstimate,
      },
      'Injected thread context into upstream request',
    );
    // Manual smoke test:
    // 1) New thread, send message 1: request succeeds.
    // 2) Same thread, send message 2: request succeeds (no 400 invalid content-part type).

    await persistMessage({
      threadId: targetThreadId,
      userId: user.id,
      role: 'user',
      content: userPrompt || '[non-text input]',
      rawContent: hydratedCurrentInput,
    });

    await maybeAutoRenameThread({
      threadId: targetThreadId,
      userId: user.id,
      sourceText: userPrompt,
    });

    const stream = requestBody.stream === true;
    let streamLease: StreamLease | null = null;
    if (stream) {
      const leaseResult = await acquireUserStreamLease(user.id);
      if (!leaseResult.allowed) {
        await incrementAbuseCounters(user.id, [
          { dimension: 'stream_concurrency_rejected', value: 1 },
          { dimension: 'request_429', value: 1 },
        ]);
        await writeAuditEvent({
          eventType: 'abuse.stream_concurrency_blocked',
          request,
          userId: user.id,
          metadata: {
            endpoint: '/responses',
            active_streams: leaseResult.active,
            stream_limit: config.abuseStreamConcurrencyLimit,
          },
        });
        await evaluateUserAbuseAndMaybeAct({
          request,
          user,
          currentIp: getClientIp(request),
          currentUa: getClientUserAgent(request),
        });
        reply.code(429).send({ error: 'Too many concurrent streams for this user' });
        return;
      }

      streamLease = leaseResult.lease;
      await incrementAbuseCounters(user.id, [{ dimension: 'stream_started', value: 1 }]);
    }

    try {
      const started = Date.now();

      await writeAuditEvent({
        eventType: 'upstream.request',
        request,
        userId: user.id,
        metadata: {
          endpoint: '/responses',
          provider: selectedModel.provider_code,
          stream,
          has_model: Boolean(effectiveModel),
          history_items_used: contextMessagesUsed,
          history_tokens_estimate: threadContext.tokenEstimate,
        },
      });

      const upstream = await fetch(`${selectedModel.provider_base_url}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      await writeAuditEvent({
        eventType: 'upstream.response',
        request,
        userId: user.id,
        metadata: {
          endpoint: '/responses',
          provider: selectedModel.provider_code,
          status: upstream.status,
          duration_ms: Date.now() - started,
          stream,
        },
      });

      if (!upstream.ok) {
        const errorCounters =
          upstream.status === 429
            ? [
                { dimension: 'request_error', value: 1 },
                { dimension: 'request_429', value: 1 },
              ]
            : [{ dimension: 'request_error', value: 1 }];
        await incrementAbuseCounters(user.id, errorCounters);
        await evaluateUserAbuseAndMaybeAct({
          request,
          user,
          currentIp: getClientIp(request),
          currentUa: getClientUserAgent(request),
        });

        const upstreamText = await upstream.text();
        let parsed: unknown = { error: { message: upstreamText } };
        try {
          parsed = JSON.parse(upstreamText);
        } catch {
          parsed = { error: { message: upstreamText } };
        }

        reply.code(upstream.status).send(parsed);
        return;
      }

      if (stream) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          await incrementAbuseCounters(user.id, [{ dimension: 'request_error', value: 1 }]);
          reply.code(502).send({ error: 'Upstream stream body missing' });
          return;
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Thread-Id': targetThreadId,
          'X-Context-Messages-Used': String(contextMessagesUsed),
        });

        let parserBuffer = '';
        let assistantText = '';
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          reply.raw.write(chunk);

          parserBuffer += chunk;
          const parsed = parseSseAssistantDelta({ streamKind: 'responses', buffer: parserBuffer });
          parserBuffer = parsed.remaining;
          assistantText += parsed.assistantDelta;
        }

        const tail = decoder.decode();
        if (tail) {
          parserBuffer += tail;
        }

        const parsedTail = parseSseAssistantDelta({ streamKind: 'responses', buffer: parserBuffer });
        assistantText += parsedTail.assistantDelta;

        await persistMessage({
          threadId: targetThreadId,
          userId: user.id,
          role: 'assistant',
          content: assistantText || '[streamed response]',
        });

        await maybeAutoRenameThread({
          threadId: targetThreadId,
          userId: user.id,
          sourceText: assistantText,
        });

        await addTpmUsageEvent(user.id, estimateTokensFromText(assistantText));

        reply.raw.end();
        return;
      }

      const payload = (await upstream.json()) as Record<string, unknown>;
      const assistantText = extractAssistantTextFromResponses(payload);

      await persistMessage({
        threadId: targetThreadId,
        userId: user.id,
        role: 'assistant',
        content: assistantText || '[empty response]',
        rawContent: payload,
      });

      await maybeAutoRenameThread({
        threadId: targetThreadId,
        userId: user.id,
        sourceText: assistantText,
      });

      const usageTotalTokens = extractUsageTotalTokens(payload);
      if (usageTotalTokens !== null) {
        await addTpmUsageEvent(user.id, Math.max(0, usageTotalTokens - inputTokenEstimate));
      } else {
        await addTpmUsageEvent(user.id, estimateTokensFromText(assistantText));
      }

      reply.header('X-Thread-Id', targetThreadId);
      reply.header('X-Context-Messages-Used', String(contextMessagesUsed));
      reply.send(payload);
    } finally {
      await releaseUserStreamLease(streamLease);
    }
  });

  app.post('/v1/chat/completions', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const user = request.authUser!;
    const requestBody = { ...((request.body ?? {}) as Record<string, unknown>) };

    const threadId =
      typeof requestBody.thread_id === 'string'
        ? (requestBody.thread_id as string)
        : typeof requestBody.threadId === 'string'
          ? (requestBody.threadId as string)
          : undefined;

    if (Object.prototype.hasOwnProperty.call(requestBody, 'provider')) {
      reply.code(400).send({ error: 'provider override is not supported. Use model public_id only.' });
      return;
    }

    delete requestBody.thread_id;
    delete requestBody.threadId;

    let selectedModel: ModelCatalogRow;
    try {
      selectedModel = await resolveModelForRequest({
        user,
        requestedPublicModelId: normalizePublicModelId(requestBody.model) ?? undefined,
      });
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid model selection' });
      return;
    }

    const apiKey = await getProviderSecret(selectedModel.provider_id);
    if (!apiKey) {
      reply.code(503).send({
        error: `Provider "${selectedModel.provider_code}" is missing a configured platform API key`,
      });
      return;
    }

    const currentMessages = requestBody.messages;
    const inputTokenEstimate = estimateTokensFromUnknown(currentMessages);
    const effectiveRateLimits =
      request.effectiveRateLimits ?? (await loadEffectiveRateLimitsForUser(user.id));
    const tpmReservation = await reserveTpmUsage({
      userId: user.id,
      tokens: inputTokenEstimate,
      limit: effectiveRateLimits.tpm_effective,
    });
    if (!tpmReservation.allowed) {
      await incrementAbuseCounters(user.id, [{ dimension: 'request_429', value: 1 }]);
      await evaluateUserAbuseAndMaybeAct({
        request,
        user,
        currentIp: getClientIp(request),
        currentUa: getClientUserAgent(request),
      });
      reply.code(429).send({ error: 'Rate limit exceeded (TPM)' });
      return;
    }

    requestBody.model = selectedModel.model_id;

    const hydratedCurrentMessages = await hydrateChatMessages(currentMessages, user.id);
    const userPrompt = extractTextFromChatMessages(hydratedCurrentMessages);
    const effectiveModel = selectedModel.public_id;

    const targetThreadId = await getOrCreateThread({
      userId: user.id,
      threadId,
      providerId: selectedModel.provider_id,
      model: effectiveModel,
    });

    const threadContext = await loadRecentThreadContextMessages({
      threadId: targetThreadId,
      userId: user.id,
    });
    const chatHistoryMessages = buildChatHistoryMessagesFromThreadMessages(threadContext.messages);
    const canPrependContext = Array.isArray(hydratedCurrentMessages);
    const contextMessagesUsed = canPrependContext ? chatHistoryMessages.length : 0;

    if (canPrependContext && contextMessagesUsed > 0) {
      requestBody.messages = [...chatHistoryMessages, ...hydratedCurrentMessages];
    } else {
      requestBody.messages = hydratedCurrentMessages;
    }
    reply.header('X-Context-Messages-Used', String(contextMessagesUsed));

    app.log.debug(
      {
        endpoint: '/chat/completions',
        userId: user.id,
        threadId: targetThreadId,
        historyItemsUsed: contextMessagesUsed,
        historyTokensEstimate: threadContext.tokenEstimate,
      },
      'Injected thread context into upstream request',
    );

    await persistMessage({
      threadId: targetThreadId,
      userId: user.id,
      role: 'user',
      content: userPrompt || '[non-text input]',
      rawContent: hydratedCurrentMessages,
    });

    await maybeAutoRenameThread({
      threadId: targetThreadId,
      userId: user.id,
      sourceText: userPrompt,
    });

    const stream = requestBody.stream === true;
    let streamLease: StreamLease | null = null;
    if (stream) {
      const leaseResult = await acquireUserStreamLease(user.id);
      if (!leaseResult.allowed) {
        await incrementAbuseCounters(user.id, [
          { dimension: 'stream_concurrency_rejected', value: 1 },
          { dimension: 'request_429', value: 1 },
        ]);
        await writeAuditEvent({
          eventType: 'abuse.stream_concurrency_blocked',
          request,
          userId: user.id,
          metadata: {
            endpoint: '/chat/completions',
            active_streams: leaseResult.active,
            stream_limit: config.abuseStreamConcurrencyLimit,
          },
        });
        await evaluateUserAbuseAndMaybeAct({
          request,
          user,
          currentIp: getClientIp(request),
          currentUa: getClientUserAgent(request),
        });
        reply.code(429).send({ error: 'Too many concurrent streams for this user' });
        return;
      }

      streamLease = leaseResult.lease;
      await incrementAbuseCounters(user.id, [{ dimension: 'stream_started', value: 1 }]);
    }

    try {
      const started = Date.now();

      await writeAuditEvent({
        eventType: 'upstream.request',
        request,
        userId: user.id,
        metadata: {
          endpoint: '/chat/completions',
          provider: selectedModel.provider_code,
          stream,
          has_model: Boolean(effectiveModel),
          history_items_used: contextMessagesUsed,
          history_tokens_estimate: threadContext.tokenEstimate,
        },
      });

      const upstream = await fetch(`${selectedModel.provider_base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      await writeAuditEvent({
        eventType: 'upstream.response',
        request,
        userId: user.id,
        metadata: {
          endpoint: '/chat/completions',
          provider: selectedModel.provider_code,
          status: upstream.status,
          duration_ms: Date.now() - started,
          stream,
        },
      });

      if (!upstream.ok) {
        const errorCounters =
          upstream.status === 429
            ? [
                { dimension: 'request_error', value: 1 },
                { dimension: 'request_429', value: 1 },
              ]
            : [{ dimension: 'request_error', value: 1 }];
        await incrementAbuseCounters(user.id, errorCounters);
        await evaluateUserAbuseAndMaybeAct({
          request,
          user,
          currentIp: getClientIp(request),
          currentUa: getClientUserAgent(request),
        });

        const upstreamText = await upstream.text();
        let parsed: unknown = { error: { message: upstreamText } };
        try {
          parsed = JSON.parse(upstreamText);
        } catch {
          parsed = { error: { message: upstreamText } };
        }

        reply.code(upstream.status).send(parsed);
        return;
      }

      if (stream) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          await incrementAbuseCounters(user.id, [{ dimension: 'request_error', value: 1 }]);
          reply.code(502).send({ error: 'Upstream stream body missing' });
          return;
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Thread-Id': targetThreadId,
          'X-Context-Messages-Used': String(contextMessagesUsed),
        });

        let parserBuffer = '';
        let assistantText = '';
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          reply.raw.write(chunk);

          parserBuffer += chunk;
          const parsed = parseSseAssistantDelta({ streamKind: 'chat', buffer: parserBuffer });
          parserBuffer = parsed.remaining;
          assistantText += parsed.assistantDelta;
        }

        const tail = decoder.decode();
        if (tail) {
          parserBuffer += tail;
        }

        const parsedTail = parseSseAssistantDelta({ streamKind: 'chat', buffer: parserBuffer });
        assistantText += parsedTail.assistantDelta;

        await persistMessage({
          threadId: targetThreadId,
          userId: user.id,
          role: 'assistant',
          content: assistantText || '[streamed response]',
        });

        await maybeAutoRenameThread({
          threadId: targetThreadId,
          userId: user.id,
          sourceText: assistantText,
        });

        await addTpmUsageEvent(user.id, estimateTokensFromText(assistantText));

        reply.raw.end();
        return;
      }

      const payload = (await upstream.json()) as Record<string, unknown>;
      const assistantText = extractAssistantTextFromChatCompletions(payload);

      await persistMessage({
        threadId: targetThreadId,
        userId: user.id,
        role: 'assistant',
        content: assistantText || '[empty response]',
        rawContent: payload,
      });

      await maybeAutoRenameThread({
        threadId: targetThreadId,
        userId: user.id,
        sourceText: assistantText,
      });

      const usageTotalTokens = extractUsageTotalTokens(payload);
      if (usageTotalTokens !== null) {
        await addTpmUsageEvent(user.id, Math.max(0, usageTotalTokens - inputTokenEstimate));
      } else {
        await addTpmUsageEvent(user.id, estimateTokensFromText(assistantText));
      }

      reply.header('X-Thread-Id', targetThreadId);
      reply.header('X-Context-Messages-Used', String(contextMessagesUsed));
      reply.send(payload);
    } finally {
      await releaseUserStreamLease(streamLease);
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    app.log.error({ err: error, url: request.url }, 'Unhandled error');

    if (request.authUser) {
      try {
        await incrementAbuseCounters(request.authUser.id, [{ dimension: 'request_error', value: 1 }]);
        await evaluateUserAbuseAndMaybeAct({
          request,
          user: request.authUser,
          currentIp: getClientIp(request),
          currentUa: getClientUserAgent(request),
        });
      } catch (abuseError) {
        app.log.warn({ err: abuseError, userId: request.authUser.id }, 'Failed to record abuse error');
      }
    }

    if (!reply.sent) {
      reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

async function start(): Promise<void> {
  await runMigrations(pool);
  await ensureBucketExists();
  await setupServer();
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ port: config.port }, 'Gateway started');
}

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
  await redis.quit();
}

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

start().catch((error) => {
  app.log.error(error, 'Failed to start gateway');
  process.exit(1);
});
