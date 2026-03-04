'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type {
  AdminThreadItem,
  AdminThreadMessageItem,
  AdminUserItem,
} from '../_components/types';
import { formatDateTime, parseError } from '../_components/utils';

type ChatUser = {
  id: string;
  email: string;
};

export default function AdminChatPage() {
  const searchParams = useSearchParams();
  const initialUserId = searchParams.get('user');
  const initialEmail = searchParams.get('email');

  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersQuery, setUsersQuery] = useState(initialEmail ?? '');

  const [selectedChatUser, setSelectedChatUser] = useState<ChatUser | null>(null);
  const [chatThreads, setChatThreads] = useState<AdminThreadItem[]>([]);
  const [selectedChatThreadId, setSelectedChatThreadId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<AdminThreadMessageItem[]>([]);
  const [chatMessagesNextCursor, setChatMessagesNextCursor] = useState<string | null>(null);

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

  const loadUserThreads = async (userId: string) => {
    const res = await fetch(`/api/admin/users/${userId}/threads`, {
      credentials: 'include',
    });

    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(parseError(body, `Failed to load threads for user ${userId}`));
    }

    const payload = body as { data?: AdminThreadItem[] };
    setChatThreads(Array.isArray(payload.data) ? payload.data : []);
  };

  const loadThreadMessages = async (params: {
    userId: string;
    threadId: string;
    cursor?: string | null;
    append?: boolean;
  }) => {
    const search = new URLSearchParams();
    search.set('limit', '100');
    if (params.cursor) {
      search.set('cursor', params.cursor);
    }

    const res = await fetch(
      `/api/admin/users/${params.userId}/threads/${params.threadId}/messages?${search.toString()}`,
      {
        credentials: 'include',
      },
    );

    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(parseError(body, `Failed to load messages for thread ${params.threadId}`));
    }

    const payload = body as {
      data?: AdminThreadMessageItem[];
      paging?: { next_cursor?: string | null };
    };
    const messages = Array.isArray(payload.data) ? payload.data : [];
    const nextCursor =
      payload.paging && typeof payload.paging.next_cursor === 'string'
        ? payload.paging.next_cursor
        : null;

    setChatMessages((previous) => (params.append ? [...previous, ...messages] : messages));
    setChatMessagesNextCursor(nextCursor);
  };

  const openUserChats = async (user: ChatUser) => {
    setStatus(null);
    setError(null);
    setBusy(`chat-threads-${user.id}`);
    setSelectedChatUser({ id: user.id, email: user.email });
    setSelectedChatThreadId(null);
    setChatMessages([]);
    setChatMessagesNextCursor(null);

    try {
      await loadUserThreads(user.id);
      setStatus(`Loaded chat threads for ${user.email}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load user chats');
      setSelectedChatUser(null);
      setChatThreads([]);
    } finally {
      setBusy(null);
    }
  };

  const openThreadMessages = async (userId: string, threadId: string) => {
    setStatus(null);
    setError(null);
    setBusy(`chat-messages-${threadId}`);
    setSelectedChatThreadId(threadId);
    setChatMessages([]);
    setChatMessagesNextCursor(null);

    try {
      await loadThreadMessages({ userId, threadId, append: false });
      setStatus('Loaded thread messages');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load thread messages');
    } finally {
      setBusy(null);
    }
  };

  const loadMoreThreadMessages = async () => {
    if (!selectedChatUser || !selectedChatThreadId || !chatMessagesNextCursor) {
      return;
    }

    setStatus(null);
    setError(null);
    setBusy(`chat-messages-more-${selectedChatThreadId}`);

    try {
      await loadThreadMessages({
        userId: selectedChatUser.id,
        threadId: selectedChatThreadId,
        cursor: chatMessagesNextCursor,
        append: true,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load more messages');
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
          await openUserChats({ id: matchedUser.id, email: matchedUser.email });
          return;
        }

        if (initialEmail) {
          await openUserChats({ id: initialUserId, email: initialEmail });
        }
      } catch (requestError) {
        if (!active) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : 'Failed to load chat viewer');
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
        <h2>Chat Viewer</h2>

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
                const rowBusy = busy === `chat-threads-${user.id}`;
                return (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>
                      <span className={`admin-status-pill ${user.status}`}>
                        {user.status === 'active' ? 'active' : 'banned'}
                      </span>
                      {user.deleted_at ? (
                        <div className="notice">soft-deleted {formatDateTime(user.deleted_at)}</div>
                      ) : null}
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
                        onClick={() => void openUserChats({ id: user.id, email: user.email })}
                      >
                        {rowBusy ? 'Loading...' : 'View chats'}
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

      {selectedChatUser ? (
        <div className="card">
          <div className="admin-chat-viewer">
            <div className="card-title-row">
              <strong>Chat Records for {selectedChatUser.email}</strong>
              <button
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setSelectedChatUser(null);
                  setChatThreads([]);
                  setSelectedChatThreadId(null);
                  setChatMessages([]);
                  setChatMessagesNextCursor(null);
                }}
              >
                Close
              </button>
            </div>

            <div className="admin-chat-layout">
              <div className="admin-chat-threads">
                {chatThreads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`admin-chat-thread-button ${selectedChatThreadId === thread.id ? 'active' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void openThreadMessages(selectedChatUser.id, thread.id)}
                  >
                    <span>{thread.title}</span>
                    <span className="notice">messages: {thread.msg_count}</span>
                    <span className="notice">updated: {formatDateTime(thread.updated_at)}</span>
                  </button>
                ))}
                {chatThreads.length === 0 ? (
                  <div className="notice admin-chat-empty">No threads found for this user.</div>
                ) : null}
              </div>

              <div className="admin-chat-messages">
                {!selectedChatThreadId ? (
                  <div className="notice admin-chat-empty">Select a thread to view messages.</div>
                ) : (
                  <>
                    <div className="admin-chat-message-list">
                      {chatMessages.map((message) => (
                        <div key={message.id} className="admin-chat-message">
                          <div className="admin-chat-message-header">
                            <span className="mono">{message.role}</span>
                            <span className="notice">{formatDateTime(message.created_at)}</span>
                          </div>
                          <pre className="admin-chat-message-content">{message.content}</pre>
                          {message.attachments.length > 0 ? (
                            <div className="admin-chat-attachments">
                              {message.attachments.map((attachment) => (
                                <a
                                  key={`${message.id}-${attachment.file_id}`}
                                  className="admin-chat-attachment"
                                  href={attachment.content_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {attachment.filename} ({attachment.mime_type})
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {chatMessages.length === 0 ? (
                        <div className="notice admin-chat-empty">No messages found for this thread.</div>
                      ) : null}
                    </div>

                    {chatMessagesNextCursor ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy !== null}
                        onClick={() => void loadMoreThreadMessages()}
                      >
                        {busy === `chat-messages-more-${selectedChatThreadId}` ? 'Loading...' : 'Load more'}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {status ? <div className="notice">{status}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
