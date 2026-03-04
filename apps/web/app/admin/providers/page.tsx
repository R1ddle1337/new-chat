'use client';

import { useEffect, useState } from 'react';
import type { CreateProviderDraft, ProviderDraft, ProviderItem } from '../_components/types';
import {
  normalizeProviderBaseUrl,
  normalizeProviderCode,
  parseError,
} from '../_components/utils';

const initialCreateProviderDraft: CreateProviderDraft = {
  code: '',
  name: '',
  base_url: '',
  enabled: true,
  api_key: '',
};

export default function AdminProvidersPage() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<number, ProviderDraft>>({});
  const [providerSecretDrafts, setProviderSecretDrafts] = useState<Record<number, string>>({});
  const [createProviderDraft, setCreateProviderDraft] =
    useState<CreateProviderDraft>(initialCreateProviderDraft);

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createProviderBusy, setCreateProviderBusy] = useState(false);

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
    setProviderSecretDrafts(Object.fromEntries(payload.data.map((item) => [item.id, ''])));
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        await loadProviders();
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : 'Failed to load providers');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const validateProviderDraft = (draft: ProviderDraft, providerId?: number) => {
    const code = normalizeProviderCode(draft.code);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      setError('Provider ID must be 1-64 chars: lowercase letters, numbers, "_" or "-"');
      return null;
    }

    const duplicate = providers.some((provider) => {
      if (typeof providerId === 'number' && provider.id === providerId) {
        return false;
      }
      return provider.code.toLowerCase() === code;
    });
    if (duplicate) {
      setError(`Provider ID "${code}" already exists`);
      return null;
    }

    const name = draft.name.trim();
    if (!name || name.length > 120) {
      setError('Display name must be non-empty and at most 120 characters');
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
    if (createProviderBusy) {
      return;
    }

    const payload = validateProviderDraft(createProviderDraft);
    if (!payload) {
      return;
    }

    const apiKey = createProviderDraft.api_key.trim();

    setStatus(null);
    setError(null);
    setCreateProviderBusy(true);

    try {
      const res = await fetch('/api/admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => null)) as { data?: { id?: unknown } } | null;
      if (!res.ok) {
        setError(parseError(body, 'Failed to create provider'));
        return;
      }

      const providerId =
        typeof body?.data?.id === 'number' && Number.isInteger(body.data.id) ? body.data.id : null;
      let providerStatus = `Provider "${payload.code}" created`;
      let providerError: string | null = null;

      if (apiKey) {
        if (!providerId) {
          providerError =
            'Provider was created, but API key was not saved because the provider ID was missing from the create response';
        } else {
          const secretRes = await fetch(`/api/admin/providers/${providerId}/secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ api_key: apiKey }),
          });
          const secretBody = (await secretRes.json().catch(() => null)) as unknown;

          if (!secretRes.ok) {
            providerError = `Provider was created, but API key save failed: ${parseError(secretBody, 'Failed to update provider secret')}`;
          } else {
            providerStatus = `Provider "${payload.code}" created and API key saved`;
          }
        }
      }

      setCreateProviderDraft(initialCreateProviderDraft);
      setStatus(providerStatus);
      setError(providerError);
      await loadProviders();
    } finally {
      setCreateProviderBusy(false);
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

  return (
    <>
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
              Provider ID (code)
              <div className="notice">Stable unique machine identifier.</div>
              <input
                value={createProviderDraft.code}
                disabled={createProviderBusy}
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
              Display name
              <input
                value={createProviderDraft.name}
                disabled={createProviderBusy}
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
                disabled={createProviderBusy}
                onChange={(event) =>
                  setCreateProviderDraft((previous) => ({
                    ...previous,
                    base_url: event.target.value,
                  }))
                }
                placeholder="https://api.openai.com/v1"
              />
            </label>

            <label>
              API key (optional)
              <input
                type="password"
                value={createProviderDraft.api_key}
                disabled={createProviderBusy}
                onChange={(event) =>
                  setCreateProviderDraft((previous) => ({
                    ...previous,
                    api_key: event.target.value,
                  }))
                }
                autoComplete="off"
                placeholder="sk-..."
              />
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={createProviderDraft.enabled}
                disabled={createProviderBusy}
                onChange={(event) =>
                  setCreateProviderDraft((previous) => ({
                    ...previous,
                    enabled: event.target.checked,
                  }))
                }
              />
              Enabled
            </label>

            <button className="primary" type="submit" disabled={createProviderBusy}>
              {createProviderBusy ? 'Creating...' : 'Create provider'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Existing providers</h2>

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
                  Provider ID (code)
                  <div className="notice">Stable unique machine identifier.</div>
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
                  Display name
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
          {providers.length === 0 ? <div className="notice">No providers found.</div> : null}
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
