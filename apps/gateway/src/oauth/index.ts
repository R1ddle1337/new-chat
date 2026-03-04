import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';

const OAUTH_STATE_COOKIE_NAME = 'oauth_state';
const OAUTH_NONCE_COOKIE_NAME = 'oauth_nonce';
const OAUTH_STATE_TTL_SECONDS = 600;

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

type OAuthProviderCode = 'google';

type OAuthStateRecord = {
  provider: OAuthProviderCode;
  nonce: string;
  created_at: string;
};

export type OAuthProviderSummary = {
  code: OAuthProviderCode;
  name: string;
};

export type OAuthCallbackIdentity = {
  provider: OAuthProviderCode;
  providerSubject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

type GoogleProviderConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type OAuthProviderIdentity = Omit<OAuthCallbackIdentity, 'provider'>;

type OAuthProvider = {
  code: OAuthProviderCode;
  name: string;
  isConfigured: () => boolean;
  buildAuthorizationUrl: (params: { state: string; nonce: string }) => string;
  exchangeCodeForIdentity: (params: { code: string; nonce: string }) => Promise<OAuthProviderIdentity>;
};

type OAuthCallbackResult =
  | { ok: true; identity: OAuthCallbackIdentity }
  | { ok: false; error: string };

type OAuthStartResult =
  | { ok: true }
  | { ok: false; error: string };

export type OAuthRegistry = {
  listConfiguredProviders: () => OAuthProviderSummary[];
  startAuth: (
    providerCode: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<OAuthStartResult>;
  handleCallback: (
    providerCode: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<OAuthCallbackResult>;
};

type CreateOAuthRegistryParams = {
  redis: Redis;
  secureCookies: boolean;
  google: GoogleProviderConfig;
};

type GoogleTokenExchangeResponse = {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenInfoResponse = {
  aud?: string;
  iss?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  nonce?: string;
  name?: string;
  picture?: string;
};

function randomBase64Url(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeProviderCode(value: string): OAuthProviderCode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'google') {
    return 'google';
  }
  return null;
}

function getQueryString(query: FastifyRequest['query'], key: string): string {
  if (!query || typeof query !== 'object') {
    return '';
  }

  const raw = (query as Record<string, unknown>)[key];
  if (typeof raw !== 'string') {
    return '';
  }

  return raw.trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBooleanString(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  return false;
}

function clearOAuthCookies(reply: FastifyReply, secureCookies: boolean): void {
  const options = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies,
  };

  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, options);
  reply.clearCookie(OAUTH_NONCE_COOKIE_NAME, options);
}

function setOAuthCookies(reply: FastifyReply, secureCookies: boolean, state: string, nonce: string): void {
  const options = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  };

  reply.setCookie(OAUTH_STATE_COOKIE_NAME, state, options);
  reply.setCookie(OAUTH_NONCE_COOKIE_NAME, nonce, options);
}

function sanitizeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'oauth_failed';
}

function createGoogleProvider(config: GoogleProviderConfig): OAuthProvider {
  const isConfigured = () => Boolean(config.clientId && config.clientSecret && config.redirectUri);

  return {
    code: 'google',
    name: 'Google',
    isConfigured,
    buildAuthorizationUrl(params) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', params.state);
      url.searchParams.set('nonce', params.nonce);
      url.searchParams.set('prompt', 'select_account');
      return url.toString();
    },
    async exchangeCodeForIdentity(params) {
      if (!isConfigured()) {
        throw new Error('provider_unavailable');
      }

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          code: params.code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenResponse.ok) {
        throw new Error('google_token_exchange_failed');
      }

      const tokenPayload = (await tokenResponse.json()) as GoogleTokenExchangeResponse;
      const idToken = typeof tokenPayload.id_token === 'string' ? tokenPayload.id_token : '';
      if (!idToken) {
        throw new Error('google_token_missing_id_token');
      }

      const tokenInfoUrl = new URL('https://oauth2.googleapis.com/tokeninfo');
      tokenInfoUrl.searchParams.set('id_token', idToken);
      const tokenInfoResponse = await fetch(tokenInfoUrl.toString());
      if (!tokenInfoResponse.ok) {
        throw new Error('google_tokeninfo_failed');
      }

      const tokenInfo = (await tokenInfoResponse.json()) as GoogleTokenInfoResponse;
      if (tokenInfo.aud !== config.clientId) {
        throw new Error('google_invalid_audience');
      }

      if (!tokenInfo.iss || !GOOGLE_ISSUERS.has(tokenInfo.iss)) {
        throw new Error('google_invalid_issuer');
      }

      const providerSubject = typeof tokenInfo.sub === 'string' ? tokenInfo.sub.trim() : '';
      if (!providerSubject) {
        throw new Error('google_missing_subject');
      }

      const email = typeof tokenInfo.email === 'string' ? normalizeEmail(tokenInfo.email) : '';
      if (!email) {
        throw new Error('google_missing_email');
      }

      const emailVerified = parseBooleanString(tokenInfo.email_verified);
      if (!emailVerified) {
        throw new Error('google_email_not_verified');
      }

      if (typeof tokenInfo.nonce === 'string' && tokenInfo.nonce.trim()) {
        if (tokenInfo.nonce.trim() !== params.nonce) {
          throw new Error('google_invalid_nonce');
        }
      }

      return {
        providerSubject,
        email,
        emailVerified,
        name: typeof tokenInfo.name === 'string' ? tokenInfo.name.trim() || null : null,
        picture: typeof tokenInfo.picture === 'string' ? tokenInfo.picture.trim() || null : null,
      };
    },
  };
}

