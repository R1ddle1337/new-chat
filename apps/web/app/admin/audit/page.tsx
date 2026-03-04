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
      throw new Error(parseError(body, 'Failed to load users'));
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
        setError(parseError(body, `Failed to load abuse events for user ${user.id}`));
        return;
      }

      const payload = body as { data?: AbuseEventItem[] };
      setSelectedUser(user);
      setEvents(Array.isArray(payload.data) ? payload.data : []);
      setStatus(`Loaded abuse events for ${user.email}`);
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
        setError(requestError instanceof Error ? requestError.message : 'Failed to load audit page');
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
      setStatus('User list updated');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to search users');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Audit Events</h2>

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
              void loadUsers('')
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
                <th>Last Seen</th>
                <th>Action</th>
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
                        {user.status === 'active' ? 'active' : 'banned'}
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
                        {rowBusy ? 'Loading...' : 'View events'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={4} className="notice">
                    No users found
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
              <strong>Recent Events for {selectedUser.email}</strong>
              <button
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setSelectedUser(null);
                  setEvents([]);
                }}
              >
                Close
              </button>
            </div>
            <div className="allowlist-preview admin-audit-events-list">
              {events.map((event) => (
                <div key={event.id} className="admin-event-item">
                  <div className="mono">
                    {event.event_type} @ {formatDateTime(event.created_at)}
                  </div>
                  <div className="notice">IP: {event.ip ?? '-'}</div>
                  <pre className="admin-event-metadata">{JSON.stringify(event.metadata ?? {}, null, 2)}</pre>
                </div>
              ))}
              {events.length === 0 ? <div className="notice">No events found</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
