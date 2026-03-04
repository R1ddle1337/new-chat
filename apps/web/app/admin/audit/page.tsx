'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AbuseEventItem, AdminUserItem } from '../_components/types';
import { formatDateTime, parseError } from '../_components/utils';

type SelectedAuditUser = {
  id: string;
  email: string;
};

export default function AdminAuditPage() {
  const searchParams = useSearchParams();
  const initialUserId = searchParams.get('user');
  const initialEmail = searchParams.get('email');

  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersQuery, setUsersQuery] = useState(initialEmail ?? '');
  const [selectedUser, setSelectedUser] = useState<SelectedAuditUser | null>(null);
  const [events, setEvents] = useState<AbuseEventItem[]>([]);

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
    return payload.data;
  };

  const viewAbuseEvents = async (user: SelectedAuditUser) => {
    setStatus(null);
    setError(null);
    setBusy(`abuse-events-${user.id}`);

    try {
      const res = await fetch(`/api/admin/users/${user.id}/abuse-events?limit=40`, {
        credentials: 'include',
      });

      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setError(parseError(body, `加载用户 ${user.id} 的风控事件失败`));
        return;
      }

      const payload = body as { data?: AbuseEventItem[] };
      setSelectedUser(user);
      setEvents(Array.isArray(payload.data) ? payload.data : []);
      setStatus(`已加载 ${user.email} 的风控事件`);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      try {
        const loadedUsers = await loadUsers(initialEmail ?? '');
        if (!active || !initialUserId) {
          return;
        }

        const matchedUser = loadedUsers.find((user) => user.id === initialUserId);
        if (matchedUser) {
          await viewAbuseEvents({ id: matchedUser.id, email: matchedUser.email });
          return;
        }

        if (initialEmail) {
          await viewAbuseEvents({ id: initialUserId, email: initialEmail });
        }
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : '加载审计页面失败');
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, [initialEmail, initialUserId]);

  const searchUsers = async () => {
    setStatus(null);
    setError(null);
    setBusy('users-search');

    try {
      await loadUsers(usersQuery);
      setStatus('用户列表已更新');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '搜索用户失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2>审计事件</h2>

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
              void loadUsers('')
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
                <th>最近活跃</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const rowBusy = busy === `abuse-events-${user.id}`;
                return (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>
                      <span className={`admin-status-pill ${user.status}`}>
                        {user.status === 'active' ? '正常' : '封禁'}
                      </span>
                    </td>
                    <td>
                      <div className="mono">{user.last_seen_ip ?? '-'}</div>
                      <div className="notice">{formatDateTime(user.last_seen_at)}</div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        onClick={() => void viewAbuseEvents({ id: user.id, email: user.email })}
                      >
                        {rowBusy ? '加载中...' : '查看事件'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="notice">
                    未找到用户
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {selectedUser ? (
        <div className="card">
          <div className="admin-events-panel">
            <div className="card-title-row">
              <strong>{selectedUser.email} 的最近事件</strong>
              <button
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setSelectedUser(null);
                  setEvents([]);
                }}
              >
                关闭
              </button>
            </div>
            <div className="allowlist-preview admin-audit-events-list">
              {events.map((event) => (
                <div key={event.id} className="admin-event-item">
                  <div className="mono">
                    {event.event_type} @ {formatDateTime(event.created_at)}
                  </div>
                  <div className="notice">IP：{event.ip ?? '-'}</div>
                  <pre className="admin-event-metadata">{JSON.stringify(event.metadata ?? {}, null, 2)}</pre>
                </div>
              ))}
              {events.length === 0 ? <div className="notice">未找到事件</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
