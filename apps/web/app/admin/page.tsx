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

type RateLimitsPayload = {
  rpm_limit: number;
  tpm_limit: number;
  updated_at: string;
};

type AdminUserItem = {
  id: string;
  email: string;
  status: 'active' | 'banned';
  created_at: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  rpm_override: number | null;
  tpm_override: number | null;
  rpm_effective: number;
  tpm_effective: number;
};

type UserLimitDraft = {
  rpm_limit: string;
  tpm_limit: string;
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

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [providerBaseUrlDrafts, setProviderBaseUrlDrafts] = useState<Record<number, string>>({});
  const [providerSecretDrafts, setProviderSecretDrafts] = useState<Record<number, string>>({});

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
    setProviderBaseUrlDrafts(
      Object.fromEntries(payload.data.map((item) => [item.id, item.base_url])),
    );
    setProviderSecretDrafts(
      Object.fromEntries(payload.data.map((item) => [item.id, ''])),
    );

    if (!importProviderId && payload.data.length > 0) {
      setImportProviderId(String(payload.data[0]!.id));
    }
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

  const reloadAll = async () => {
    await Promise.all([loadProviders(), loadModels(), loadRateLimits(), loadUsers(usersQuery)]);
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

  const saveProviderBaseUrl = async (providerId: number) => {
    const baseUrl = (providerBaseUrlDrafts[providerId] ?? '').trim();
    if (!baseUrl) {
      setError('Base URL is required');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`provider-base-${providerId}`);

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/base_url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ base_url: baseUrl }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, 'Failed to update provider base URL'));
        return;
      }

      setStatus('Provider base URL updated');
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
        method: 'PUT',
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
      await loadUsers(usersQuery);
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
      await loadUsers(usersQuery);
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
      await loadUsers(usersQuery);
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
      await loadUsers(usersQuery);
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
          <div className="stack-tight">
            {providers.map((provider) => {
              const baseUrlDraft = providerBaseUrlDrafts[provider.id] ?? provider.base_url;
              const secretDraft = providerSecretDrafts[provider.id] ?? '';
              return (
                <div key={provider.id} className="admin-item">
                  <div className="mono admin-item-title">
                    {provider.code} ({provider.enabled ? 'enabled' : 'disabled'})
                  </div>
                  <div className="notice">Secret configured: {provider.has_secret ? 'yes' : 'no'}</div>

                  <label>
                    Base URL
                    <input
                      value={baseUrlDraft}
                      onChange={(event) =>
                        setProviderBaseUrlDrafts((previous) => ({
                          ...previous,
                          [provider.id]: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void saveProviderBaseUrl(provider.id)}
                    disabled={busy !== null}
                  >
                    {busy === `provider-base-${provider.id}` ? 'Saving...' : 'Save base URL'}
                  </button>

                  <label>
                    API key
                    <input
                      value={secretDraft}
                      onChange={(event) =>
                        setProviderSecretDrafts((previous) => ({
                          ...previous,
                          [provider.id]: event.target.value,
                        }))
                      }
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
                void loadUsers('')
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
                  const rowBusy = busy === `user-status-${user.id}` || busy === `user-limits-${user.id}`;

                  return (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        <span className={`admin-status-pill ${user.status}`}>
                          {user.status === 'active' ? 'active' : 'banned'}
                        </span>
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
        </div>

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
