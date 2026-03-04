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
      throw new Error(parseError(body, '加载用户失败'));
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
      throw new Error(parseError(body, `加载用户 ${userId} 的会话失败`));
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
      throw new Error(parseError(body, `加载会话 ${params.threadId} 的消息失败`));
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
      setStatus(`已加载 ${user.email} 的聊天会话`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载用户聊天失败');
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
      setStatus('会话消息已加载');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '加载会话消息失败');
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
      setError(requestError instanceof Error ? requestError.message : '加载更多消息失败');
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
        setError(requestError instanceof Error ? requestError.message : '加载聊天查看器失败');
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
        <h2>聊天查看器</h2>

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
                const rowBusy = busy === `chat-threads-${user.id}`;
                return (
                  <tr key={user.id}>
                    <td>{user.email}</td>
                    <td>
                      <span className={`admin-status-pill ${user.status}`}>
                        {user.status === 'active' ? '正常' : '封禁'}
                      </span>
                      {user.deleted_at ? (
                        <div className="notice">软删除于 {formatDateTime(user.deleted_at)}</div>
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
                        {rowBusy ? '加载中...' : '查看聊天'}
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

      {selectedChatUser ? (
        <div className="card">
          <div className="admin-chat-viewer">
            <div className="card-title-row">
              <strong>{selectedChatUser.email} 的聊天记录</strong>
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
                关闭
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
                    <span className="notice">消息数：{thread.msg_count}</span>
                    <span className="notice">更新于：{formatDateTime(thread.updated_at)}</span>
                  </button>
                ))}
                {chatThreads.length === 0 ? (
                  <div className="notice admin-chat-empty">该用户暂无聊天会话。</div>
                ) : null}
              </div>

              <div className="admin-chat-messages">
                {!selectedChatThreadId ? (
                  <div className="notice admin-chat-empty">请选择会话以查看消息。</div>
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
                        <div className="notice admin-chat-empty">该会话暂无消息。</div>
                      ) : null}
                    </div>

                    {chatMessagesNextCursor ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy !== null}
                        onClick={() => void loadMoreThreadMessages()}
                      >
                        {busy === `chat-messages-more-${selectedChatThreadId}` ? '加载中...' : '加载更多'}
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
