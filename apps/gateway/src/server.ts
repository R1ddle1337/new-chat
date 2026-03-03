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

type DbUser = {
  id: string;
  email: string;
  is_admin: boolean;
  default_provider_id: number | null;
  default_model: string | null;
};

type ProviderRow = {
  id: number;
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
};

type UserProviderKeyRow = {
  provider_id: number;
  code: string;
  base_url: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
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

type AllowedModelRow = {
  id: number;
  provider_id: number;
  provider_code: string;
  model_id: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
};

type UpstreamModelItem = {
  id: string;
  owned_by?: string;
  raw?: Record<string, unknown>;
};

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: DbUser;
    sessionId?: string;
  }
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
  v1RateLimitPerMinute: Number(process.env.V1_RATE_LIMIT_PER_MIN ?? 120),
  minioEndpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  minioPort: Number(process.env.MINIO_PORT ?? 9000),
  minioUseSsl: process.env.MINIO_USE_SSL === 'true',
  minioAccessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  minioSecretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  minioBucket: process.env.MINIO_BUCKET ?? 'uploads',
  keyEncryptionKey: process.env.KEY_ENCRYPTION_KEY ?? '',
  secureCookies: process.env.SECURE_COOKIES === 'true',
  adminEmail: (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase(),
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

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RAW_CONTENT_JSON_BYTES = 200 * 1024;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isConfiguredAdminEmail(email: string): boolean {
  return Boolean(config.adminEmail) && normalizeEmail(email) === config.adminEmail;
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

function maskApiKey(value: string): string {
  if (value.length <= 8) {
    return '********';
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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

async function checkRateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }
  return current <= max;
}

async function authRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = (request.body ?? {}) as { email?: unknown };
  const email = typeof body.email === 'string' ? body.email.toLowerCase() : 'unknown';
  const key = `ratelimit:auth:${getClientIp(request)}:${email}`;
  const allowed = await checkRateLimit(key, config.authRateLimitPerMinute, 60);
  if (!allowed) {
    reply.code(429).send({ error: 'Too many authentication attempts' });
  }
}

async function v1RateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.authUser) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const key = `ratelimit:v1:${getClientIp(request)}:${request.authUser.id}`;
  const allowed = await checkRateLimit(key, config.v1RateLimitPerMinute, 60);
  if (!allowed) {
    reply.code(429).send({ error: 'Too many requests' });
  }
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

