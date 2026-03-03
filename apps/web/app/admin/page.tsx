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

  const reloadAll = async () => {
    await Promise.all([loadProviders(), loadModels(), loadRateLimits()]);
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
      <MainHeader title="Admin" subtitle="Platform providers, model catalog, and rate limits" />

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

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
