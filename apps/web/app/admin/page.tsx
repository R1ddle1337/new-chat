'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import MainHeader from '../components/main-header';

type MePayload = {
  is_admin: boolean;
  admin_enabled: boolean;
};

type ProviderItem = {
  id: number;
  code: string;
  name: string;
  base_url: string;
  enabled: boolean;
};

type ModelItem = {
  id: number;
  provider: string;
  provider_id: number;
  model_id: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
};

type ProviderDraft = {
  base_url: string;
  enabled: boolean;
};

type ModelDraft = {
  display_name: string;
  enabled: boolean;
};

function parseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') {
    return record.error;
  }

  return fallback;
}

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderDraft>>({});
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelDrafts, setModelDrafts] = useState<Record<number, ModelDraft>>({});
  const [newProvider, setNewProvider] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newEnabled, setNewEnabled] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerCodes = useMemo(() => providers.map((provider) => provider.code), [providers]);

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
        payload.data.map((providerItem) => [
          providerItem.code,
          {
            base_url: providerItem.base_url,
            enabled: providerItem.enabled,
          },
        ]),
      ),
    );
  };

  const loadModels = async () => {
    const res = await fetch('/api/admin/models', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, 'Failed to load allowed models'));
    }

    const payload = (await res.json()) as { data: ModelItem[] };
    setModels(payload.data);
    setModelDrafts(
      Object.fromEntries(
        payload.data.map((modelItem) => [
          modelItem.id,
          {
            display_name: modelItem.display_name ?? '',
            enabled: modelItem.enabled,
          },
        ]),
      ),
    );
  };

  const reloadAll = async () => {
    await Promise.all([loadProviders(), loadModels()]);
  };

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      setStatus(null);

      const meRes = await fetch('/api/me', { credentials: 'include' });
      if (meRes.status === 401) {
        router.replace('/login');
        return;
      }

      if (!meRes.ok) {
        setError('Failed to load session');
        setAuthorized(false);
        setLoading(false);
        return;
      }

      const me = (await meRes.json()) as MePayload;
      if (!me.admin_enabled || !me.is_admin) {
        setAuthorized(false);
        setLoading(false);
        return;
      }

      setAuthorized(true);

      try {
        await reloadAll();
        setStatus('Admin data loaded');
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load admin data');
      } finally {
        setLoading(false);
      }
    };

    void bootstrap();
  }, [router]);

  useEffect(() => {
    if (!newProvider && providerCodes.length > 0) {
      setNewProvider(providerCodes[0]!);
    }
  }, [newProvider, providerCodes]);

  const saveProvider = async (providerCode: string) => {
    const draft = providerDrafts[providerCode];
    if (!draft) {
      return;
    }

    setStatus(null);
    setError(null);

    const res = await fetch(`/api/admin/providers/${providerCode}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        base_url: draft.base_url,
        enabled: draft.enabled,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseError(body, `Failed to update provider ${providerCode}`));
      return;
    }

    setStatus(`Updated provider ${providerCode}`);
    await reloadAll();
  };

  const createModel = async () => {
    const provider = newProvider.trim();
    const modelId = newModelId.trim();
    if (!provider || !modelId) {
      setError('provider and model_id are required');
      return;
    }

    setStatus(null);
    setError(null);

    const res = await fetch('/api/admin/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        provider,
        model_id: modelId,
        display_name: newDisplayName.trim() || null,
        enabled: newEnabled,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseError(body, 'Failed to create allowed model'));
      return;
    }

    setNewModelId('');
    setNewDisplayName('');
    setNewEnabled(true);
    setStatus('Allowed model created');
    await reloadAll();
  };

  const saveModel = async (modelId: number) => {
    const draft = modelDrafts[modelId];
    if (!draft) {
      return;
    }

    setStatus(null);
    setError(null);

    const res = await fetch(`/api/admin/models/${modelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        display_name: draft.display_name.trim() || null,
        enabled: draft.enabled,
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseError(body, `Failed to update model ${modelId}`));
      return;
    }

    setStatus(`Updated model ${modelId}`);
    await reloadAll();
  };

  const deleteModel = async (modelId: number) => {
    const confirmed = window.confirm('Delete this allowed model?');
    if (!confirmed) {
      return;
    }

    setStatus(null);
    setError(null);

    const res = await fetch(`/api/admin/models/${modelId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseError(body, `Failed to delete model ${modelId}`));
      return;
    }

    setStatus(`Deleted model ${modelId}`);
    await reloadAll();
  };

  if (loading) {
    return <section className="panel page-loading">Loading admin console...</section>;
  }

  if (!authorized) {
    return (
      <section className="admin-page app-page">
        <MainHeader title="Admin" subtitle="Restricted" />
        <div className="page-stack">
          <div className="card">
            <p className="error">403 Forbidden. Admin access requires ADMIN_EMAIL and matching user.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-page app-page">
      <MainHeader title="Admin" subtitle="Manage provider base URLs and model allowlist" />

      <div className="page-stack">
        <div className="card">
          <h2>Providers</h2>
          <div className="stack-tight">
            {providers.map((providerItem) => {
              const draft = providerDrafts[providerItem.code];
              if (!draft) {
                return null;
              }

              return (
                <div key={providerItem.code} className="admin-item">
                  <div className="mono admin-item-title">{providerItem.code}</div>

                  <label>
                    Base URL
                    <input
                      value={draft.base_url}
                      onChange={(event) =>
                        setProviderDrafts((previous) => ({
                          ...previous,
                          [providerItem.code]: {
                            ...previous[providerItem.code],
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
                          [providerItem.code]: {
                            ...previous[providerItem.code],
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
                    onClick={() => void saveProvider(providerItem.code)}
                  >
                    Save provider
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <h2>Allowed Models</h2>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createModel();
            }}
          >
            <label>
              Provider
              <select value={newProvider} onChange={(event) => setNewProvider(event.target.value)}>
                {providerCodes.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Model ID
              <input
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
                placeholder="gpt-4o-mini"
                required
              />
            </label>

            <label>
              Display name (optional)
              <input
                value={newDisplayName}
                onChange={(event) => setNewDisplayName(event.target.value)}
                placeholder="GPT-4o Mini"
              />
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={newEnabled}
                onChange={(event) => setNewEnabled(event.target.checked)}
              />
              Enabled
            </label>

            <button className="primary" type="submit">
              Add allowed model
            </button>
          </form>

          <div className="stack-tight">
            {models.map((modelItem) => {
              const draft = modelDrafts[modelItem.id];
              if (!draft) {
                return null;
              }

              return (
                <div key={modelItem.id} className="admin-item">
                  <div className="mono admin-item-title">
                    {modelItem.provider}/{modelItem.model_id}
                  </div>

                  <label>
                    Display name
                    <input
                      value={draft.display_name}
                      onChange={(event) =>
                        setModelDrafts((previous) => ({
                          ...previous,
                          [modelItem.id]: {
                            ...previous[modelItem.id],
                            display_name: event.target.value,
                          },
                        }))
                      }
                      placeholder="Optional label"
                    />
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setModelDrafts((previous) => ({
                          ...previous,
                          [modelItem.id]: {
                            ...previous[modelItem.id],
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
                      onClick={() => void saveModel(modelItem.id)}
                    >
                      Save model
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void deleteModel(modelItem.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
