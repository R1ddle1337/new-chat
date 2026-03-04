'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  AdminUserItem,
  ModelItem,
  ProviderItem,
  RateLimitsPayload,
  SuspiciousUserItem,
} from './_components/types';
import { parseError } from './_components/utils';

type OverviewStats = {
  providers: number;
  enabledProviders: number;
  models: number;
  enabledModels: number;
  users: number;
  suspiciousUsers: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  limitsUpdatedAt: string | null;
};

const defaultStats: OverviewStats = {
  providers: 0,
  enabledProviders: 0,
  models: 0,
  enabledModels: 0,
  users: 0,
  suspiciousUsers: 0,
  rpmLimit: null,
  tpmLimit: null,
  limitsUpdatedAt: null,
};

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<OverviewStats>(defaultStats);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async () => {
    setError(null);

    const [providersRes, modelsRes, usersRes, suspiciousRes, limitsRes] = await Promise.all([
      fetch('/api/admin/providers', { credentials: 'include' }),
      fetch('/api/admin/models', { credentials: 'include' }),
      fetch('/api/admin/users', { credentials: 'include' }),
      fetch('/api/admin/abuse/suspicious', { credentials: 'include' }),
      fetch('/api/admin/rate-limits', { credentials: 'include' }),
    ]);

    const responses = [providersRes, modelsRes, usersRes, suspiciousRes, limitsRes];
    for (const res of responses) {
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as unknown;
        throw new Error(parseError(body, '加载管理概览失败'));
      }
    }

    const providersPayload = (await providersRes.json()) as { data: ProviderItem[] };
    const modelsPayload = (await modelsRes.json()) as { data: ModelItem[] };
    const usersPayload = (await usersRes.json()) as { data: AdminUserItem[] };
    const suspiciousPayload = (await suspiciousRes.json()) as { data: SuspiciousUserItem[] };
    const limitsPayload = (await limitsRes.json()) as { data: RateLimitsPayload };

    const providers = providersPayload.data;
    const models = modelsPayload.data;
    const users = usersPayload.data;
    const suspiciousUsers = suspiciousPayload.data;
    const limits = limitsPayload.data;

    setStats({
      providers: providers.length,
      enabledProviders: providers.filter((provider) => provider.enabled).length,
      models: models.length,
      enabledModels: models.filter((model) => model.enabled).length,
      users: users.length,
      suspiciousUsers: suspiciousUsers.length,
      rpmLimit: limits.rpm_limit,
      tpmLimit: limits.tpm_limit,
      limitsUpdatedAt: limits.updated_at,
    });
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      setLoading(true);
      try {
        await loadOverview();
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : '加载管理概览失败');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <div className="card">
        <div className="card-title-row">
          <h2>概览</h2>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setLoading(true);
              void loadOverview()
                .catch((requestError: unknown) => {
                  setError(
                    requestError instanceof Error
                      ? requestError.message
                      : '重新加载管理概览失败',
                  );
                })
                .finally(() => {
                  setLoading(false);
                });
            }}
            disabled={loading}
          >
            {loading ? '刷新中...' : '刷新'}
          </button>
        </div>

        <div className="admin-dashboard-grid">
          <div className="admin-kpi-card">
            <div className="notice">提供商</div>
            <strong>{stats.providers}</strong>
            <div className="notice">已启用：{stats.enabledProviders}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">模型</div>
            <strong>{stats.models}</strong>
            <div className="notice">已启用：{stats.enabledModels}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">用户</div>
            <strong>{stats.users}</strong>
            <div className="notice">可疑：{stats.suspiciousUsers}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">全局限制</div>
            <strong className="mono">
              {stats.rpmLimit ?? '-'} RPM / {stats.tpmLimit ?? '-'} TPM
            </strong>
            <div className="notice">
              {stats.limitsUpdatedAt
                ? `更新时间：${new Date(stats.limitsUpdatedAt).toLocaleString('zh-CN')}`
                : '暂无更新时间'}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>快捷入口</h2>
        <div className="admin-shortcuts">
          <Link href="/admin/users" className="admin-shortcut-link">
            管理用户、可疑行为与限流覆盖
          </Link>
          <Link href="/admin/chat" className="admin-shortcut-link">
            查看用户聊天会话、消息与附件
          </Link>
          <Link href="/admin/providers" className="admin-shortcut-link">
            创建提供商、编辑配置并轮换 API Key
          </Link>
          <Link href="/admin/models" className="admin-shortcut-link">
            导入上游模型并发布到模型目录
          </Link>
          <Link href="/admin/rate-limits" className="admin-shortcut-link">
            更新全局 RPM/TPM 默认值
          </Link>
          <Link href="/admin/audit" className="admin-shortcut-link">
            按用户查看最近风控/审计事件
          </Link>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
