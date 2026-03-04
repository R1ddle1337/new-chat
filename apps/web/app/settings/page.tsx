'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { readStreamResponsesPreference, writeStreamResponsesPreference } from '../components/chat-preferences';
import MainHeader from '../components/main-header';

type MePayload = {
  id: string;
  email: string;
  default_model: string | null;
  is_admin: boolean;
};

type AllowedModelItem = {
  id: string;
  display_name?: string | null;
};

type ModelsPayload = {
  data: Array<{ id?: string; display_name?: string | null }>;
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
  const [allowedModels, setAllowedModels] = useState<AllowedModelItem[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [streamResponses, setStreamResponses] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasModels = allowedModels.length > 0;

  const sortedModels = useMemo(() => {
    return [...allowedModels].sort((a, b) => {
      const labelA = (a.display_name ?? a.id).toLowerCase();
      const labelB = (b.display_name ?? b.id).toLowerCase();
      if (labelA !== labelB) {
        return labelA.localeCompare(labelB);
      }
      return a.id.localeCompare(b.id);
    });
  }, [allowedModels]);

  const loadAllowedModels = async (): Promise<AllowedModelItem[]> => {
    const res = await fetch('/api/v1/models', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseErrorMessage(body, 'Failed to load models'));
    }

    const payload = (await res.json()) as ModelsPayload;
    const models = payload.data
      .filter((item): item is { id: string; display_name?: string | null } => {
        return typeof item.id === 'string';
      })
      .map((item) => ({
        id: item.id,
        display_name: item.display_name ?? null,
      }));

    setAllowedModels(models);
    return models;
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

    try {
      const models = await loadAllowedModels();
      if (meBody.default_model && models.some((model) => model.id === meBody.default_model)) {
        setDefaultModel(meBody.default_model);
      } else {
        setDefaultModel(models[0]?.id ?? '');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load models');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setStreamResponses(readStreamResponsesPreference());
  }, []);

  useEffect(() => {
    if (!defaultModel && sortedModels.length > 0) {
      setDefaultModel(sortedModels[0]!.id);
      return;
    }

    if (defaultModel && !sortedModels.some((model) => model.id === defaultModel)) {
      setDefaultModel(sortedModels[0]?.id ?? '');
    }
  }, [defaultModel, sortedModels]);

  const saveDefaultModel = async () => {
    setStatus(null);
    setError(null);

    if (!defaultModel) {
      setError('Select a model first');
      return;
    }

    const res = await fetch('/api/me/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ model: defaultModel }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      setError(parseErrorMessage(body, 'Failed to save default model'));
      return;
    }

    setStatus('Default model updated');
    await load();
  };

  const refreshModels = async () => {
    setStatus(null);
    setError(null);

    try {
      const models = await loadAllowedModels();
      setStatus(`Loaded ${models.length} published models`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load models');
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
  };

  const toggleStreamResponses = (nextValue: boolean) => {
    setStreamResponses(nextValue);
    writeStreamResponsesPreference(nextValue);
  };

  return (
    <section className="settings-page app-page">
      <MainHeader
        title="Settings"
        subtitle={
          me ? (
            <>
              Signed in as <span className="mono">{me.email}</span>
            </>
          ) : (
            'Loading profile...'
          )
        }
      />

      <div className="page-stack">
        <div className="card">
          <div className="card-title-row">
            <h2>Account</h2>
            <button type="button" className="ghost" onClick={logout}>
              Logout
            </button>
          </div>
          <p className="notice">Session is cookie-based and scoped to this web app origin.</p>
        </div>

        <div className="card">
          <h2>Default Model</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveDefaultModel();
            }}
          >
            <label>
              Published model
              <select
                value={defaultModel}
                onChange={(event) => setDefaultModel(event.target.value)}
                disabled={!hasModels}
              >
                {!hasModels ? (
                  <option value="">No published models</option>
                ) : (
                  sortedModels.map((modelItem) => (
                    <option key={modelItem.id} value={modelItem.id}>
                      {makeModelLabel(modelItem)}
                    </option>
                  ))
                )}
              </select>
            </label>

            <button className="primary" type="submit" disabled={!defaultModel}>
              Save default model
            </button>
          </form>

          <div className="stack-tight">
            <button className="secondary" type="button" onClick={() => void refreshModels()}>
              Refresh published models
            </button>
            <div className="allowlist-preview">
              {sortedModels.map((modelItem) => (
                <div key={modelItem.id} className="notice">
                  {makeModelLabel(modelItem)}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Chat</h2>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={streamResponses}
              onChange={(event) => toggleStreamResponses(event.target.checked)}
            />
            <span>Stream responses</span>
          </label>
          <p className="notice">When enabled, assistant responses render incrementally in chat.</p>
        </div>

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
