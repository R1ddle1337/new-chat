'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  ImportedModelItem,
  ModelDraft,
  ModelItem,
  ProviderItem,
} from '../_components/types';
import { parseError } from '../_components/utils';

export default function AdminModelsPage() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelDrafts, setModelDrafts] = useState<Record<number, ModelDraft>>({});

  const [importProviderId, setImportProviderId] = useState('');
  const [importedModels, setImportedModels] = useState<ImportedModelItem[]>([]);
  const [importSelection, setImportSelection] = useState<Record<string, boolean>>({});
  const [importSearch, setImportSearch] = useState('');

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

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        await Promise.all([loadProviders(), loadModels()]);
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : 'Failed to load models page');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

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

  return (
    <>
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
          {models.length === 0 ? <div className="notice">No models published yet.</div> : null}
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
