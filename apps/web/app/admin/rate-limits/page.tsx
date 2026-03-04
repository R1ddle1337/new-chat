'use client';

import { useEffect, useState } from 'react';
import type { RateLimitsPayload } from '../_components/types';
import { parseError } from '../_components/utils';

export default function AdminRateLimitsPage() {
  const [rpmLimit, setRpmLimit] = useState('120');
  const [tpmLimit, setTpmLimit] = useState('120000');
  const [rateLimitsUpdatedAt, setRateLimitsUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadRateLimits = async () => {
    const res = await fetch('/api/admin/rate-limits', { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, '加载速率限制失败'));
    }

    const payload = (await res.json()) as { data: RateLimitsPayload };
    setRpmLimit(String(payload.data.rpm_limit));
    setTpmLimit(String(payload.data.tpm_limit));
    setRateLimitsUpdatedAt(payload.data.updated_at);
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        await loadRateLimits();
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : '加载速率限制失败');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const saveRateLimits = async () => {
    const rpm = Number(rpmLimit);
    const tpm = Number(tpmLimit);

    if (!Number.isInteger(rpm) || rpm <= 0 || !Number.isInteger(tpm) || tpm <= 0) {
      setError('RPM 和 TPM 都必须是正整数');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(true);

    try {
      const res = await fetch('/api/admin/rate-limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: rpm,
          tpm_limit: tpm,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, '更新速率限制失败'));
        return;
      }

      const payload = body as { data?: RateLimitsPayload };
      setRateLimitsUpdatedAt(payload.data?.updated_at ?? null);
      setStatus('速率限制已更新');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>速率限制</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRateLimits();
          }}
        >
          <label>
            每位用户每分钟请求数（RPM）
            <input
              type="number"
              min={1}
              step={1}
              value={rpmLimit}
              onChange={(event) => setRpmLimit(event.target.value)}
            />
          </label>

          <label>
            每位用户每分钟 Token 数（TPM）
            <input
              type="number"
              min={1}
              step={1}
              value={tpmLimit}
              onChange={(event) => setTpmLimit(event.target.value)}
            />
          </label>

          <button className="primary" type="submit" disabled={busy}>
            {busy ? '保存中...' : '保存速率限制'}
          </button>
        </form>

        {rateLimitsUpdatedAt ? (
          <div className="notice">
            最后更新：{new Date(rateLimitsUpdatedAt).toLocaleString('zh-CN')}
          </div>
        ) : null}
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
