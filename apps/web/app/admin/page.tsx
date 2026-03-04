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
        throw new Error(parseError(body, 'Failed to load admin overview'));
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
        setError(requestError instanceof Error ? requestError.message : 'Failed to load admin overview');
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
          <h2>Overview</h2>
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
                      : 'Failed to reload admin overview',
                  );
                })
                .finally(() => {
                  setLoading(false);
                });
            }}
            disabled={loading}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="admin-dashboard-grid">
          <div className="admin-kpi-card">
            <div className="notice">Providers</div>
            <strong>{stats.providers}</strong>
            <div className="notice">Enabled: {stats.enabledProviders}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">Models</div>
            <strong>{stats.models}</strong>
            <div className="notice">Enabled: {stats.enabledModels}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">Users</div>
            <strong>{stats.users}</strong>
            <div className="notice">Suspicious: {stats.suspiciousUsers}</div>
          </div>

          <div className="admin-kpi-card">
            <div className="notice">Global limits</div>
            <strong className="mono">
              {stats.rpmLimit ?? '-'} RPM / {stats.tpmLimit ?? '-'} TPM
            </strong>
            <div className="notice">
              {stats.limitsUpdatedAt
                ? `Updated ${new Date(stats.limitsUpdatedAt).toLocaleString()}`
                : 'No update timestamp'}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Shortcuts</h2>
        <div className="admin-shortcuts">
          <Link href="/admin/users" className="admin-shortcut-link">
            Manage users, suspicious activity, and overrides
          </Link>
          <Link href="/admin/chat" className="admin-shortcut-link">
            Inspect user chat threads, messages, and attachments
          </Link>
          <Link href="/admin/providers" className="admin-shortcut-link">
            Create providers, edit config, and rotate API keys
          </Link>
          <Link href="/admin/models" className="admin-shortcut-link">
            Import upstream models and publish catalog entries
          </Link>
          <Link href="/admin/rate-limits" className="admin-shortcut-link">
            Update global RPM/TPM defaults
          </Link>
          <Link href="/admin/audit" className="admin-shortcut-link">
            View recent abuse/audit events by user
          </Link>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