export function createOAuthRegistry(params: CreateOAuthRegistryParams): OAuthRegistry {
  const providers: Record<OAuthProviderCode, OAuthProvider> = {
    google: createGoogleProvider(params.google),
  };

  function getProvider(rawProviderCode: string): OAuthProvider | null {
    const providerCode = normalizeProviderCode(rawProviderCode);
    if (!providerCode) {
      return null;
    }

    const provider = providers[providerCode];
    if (!provider) {
      return null;
    }

    return provider;
  }

  return {
    listConfiguredProviders() {
      return Object.values(providers)
        .filter((provider) => provider.isConfigured())
        .map((provider) => ({
          code: provider.code,
          name: provider.name,
        }));
    },

    async startAuth(providerCode, _request, reply) {
      const provider = getProvider(providerCode);
      if (!provider || !provider.isConfigured()) {
        return { ok: false, error: 'provider_unavailable' };
      }

      const state = `${crypto.randomUUID()}.${randomBase64Url(18)}`;
      const nonce = randomBase64Url(24);
      const stateRecord: OAuthStateRecord = {
        provider: provider.code,
        nonce,
        created_at: new Date().toISOString(),
      };

      await params.redis.setex(
        `oauth:state:${state}`,
        OAUTH_STATE_TTL_SECONDS,
        JSON.stringify(stateRecord),
      );
      setOAuthCookies(reply, params.secureCookies, state, nonce);

      reply.redirect(provider.buildAuthorizationUrl({ state, nonce }));
      return { ok: true };
    },

    async handleCallback(providerCode, request, reply) {
      const provider = getProvider(providerCode);
      if (!provider || !provider.isConfigured()) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: 'provider_unavailable' };
      }

      const upstreamError = getQueryString(request.query, 'error');
      if (upstreamError) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: sanitizeErrorCode(`google_${upstreamError}`) };
      }

      const state = getQueryString(request.query, 'state');
      const code = getQueryString(request.query, 'code');
      const cookieState = request.cookies[OAUTH_STATE_COOKIE_NAME];
      const cookieNonce = request.cookies[OAUTH_NONCE_COOKIE_NAME];
      if (!state || !code || !cookieState || !cookieNonce) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: 'invalid_callback_params' };
      }

      if (state !== cookieState) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: 'invalid_oauth_state' };
      }

      const redisKey = `oauth:state:${state}`;
      const stateRecordRaw = await params.redis.get(redisKey);
      await params.redis.del(redisKey);

      if (!stateRecordRaw) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: 'expired_oauth_state' };
      }

      let stateRecord: OAuthStateRecord | null = null;
      try {
        const parsed = JSON.parse(stateRecordRaw) as Partial<OAuthStateRecord>;
        if (parsed.provider === provider.code && typeof parsed.nonce === 'string' && parsed.nonce) {
          stateRecord = {
            provider: parsed.provider,
            nonce: parsed.nonce,
            created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
          };
        }
      } catch {
        stateRecord = null;
      }

      if (!stateRecord || stateRecord.nonce !== cookieNonce) {
        clearOAuthCookies(reply, params.secureCookies);
        return { ok: false, error: 'invalid_oauth_nonce' };
      }

      clearOAuthCookies(reply, params.secureCookies);

      try {
        const identity = await provider.exchangeCodeForIdentity({
          code,
          nonce: stateRecord.nonce,
        });

        return {
          ok: true,
          identity: {
            provider: provider.code,
            providerSubject: identity.providerSubject,
            email: identity.email,
            emailVerified: identity.emailVerified,
            name: identity.name,
            picture: identity.picture,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: sanitizeErrorCode(error instanceof Error ? error.message : 'oauth_identity_verification_failed'),
        };
      }
    },
  };
}
