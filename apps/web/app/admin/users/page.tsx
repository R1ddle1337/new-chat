'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AdminUserItem,
  SuspiciousUserItem,
  ThrottleOverrideDraft,
  UserLimitDraft,
} from '../_components/types';
import { formatDateTime, parseError, summarizeRuleHits } from '../_components/utils';

export default function AdminUsersPage() {
  const router = useRouter();

  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersQuery, setUsersQuery] = useState('');
  const [userLimitDrafts, setUserLimitDrafts] = useState<Record<string, UserLimitDraft>>({});

  const [suspiciousUsers, setSuspiciousUsers] = useState<SuspiciousUserItem[]>([]);
  const [throttleOverrideDrafts, setThrottleOverrideDrafts] = useState<
    Record<string, ThrottleOverrideDraft>
  >({});

  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadUsers = async (query = usersQuery) => {
    const search = query.trim();
    const params = new URLSearchParams();
    if (search) {
      params.set('query', search);
    }

    const res = await fetch(`/api/admin/users${params.size > 0 ? `?${params.toString()}` : ''}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, '加载用户失败'));
    }

    const payload = (await res.json()) as { data: AdminUserItem[] };
    setUsers(payload.data);
    setUserLimitDrafts(
      Object.fromEntries(
        payload.data.map((item) => [
          item.id,
          {
            rpm_limit: item.rpm_override === null ? '' : String(item.rpm_override),
            tpm_limit: item.tpm_override === null ? '' : String(item.tpm_override),
          },
        ]),
      ),
    );
  };

  const loadSuspiciousUsers = async (query = usersQuery) => {
    const search = query.trim();
    const params = new URLSearchParams();
    if (search) {
      params.set('query', search);
    }

    const res = await fetch(
      `/api/admin/abuse/suspicious${params.size > 0 ? `?${params.toString()}` : ''}`,
      {
        credentials: 'include',
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      throw new Error(parseError(body, '加载可疑用户失败'));
    }

    const payload = (await res.json()) as { data: SuspiciousUserItem[] };
    setSuspiciousUsers(payload.data);
    setThrottleOverrideDrafts((previous) => {
      const next = { ...previous };
      for (const item of payload.data) {
        if (!next[item.id]) {
          next[item.id] = {
            rpm_limit: item.throttle_rpm_limit === null ? '' : String(item.throttle_rpm_limit),
            tpm_limit: item.throttle_tpm_limit === null ? '' : String(item.throttle_tpm_limit),
            duration_minutes: '30',
          };
        }
      }
      return next;
    });
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        await Promise.all([loadUsers(''), loadSuspiciousUsers('')]);
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : '加载用户页面失败');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const searchUsers = async () => {
    setStatus(null);
    setError(null);
    setBusy('users-search');

    try {
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
      setStatus('用户列表已更新');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '搜索用户失败');
    } finally {
      setBusy(null);
    }
  };

  const saveUserStatus = async (userId: string, userStatus: 'active' | 'banned') => {
    setStatus(null);
    setError(null);
    setBusy(`user-status-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: userStatus }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `更新用户 ${userId} 失败`));
        return;
      }

      setStatus(userStatus === 'banned' ? '用户已封禁' : '用户已解封');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const saveUserLimits = async (userId: string) => {
    const draft = userLimitDrafts[userId];
    if (!draft) {
      return;
    }

    const rpmRaw = draft.rpm_limit.trim();
    const tpmRaw = draft.tpm_limit.trim();

    const rpm = rpmRaw === '' ? null : Number(rpmRaw);
    const tpm = tpmRaw === '' ? null : Number(tpmRaw);

    if (
      (rpm !== null && (!Number.isInteger(rpm) || rpm <= 0)) ||
      (tpm !== null && (!Number.isInteger(tpm) || tpm <= 0))
    ) {
      setError('用户覆盖限制必须为正整数或留空');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`user-limits-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/limits`, {
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
        setError(parseError(body, `更新用户 ${userId} 的限制失败`));
        return;
      }

      setStatus('用户限制已更新');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const clearUserLimits = async (userId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`user-limits-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/limits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: null,
          tpm_limit: null,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `清除用户 ${userId} 的限制失败`));
        return;
      }

      setStatus('用户限制覆盖已清除');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const setThrottleOverride = async (userId: string) => {
    const draft = throttleOverrideDrafts[userId] ?? {
      rpm_limit: '',
      tpm_limit: '',
      duration_minutes: '30',
    };
    const rpm = Number(draft.rpm_limit);
    const tpm = Number(draft.tpm_limit);
    const durationMinutes = Number(draft.duration_minutes);

    if (
      !Number.isInteger(rpm) ||
      rpm <= 0 ||
      !Number.isInteger(tpm) ||
      tpm <= 0 ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes <= 0
    ) {
      setError('限流覆盖要求 RPM、TPM 和持续时间（分钟）均为正整数');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`throttle-override-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/throttle-override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          rpm_limit: rpm,
          tpm_limit: tpm,
          duration_minutes: durationMinutes,
        }),
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `为用户 ${userId} 设置限流覆盖失败`));
        return;
      }

      setStatus('限流覆盖已设置');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const clearThrottleOverride = async (userId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`throttle-override-${userId}`);

    try {
      const res = await fetch(`/api/admin/users/${userId}/throttle-override`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `清除用户 ${userId} 的限流覆盖失败`));
        return;
      }

      setStatus('限流覆盖已清除');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const deleteUser = async (user: AdminUserItem) => {
    const confirmation = window.prompt(
      `请输入 "${user.email}" 或 "${user.id}" 以确认删除该账号`,
      '',
    );
    if (confirmation === null) {
      return;
    }

    const typed = confirmation.trim().toLowerCase();
    if (typed !== user.email.toLowerCase() && typed !== user.id.toLowerCase()) {
      setError('确认信息不匹配，已取消删除。');
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`user-delete-${user.id}`);

    try {
      const res = await fetch(`/api/admin/users/${user.id}/delete`, {
        method: 'POST',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `删除用户 ${user.id} 失败`));
        return;
      }

      const payload = body as { data?: { revoked_session_count?: unknown } };
      const revokedSessionCount =
        typeof payload.data?.revoked_session_count === 'number' ? payload.data.revoked_session_count : 0;

      setStatus(`用户已软删除。已撤销 ${revokedSessionCount} 个活跃会话。`);
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const restoreUser = async (user: AdminUserItem) => {
    setStatus(null);
    setError(null);
    setBusy(`user-restore-${user.id}`);

    try {
      const res = await fetch(`/api/admin/users/${user.id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `恢复用户 ${user.id} 失败`));
        return;
      }

      setStatus('用户已恢复');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2>用户</h2>

        <form
          className="admin-user-search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchUsers();
          }}
        >
          <label>
            搜索用户
            <input
              value={usersQuery}
              onChange={(event) => setUsersQuery(event.target.value)}
              placeholder="按邮箱搜索"
            />
          </label>
          <button type="submit" className="secondary" disabled={busy !== null}>
            {busy === 'users-search' ? '搜索中...' : '搜索'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={() => {
              setUsersQuery('');
              setStatus(null);
              setError(null);
              setBusy('users-search');
              void Promise.all([loadUsers(''), loadSuspiciousUsers('')])
                .then(() => {
                  setStatus('用户列表已更新');
                })
                .catch((requestError: unknown) => {
                  setError(requestError instanceof Error ? requestError.message : '加载用户失败');
                })
                .finally(() => {
                  setBusy(null);
                });
            }}
          >
            清空
          </button>
        </form>

        <div className="admin-users-table-wrap">
          <table className="admin-users-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最近登录</th>
                <th>最近登录 IP</th>
                <th>RPM</th>
                <th>TPM</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const draft = userLimitDrafts[user.id] ?? { rpm_limit: '', tpm_limit: '' };
                const rowBusy =
                  busy === `user-status-${user.id}` ||
                  busy === `user-limits-${user.id}` ||
                  busy === `user-delete-${user.id}` ||
                  busy === `user-restore-${user.id}`;

                return (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>
                      <span className={`admin-status-pill ${user.status}`}>
                        {user.status === 'active' ? '正常' : '封禁'}
                      </span>
                      {user.ban_expires_at ? (
                        <div className="notice">截至 {formatDateTime(user.ban_expires_at)}</div>
                      ) : null}
                      {user.deleted_at ? (
                        <div className="notice">
                          软删除于 {formatDateTime(user.deleted_at)}（{user.deleted_reason ?? 'admin_delete'}）
                        </div>
                      ) : null}
                    </td>
                    <td>{formatDateTime(user.created_at)}</td>
                    <td>{formatDateTime(user.last_login_at)}</td>
                    <td className="mono">{user.last_login_ip ?? '-'}</td>
                    <td className="mono">
                      {user.rpm_effective}
                      <div className="notice">
                        {user.rpm_override === null ? '默认' : `覆盖 ${user.rpm_override}`}
                      </div>
                    </td>
                    <td className="mono">
                      {user.tpm_effective}
                      <div className="notice">
                        {user.tpm_override === null ? '默认' : `覆盖 ${user.tpm_override}`}
                      </div>
                    </td>
                    <td>
                      <div className="admin-user-actions">
                        <div className="button-row">
                          <button
                            type="button"
                            className={user.status === 'banned' ? 'secondary' : 'danger'}
                            disabled={busy !== null}
                            onClick={() =>
                              void saveUserStatus(user.id, user.status === 'banned' ? 'active' : 'banned')
                            }
                          >
                            {rowBusy && busy === `user-status-${user.id}`
                              ? '保存中...'
                              : user.status === 'banned'
                                ? '解封'
                                : '封禁'}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy !== null || user.deleted_at !== null}
                            onClick={() => void deleteUser(user)}
                          >
                            {rowBusy && busy === `user-delete-${user.id}` ? '删除中...' : '删除'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null || user.deleted_at === null}
                            onClick={() => void restoreUser(user)}
                          >
                            {rowBusy && busy === `user-restore-${user.id}` ? '恢复中...' : '恢复'}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              router.push(
                                `/admin/chat?user=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email)}`,
                              )
                            }
                          >
                            查看聊天
                          </button>
                        </div>

                        <div className="admin-limit-inputs">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="RPM 覆盖值"
                            value={draft.rpm_limit}
                            onChange={(event) =>
                              setUserLimitDrafts((previous) => ({
                                ...previous,
                                [user.id]: {
                                  ...(previous[user.id] ?? { rpm_limit: '', tpm_limit: '' }),
                                  rpm_limit: event.target.value,
                                },
                              }))
                            }
                          />
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="TPM 覆盖值"
                            value={draft.tpm_limit}
                            onChange={(event) =>
                              setUserLimitDrafts((previous) => ({
                                ...previous,
                                [user.id]: {
                                  ...(previous[user.id] ?? { rpm_limit: '', tpm_limit: '' }),
                                  tpm_limit: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>

                        <div className="button-row">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null}
                            onClick={() => void saveUserLimits(user.id)}
                          >
                            {rowBusy && busy === `user-limits-${user.id}` ? '保存中...' : '保存'}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() => void clearUserLimits(user.id)}
                          >
                            清除覆盖
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={8} className="notice">
                    未找到用户
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>可疑用户</h2>
        <div className="notice">
          可疑用户根据规则命中评分（RPM/TPM 激增、登录暴力尝试、流式接口滥用、IP/UA 频繁变化以及高错误率）。
        </div>

        <div className="admin-users-table-wrap">
          <table className="admin-users-table admin-abuse-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>评分</th>
                <th>规则</th>
                <th>最近活跃</th>
                <th>动作</th>
                <th>控制</th>
              </tr>
            </thead>
            <tbody>
              {suspiciousUsers.map((user) => {
                const draft = throttleOverrideDrafts[user.id] ?? {
                  rpm_limit: '',
                  tpm_limit: '',
                  duration_minutes: '30',
                };
                const rowBusy =
                  busy === `user-status-${user.id}` || busy === `throttle-override-${user.id}`;

                return (
                  <tr key={`suspicious-${user.id}`}>
                    <td>
                      <div>{user.email}</div>
                      <div className="notice">
                        <span className={`admin-status-pill ${user.status}`}>
                          {user.status === 'active' ? '正常' : '封禁'}
                        </span>
                        {user.ban_expires_at ? ` 截至 ${formatDateTime(user.ban_expires_at)}` : ''}
                      </div>
                    </td>
                    <td className="mono">{user.anomaly_score}</td>
                    <td>
                      <div className="notice">{summarizeRuleHits(user.last_rule_hits)}</div>
                      <div className="notice">
                        {user.last_rule_hits.length > 0
                          ? user.last_rule_hits
                              .slice(0, 3)
                              .map((hit) => `${hit.rule}:${hit.value}/${hit.threshold}`)
                              .join(' | ')
                          : '-'}
                      </div>
                    </td>
                    <td>
                      <div className="mono">{user.last_seen_ip ?? '-'}</div>
                      <div className="notice">{user.last_seen_ua ?? '-'}</div>
                      <div className="notice">{formatDateTime(user.last_seen_at)}</div>
                    </td>
                    <td>
                      <div>{user.last_action ?? '无'}</div>
                      <div className="notice">{formatDateTime(user.last_action_at)}</div>
                      <div className="notice">
                        {user.throttle_source === 'none'
                          ? '限流：无'
                          : `限流 ${user.throttle_source}，截至 ${formatDateTime(user.throttle_expires_at)}`}
                      </div>
                    </td>
                    <td>
                      <div className="admin-user-actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy !== null || user.status !== 'banned'}
                          onClick={() => void saveUserStatus(user.id, 'active')}
                        >
                          {rowBusy && busy === `user-status-${user.id}` ? '保存中...' : '解封'}
                        </button>

                        <div className="admin-throttle-inputs">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="限流 RPM"
                            value={draft.rpm_limit}
                            onChange={(event) =>
                              setThrottleOverrideDrafts((previous) => ({
                                ...previous,
                                [user.id]: {
                                  ...(previous[user.id] ?? {
                                    rpm_limit: '',
                                    tpm_limit: '',
                                    duration_minutes: '30',
                                  }),
                                  rpm_limit: event.target.value,
                                },
                              }))
                            }
                          />
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="限流 TPM"
                            value={draft.tpm_limit}
                            onChange={(event) =>
                              setThrottleOverrideDrafts((previous) => ({
                                ...previous,
                                [user.id]: {
                                  ...(previous[user.id] ?? {
                                    rpm_limit: '',
                                    tpm_limit: '',
                                    duration_minutes: '30',
                                  }),
                                  tpm_limit: event.target.value,
                                },
                              }))
                            }
                          />
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="时长（分钟）"
                            value={draft.duration_minutes}
                            onChange={(event) =>
                              setThrottleOverrideDrafts((previous) => ({
                                ...previous,
                                [user.id]: {
                                  ...(previous[user.id] ?? {
                                    rpm_limit: '',
                                    tpm_limit: '',
                                    duration_minutes: '30',
                                  }),
                                  duration_minutes: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>

                        <div className="button-row">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null}
                            onClick={() => void setThrottleOverride(user.id)}
                          >
                            {rowBusy && busy === `throttle-override-${user.id}` ? '保存中...' : '设置限流'}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() => void clearThrottleOverride(user.id)}
                          >
                            清除限流
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              router.push(
                                `/admin/audit?user=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email)}`,
                              )
                            }
                          >
                            查看事件
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {suspiciousUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="notice">
                    当前无可疑用户
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
