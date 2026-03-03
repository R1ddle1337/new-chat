'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import MainHeader from '../components/main-header';

type MePayload = {
  is_admin: boolean;
};

type ProviderItem = {
  id: number;
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
  has_secret: boolean;
  secret_updated_at: string | null;
};

type ImportedModelItem = {
  model_id: string;
  display_name: string;
  owned_by: string | null;
  already_added: boolean;
  existing_public_id: string | null;
  existing_enabled: boolean | null;
};

type ModelItem = {
  id: number;
  provider: string;
  provider_id: number;
  model_id: string;
  public_id: string;
  display_name: string;
  enabled: boolean;
  created_at: string;
};

type ModelDraft = {
  display_name: string;
  enabled: boolean;
};

type ProviderDraft = {
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
};

type RateLimitsPayload = {
  rpm_limit: number;
  tpm_limit: number;
  updated_at: string;
};

type AdminUserItem = {
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

type UserLimitDraft = {
  rpm_limit: string;
  tpm_limit: string;
};

type AbuseRuleHit = {
  rule: string;
  score: number;
  value: number;
  threshold: number;
  window_seconds: number;
};

type SuspiciousUserItem = {
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

type ThrottleOverrideDraft = {
  rpm_limit: string;
  tpm_limit: string;
  duration_minutes: string;
};

type AbuseEventItem = {
  id: string;
  event_type: string;
  ip: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type AdminThreadItem = {
  id: string;
  title: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  msg_count: number;
};

type AdminMessageAttachment = {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_url: string;
};

type AdminThreadMessageItem = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments: AdminMessageAttachment[];
};

function parseError(payload: unknown, fallback: string): string {
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

function formatDateTime(value: string | null): string {
  if (!value) {
    return 'Never';
  }

  return new Date(value).toLocaleString();
}

function normalizeProviderCode(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeProviderBaseUrl(value: string): string | null {
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

function summarizeRuleHits(ruleHits: AbuseRuleHit[]): string {
  if (!Array.isArray(ruleHits) || ruleHits.length === 0) {
    return 'No rule hits';
  }

  return ruleHits
    .slice(0, 3)
    .map((hit) => `${hit.rule} (+${hit.score})`)
    .join(', ');
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<number, ProviderDraft>>({});
  const [providerSecretDrafts, setProviderSecretDrafts] = useState<Record<number, string>>({});
  const [createProviderDraft, setCreateProviderDraft] = useState<ProviderDraft>({
    code: '',
    name: '',
    base_url: '',
    enabled: true,
  });

  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelDrafts, setModelDrafts] = useState<Record<number, ModelDraft>>({});

  const [importProviderId, setImportProviderId] = useState('');
  const [importedModels, setImportedModels] = useState<ImportedModelItem[]>([]);
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [importSearch, setImportSearch] = useState('');

  const [rpmLimit, setRpmLimit] = useState('120');
  const [tpmLimit, setTpmLimit] = useState('120000');
  const [rateLimitsUpdatedAt, setRateLimitsUpdatedAt] = useState<string | null>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersQuery, setUsersQuery] = useState('');
  const [userLimitDrafts, setUserLimitDrafts] = useState<Record<string, UserLimitDraft>>({});
  const [suspiciousUsers, setSuspiciousUsers] = useState<SuspiciousUserItem[]>([]);
  const [throttleOverrideDrafts, setThrottleOverrideDrafts] = useState<
    Record<string, ThrottleOverrideDraft>
  >({});
  const [selectedEventUserId, setSelectedEventUserId] = useState<string | null>(null);
  const [selectedUserEvents, setSelectedUserEvents] = useState<AbuseEventItem[]>([]);
  const [selectedChatUser, setSelectedChatUser] = useState<{ id: string; email: string } | null>(null);
  const [chatThreads, setChatThreads] = useState<AdminThreadItem[]>([]);
  const [selectedChatThreadId, setSelectedChatThreadId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<AdminThreadMessageItem[]>([]);
  const [chatMessagesNextCursor, setChatMessagesNextCursor] = useState<string | null>(null);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const filteredImportedModels = useMemo(() => {
    const query = importSearch.trim().toLowerCase();
    if (!query) {
      return importedModels;
    }

    return importedModels.filter((item) => {
      return (
        item.model_id.toLowerCase().includes(query) ||
        (item.owned_by ?? '').toLowerCase().includes(query)
      );
    });
  }, [importSearch, importedModels]);

  const selectedImportedModelIds = useMemo(
    () => Object.entries(importSelection).filter((entry) => entry[1]).map((entry) => entry[0]),
    [importSelection],
  );

  const loadProviders = async () => {
    const res = await fetch('/api/admin/providers', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load providers'));
    }

    const payload = (await res.json()) as { data: ProviderItem[] };
    setProviders(payload.data);
    setProviderDrafts(
      Object.fromEntries(
        payload.data.map((item) => [
          item.id,
          {
            code: item.code,
            name: item.name,
            base_url: item.base_url,
            enabled: item.enabled,
          },
        ]),
      ),
    );
    setProviderSecretDrafts(
      Object.fromEntries(payload.data.map((item) => [item.id, ''])),
    );

    setImportProviderId((previous) => {
      if (payload.data.length === 0) {
        return '';
      }
      if (previous && payload.data.some((item) => String(item.id) === previous)) {
        return previous;
      }
      return String(payload.data[0]!.id);
    });
  };

  const loadModels = async () => {
    const res = await fetch('/api/admin/models', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load model catalog'));
    }

    const payload = (await res.json()) as { data: ModelItem[] };
    setModels(payload.data);
    setModelDrafts(
      Object.fromEntries(
        payload.data.map((item) => [
          item.id,
          {
            display_name: item.display_name,
            enabled: item.enabled,
          },
        ]),
      ),
    );
  };

  const loadRateLimits = async () => {
    const res = await fetch('/api/admin/rate-limits', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load rate limits'));
    }

    const payload = (await res.json()) as { data: RateLimitsPayload };
    setRpmLimit(String(payload.data.rpm_limit));
    setTpmLimit(String(payload.data.tpm_limit));
    setRateLimitsUpdatedAt(payload.data.updated_at);
  };

  const loadUsers = async (query = usersQuery) => {
    const search = query.trim();
    const params = new URLSearchParams();
    if (search) {
      params.set('query', search);
    }

    const res = await fetch(`/api/admin/users${params.size > 0 ? `?${params.toString()}` : ''}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load users'));
    }

    const payload = (await res.json()) as { data: AdminUserItem[] };
    setUsers(payload.data);
    setUserLimitDrafts(
      Object.fromEntries(
        payload.data.map((item) => [
          item.id,
          {
            rpm_limit: item.rpm_override === null ? '' : String(item.rpm_override),
            tpm_limit: item.tpm_override === null ? '' : String(item.tpm_override),
          },
        ]),
      ),
    );
  };

  const loadSuspiciousUsers = async (query = usersQuery) => {
    const search = query.trim();
    const params = new URLSearchParams();
    if (search) {
      params.set('query', search);
    }

    const res = await fetch(
      `/api/admin/abuse/suspicious${params.size > 0 ? `?${params.toString()}` : ''}`,
      {
        credentials: 'include',
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load suspicious users'));
    }

    const payload = (await res.json()) as { data: SuspiciousUserItem[] };
    setSuspiciousUsers(payload.data);
    setThrottleOverrideDrafts((previous) => {
      const next = { ...previous };
      for (const item of payload.data) {
        if (!next[item.id]) {
          next[item.id] = {
            rpm_limit: item.throttle_rpm_limit === null ? '' : String(item.throttle_rpm_limit),
            tpm_limit: item.throttle_tpm_limit === null ? '' : String(item.throttle_tpm_limit),
            duration_minutes: '30',
          };
        }
      }
      return next;
    });
  };

  const reloadAll = async () => {
    await Promise.all([
      loadProviders(),
      loadModels(),
      loadRateLimits(),
      loadUsers(usersQuery),
      loadSuspiciousUsers(usersQuery),
    ]);
  };

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      setError(null);

      const meRes = await fetch('/api/me', { credentials: 'include' });
      if (meRes.status === 401) {
        router.replace('/login');
        return;
      }

      if (!meRes.ok) {
        setAuthorized(false);
        setError('Failed to load session');
        setLoading(false);
        return;
      }

      const me = (await meRes.json()) as MePayload;
      if (!me.is_admin) {
        setAuthorized(false);
        setLoading(false);
        return;
      }

      setAuthorized(true);

      try {
        await reloadAll();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load admin data');
      } finally {
        setLoading(false);
      }
    };

    void bootstrap();
  }, [router]);

  const validateProviderDraft = (draft: ProviderDraft, providerId?: number) => {
    const code = normalizeProviderCode(draft.code);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      setError('Provider code must be 1-64 chars: lowercase letters, numbers, "_" or "-"');
      return null;
    }

    const duplicate = providers.some((provider) => {
      if (typeof providerId === 'number' && provider.id === providerId) {
        return false;
      }
      return provider.code.toLowerCase() === code;
    });
    if (duplicate) {
      setError(`Provider code "${code}" already exists`);
      return null;
    }

    const name = draft.name.trim();
    if (!name || name.length > 120) {
      setError('Provider name must be non-empty and at most 120 characters');
      return null;
    }

    const baseUrl = normalizeProviderBaseUrl(draft.base_url);
    if (!baseUrl) {
      setError('Base URL must be a valid http(s) URL without query string or fragment');
      return null;
    }

    return {
      code,
      name,
      base_url: baseUrl,
      enabled: draft.enabled,
    };
  };

  const createProvider = async () => {
    const payload = validateProviderDraft(createProviderDraft);
    if (!payload) {
      return;
    }

    setStatus(null);
    setError(null);
    setBusy('provider-create');

    try {
      const res = await fetch('/api/admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to create provider'));
        return;
      }

      setCreateProviderDraft({
        code: '',
        name: '',
        base_url: '',
        enabled: true,
      });
      setStatus(`Provider "${payload.code}" created`);
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  const saveProvider = async (providerId: number) => {
    const draft = providerDrafts[providerId];
    if (!draft) {
      return;
    }

    const payload = validateProviderDraft(draft, providerId);
    if (!payload) {
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`provider-${providerId}`);

    try {
      const res = await fetch(`/api/admin/providers/${providerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to update provider'));
        return;
      }

      setStatus(`Provider "${payload.code}" updated`);
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  const toggleProviderEnabled = async (provider: ProviderItem) => {
    setStatus(null);
    setError(null);
    setBusy(`provider-toggle-${provider.id}`);

    try {
      const res = await fetch(`/api/admin/providers/${provider.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: !provider.enabled }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to toggle provider'));
        return;
      }

      setStatus(`Provider "${provider.code}" ${provider.enabled ? 'disabled' : 'enabled'}`);
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  const saveProviderSecret = async (providerId: number) => {
    const apiKey = (providerSecretDrafts[providerId] ?? '').trim();
    if (!apiKey) {
      setError('API key is required');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`provider-secret-${providerId}`);

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ api_key: apiKey }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to update provider secret'));
        return;
      }

      setProviderSecretDrafts((previous) => ({ ...previous, [providerId]: '' }));
      setStatus('Provider API key saved');
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  const importModels = async () => {
    const providerId = Number(importProviderId);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      setError('Choose a provider to import from');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy('import-models');

    try {
      const res = await fetch('/api/admin/models/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider_id: providerId }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to import models from provider'));
        return;
      }

      const payload = body as { data?: ImportedModelItem[] };
      const items = Array.isArray(payload.data) ? payload.data : [];
      setImportedModels(items);
      setImportSelection({});
      setImportSearch('');
      setStatus(`Imported ${items.length} upstream models`);
    } finally {
      setBusy(null);
    }
  };

  const publishSelectedImportedModels = async () => {
    const providerId = Number(importProviderId);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      setError('Choose a provider first');
      return;
    }

    if (selectedImportedModelIds.length === 0) {
      setError('Select at least one model to publish');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy('publish-imported');

    try {
      const res = await fetch('/api/admin/models/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          provider_id: providerId,
          models: selectedImportedModelIds,
          enabled: true,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to publish selected models'));
        return;
      }

      const payload = body as { created_count?: unknown; requested_count?: unknown };
      const createdCount = typeof payload.created_count === 'number' ? payload.created_count : 0;
      const requestedCount =
        typeof payload.requested_count === 'number'
          ? payload.requested_count
          : selectedImportedModelIds.length;

      setStatus(`Published ${createdCount} models (${requestedCount} selected)`);
      setImportSelection({});
      await loadModels();
    } finally {
      setBusy(null);
    }
  };

  const saveModel = async (modelId: number) => {
    const draft = modelDrafts[modelId];
    if (!draft) {
      return;
    }

    const displayName = draft.display_name.trim();
    if (!displayName) {
      setError('Display name cannot be empty');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`model-${modelId}`);

    try {
      const res = await fetch(`/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          display_name: displayName,
          enabled: draft.enabled,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to update model ${modelId}`));
        return;
      }

      setStatus(`Updated model ${modelId}`);
      await loadModels();
    } finally {
      setBusy(null);
    }
  };

  const saveRateLimits = async () => {
    const rpm = Number(rpmLimit);
    const tpm = Number(tpmLimit);

    if (!Number.isInteger(rpm) || rpm <= 0 || !Number.isInteger(tpm) || tpm <= 0) {
      setError('RPM and TPM must both be positive integers');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy('rate-limits');

    try {
      const res = await fetch('/api/admin/rate-limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: rpm,
          tpm_limit: tpm,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to update rate limits'));
        return;
      }

      const payload = body as { data?: RateLimitsPayload };
      setRateLimitsUpdatedAt(payload.data?.updated_at ?? null);
      setStatus('Rate limits updated');
    } finally {
      setBusy(null);
    }
  };

  const searchUsers = async () => {
    setStatus(null);
    setError(null);
    setBusy('users-search');

    try {
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
      setStatus('User list updated');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to search users');
    } finally {
      setBusy(null);
    }
  };

  const saveUserStatus = async (userId: string, status: 'active' | 'banned') => {
    setStatus(null);
    setError(null);
    setBusy(`user-status-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to update user ${userId}`));
        return;
      }

      setStatus(status === 'banned' ? 'User banned' : 'User reactivated');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const saveUserLimits = async (userId: string) => {
    const draft = userLimitDrafts[userId];
    if (!draft) {
      return;
    }

    const rpmRaw = draft.rpm_limit.trim();
    const tpmRaw = draft.tpm_limit.trim();

    const rpm = rpmRaw === '' ? null : Number(rpmRaw);
    const tpm = tpmRaw === '' ? null : Number(tpmRaw);

    if (
      (rpm !== null && (!Number.isInteger(rpm) || rpm <= 0)) ||
      (tpm !== null && (!Number.isInteger(tpm) || tpm <= 0))
    ) {
      setError('User override limits must be positive integers or blank');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`user-limits-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/limits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: rpm,
          tpm_limit: tpm,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to update limits for user ${userId}`));
        return;
      }

      setStatus('User limits updated');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const clearUserLimits = async (userId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`user-limits-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/limits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: null,
          tpm_limit: null,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to clear limits for user ${userId}`));
        return;
      }

      setStatus('User limit overrides cleared');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const setThrottleOverride = async (userId: string) => {
    const draft = throttleOverrideDrafts[userId] ?? {
      rpm_limit: '',
      tpm_limit: '',
      duration_minutes: '30',
    };
    const rpm = Number(draft.rpm_limit);
    const tpm = Number(draft.tpm_limit);
    const durationMinutes = Number(draft.duration_minutes);

    if (
      !Number.isInteger(rpm) ||
      rpm <= 0 ||
      !Number.isInteger(tpm) ||
      tpm <= 0 ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes <= 0
    ) {
      setError('Throttle override requires positive RPM, TPM, and duration minutes');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`throttle-override-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/throttle-override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: rpm,
          tpm_limit: tpm,
          duration_minutes: durationMinutes,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to set throttle override for user ${userId}`));
        return;
      }

      setStatus('Throttle override set');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const clearThrottleOverride = async (userId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`throttle-override-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/throttle-override`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to clear throttle override for user ${userId}`));
        return;
      }

      setStatus('Throttle override cleared');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const viewAbuseEvents = async (userId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`abuse-events-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/abuse-events?limit=40`, {
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to load abuse events for user ${userId}`));
        return;
      }

      const payload = body as { data?: AbuseEventItem[] };
      setSelectedEventUserId(userId);
      setSelectedUserEvents(Array.isArray(payload.data) ? payload.data : []);
      setStatus('Loaded abuse events');
    } finally {
      setBusy(null);
    }
  };

  const loadUserThreads = async (userId: string) => {
    const res = await fetch(`/api/admin/users/${userId}/threads`, {
      credentials: 'include',
    });

    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(parseError(body, `Failed to load threads for user ${userId}`));
    }

    const payload = body as { data?: AdminThreadItem[] };
    setChatThreads(Array.isArray(payload.data) ? payload.data : []);
  };

  const loadThreadMessages = async (params: {
    userId: string;
    threadId: string;
    cursor?: string | null;
    append?: boolean;
  }) => {
    const search = new URLSearchParams();
    search.set('limit', '100');
    if (params.cursor) {
      search.set('cursor', params.cursor);
    }

    const res = await fetch(
      `/api/admin/users/${params.userId}/threads/${params.threadId}/messages?${search.toString()}`,
      {
        credentials: 'include',
      },
    );

    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(parseError(body, `Failed to load messages for thread ${params.threadId}`));
    }

    const payload = body as {
      data?: AdminThreadMessageItem[];
      paging?: { next_cursor?: string | null };
    };
    const messages = Array.isArray(payload.data) ? payload.data : [];
    const nextCursor =
      payload.paging && typeof payload.paging.next_cursor === 'string'
        ? payload.paging.next_cursor
        : null;

    setChatMessages((previous) => (params.append ? [...previous, ...messages] : messages));
    setChatMessagesNextCursor(nextCursor);
  };

  const openUserChats = async (user: AdminUserItem) => {
    setStatus(null);
    setError(null);
    setBusy(`chat-threads-${user.id}`);
    setSelectedChatUser({ id: user.id, email: user.email });
    setSelectedChatThreadId(null);
    setChatMessages([]);
    setChatMessagesNextCursor(null);

    try {
      await loadUserThreads(user.id);
      setStatus(`Loaded chat threads for ${user.email}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load user chats');
      setSelectedChatUser(null);
      setChatThreads([]);
    } finally {
      setBusy(null);
    }
  };

  const openThreadMessages = async (userId: string, threadId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`chat-messages-${threadId}`);
    setSelectedChatThreadId(threadId);
    setChatMessages([]);
    setChatMessagesNextCursor(null);

    try {
      await loadThreadMessages({ userId, threadId, append: false });
      setStatus('Loaded thread messages');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load thread messages');
    } finally {
      setBusy(null);
    }
  };

  const loadMoreThreadMessages = async () => {
    if (!selectedChatUser || !selectedChatThreadId || !chatMessagesNextCursor) {
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`chat-messages-more-${selectedChatThreadId}`);

    try {
      await loadThreadMessages({
        userId: selectedChatUser.id,
        threadId: selectedChatThreadId,
        cursor: chatMessagesNextCursor,
        append: true,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load more messages');
    } finally {
      setBusy(null);
    }
  };

  const deleteUser = async (user: AdminUserItem) => {
    const confirmation = window.prompt(
      `Type "${user.email}" or "${user.id}" to confirm deleting this account`,
      '',
    );
    if (confirmation === null) {
      return;
    }

    const typed = confirmation.trim().toLowerCase();
    if (typed !== user.email.toLowerCase() && typed !== user.id.toLowerCase()) {
      setError('Confirmation mismatch. Deletion canceled.');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`user-delete-${user.id}`);

    try {
      const res = await fetch(`/api/admin/users/${user.id}/delete`, {
        method: 'POST',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to delete user ${user.id}`));
        return;
      }

      const payload = body as { data?: { revoked_session_count?: unknown } };
      const revokedSessionCount =
        typeof payload.data?.revoked_session_count === 'number' ? payload.data.revoked_session_count : 0;

      setStatus(`User soft-deleted. Revoked ${revokedSessionCount} active sessions.`);
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);

      if (selectedChatUser?.id === user.id) {
        await loadUserThreads(user.id);
        if (selectedChatThreadId) {
          await loadThreadMessages({ userId: user.id, threadId: selectedChatThreadId, append: false });
        }
      }
    } finally {
      setBusy(null);
    }
  };

  const restoreUser = async (user: AdminUserItem) => {
    setStatus(null);
    setError(null);
    setBusy(`user-restore-${user.id}`);

    try {
      const res = await fetch(`/api/admin/users/${user.id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `Failed to restore user ${user.id}`));
        return;
      }

      setStatus('User restored');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);

      if (selectedChatUser?.id === user.id) {
        await loadUserThreads(user.id);
        if (selectedChatThreadId) {
          await loadThreadMessages({ userId: user.id, threadId: selectedChatThreadId, append: false });
        }
      }
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <section className="panel page-loading">Loading admin console...</section>;
  }

  if (!authorized) {
    return (
      <section className="admin-page app-page">
        <MainHeader title="Admin" subtitle="Not Found" />
        <div className="page-stack">
          <div className="card">
            <p className="error">404 Not Found.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-page app-page">
      <MainHeader
        title="Admin"
        subtitle="Users, providers, model catalog, and global rate limits"
      />

      <div className="page-stack">
        <div className="card">
          <h2>Providers</h2>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createProvider();
            }}
          >
            <div className="stack-tight">
              <div className="notice">Create provider</div>

              <label>
                Code
                <input
                  value={createProviderDraft.code}
                  onChange={(event) =>
                    setCreateProviderDraft((previous) => ({
                      ...previous,
                      code: event.target.value,
                    }))
                  }
                  placeholder="openai"
                />
              </label>

              <label>
                Name
                <input
                  value={createProviderDraft.name}
                  onChange={(event) =>
                    setCreateProviderDraft((previous) => ({
                      ...previous,
                      name: event.target.value,
                    }))
                  }
                  placeholder="OpenAI"
                />
              </label>

              <label>
                Base URL
                <input
                  value={createProviderDraft.base_url}
                  onChange={(event) =>
                    setCreateProviderDraft((previous) => ({
                      ...previous,
                      base_url: event.target.value,
                    }))
                  }
                  placeholder="https://api.openai.com/v1"
                />
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={createProviderDraft.enabled}
                  onChange={(event) =>
                    setCreateProviderDraft((previous) => ({
                      ...previous,
                      enabled: event.target.checked,
                    }))
                  }
                />
                Enabled
              </label>

              <button className="primary" type="submit" disabled={busy !== null}>
                {busy === 'provider-create' ? 'Creating...' : 'Create provider'}
              </button>
            </div>
          </form>

          <hr />

          <div className="stack-tight">
            {providers.map((provider) => {
              const draft = providerDrafts[provider.id] ?? {
                code: provider.code,
                name: provider.name,
                base_url: provider.base_url,
                enabled: provider.enabled,
              };
              const secretDraft = providerSecretDrafts[provider.id] ?? '';
              return (
                <div key={provider.id} className="admin-item">
                  <div className="mono admin-item-title">
                    {provider.code} ({provider.enabled ? 'enabled' : 'disabled'})
                  </div>
                  <div className="notice">
                    Secret configured: {provider.has_secret ? 'yes' : 'no'}
                    {provider.secret_updated_at
                      ? ` (updated ${new Date(provider.secret_updated_at).toLocaleString()})`
                      : ''}
                  </div>

                  <label>
                    Code
                    <input
                      value={draft.code}
                      onChange={(event) =>
                        setProviderDrafts((previous) => ({
                          ...previous,
                          [provider.id]: {
                            ...draft,
                            code: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>

                  <label>
                    Name
                    <input
                      value={draft.name}
                      onChange={(event) =>
                        setProviderDrafts((previous) => ({
                          ...previous,
                          [provider.id]: {
                            ...draft,
                            name: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>

                  <label>
                    Base URL
                    <input
                      value={draft.base_url}
                      onChange={(event) =>
                        setProviderDrafts((previous) => ({
                          ...previous,
                          [provider.id]: {
                            ...draft,
                            base_url: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setProviderDrafts((previous) => ({
                          ...previous,
                          [provider.id]: {
                            ...draft,
                            enabled: event.target.checked,
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>

                  <div className="button-row">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void saveProvider(provider.id)}
                      disabled={busy !== null}
                    >
                      {busy === `provider-${provider.id}` ? 'Saving...' : 'Save provider'}
                    </button>

                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void toggleProviderEnabled(provider)}
                      disabled={busy !== null}
                    >
                      {busy === `provider-toggle-${provider.id}`
                        ? 'Saving...'
                        : provider.enabled
                          ? 'Disable'
                          : 'Enable'}
                    </button>
                  </div>

                  <label>
                    API key
                    <input
                      type="password"
                      value={secretDraft}
                      onChange={(event) =>
                        setProviderSecretDrafts((previous) => ({
                          ...previous,
                          [provider.id]: event.target.value,
                        }))
                      }
                      autoComplete="off"
                      placeholder="sk-..."
                    />
                  </label>

                  <button
                    type="button"
                    className="primary"
                    onClick={() => void saveProviderSecret(provider.id)}
                    disabled={busy !== null || !secretDraft.trim()}
                  >
                    {busy === `provider-secret-${provider.id}` ? 'Saving...' : 'Save API key'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <h2>Import and Publish Models</h2>

          <label>
            Provider
            <select value={importProviderId} onChange={(event) => setImportProviderId(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.code}
                </option>
              ))}
            </select>
          </label>

          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => void importModels()}
              disabled={busy !== null || !importProviderId}
            >
              {busy === 'import-models' ? 'Importing...' : 'Import upstream models'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void publishSelectedImportedModels()}
              disabled={busy !== null || selectedImportedModelIds.length === 0}
            >
              {busy === 'publish-imported' ? 'Publishing...' : 'Publish selected'}
            </button>
          </div>

          <label>
            Search imported models
            <input
              value={importSearch}
              onChange={(event) => setImportSearch(event.target.value)}
              placeholder="Filter by model ID or owner"
            />
          </label>

          <div className="allowlist-preview">
            {filteredImportedModels.length === 0 ? (
              <div className="notice">No imported models loaded</div>
            ) : (
              filteredImportedModels.map((item) => (
                <label key={item.model_id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(importSelection[item.model_id])}
                    onChange={(event) =>
                      setImportSelection((previous) => ({
                        ...previous,
                        [item.model_id]: event.target.checked,
                      }))
                    }
                  />
                  <span className="mono">{item.model_id}</span>
                  {item.owned_by ? <span className="notice">({item.owned_by})</span> : null}
                  {item.already_added ? (
                    <span className="notice">already published as {item.existing_public_id}</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <h2>Published Model Catalog</h2>

          <div className="stack-tight">
            {models.map((model) => {
              const draft = modelDrafts[model.id];
              if (!draft) {
                return null;
              }

              return (
                <div key={model.id} className="admin-item">
                  <div className="mono admin-item-title">
                    {model.public_id} ({model.provider}/{model.model_id})
                  </div>

                  <label>
                    Display name
                    <input
                      value={draft.display_name}
                      onChange={(event) =>
                        setModelDrafts((previous) => ({
                          ...previous,
                          [model.id]: {
                            ...previous[model.id],
                            display_name: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setModelDrafts((previous) => ({
                          ...previous,
                          [model.id]: {
                            ...previous[model.id],
                            enabled: event.target.checked,
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>

                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void saveModel(model.id)}
                    disabled={busy !== null}
                  >
                    {busy === `model-${model.id}` ? 'Saving...' : 'Save model'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <h2>Rate Limits</h2>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveRateLimits();
            }}
          >
            <label>
              Requests per minute (RPM) per user
              <input
                type="number"
                min={1}
                step={1}
                value={rpmLimit}
                onChange={(event) => setRpmLimit(event.target.value)}
              />
            </label>

            <label>
              Tokens per minute (TPM) per user
              <input
                type="number"
                min={1}
                step={1}
                value={tpmLimit}
                onChange={(event) => setTpmLimit(event.target.value)}
              />
            </label>

            <button className="primary" type="submit" disabled={busy !== null}>
              {busy === 'rate-limits' ? 'Saving...' : 'Save rate limits'}
            </button>
          </form>

          {rateLimitsUpdatedAt ? (
            <div className="notice">Last updated: {new Date(rateLimitsUpdatedAt).toLocaleString()}</div>
          ) : null}
        </div>

        <div className="card">
          <h2>Abuse Monitor</h2>
          <div className="notice">
            Suspicious users are scored by rule hits (RPM/TPM spikes, login brute force, stream abuse, IP/UA
            churn, and high error rates).
          </div>

          <div className="admin-users-table-wrap">
            <table className="admin-users-table admin-abuse-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Score</th>
                  <th>Rules</th>
                  <th>Last Seen</th>
                  <th>Action</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {suspiciousUsers.map((user) => {
                  const draft = throttleOverrideDrafts[user.id] ?? {
                    rpm_limit: '',
                    tpm_limit: '',
                    duration_minutes: '30',
                  };
                  const rowBusy =
                    busy === `user-status-${user.id}` ||
                    busy === `throttle-override-${user.id}` ||
                    busy === `abuse-events-${user.id}`;

                  return (
                    <tr key={`suspicious-${user.id}`}>
                      <td>
                        <div>{user.email}</div>
                        <div className="notice">
                          <span className={`admin-status-pill ${user.status}`}>
                            {user.status === 'active' ? 'active' : 'banned'}
                          </span>
                          {user.ban_expires_at ? ` until ${formatDateTime(user.ban_expires_at)}` : ''}
                        </div>
                      </td>
                      <td className="mono">{user.anomaly_score}</td>
                      <td>
                        <div className="notice">{summarizeRuleHits(user.last_rule_hits)}</div>
                        <div className="notice">
                          {user.last_rule_hits.length > 0
                            ? user.last_rule_hits
                                .slice(0, 3)
                                .map((hit) => `${hit.rule}:${hit.value}/${hit.threshold}`)
                                .join(' | ')
                            : '-'}
                        </div>
                      </td>
                      <td>
                        <div className="mono">{user.last_seen_ip ?? '-'}</div>
                        <div className="notice">{user.last_seen_ua ?? '-'}</div>
                        <div className="notice">{formatDateTime(user.last_seen_at)}</div>
                      </td>
                      <td>
                        <div>{user.last_action ?? 'none'}</div>
                        <div className="notice">{formatDateTime(user.last_action_at)}</div>
                        <div className="notice">
                          {user.throttle_source === 'none'
                            ? 'throttle: none'
                            : `throttle ${user.throttle_source} until ${formatDateTime(user.throttle_expires_at)}`}
                        </div>
                      </td>
                      <td>
                        <div className="admin-user-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null || user.status !== 'banned'}
                            onClick={() => void saveUserStatus(user.id, 'active')}
                          >
                            {rowBusy && busy === `user-status-${user.id}` ? 'Saving...' : 'Unban'}
                          </button>

                          <div className="admin-throttle-inputs">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              placeholder="Throttle RPM"
                              value={draft.rpm_limit}
                              onChange={(event) =>
                                setThrottleOverrideDrafts((previous) => ({
                                  ...previous,
                                  [user.id]: {
                                    ...(previous[user.id] ?? {
                                      rpm_limit: '',
                                      tpm_limit: '',
                                      duration_minutes: '30',
                                    }),
                                    rpm_limit: event.target.value,
                                  },
                                }))
                              }
                            />
                            <input
                              type="number"
                              min={1}
                              step={1}
                              placeholder="Throttle TPM"
                              value={draft.tpm_limit}
                              onChange={(event) =>
                                setThrottleOverrideDrafts((previous) => ({
                                  ...previous,
                                  [user.id]: {
                                    ...(previous[user.id] ?? {
                                      rpm_limit: '',
                                      tpm_limit: '',
                                      duration_minutes: '30',
                                    }),
                                    tpm_limit: event.target.value,
                                  },
                                }))
                              }
                            />
                            <input
                              type="number"
                              min={1}
                              step={1}
                              placeholder="Duration (min)"
                              value={draft.duration_minutes}
                              onChange={(event) =>
                                setThrottleOverrideDrafts((previous) => ({
                                  ...previous,
                                  [user.id]: {
                                    ...(previous[user.id] ?? {
                                      rpm_limit: '',
                                      tpm_limit: '',
                                      duration_minutes: '30',
                                    }),
                                    duration_minutes: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>

                          <div className="button-row">
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy !== null}
                              onClick={() => void setThrottleOverride(user.id)}
                            >
                              {rowBusy && busy === `throttle-override-${user.id}` ? 'Saving...' : 'Set throttle'}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy !== null}
                              onClick={() => void clearThrottleOverride(user.id)}
                            >
                              Clear throttle
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy !== null}
                              onClick={() => void viewAbuseEvents(user.id)}
                            >
                              {rowBusy && busy === `abuse-events-${user.id}` ? 'Loading...' : 'View events'}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {suspiciousUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="notice">
                      No suspicious users right now
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {selectedEventUserId ? (
            <div className="admin-events-panel">
              <div className="card-title-row">
                <strong>Recent Events for {selectedEventUserId}</strong>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setSelectedEventUserId(null);
                    setSelectedUserEvents([]);
                  }}
                >
                  Close
                </button>
              </div>
              <div className="allowlist-preview">
                {selectedUserEvents.map((event) => (
                  <div key={event.id} className="admin-event-item">
                    <div className="mono">
                      {event.event_type} @ {formatDateTime(event.created_at)}
                    </div>
                    <div className="notice">IP: {event.ip ?? '-'}</div>
                    <pre className="admin-event-metadata">
                      {JSON.stringify(event.metadata ?? {}, null, 2)}
                    </pre>
                  </div>
                ))}
                {selectedUserEvents.length === 0 ? <div className="notice">No events found</div> : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Users</h2>

          <form
            className="admin-user-search"
            onSubmit={(event) => {
              event.preventDefault();
              void searchUsers();
            }}
          >
            <label>
              Search users
              <input
                value={usersQuery}
                onChange={(event) => setUsersQuery(event.target.value)}
                placeholder="Search by email"
              />
            </label>
            <button type="submit" className="secondary" disabled={busy !== null}>
              {busy === 'users-search' ? 'Searching...' : 'Search'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy !== null}
              onClick={() => {
                setUsersQuery('');
                setStatus(null);
                setError(null);
                setBusy('users-search');
                void Promise.all([loadUsers(''), loadSuspiciousUsers('')])
                  .then(() => {
                    setStatus('User list updated');
                  })
                  .catch((requestError: unknown) => {
                    setError(
                      requestError instanceof Error ? requestError.message : 'Failed to load users',
                    );
                  })
                  .finally(() => {
                    setBusy(null);
                  });
              }}
            >
              Clear
            </button>
          </form>

          <div className="admin-users-table-wrap">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last Login</th>
                  <th>Last Login IP</th>
                  <th>RPM</th>
                  <th>TPM</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const draft = userLimitDrafts[user.id] ?? { rpm_limit: '', tpm_limit: '' };
                  const rowBusy =
                    busy === `user-status-${user.id}` ||
                    busy === `user-limits-${user.id}` ||
                    busy === `user-delete-${user.id}` ||
                    busy === `user-restore-${user.id}` ||
                    busy === `chat-threads-${user.id}`;

                  return (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        <span className={`admin-status-pill ${user.status}`}>
                          {user.status === 'active' ? 'active' : 'banned'}
                        </span>
                        {user.ban_expires_at ? (
                          <div className="notice">until {formatDateTime(user.ban_expires_at)}</div>
                        ) : null}
                        {user.deleted_at ? (
                          <div className="notice">
                            soft-deleted {formatDateTime(user.deleted_at)} ({user.deleted_reason ?? 'admin_delete'})
                          </div>
                        ) : null}
                      </td>
                      <td>{formatDateTime(user.created_at)}</td>
                      <td>{formatDateTime(user.last_login_at)}</td>
                      <td className="mono">{user.last_login_ip ?? '-'}</td>
                      <td className="mono">
                        {user.rpm_effective}
                        <div className="notice">
                          {user.rpm_override === null ? 'default' : `override ${user.rpm_override}`}
                        </div>
                      </td>
                      <td className="mono">
                        {user.tpm_effective}
                        <div className="notice">
                          {user.tpm_override === null ? 'default' : `override ${user.tpm_override}`}
                        </div>
                      </td>
                      <td>
                        <div className="admin-user-actions">
                          <div className="button-row">
                            <button
                              type="button"
                              className={user.status === 'banned' ? 'secondary' : 'danger'}
                              disabled={busy !== null}
                              onClick={() =>
                                void saveUserStatus(user.id, user.status === 'banned' ? 'active' : 'banned')
                              }
                            >
                              {rowBusy && busy === `user-status-${user.id}`
                                ? 'Saving...'
                                : user.status === 'banned'
                                  ? 'Unban'
                                  : 'Ban'}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={busy !== null || user.deleted_at !== null}
                              onClick={() => void deleteUser(user)}
                            >
                              {rowBusy && busy === `user-delete-${user.id}` ? 'Deleting...' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy !== null || user.deleted_at === null}
                              onClick={() => void restoreUser(user)}
                            >
                              {rowBusy && busy === `user-restore-${user.id}` ? 'Restoring...' : 'Restore'}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy !== null}
                              onClick={() => void openUserChats(user)}
                            >
                              {rowBusy && busy === `chat-threads-${user.id}` ? 'Loading...' : 'View chats'}
                            </button>
                          </div>

                          <div className="admin-limit-inputs">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              placeholder="RPM override"
                              value={draft.rpm_limit}
                              onChange={(event) =>
                                setUserLimitDrafts((previous) => ({
                                  ...previous,
                                  [user.id]: {
                                    ...(previous[user.id] ?? { rpm_limit: '', tpm_limit: '' }),
                                    rpm_limit: event.target.value,
                                  },
                                }))
                              }
                            />
                            <input
                              type="number"
                              min={1}
                              step={1}
                              placeholder="TPM override"
                              value={draft.tpm_limit}
                              onChange={(event) =>
                                setUserLimitDrafts((previous) => ({
                                  ...previous,
                                  [user.id]: {
                                    ...(previous[user.id] ?? { rpm_limit: '', tpm_limit: '' }),
                                    tpm_limit: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>

                          <div className="button-row">
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy !== null}
                              onClick={() => void saveUserLimits(user.id)}
                            >
                              {rowBusy && busy === `user-limits-${user.id}` ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={busy !== null}
                              onClick={() => void clearUserLimits(user.id)}
                            >
                              Clear override
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="notice">
                      No users found
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {selectedChatUser ? (
            <div className="admin-chat-viewer">
              <div className="card-title-row">
                <strong>Chat Records for {selectedChatUser.email}</strong>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setSelectedChatUser(null);
                    setChatThreads([]);
                    setSelectedChatThreadId(null);
                    setChatMessages([]);
                    setChatMessagesNextCursor(null);
                  }}
                >
                  Close
                </button>
              </div>

              <div className="admin-chat-layout">
                <div className="admin-chat-threads">
                  {chatThreads.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      className={`admin-chat-thread-button ${selectedChatThreadId === thread.id ? 'active' : ''}`}
                      disabled={busy !== null}
                      onClick={() => void openThreadMessages(selectedChatUser.id, thread.id)}
                    >
                      <span>{thread.title}</span>
                      <span className="notice">messages: {thread.msg_count}</span>
                      <span className="notice">updated: {formatDateTime(thread.updated_at)}</span>
                    </button>
                  ))}
                  {chatThreads.length === 0 ? (
                    <div className="notice admin-chat-empty">No threads found for this user.</div>
                  ) : null}
                </div>

                <div className="admin-chat-messages">
                  {!selectedChatThreadId ? (
                    <div className="notice admin-chat-empty">Select a thread to view messages.</div>
                  ) : (
                    <>
                      <div className="admin-chat-message-list">
                        {chatMessages.map((message) => (
                          <div key={message.id} className="admin-chat-message">
                            <div className="admin-chat-message-header">
                              <span className="mono">{message.role}</span>
                              <span className="notice">{formatDateTime(message.created_at)}</span>
                            </div>
                            <pre className="admin-chat-message-content">{message.content}</pre>
                            {message.attachments.length > 0 ? (
                              <div className="admin-chat-attachments">
                                {message.attachments.map((attachment) => (
                                  <a
                                    key={`${message.id}-${attachment.file_id}`}
                                    className="admin-chat-attachment"
                                    href={attachment.content_url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {attachment.filename} ({attachment.mime_type})
                                  </a>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                        {chatMessages.length === 0 ? (
                          <div className="notice admin-chat-empty">No messages found for this thread.</div>
                        ) : null}
                      </div>

                      {chatMessagesNextCursor ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy !== null}
                          onClick={() => void loadMoreThreadMessages()}
                        >
                          {busy === `chat-messages-more-${selectedChatThreadId}` ? 'Loading...' : 'Load more'}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
