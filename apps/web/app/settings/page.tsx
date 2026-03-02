'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type MePayload = {
  id: string;
  email: string;
  default_provider: string;
  default_model: string | null;
};

type KeyItem = {
  provider: string;
  has_key: boolean;
  masked_key: string | null;
};

type ModelsPayload = {
  data: Array<{ id?: string; provider?: string }>;
};

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<MePayload | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('openai');
  const [defaultModel, setDefaultModel] = useState('');
  const [models, setModels] = useState<Array<{ id: string; provider: string }>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setDefaultProvider(meBody.default_provider);
    setDefaultModel(meBody.default_model ?? '');

    const keyRes = await fetch('/api/me/keys', { credentials: 'include' });
    if (keyRes.ok) {
      const keyBody = (await keyRes.json()) as { data: KeyItem[] };
      setKeys(keyBody.data);
    }
  };

  useEffect(() => {
    void load();
  }, []);

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
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'Failed to save key');
      return;
    }

    setApiKey('');
    setStatus('Provider key saved');
    await load();
  };

  const saveDefaults = async () => {
    setStatus(null);
    setError(null);

    const res = await fetch('/api/me/provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider: defaultProvider, model: defaultModel || null }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'Failed to save defaults');
      return;
    }

    setStatus('Default provider/model updated');
    await load();
  };

  const loadModels = async () => {
    setStatus(null);
    setError(null);

    const res = await fetch('/api/v1/models', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'Failed to load models');
      return;
    }

    const payload = (await res.json()) as ModelsPayload;
    const list = payload.data
      .filter((item): item is { id: string; provider: string } => {
        return typeof item.id === 'string' && typeof item.provider === 'string';
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

    setModels(list);
    setStatus(`Loaded ${list.length} model entries`);
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
              <option value="openai">openai</option>
              <option value="grok2api">grok2api</option>
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
          <button className="primary" type="submit">
            Save key
          </button>
        </form>
        <div>
          {keys.map((item) => (
            <div key={item.provider} className="notice">
              <span className="mono">{item.provider}</span>: {item.has_key ? item.masked_key : 'not set'}
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
              <option value="openai">openai</option>
              <option value="grok2api">grok2api</option>
            </select>
          </label>
          <label>
            Default model
            <input
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
              placeholder="gpt-4o-mini"
            />
          </label>
          <button className="primary" type="submit">
            Save defaults
          </button>
        </form>

        <div>
          <button className="secondary" type="button" onClick={() => void loadModels()}>
            Refresh models from providers
          </button>
          <div style={{ marginTop: '.75rem', maxHeight: 180, overflow: 'auto' }}>
            {models.map((model) => (
              <div key={`${model.provider}:${model.id}`} className="notice">
                <span className="mono">{model.provider}</span>/{model.id}
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
