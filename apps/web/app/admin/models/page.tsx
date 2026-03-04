'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  ImportedModelItem,
  ModelDraft,
  ModelItem,
  ProviderItem,
} from '../_components/types';
import { parseError } from '../_components/utils';

type ModelActionBusy = 'save-name' | 'enable' | 'disable' | 'delete';

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
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState<Record<number, ModelActionBusy>>({});

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
      throw new Error(parseError(body, '加载提供商失败'));
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
      throw new Error(parseError(body, '加载模型目录失败'));
    }

    const payload = (await res.json()) as { data: ModelItem[] };
    setModels(payload.data);
    setModelDrafts(
      Object.fromEntries(
        payload.data.map((item) => [
          item.id,
          {
            display_name: item.display_name,
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
        setError(requestError instanceof Error ? requestError.message : '加载模型页面失败');
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
      setError('请选择要导入的提供商');
      return;
    }

    setStatus(null);
    setError(null);
    setCatalogBusy('import-models');

    try {
      const res = await fetch('/api/admin/models/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider_id: providerId }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, '从提供商导入模型失败'));
        return;
      }

      const payload = body as { data?: ImportedModelItem[] };
      const items = Array.isArray(payload.data) ? payload.data : [];
      setImportedModels(items);
      setImportSelection({});
      setImportSearch('');
      setStatus(`已导入 ${items.length} 个上游模型`);
    } finally {
      setCatalogBusy(null);
    }
  };

  const publishSelectedImportedModels = async () => {
    const providerId = Number(importProviderId);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      setError('请先选择提供商');
      return;
    }

    if (selectedImportedModelIds.length === 0) {
      setError('请至少选择一个要发布的模型');
      return;
    }

    setStatus(null);
    setError(null);
    setCatalogBusy('publish-imported');

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
        setError(parseError(body, '发布所选模型失败'));
        return;
      }

      const payload = body as { created_count?: unknown; requested_count?: unknown };
      const createdCount = typeof payload.created_count === 'number' ? payload.created_count : 0;
      const requestedCount =
        typeof payload.requested_count === 'number'
          ? payload.requested_count
          : selectedImportedModelIds.length;

      setStatus(`已发布 ${createdCount} 个模型（已选择 ${requestedCount} 个）`);
      setImportSelection({});
      await loadModels();
    } finally {
      setCatalogBusy(null);
    }
  };

  const withModelBusy = async (
    modelId: number,
    action: ModelActionBusy,
    task: () => Promise<void>,
  ) => {
    setModelBusy((previous) => ({
      ...previous,
      [modelId]: action,
    }));

    try {
      await task();
    } finally {
      setModelBusy((previous) => {
        const next = { ...previous };
        delete next[modelId];
        return next;
      });
    }
  };

  const saveModelDisplayName = async (modelId: number) => {
    const draft = modelDrafts[modelId];
    if (!draft) {
      return;
    }

    const displayName = draft.display_name.trim();
    if (!displayName) {
      setError('显示名称不能为空');
      return;
    }

    setStatus(null);
    setError(null);
    await withModelBusy(modelId, 'save-name', async () => {
      const res = await fetch(`/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          display_name: displayName,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `更新模型 ${modelId} 失败`));
        return;
      }

      setStatus(`模型 ${modelId} 显示名称已更新`);
      await loadModels();
    });
  };

  const setModelEnabled = async (model: ModelItem, enabled: boolean) => {
    setStatus(null);
    setError(null);

    await withModelBusy(model.id, enabled ? 'enable' : 'disable', async () => {
      const res = await fetch(`/api/admin/models/${model.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          enabled,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `更新模型 ${model.public_id} 状态失败`));
        return;
      }

      setStatus(`模型 ${model.public_id} 已${enabled ? '启用' : '下架'}`);
      await loadModels();
    });
  };

  const deleteModel = async (model: ModelItem) => {
    const firstConfirmed = window.confirm(
      `确认要永久删除模型 "${model.public_id}" 吗？此操作不可恢复。`,
    );
    if (!firstConfirmed) {
      return;
    }

    const typedPublicId = window.prompt(
      `请输入模型 public_id（${model.public_id}）以确认永久删除：`,
      '',
    );
    if ((typedPublicId ?? '').trim() !== model.public_id) {
      setError('输入的 public_id 不匹配，已取消删除');
      return;
    }

    setStatus(null);
    setError(null);

    await withModelBusy(model.id, 'delete', async () => {
      const res = await fetch(`/api/admin/models/${model.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `永久删除模型 ${model.public_id} 失败`));
        return;
      }

      setStatus(`模型 ${model.public_id} 已永久删除`);
      await loadModels();
    });
  };

  return (
    <>
      <div className="card">
        <h2>导入并发布模型</h2>

        <label>
          提供商
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
            disabled={catalogBusy !== null || !importProviderId}
          >
            {catalogBusy === 'import-models' ? '导入中...' : '导入上游模型'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void publishSelectedImportedModels()}
            disabled={catalogBusy !== null || selectedImportedModelIds.length === 0}
          >
            {catalogBusy === 'publish-imported' ? '发布中...' : '发布所选模型'}
          </button>
        </div>

        <label>
          搜索已导入模型
          <input
            value={importSearch}
            onChange={(event) => setImportSearch(event.target.value)}
            placeholder="按模型 ID 或所有者筛选"
          />
        </label>

        <div className="allowlist-preview">
          {filteredImportedModels.length === 0 ? (
            <div className="notice">暂无已导入模型</div>
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
                  <span className="notice">已发布为 {item.existing_public_id}</span>
                ) : null}
              </label>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <h2>已发布模型目录</h2>

        <div className="stack-tight">
          {models.map((model) => {
            const draft = modelDrafts[model.id];
            if (!draft) {
              return null;
            }
            const busyAction = modelBusy[model.id];
            const rowBusy = Boolean(busyAction);

            return (
              <div key={model.id} className="admin-item">
                <div className="mono admin-item-title">
                  {model.public_id} ({model.provider}/{model.model_id})
                </div>

                <label>
                  显示名称
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

                <div className="notice">状态：{model.enabled ? '已启用' : '已下架'}</div>

                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void saveModelDisplayName(model.id)}
                    disabled={rowBusy}
                  >
                    {busyAction === 'save-name' ? '保存中...' : '保存名称'}
                  </button>

                  {model.enabled ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void setModelEnabled(model, false)}
                      disabled={rowBusy}
                    >
                      {busyAction === 'disable' ? '下架中...' : '下架'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void setModelEnabled(model, true)}
                      disabled={rowBusy}
                    >
                      {busyAction === 'enable' ? '启用中...' : '启用'}
                    </button>
                  )}

                  <button
                    type="button"
                    className="danger"
                    onClick={() => void deleteModel(model)}
                    disabled={rowBusy}
                  >
                    {busyAction === 'delete' ? '删除中...' : '永久删除'}
                  </button>
                </div>
              </div>
            );
          })}
          {models.length === 0 ? <div className="notice">尚未发布模型。</div> : null}
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
