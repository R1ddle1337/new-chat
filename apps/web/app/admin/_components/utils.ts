import type { AbuseRuleHit } from './types';

export function parseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') {
    return record.error;
  }

  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') {
      return nested.message;
    }
  }

  return fallback;
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Never';
  }

  return new Date(value).toLocaleString();
}

export function normalizeProviderCode(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeProviderBaseUrl(value: string): string | null {
  const candidate = value.trim();
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

  if (parsed.search || parsed.hash || !parsed.hostname) {
    return null;
  }

  const cleanedPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanedPath}`;
}

export function summarizeRuleHits(ruleHits: AbuseRuleHit[]): string {
  if (!Array.isArray(ruleHits) || ruleHits.length === 0) {
    return 'No rule hits';
  }

  return ruleHits
    .slice(0, 3)
    .map((hit) => `${hit.rule} (+${hit.score})`)
    .join(', ');
}
