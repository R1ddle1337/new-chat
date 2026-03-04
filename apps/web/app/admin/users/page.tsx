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
      throw new Error(parseError(body, 'Failed to load users'));
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
      throw new Error(parseError(body, 'Failed to load suspicious users'));
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
        setError(requestError instanceof Error ? requestError.message : 'Failed to load users page');
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
      setStatus('User list updated');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to search users');
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
        setError(parseError(body, `Failed to update user ${userId}`));
        return;
      }

      setStatus(userStatus === 'banned' ? 'User banned' : 'User reactivated');
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
      setError('User override limits must be positive integers or blank');
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
        setError(parseError(body, `Failed to update limits for user ${userId}`));
        return;
      }

      setStatus('User limits updated');
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
        setError(parseError(body, `Failed to clear limits for user ${userId}`));
        return;
      }

      setStatus('User limit overrides cleared');
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
      setError('Throttle override requires positive RPM, TPM, and duration minutes');
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
        setError(parseError(body, `Failed to set throttle override for user ${userId}`));
        return;
      }

      setStatus('Throttle override set');
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
        setError(parseError(body, `Failed to clear throttle override for user ${userId}`));
        return;
      }

      setStatus('Throttle override cleared');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  const deleteUser = async (user: AdminUserItem) => {
    const confirmation = window.prompt(
      `Type "${user.email}" or "${user.id}" to confirm deleting this account`,
      '',
    );
    if (confirmation === null) {
      return;
    }

    const typed = confirmation.trim().toLowerCase();
    if (typed !== user.email.toLowerCase() && typed !== user.id.toLowerCase()) {
      setError('Confirmation mismatch. Deletion canceled.');
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
        setError(parseError(body, `Failed to delete user ${user.id}`));
        return;
      }

      const payload = body as { data?: { revoked_session_count?: unknown } };
      const revokedSessionCount =
        typeof payload.data?.revoked_session_count === 'number' ? payload.data.revoked_session_count : 0;

      setStatus(`User soft-deleted. Revoked ${revokedSessionCount} active sessions.`);
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
        setError(parseError(body, `Failed to restore user ${user.id}`));
        return;
      }

      setStatus('User restored');
      await Promise.all([loadUsers(usersQuery), loadSuspiciousUsers(usersQuery)]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Users</h2>

        <form
          className="admin-user-search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchUsers();
          }}
        >
          <label>
            Search users
            <input
              value={usersQuery}
              onChange={(event) => setUsersQuery(event.target.value)}
              placeholder="Search by email"
            />
          </label>
          <button type="submit" className="secondary" disabled={busy !== null}>
            {busy === 'users-search' ? 'Searching...' : 'Search'}
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
                  setStatus('User list updated');
                })
                .catch((requestError: unknown) => {
                  setError(requestError instanceof Error ? requestError.message : 'Failed to load users');
                })
                .finally(() => {
                  setBusy(null);
                });
            }}
          >
            Clear
          </button>
        </form>

        <div className="admin-users-table-wrap">
          <table className="admin-users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last Login</th>
                <th>Last Login IP</th>
                <th>RPM</th>
                <th>TPM</th>
                <th>Actions</th>
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
                        {user.status === 'active' ? 'active' : 'banned'}
                      </span>
                      {user.ban_expires_at ? (
                        <div className="notice">until {formatDateTime(user.ban_expires_at)}</div>
                      ) : null}
                      {user.deleted_at ? (
                        <div className="notice">
                          soft-deleted {formatDateTime(user.deleted_at)} ({user.deleted_reason ?? 'admin_delete'})
                        </div>
                      ) : null}
                    </td>
                    <td>{formatDateTime(user.created_at)}</td>
                    <td>{formatDateTime(user.last_login_at)}</td>
                    <td className="mono">{user.last_login_ip ?? '-'}</td>
                    <td className="mono">
                      {user.rpm_effective}
                      <div className="notice">
                        {user.rpm_override === null ? 'default' : `override ${user.rpm_override}`}
                      </div>
                    </td>
                    <td className="mono">
                      {user.tpm_effective}
                      <div className="notice">
                        {user.tpm_override === null ? 'default' : `override ${user.tpm_override}`}
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
                              ? 'Saving...'
                              : user.status === 'banned'
                                ? 'Unban'
                                : 'Ban'}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy !== null || user.deleted_at !== null}
                            onClick={() => void deleteUser(user)}
                          >
                            {rowBusy && busy === `user-delete-${user.id}` ? 'Deleting...' : 'Delete'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null || user.deleted_at === null}
                            onClick={() => void restoreUser(user)}
                          >
                            {rowBusy && busy === `user-restore-${user.id}` ? 'Restoring...' : 'Restore'}
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
                            View chats
                          </button>
                        </div>

                        <div className="admin-limit-inputs">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="RPM override"
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
                            placeholder="TPM override"
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
                            {rowBusy && busy === `user-limits-${user.id}` ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() => void clearUserLimits(user.id)}
                          >
                            Clear override
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
                    No users found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Suspicious Users</h2>
        <div className="notice">
          Suspicious users are scored by rule hits (RPM/TPM spikes, login brute force, stream abuse, IP/UA
          churn, and high error rates).
        </div>

        <div className="admin-users-table-wrap">
          <table className="admin-users-table admin-abuse-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Score</th>
                <th>Rules</th>
                <th>Last Seen</th>
                <th>Action</th>
                <th>Controls</th>
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
                          {user.status === 'active' ? 'active' : 'banned'}
                        </span>
                        {user.ban_expires_at ? ` until ${formatDateTime(user.ban_expires_at)}` : ''}
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
                      <div>{user.last_action ?? 'none'}</div>
                      <div className="notice">{formatDateTime(user.last_action_at)}</div>
                      <div className="notice">
                        {user.throttle_source === 'none'
                          ? 'throttle: none'
                          : `throttle ${user.throttle_source} until ${formatDateTime(user.throttle_expires_at)}`}
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
                          {rowBusy && busy === `user-status-${user.id}` ? 'Saving...' : 'Unban'}
                        </button>

                        <div className="admin-throttle-inputs">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="Throttle RPM"
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
                            placeholder="Throttle TPM"
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
                            placeholder="Duration (min)"
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
                            {rowBusy && busy === `throttle-override-${user.id}` ? 'Saving...' : 'Set throttle'}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy !== null}
                            onClick={() => void clearThrottleOverride(user.id)}
                          >
                            Clear throttle
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
                            View events
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
                    No suspicious users right now
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
