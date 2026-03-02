'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type MePayload = {
  id: string;
  email: string;
  default_provider: string;
  default_model: string | null;
  is_admin: boolean;
  admin_enabled: boolean;
};

type KeyItem = {
  provider: string;
  enabled: boolean;
  has_key: boolean;
  masked_key: string | null;
};

type AllowedModelItem = {
  id: string;
  provider: string;
  display_name?: string | null;
};

type ModelsPayload = {
  data: Array<{ id?: string; provider?: string; display_name?: string | null }>;
};

function parseErrorMessage(payload: unknown, fallback: string): string {
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

function makeModelLabel(model: AllowedModelItem): string {
  const displayName = model.display_name?.trim();
  return displayName ? `${displayName} (${model.id})` : model.id;
}

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<MePayload | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [allowedModels, setAllowedModels] = useState<AllowedModelItem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providersWithModels = useMemo(() => {
    return Array.from(new Set(allowedModels.map((model) => model.provider))).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [allowedModels]);

  const modelsForDefaultProvider = useMemo(() => {
    return allowedModels.filter((model) => model.provider === defaultProvider);
  }, [allowedModels, defaultProvider]);

  const modelsForDisplay = useMemo(() => {
    return [...allowedModels].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );
  }, [allowedModels]);

  const loadAllowedModels = async (nextMe?: MePayload | null) => {
    const res = await fetch('/api/v1/models', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseErrorMessage(body, 'Failed to load models'));
    }

    const payload = (await res.json()) as ModelsPayload;
    const list = payload.data
      .filter((item): item is { id: string; provider: string; display_name?: string | null } => {
        return typeof item.id === 'string' && typeof item.provider === 'string';
      })
      .map((item) => ({
        id: item.id,
        provider: item.provider,
        display_name: item.display_name ?? null,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

    setAllowedModels(list);

    const modelProviders = Array.from(new Set(list.map((item) => item.provider)));
    const mePayload = nextMe ?? me;

    const preferredProvider =
      mePayload && modelProviders.includes(mePayload.default_provider)
        ? mePayload.default_provider
        : modelProviders[0] ?? '';
    setDefaultProvider(preferredProvider);

    const matchingModels = list.filter((item) => item.provider === preferredProvider);
    const preferredModel =
      mePayload?.default_model && matchingModels.some((item) => item.id === mePayload.default_model)
        ? mePayload.default_model
        : matchingModels[0]?.id ?? '';
    setDefaultModel(preferredModel);

    return list;
  };

  const load = async () => {
    setError(null);

    const meRes = await fetch('/api/me', { credentials: 'include' });
    if (meRes.status === 401) {
      router.replace('/login');
      return;
    }

    if (!meRes.ok) {
      setError('Failed to load profile');
      return;
    }

    const meBody = (await meRes.json()) as MePayload;
    setMe(meBody);

    const keyRes = await fetch('/api/me/keys', { credentials: 'include' });
    if (keyRes.ok) {
      const keyBody = (await keyRes.json()) as { data: KeyItem[] };
      setKeys(keyBody.data);

      const firstEnabledProvider = keyBody.data.find((item) => item.enabled)?.provider;
      setProvider(firstEnabledProvider ?? keyBody.data[0]?.provider ?? 'openai');
    }

    try {
      await loadAllowedModels(meBody);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load models');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!defaultProvider) {
      return;
    }

    const providerModels = allowedModels.filter((model) => model.provider === defaultProvider);
    if (providerModels.length === 0) {
      setDefaultModel('');
      return;
    }

    if (!providerModels.some((model) => model.id === defaultModel)) {
      setDefaultModel(providerModels[0]!.id);
    }
  }, [allowedModels, defaultProvider, defaultModel]);

  const saveKey = async () => {
    setStatus(null);
    setError(null);

    const res = await fetch('/api/me/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider, apiKey }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseErrorMessage(body, 'Failed to save key'));
      return;
    }

    setApiKey('');
    setStatus('Provider key saved');
    await load();
  };

  const saveDefaults = async () => {
    setStatus(null);
    setError(null);

    if (!defaultProvider || !defaultModel) {
      setError('Select both provider and model from the admin allowlist');
      return;
    }

    const res = await fetch('/api/me/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider: defaultProvider, model: defaultModel }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseErrorMessage(body, 'Failed to save defaults'));
      return;
    }

    setStatus('Default provider/model updated');
    await load();
  };

  const refreshModels = async () => {
    setStatus(null);
    setError(null);

    try {
      const models = await loadAllowedModels();
      setStatus(`Loaded ${models.length} allowed model entries`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load models');
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
  };

  return (
    <section style={{ display: 'grid', gap: '1rem' }}>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Settings</h1>
        <p className="notice">
          {me ? (
            <>
              Signed in as <span className="mono">{me.email}</span>
            </>
          ) : (
            'Loading profile...'
          )}
        </p>
        <button type="button" className="ghost" onClick={logout}>
          Logout
        </button>
      </div>

      <div className="panel" style={{ display: 'grid', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>Provider API Keys (BYOK)</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <label>
            Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {keys
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.provider} value={item.provider}>
                    {item.provider}
                  </option>
                ))}
            </select>
          </label>
          <label>
            API key
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              required
            />
          </label>
          <button className="primary" type="submit" disabled={!provider}>
            Save key
          </button>
        </form>
        <div>
          {keys.map((item) => (
            <div key={item.provider} className="notice">
              <span className="mono">{item.provider}</span> ({item.enabled ? 'enabled' : 'disabled'}):{' '}
              {item.has_key ? item.masked_key : 'not set'}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ display: 'grid', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>Default Provider and Model</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveDefaults();
          }}
        >
          <label>
            Default provider
            <select
              value={defaultProvider}
              onChange={(event) => setDefaultProvider(event.target.value)}
            >
              {providersWithModels.map((providerCode) => (
                <option key={providerCode} value={providerCode}>
                  {providerCode}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default model
            <select
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
              disabled={!defaultProvider || modelsForDefaultProvider.length === 0}
            >
              {modelsForDefaultProvider.length === 0 ? (
                <option value="">No allowed models for this provider</option>
              ) : (
                modelsForDefaultProvider.map((model) => (
                  <option key={`${model.provider}:${model.id}`} value={model.id}>
                    {makeModelLabel(model)}
                  </option>
                ))
              )}
            </select>
          </label>
          <button className="primary" type="submit" disabled={!defaultProvider || !defaultModel}>
            Save defaults
          </button>
        </form>

        <div>
          <button className="secondary" type="button" onClick={() => void refreshModels()}>
            Refresh allowed models
          </button>
          <div style={{ marginTop: '.75rem', maxHeight: 180, overflow: 'auto' }}>
            {modelsForDisplay.map((model) => (
              <div key={`${model.provider}:${model.id}`} className="notice">
                <span className="mono">{model.provider}</span>/{makeModelLabel(model)}
              </div>
            ))}
          </div>
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
