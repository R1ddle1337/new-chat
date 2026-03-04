'use client';

import { useEffect, useState } from 'react';
import type {
  CreateProviderDraft,
  ProviderApiType,
  ProviderDraft,
  ProviderItem,
} from '../_components/types';
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
  api_type: 'openai_chat',
  api_key: '',
};

const apiTypeOptions: Array<{ value: ProviderApiType; label: string }> = [
  { value: 'openai_chat', label: 'OpenAI Chat' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic_messages', label: 'Claude (Anthropic Messages)' },
];

const apiTypeLabels: Record<ProviderApiType, string> = {
  openai_chat: 'OpenAI Chat',
  openai_responses: 'OpenAI Responses',
  anthropic_messages: 'Claude (Anthropic Messages)',
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
      throw new Error(parseError(body, '加载提供商失败'));
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
            api_type: item.api_type,
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
        setError(requestError instanceof Error ? requestError.message : '加载提供商失败');
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
      setError('Provider ID 必须为 1-64 位，仅支持小写字母、数字、"_" 或 "-"');
      return null;
    }

    const duplicate = providers.some((provider) => {
      if (typeof providerId === 'number' && provider.id === providerId) {
        return false;
      }
      return provider.code.toLowerCase() === code;
    });
    if (duplicate) {
      setError(`Provider ID "${code}" 已存在`);
      return null;
    }

    const name = draft.name.trim();
    if (!name || name.length > 120) {
      setError('显示名称不能为空，且长度不能超过 120 个字符');
      return null;
    }

    const baseUrl = normalizeProviderBaseUrl(draft.base_url);
    if (!baseUrl) {
      setError('基础 URL 必须是合法的 http(s) URL，且不能包含查询参数或片段');
      return null;
    }

    const apiType = draft.api_type;
    if (!apiTypeOptions.some((option) => option.value === apiType)) {
      setError('API 协议类型无效');
      return null;
    }

    return {
      code,
      name,
      base_url: baseUrl,
      enabled: draft.enabled,
      api_type: apiType,
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
        setError(parseError(body, '创建提供商失败'));
        return;
      }

      const providerId =
        typeof body?.data?.id === 'number' && Number.isInteger(body.data.id) ? body.data.id : null;
      let providerStatus = `提供商 "${payload.code}" 已创建`;
      let providerError: string | null = null;

      if (apiKey) {
        if (!providerId) {
          providerError =
            '提供商已创建，但创建响应中缺少 provider ID，API Key 未保存';
        } else {
          const secretRes = await fetch(`/api/admin/providers/${providerId}/secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ api_key: apiKey }),
          });
          const secretBody = (await secretRes.json().catch(() => null)) as unknown;

          if (!secretRes.ok) {
            providerError = `提供商已创建，但保存 API Key 失败：${parseError(secretBody, '更新提供商密钥失败')}`;
          } else {
            providerStatus = `提供商 "${payload.code}" 已创建并保存 API Key`;
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
        setError(parseError(body, '更新提供商失败'));
        return;
      }

      setStatus(`提供商 "${payload.code}" 已更新`);
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
        setError(parseError(body, '切换提供商状态失败'));
        return;
      }

      setStatus(`提供商 "${provider.code}" 已${provider.enabled ? '禁用' : '启用'}`);
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  const saveProviderSecret = async (providerId: number) => {
    const apiKey = (providerSecretDrafts[providerId] ?? '').trim();
    if (!apiKey) {
      setError('必须填写 API Key');
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
        setError(parseError(body, '更新提供商密钥失败'));
        return;
      }

      setProviderSecretDrafts((previous) => ({ ...previous, [providerId]: '' }));
      setStatus('提供商 API Key 已保存');
      await loadProviders();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2>提供商</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createProvider();
          }}
        >
          <div className="stack-tight">
            <div className="notice">创建提供商</div>

            <label>
              Provider ID（唯一标识）
              <div className="notice">系统内稳定且唯一的机器标识。</div>
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
              显示名称
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
              基础 URL
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
              API Protocol
              <select
                value={createProviderDraft.api_type}
                disabled={createProviderBusy}
                onChange={(event) =>
                  setCreateProviderDraft((previous) => ({
                    ...previous,
                    api_type: event.target.value as ProviderApiType,
                  }))
                }
              >
                {apiTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              API Key（可选）
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
              已启用
            </label>

            <button className="primary" type="submit" disabled={createProviderBusy}>
              {createProviderBusy ? '创建中...' : '创建提供商'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>现有提供商</h2>

        <div className="stack-tight">
          {providers.map((provider) => {
            const draft = providerDrafts[provider.id] ?? {
              code: provider.code,
              name: provider.name,
              base_url: provider.base_url,
              enabled: provider.enabled,
              api_type: provider.api_type,
            };
            const secretDraft = providerSecretDrafts[provider.id] ?? '';
            return (
              <div key={provider.id} className="admin-item">
                <div className="mono admin-item-title">
                  {provider.code}（{provider.enabled ? '已启用' : '已禁用'}）
                </div>
                <div className="notice">API Protocol：{apiTypeLabels[provider.api_type]}</div>
                <div className="notice">
                  密钥已配置：{provider.has_secret ? '是' : '否'}
                  {provider.secret_updated_at
                    ? `（更新于 ${new Date(provider.secret_updated_at).toLocaleString('zh-CN')}）`
                    : ''}
                </div>

                <label>
                  Provider ID（唯一标识）
                  <div className="notice">系统内稳定且唯一的机器标识。</div>
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
                  显示名称
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
                  基础 URL
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

                <label>
                  API Protocol
                  <select
                    value={draft.api_type}
                    onChange={(event) =>
                      setProviderDrafts((previous) => ({
                        ...previous,
                        [provider.id]: {
                          ...draft,
                          api_type: event.target.value as ProviderApiType,
                        },
                      }))
                    }
                  >
                    {apiTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
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
                  已启用
                </label>

                <div className="button-row">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void saveProvider(provider.id)}
                    disabled={busy !== null}
                  >
                    {busy === `provider-${provider.id}` ? '保存中...' : '保存提供商'}
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void toggleProviderEnabled(provider)}
                    disabled={busy !== null}
                  >
                    {busy === `provider-toggle-${provider.id}`
                      ? '保存中...'
                      : provider.enabled
                        ? '禁用'
                        : '启用'}
                  </button>
                </div>

                <label>
                  API Key
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
                  {busy === `provider-secret-${provider.id}` ? '保存中...' : '保存 API Key'}
                </button>
              </div>
            );
          })}
          {providers.length === 0 ? <div className="notice">未找到提供商。</div> : null}
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