async function getUserById(userId: string): Promise<DbUser | null> {
  const result = await pool.query<DbUser>(
    'SELECT id, email, is_admin, default_provider_id, default_model FROM users WHERE id = $1',
    [userId],
  );
  return result.rowCount ? result.rows[0]! : null;
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

async function getDefaultProviderForUser(): Promise<ProviderRow | null> {
  const openai = await getProviderByCode('openai');
  if (openai && openai.enabled) {
    return openai;
  }

  const result = await pool.query<ProviderRow>(
    `SELECT id, code, name, base_url, enabled
     FROM providers
     WHERE enabled = true
     ORDER BY id ASC
     LIMIT 1`,
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function listAllowedModels(params?: {
  includeDisabled?: boolean;
}): Promise<AllowedModelRow[]> {
  const includeDisabled = params?.includeDisabled ?? false;
  const result = await pool.query<AllowedModelRow>(
    `SELECT am.id,
            am.provider_id,
            p.code AS provider_code,
            am.model_id,
            am.display_name,
            am.enabled,
            am.created_at
     FROM allowed_models am
     JOIN providers p ON p.id = am.provider_id
     WHERE ($1::boolean = true OR (am.enabled = true AND p.enabled = true))
     ORDER BY p.code ASC, am.model_id ASC`,
    [includeDisabled],
  );
  return result.rows;
}

async function findAllowedModel(providerId: number, modelId: string): Promise<AllowedModelRow | null> {
  const normalizedModel = modelId.trim();
  if (!normalizedModel) {
    return null;
  }

  const result = await pool.query<AllowedModelRow>(
    `SELECT am.id,
            am.provider_id,
            p.code AS provider_code,
            am.model_id,
            am.display_name,
            am.enabled,
            am.created_at
     FROM allowed_models am
     JOIN providers p ON p.id = am.provider_id
     WHERE am.provider_id = $1
       AND am.model_id = $2
       AND am.enabled = true
       AND p.enabled = true`,
    [providerId, normalizedModel],
  );
  return result.rowCount ? result.rows[0]! : null;
}

async function syncUserAdminFlag(user: DbUser): Promise<DbUser> {
  const shouldBeAdmin = isConfiguredAdminEmail(user.email);
  if (user.is_admin === shouldBeAdmin) {
    return user;
  }

  await pool.query('UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1', [
    user.id,
    shouldBeAdmin,
  ]);

  return {
    ...user,
    is_admin: shouldBeAdmin,
  };
}

async function getUserProviderKey(userId: string, providerId: number): Promise<string | null> {
  const result = await pool.query<{ encrypted_key: string; iv: string; auth_tag: string }>(
    `SELECT encrypted_key, iv, auth_tag
     FROM user_provider_keys
     WHERE user_id = $1 AND provider_id = $2`,
    [userId, providerId],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0]!;
  return decryptApiKey(row.encrypted_key, row.iv, row.auth_tag);
}

async function resolveProviderForRequest(
  user: DbUser,
  providerOverride: string | undefined,
): Promise<ProviderRow> {
  if (providerOverride) {
    const byCode = await getProviderByCode(providerOverride);
    if (!byCode) {
      throw new Error(`Unknown provider: ${providerOverride}`);
    }
    if (!byCode.enabled) {
      throw new Error(`Provider is disabled: ${providerOverride}`);
    }
    return byCode;
  }

  if (user.default_provider_id) {
    const byId = await getProviderById(user.default_provider_id);
    if (byId && byId.enabled) {
      return byId;
    }
  }

  const defaultProvider = await getDefaultProviderForUser();
  if (!defaultProvider) {
    throw new Error('No enabled providers are configured');
  }
  return defaultProvider;
}

async function resolveAndValidateProviderModel(params: {
  user: DbUser;
  providerOverride?: string;
  requestedModel?: string;
}): Promise<{ provider: ProviderRow; model: string }> {
  const provider = await resolveProviderForRequest(params.user, params.providerOverride);
  const modelCandidate = (params.requestedModel ?? params.user.default_model ?? '').trim();
  if (!modelCandidate) {
    throw new Error(
      `Model is required and must be allowed for provider "${provider.code}".`,
    );
  }

  const allowed = await findAllowedModel(provider.id, modelCandidate);
  if (!allowed) {
    throw new Error(
      `Model "${modelCandidate}" is not allowed for provider "${provider.code}".`,
    );
  }

  return {
    provider,
    model: allowed.model_id,
  };
}

const threadTitleSentenceBoundary = /[.!?]\s/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  const syncedUser = await syncUserAdminFlag(user);

  request.sessionId = sessionId;
  request.authUser = syncedUser;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.authUser;
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  if (!config.adminEmail) {
    reply.code(403).send({ error: 'Admin access is disabled. ADMIN_EMAIL is not configured.' });
    return;
  }

  if (!user.is_admin || !isConfiguredAdminEmail(user.email)) {
    reply.code(403).send({ error: 'Admin access denied' });
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

  app.post('/auth/register', { preHandler: [authRateLimit] }, async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || password.length < 8) {
      await writeAuditEvent({
        eventType: 'auth.register_failed',
        request,
        metadata: { reason: 'validation_failed', email_present: Boolean(email) },
      });
      reply.code(400).send({ error: 'Email and password (min 8 chars) are required' });
      return;
    }

    const defaultProvider = await getDefaultProviderForUser();
    if (!defaultProvider) {
      reply.code(500).send({ error: 'Default provider missing' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const isAdmin = isConfiguredAdminEmail(email);
    try {
      const created = await pool.query<DbUser>(
        `INSERT INTO users (email, password_hash, is_admin, default_provider_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, is_admin, default_provider_id, default_model`,
        [email, passwordHash, isAdmin, defaultProvider.id],
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
        admin_enabled: Boolean(config.adminEmail),
        default_provider: defaultProvider.code,
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
    const body = request.body as { email?: unknown; password?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !password) {
      reply.code(400).send({ error: 'Email and password are required' });
      return;
    }

    const userResult = await pool.query<DbUser & { password_hash: string }>(
      `SELECT id, email, password_hash, is_admin, default_provider_id, default_model
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
      await writeAuditEvent({
        eventType: 'auth.login_failed',
        request,
        userId: user.id,
        metadata: { reason: 'invalid_credentials' },
      });
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    const syncedUser = await syncUserAdminFlag(user);
    await createSession(reply, syncedUser.id);

    await writeAuditEvent({
      eventType: 'auth.login_success',
      request,
      userId: syncedUser.id,
      metadata: {},
    });

    const provider = syncedUser.default_provider_id
      ? await getProviderById(syncedUser.default_provider_id)
      : null;
    const fallbackProvider = await getDefaultProviderForUser();
    reply.send({
      id: syncedUser.id,
      email: syncedUser.email,
      is_admin: syncedUser.is_admin,
      admin_enabled: Boolean(config.adminEmail),
      default_provider: provider?.code ?? fallbackProvider?.code ?? 'openai',
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
    const provider = user.default_provider_id ? await getProviderById(user.default_provider_id) : null;
    const fallbackProvider = await getDefaultProviderForUser();
    return {
      id: user.id,
      email: user.email,
      is_admin: user.is_admin && isConfiguredAdminEmail(user.email),
      admin_enabled: Boolean(config.adminEmail),
      default_provider: provider?.code ?? fallbackProvider?.code ?? 'openai',
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
      [user.id, 'New chat', user.default_provider_id, user.default_model],
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

  app.post('/me/keys', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const body = request.body as { provider?: unknown; apiKey?: unknown };
    const providerCode = typeof body.provider === 'string' ? body.provider.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

    if (!providerCode || !apiKey) {
      reply.code(400).send({ error: 'provider and apiKey are required' });
      return;
    }

    const provider = await getProviderByCode(providerCode);
    if (!provider) {
      reply.code(400).send({ error: 'Unknown provider' });
      return;
    }
    if (!provider.enabled) {
      reply.code(400).send({ error: `Provider "${provider.code}" is disabled` });
      return;
    }

    const encrypted = encryptApiKey(apiKey);

    await pool.query(
      `INSERT INTO user_provider_keys (user_id, provider_id, encrypted_key, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, provider_id)
       DO UPDATE
         SET encrypted_key = EXCLUDED.encrypted_key,
             iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag,
             updated_at = now()`,
      [user.id, provider.id, encrypted.encrypted, encrypted.iv, encrypted.authTag],
    );

    await writeAuditEvent({
      eventType: 'keys.updated',
      request,
      userId: user.id,
      metadata: { provider: provider.code },
    });

    reply.send({ ok: true, provider: provider.code });
  });

  app.get('/me/keys', { preHandler: [requireAuth] }, async (request) => {
    const user = request.authUser!;
    const providers = await getAllProviders();
    const keysResult = await pool.query<UserProviderKeyRow>(
      `SELECT upk.provider_id, p.code, p.base_url, upk.encrypted_key, upk.iv, upk.auth_tag
       FROM user_provider_keys upk
       JOIN providers p ON p.id = upk.provider_id
       WHERE upk.user_id = $1`,
      [user.id],
    );

    const byProvider = new Map<number, { masked: string; updated: boolean }>();
    for (const row of keysResult.rows) {
      const decrypted = decryptApiKey(row.encrypted_key, row.iv, row.auth_tag);
      byProvider.set(row.provider_id, {
        masked: maskApiKey(decrypted),
        updated: true,
      });
    }

    return {
      data: providers.map((provider) => ({
        provider: provider.code,
        enabled: provider.enabled,
        has_key: byProvider.has(provider.id),
        masked_key: byProvider.get(provider.id)?.masked ?? null,
      })),
    };
  });

  app.post('/me/provider', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.authUser!;
    const body = request.body as { provider?: unknown; model?: unknown };
    const providerCode = typeof body.provider === 'string' ? body.provider.trim() : '';
    const modelValue = typeof body.model === 'string' ? body.model.trim() : '';
    const model = modelValue || null;

    if (!providerCode) {
      reply.code(400).send({ error: 'provider is required' });
      return;
    }

    const provider = await getProviderByCode(providerCode);
    if (!provider) {
      reply.code(400).send({ error: 'Unknown provider' });
      return;
    }
    if (!provider.enabled) {
      reply.code(400).send({ error: `Provider "${provider.code}" is disabled` });
      return;
    }

    if (model) {
      const allowed = await findAllowedModel(provider.id, model);
      if (!allowed) {
        reply
          .code(400)
          .send({ error: `Model "${model}" is not allowed for provider "${provider.code}".` });
        return;
      }
    }

    await pool.query(
      `UPDATE users
        SET default_provider_id = $2,
           default_model = $3,
           updated_at = now()
       WHERE id = $1`,
      [user.id, provider.id, model],
    );

    await writeAuditEvent({
      eventType: 'profile.default_provider_updated',
      request,
      userId: user.id,
      metadata: { provider: provider.code, has_model: Boolean(model) },
    });

    reply.send({ ok: true });
  });

  app.get(
    '/admin/providers',
    { preHandler: [requireAuth, requireAdmin] },
    async () => {
      const providers = await getAllProviders();
      return {
        data: providers.map((provider) => ({
          id: provider.id,
          code: provider.code,
          name: provider.name,
          base_url: provider.base_url,
          enabled: provider.enabled,
        })),
      };
    },
  );

  app.patch(
    '/admin/providers/:providerCode',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const user = request.authUser!;
      const params = request.params as { providerCode: string };
      const body = (request.body ?? {}) as { base_url?: unknown; enabled?: unknown };
      const providerCode = params.providerCode.trim();

      if (!providerCode) {
        reply.code(400).send({ error: 'providerCode is required' });
        return;
      }

      let hasBaseUrlUpdate = false;
      let nextBaseUrl: string | null = null;
      if (Object.prototype.hasOwnProperty.call(body, 'base_url')) {
        if (typeof body.base_url !== 'string') {
          reply.code(400).send({ error: 'base_url must be a string' });
          return;
        }
        const normalized = normalizeProviderBaseUrl(body.base_url);
        if (!normalized) {
          reply.code(400).send({
            error:
              'base_url must be a valid http(s) URL without query string or fragment',
          });
          return;
        }
        hasBaseUrlUpdate = true;
        nextBaseUrl = normalized;
      }

      let hasEnabledUpdate = false;
      let nextEnabled = true;
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        if (typeof body.enabled !== 'boolean') {
          reply.code(400).send({ error: 'enabled must be a boolean' });
          return;
        }
        hasEnabledUpdate = true;
        nextEnabled = body.enabled;
      }

      if (!hasBaseUrlUpdate && !hasEnabledUpdate) {
        reply.code(400).send({ error: 'At least one of base_url or enabled is required' });
        return;
      }

      const updateParts: string[] = [];
      const values: Array<string | boolean> = [providerCode];
      if (hasBaseUrlUpdate) {
        updateParts.push(`base_url = $${values.length + 1}`);
        values.push(nextBaseUrl!);
      }
      if (hasEnabledUpdate) {
        updateParts.push(`enabled = $${values.length + 1}`);
        values.push(nextEnabled);
      }

      const updated = await pool.query<ProviderRow>(
        `UPDATE providers
         SET ${updateParts.join(', ')}
         WHERE code = $1
         RETURNING id, code, name, base_url, enabled`,
        values,
      );

      if (!updated.rowCount) {
        reply.code(404).send({ error: 'Provider not found' });
        return;
      }

      const provider = updated.rows[0]!;

      await writeAuditEvent({
        eventType: 'admin.providers.updated',
        request,
        userId: user.id,
        metadata: {
          provider: provider.code,
          base_url_updated: hasBaseUrlUpdate,
          enabled_updated: hasEnabledUpdate,
        },
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
    },
  );

  app.get(
    '/admin/providers/:providerCode/upstream-models',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const user = request.authUser!;
      const params = request.params as { providerCode: string };
      const providerCode = params.providerCode.trim();

      if (!providerCode) {
        reply.code(400).send({ error: 'providerCode is required' });
        return;
      }

      const provider = await getProviderByCode(providerCode);
      if (!provider) {
        reply.code(404).send({ error: `Unknown provider "${providerCode}"` });
        return;
      }

      const apiKey = await getUserProviderKey(user.id, provider.id);
      if (!apiKey) {
        reply.code(400).send({
          error: `No API key configured for provider "${provider.code}" on admin account. Set it in Settings first.`,
        });
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

      const models = normalizeUpstreamModels(upstreamPayload);
      reply.send({
        data: models,
      });
    },
  );

  app.get('/admin/models', { preHandler: [requireAuth, requireAdmin] }, async () => {
    const models = await listAllowedModels({ includeDisabled: true });
    return {
      data: models.map((model) => ({
        id: model.id,
        provider_id: model.provider_id,
        provider: model.provider_code,
        model_id: model.model_id,
        display_name: model.display_name,
        enabled: model.enabled,
        created_at: model.created_at,
      })),
    };
  });

  app.post('/admin/models', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as {
      provider?: unknown;
      model_id?: unknown;
      display_name?: unknown;
      enabled?: unknown;
    };
    const providerCode = typeof body.provider === 'string' ? body.provider.trim() : '';
    const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
    const displayName =
      typeof body.display_name === 'string' ? body.display_name.trim() || null : null;
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

    if (!providerCode || !modelId) {
      reply.code(400).send({ error: 'provider and model_id are required' });
      return;
    }

    const provider = await getProviderByCode(providerCode);
    if (!provider) {
      reply.code(400).send({ error: `Unknown provider "${providerCode}"` });
      return;
    }

    try {
      const created = await pool.query<AllowedModelRow>(
        `INSERT INTO allowed_models (provider_id, model_id, display_name, enabled)
         VALUES ($1, $2, $3, $4)
         RETURNING id,
                   provider_id,
                   $5 AS provider_code,
                   model_id,
                   display_name,
                   enabled,
                   created_at`,
        [provider.id, modelId, displayName, enabled, provider.code],
      );

      const model = created.rows[0]!;

      await writeAuditEvent({
        eventType: 'admin.models.created',
        request,
        userId: user.id,
        metadata: {
          provider: provider.code,
          model_id: model.model_id,
          enabled: model.enabled,
        },
      });

      reply.code(201).send({
        data: {
          id: model.id,
          provider_id: model.provider_id,
          provider: model.provider_code,
          model_id: model.model_id,
          display_name: model.display_name,
          enabled: model.enabled,
          created_at: model.created_at,
        },
      });
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        reply
          .code(409)
          .send({ error: `Model "${modelId}" already exists for provider "${provider.code}"` });
        return;
      }
      throw error;
    }
  });

  app.post('/admin/models/bulk', { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const user = request.authUser!;
    const body = (request.body ?? {}) as {
      provider?: unknown;
      model_ids?: unknown;
      enabled?: unknown;
    };

    const providerCode = typeof body.provider === 'string' ? body.provider.trim() : '';
    if (!providerCode) {
      reply.code(400).send({ error: 'provider is required' });
      return;
    }

    if (!Array.isArray(body.model_ids)) {
      reply.code(400).send({ error: 'model_ids must be an array of strings' });
      return;
    }

    if (body.model_ids.some((modelId) => typeof modelId !== 'string')) {
      reply.code(400).send({ error: 'model_ids must contain only strings' });
      return;
    }

    const modelIds = Array.from(
      new Set(
        body.model_ids
          .map((modelId) => (modelId as string).trim())
          .filter((modelId) => modelId.length > 0),
      ),
    );

    if (modelIds.length === 0) {
      reply.code(400).send({ error: 'model_ids must include at least one non-empty model id' });
      return;
    }

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
    const provider = await getProviderByCode(providerCode);
    if (!provider) {
      reply.code(400).send({ error: `Unknown provider "${providerCode}"` });
      return;
    }

    const created = await pool.query<{ id: number; model_id: string }>(
      `INSERT INTO allowed_models (provider_id, model_id, enabled)
       SELECT $1, incoming.model_id, $3
       FROM unnest($2::text[]) AS incoming(model_id)
       ON CONFLICT (provider_id, model_id) DO NOTHING
       RETURNING id, model_id`,
      [provider.id, modelIds, enabled],
    );

    await writeAuditEvent({
      eventType: 'admin.models.bulk_created',
      request,
      userId: user.id,
      metadata: {
        provider: provider.code,
        requested_count: modelIds.length,
        created_count: created.rowCount,
        enabled,
      },
    });

    reply.send({
      provider: provider.code,
      requested_count: modelIds.length,
      created_count: created.rowCount,
      created_model_ids: created.rows.map((row) => row.model_id),
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
    const values: Array<string | boolean | number | null> = [id];

    if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      if (body.display_name !== null && typeof body.display_name !== 'string') {
        reply.code(400).send({ error: 'display_name must be a string or null' });
        return;
      }
      const displayName =
        typeof body.display_name === 'string' ? body.display_name.trim() || null : null;
      updateParts.push(`display_name = $${values.length + 1}`);
      values.push(displayName);
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

    const updated = await pool.query<AllowedModelRow>(
      `UPDATE allowed_models am
       SET ${updateParts.join(', ')}
       FROM providers p
       WHERE am.id = $1
         AND p.id = am.provider_id
       RETURNING am.id,
                 am.provider_id,
                 p.code AS provider_code,
                 am.model_id,
                 am.display_name,
                 am.enabled,
                 am.created_at`,
      values,
    );

    if (!updated.rowCount) {
      reply.code(404).send({ error: 'Allowed model not found' });
      return;
    }

    const model = updated.rows[0]!;

    await writeAuditEvent({
      eventType: 'admin.models.updated',
      request,
      userId: user.id,
      metadata: {
        model_id: model.model_id,
        provider: model.provider_code,
      },
    });

    reply.send({
      data: {
        id: model.id,
        provider_id: model.provider_id,
        provider: model.provider_code,
        model_id: model.model_id,
        display_name: model.display_name,
        enabled: model.enabled,
        created_at: model.created_at,
      },
    });
  });

  app.delete(
    '/admin/models/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const user = request.authUser!;
      const params = request.params as { id: string };
      const id = Number(params.id);

      if (!Number.isInteger(id) || id <= 0) {
        reply.code(400).send({ error: 'id must be a positive integer' });
        return;
      }

      const deleted = await pool.query<{ id: number; model_id: string }>(
        `DELETE FROM allowed_models
         WHERE id = $1
         RETURNING id, model_id`,
        [id],
      );

      if (!deleted.rowCount) {
        reply.code(404).send({ error: 'Allowed model not found' });
        return;
      }

      await writeAuditEvent({
        eventType: 'admin.models.deleted',
        request,
        userId: user.id,
        metadata: {
          id,
          model_id: deleted.rows[0]!.model_id,
        },
      });

      reply.send({ ok: true });
    },
  );

  app.get('/v1/models', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const allowedModels = await listAllowedModels();
    reply.send({
      object: 'list',
      data: allowedModels.map((entry) => ({
        id: entry.model_id,
        object: 'model',
        created: Math.floor(new Date(entry.created_at).getTime() / 1000),
        owned_by: entry.provider_code,
        provider: entry.provider_code,
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

    const providerOverride =
      typeof requestBody.provider === 'string' ? (requestBody.provider as string) : undefined;
    const threadId =
      typeof requestBody.thread_id === 'string'
        ? (requestBody.thread_id as string)
        : typeof requestBody.threadId === 'string'
          ? (requestBody.threadId as string)
          : undefined;

    delete requestBody.provider;
    delete requestBody.thread_id;
    delete requestBody.threadId;

    let provider: ProviderRow;
    let model: string;
    try {
      const resolved = await resolveAndValidateProviderModel({
        user,
        providerOverride,
        requestedModel: typeof requestBody.model === 'string' ? requestBody.model : undefined,
      });
      provider = resolved.provider;
      model = resolved.model;
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid model selection' });
      return;
    }

    const apiKey = await getUserProviderKey(user.id, provider.id);
    if (!apiKey) {
      reply.code(400).send({ error: `No API key configured for provider: ${provider.code}` });
      return;
    }

    requestBody.model = model;

    requestBody.input = await hydrateResponsesInput(requestBody.input, user.id);

    const userPrompt = extractTextFromResponsesInput(requestBody.input);
    const effectiveModel = model;

    const targetThreadId = await getOrCreateThread({
      userId: user.id,
      threadId,
      providerId: provider.id,
      model: effectiveModel,
    });

    await persistMessage({
      threadId: targetThreadId,
      userId: user.id,
      role: 'user',
      content: userPrompt || '[non-text input]',
      rawContent: requestBody.input,
    });

    await maybeAutoRenameThread({
      threadId: targetThreadId,
      userId: user.id,
      sourceText: userPrompt,
    });

    const stream = requestBody.stream === true;
    const started = Date.now();

    await writeAuditEvent({
      eventType: 'upstream.request',
      request,
      userId: user.id,
      metadata: {
        endpoint: '/responses',
        provider: provider.code,
        stream,
        has_model: Boolean(effectiveModel),
      },
    });

    const upstream = await fetch(`${provider.base_url}/responses`, {
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
        provider: provider.code,
        status: upstream.status,
        duration_ms: Date.now() - started,
        stream,
      },
    });

    if (!upstream.ok) {
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
        reply.code(502).send({ error: 'Upstream stream body missing' });
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Thread-Id': targetThreadId,
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

    reply.header('X-Thread-Id', targetThreadId).send(payload);
  });

  app.post('/v1/chat/completions', { preHandler: [requireAuth, v1RateLimit] }, async (request, reply) => {
    const user = request.authUser!;
    const requestBody = { ...((request.body ?? {}) as Record<string, unknown>) };

    const providerOverride =
      typeof requestBody.provider === 'string' ? (requestBody.provider as string) : undefined;
    const threadId =
      typeof requestBody.thread_id === 'string'
        ? (requestBody.thread_id as string)
        : typeof requestBody.threadId === 'string'
          ? (requestBody.threadId as string)
          : undefined;

    delete requestBody.provider;
    delete requestBody.thread_id;
    delete requestBody.threadId;

    let provider: ProviderRow;
    let model: string;
    try {
      const resolved = await resolveAndValidateProviderModel({
        user,
        providerOverride,
        requestedModel: typeof requestBody.model === 'string' ? requestBody.model : undefined,
      });
      provider = resolved.provider;
      model = resolved.model;
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid model selection' });
      return;
    }

    const apiKey = await getUserProviderKey(user.id, provider.id);
    if (!apiKey) {
      reply.code(400).send({ error: `No API key configured for provider: ${provider.code}` });
      return;
    }

    requestBody.model = model;

    requestBody.messages = await hydrateChatMessages(requestBody.messages, user.id);

    const userPrompt = extractTextFromChatMessages(requestBody.messages);
    const effectiveModel = model;

    const targetThreadId = await getOrCreateThread({
      userId: user.id,
      threadId,
      providerId: provider.id,
      model: effectiveModel,
    });

    await persistMessage({
      threadId: targetThreadId,
      userId: user.id,
      role: 'user',
      content: userPrompt || '[non-text input]',
      rawContent: requestBody.messages,
    });

    await maybeAutoRenameThread({
      threadId: targetThreadId,
      userId: user.id,
      sourceText: userPrompt,
    });

    const stream = requestBody.stream === true;
    const started = Date.now();

    await writeAuditEvent({
      eventType: 'upstream.request',
      request,
      userId: user.id,
      metadata: {
        endpoint: '/chat/completions',
        provider: provider.code,
        stream,
        has_model: Boolean(effectiveModel),
      },
    });

    const upstream = await fetch(`${provider.base_url}/chat/completions`, {
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
        provider: provider.code,
        status: upstream.status,
        duration_ms: Date.now() - started,
        stream,
      },
    });

    if (!upstream.ok) {
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
        reply.code(502).send({ error: 'Upstream stream body missing' });
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Thread-Id': targetThreadId,
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

    reply.header('X-Thread-Id', targetThreadId).send(payload);
  });

  app.setErrorHandler(async (error, request, reply) => {
    app.log.error({ err: error, url: request.url }, 'Unhandled error');
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
