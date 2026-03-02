'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type ThreadItem = {
  id: string;
  title: string;
  model: string | null;
  updated_at: string;
  created_at?: string;
};

type MessageAttachment = {
  file_id: string;
  filename: string;
  mime_type: string;
  content_url: string;
};

type MessageItem = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  attachments: MessageAttachment[];
};

type MePayload = {
  default_provider: string;
  default_model: string | null;
};

type ToastKind = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

function findSseBoundary(input: string): { index: number; length: number } | null {
  const idxLf = input.indexOf('\n\n');
  const idxCrLf = input.indexOf('\r\n\r\n');

  if (idxLf === -1 && idxCrLf === -1) {
    return null;
  }

  if (idxLf === -1) {
    return { index: idxCrLf, length: 4 };
  }

  if (idxCrLf === -1) {
    return { index: idxLf, length: 2 };
  }

  if (idxLf < idxCrLf) {
    return { index: idxLf, length: 2 };
  }

  return { index: idxCrLf, length: 4 };
}

function parseResponsesSseBuffer(buffer: string): { remaining: string; assistantDelta: string } {
  let remaining = buffer;
  let assistantDelta = '';

  while (true) {
    const boundary = findSseBoundary(remaining);
    if (!boundary) {
      break;
    }

    const block = remaining.slice(0, boundary.index);
    remaining = remaining.slice(boundary.index + boundary.length);

    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const eventData = dataLines.join('\n');
    if (!eventData || eventData === '[DONE]') {
      continue;
    }

    try {
      const parsed = JSON.parse(eventData) as Record<string, unknown>;
      if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        assistantDelta += parsed.delta;
      }
    } catch {
      continue;
    }
  }

  return { remaining, assistantDelta };
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') {
    return record.output_text;
  }

  if (!Array.isArray(record.output)) {
    return '';
  }

  const parts: string[] = [];
  for (const output of record.output) {
    if (!output || typeof output !== 'object') {
      continue;
    }
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }

  return parts.join('\n').trim();
}

function parseErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') {
    return record.error;
  }
  if (typeof record.message === 'string') {
    return record.message;
  }
  if (typeof record.error_description === 'string') {
    return record.error_description;
  }
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') {
      return nested.message;
    }
  }
  return fallback;
}

function makeLocalMessageId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function ChatPage() {
  const router = useRouter();
  const messageListEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastCounterRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [streamResponses, setStreamResponses] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeAbortController, setActiveAbortController] = useState<AbortController | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  const pushToast = (kind: ToastKind, message: string) => {
    const id = toastCounterRef.current + 1;
    toastCounterRef.current = id;

    setToasts((previous) => [...previous, { id, kind, message }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 4500);
  };

  const clearImage = () => {
    setImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setImagePreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  };

  const loadThreads = async (preferredThreadId?: string | null) => {
    const res = await fetch('/api/me/threads', { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) {
        router.replace('/login');
      } else {
        pushToast('error', 'Failed to load threads');
      }
      return;
    }

    const payload = (await res.json()) as { data: ThreadItem[] };
    setThreads(payload.data);
    setSelectedThreadId((current) => {
      const candidate = preferredThreadId ?? current;
      if (candidate && payload.data.some((thread) => thread.id === candidate)) {
        return candidate;
      }
      return payload.data[0]?.id ?? null;
    });
  };

  const loadMessages = async (threadId: string) => {
    const res = await fetch(`/api/me/threads/${threadId}/messages`, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 404) {
        setMessages([]);
      } else if (res.status === 401) {
        router.replace('/login');
      } else {
        pushToast('error', 'Failed to load messages');
      }
      return;
    }

    const payload = (await res.json()) as { data: MessageItem[] };
    setMessages(
      payload.data.map((message) => ({
        ...message,
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
      })),
    );
  };

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);

      const meRes = await fetch('/api/me', { credentials: 'include' });
      if (!meRes.ok) {
        router.replace('/login');
        return;
      }

      const me = (await meRes.json()) as MePayload;
      setProvider(me.default_provider);
      setModel(me.default_model ?? '');

      await loadThreads();
      setLoading(false);
    };

    void bootstrap();
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    messageListEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  const renameThread = async (threadId: string) => {
    const title = renameDraft.replace(/\s+/g, ' ').trim();
    if (!title) {
      pushToast('error', 'Thread title cannot be empty');
      return;
    }

    const res = await fetch(`/api/me/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      credentials: 'include',
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as unknown;
      pushToast('error', parseErrorMessage(body, 'Failed to rename thread'));
      return;
    }

    const payload = (await res.json()) as { data: ThreadItem };
    setThreads((previous) =>
      previous.map((thread) => (thread.id === threadId ? payload.data : thread)),
    );
    setRenamingThreadId(null);
    setRenameDraft('');
    pushToast('success', 'Thread renamed');
  };

  const stopStreaming = () => {
    if (!activeAbortController) {
      return;
    }
    activeAbortController.abort();
  };

  const sendMessage = async () => {
    if (sending || (!input.trim() && !image)) {
      return;
    }

    setSending(true);
    const requestAbortController = new AbortController();
    setActiveAbortController(requestAbortController);

    const optimisticMessageIds: string[] = [];
    let latestThreadId = selectedThreadId;

    try {
      let fileId: string | null = null;
      if (image) {
        const formData = new FormData();
        formData.append('file', image);
        formData.append('purpose', 'vision');

        const uploadRes = await fetch('/api/v1/files', {
          method: 'POST',
          body: formData,
          credentials: 'include',
          signal: requestAbortController.signal,
        });

        if (!uploadRes.ok) {
          const uploadBody = (await uploadRes.json().catch(() => null)) as unknown;
          throw new Error(parseErrorMessage(uploadBody, 'Image upload failed'));
        }

        const uploadBody = (await uploadRes.json()) as { id: string };
        fileId = uploadBody.id;
      }

      const content: Array<Record<string, unknown>> = [];
      if (input.trim()) {
        content.push({
          type: 'input_text',
          text: input.trim(),
        });
      }
      if (fileId) {
        content.push({
          type: 'input_image',
          file_id: fileId,
        });
      }

      const body: Record<string, unknown> = {
        input: [
          {
            role: 'user',
            content,
          },
        ],
        stream: streamResponses,
      };

      if (selectedThreadId) {
        body.thread_id = selectedThreadId;
      }
      if (provider.trim()) {
        body.provider = provider.trim();
      }
      if (model.trim()) {
        body.model = model.trim();
      }

      const optimisticUserId = makeLocalMessageId('local-user');
      const optimisticAssistantId = makeLocalMessageId('local-assistant');
      optimisticMessageIds.push(optimisticUserId, optimisticAssistantId);

      const optimisticAttachments: MessageAttachment[] = fileId
        ? [
            {
              file_id: fileId,
              filename: image?.name ?? 'image',
              mime_type: image?.type || 'image/*',
              content_url: `/api/v1/files/${fileId}/content`,
            },
          ]
        : [];

      setMessages((previous) => [
        ...previous,
        {
          id: optimisticUserId,
          role: 'user',
          content: input.trim() || '[image]',
          created_at: new Date().toISOString(),
          attachments: optimisticAttachments,
        },
        {
          id: optimisticAssistantId,
          role: 'assistant',
          content: '',
          created_at: new Date().toISOString(),
          attachments: [],
        },
      ]);

      setInput('');
      clearImage();

      const res = await fetch('/api/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'include',
        signal: requestAbortController.signal,
      });

      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as unknown;
        throw new Error(parseErrorMessage(errorBody, 'Request failed'));
      }

      const responseThreadId = res.headers.get('x-thread-id');
      if (responseThreadId) {
        latestThreadId = responseThreadId;
        setSelectedThreadId(responseThreadId);
      }

      if (streamResponses) {
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('Streaming response body missing');
        }

        let parserBuffer = '';
        let assistantText = '';
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          parserBuffer += chunk;

          const parsed = parseResponsesSseBuffer(parserBuffer);
          parserBuffer = parsed.remaining;
          if (!parsed.assistantDelta) {
            continue;
          }

          assistantText += parsed.assistantDelta;
          setMessages((previous) =>
            previous.map((message) =>
              message.id === optimisticAssistantId ? { ...message, content: assistantText } : message,
            ),
          );
        }

        const tail = decoder.decode();
        if (tail) {
          parserBuffer += tail;
          const parsedTail = parseResponsesSseBuffer(parserBuffer);
          assistantText += parsedTail.assistantDelta;
        }

        setMessages((previous) =>
          previous.map((message) =>
            message.id === optimisticAssistantId
              ? { ...message, content: assistantText || '[stream ended without text]' }
              : message,
          ),
        );
      } else {
        const payload = (await res.json()) as unknown;
        const assistantText = extractAssistantText(payload);
        setMessages((previous) =>
          previous.map((message) =>
            message.id === optimisticAssistantId
              ? { ...message, content: assistantText || '[empty response]' }
              : message,
          ),
        );
      }

      await loadThreads(latestThreadId);
      if (latestThreadId) {
        await loadMessages(latestThreadId);
      }

      pushToast('success', 'Response received');
    } catch (requestError) {
      setMessages((previous) =>
        previous.filter((message) => !optimisticMessageIds.includes(message.id)),
      );

      if (latestThreadId) {
        await loadThreads(latestThreadId);
        await loadMessages(latestThreadId);
      } else {
        await loadThreads();
      }

      if (requestError instanceof Error && requestError.name === 'AbortError') {
        pushToast('info', 'Generation stopped');
      } else {
        pushToast(
          'error',
          requestError instanceof Error ? requestError.message : 'Failed to send message',
        );
      }
    } finally {
      setSending(false);
      setActiveAbortController(null);
    }
  };

  const startNewThread = () => {
    setSelectedThreadId(null);
    setMessages([]);
    setRenamingThreadId(null);
    setRenameDraft('');
  };

  if (loading) {
    return <section className="panel">Loading chat...</section>;
  }

  return (
    <section className="chat-layout">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button className="primary" type="button" onClick={startNewThread}>
            + New chat
          </button>
        </div>

        <div className="chat-thread-list">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={`chat-thread-row ${thread.id === selectedThreadId ? 'selected' : ''}`}
            >
              <button
                type="button"
                className="chat-thread-select"
                onClick={() => {
                  setSelectedThreadId(thread.id);
                  setRenamingThreadId(null);
                  setRenameDraft('');
                }}
              >
                {renamingThreadId === thread.id ? (
                  <input
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void renameThread(thread.id);
                      } else if (event.key === 'Escape') {
                        setRenamingThreadId(null);
                        setRenameDraft('');
                      }
                    }}
                    className="chat-thread-rename-input"
                    autoFocus
                  />
                ) : (
                  <span className="chat-thread-title">{thread.title}</span>
                )}
                <span className="chat-thread-model">{thread.model ?? 'default model'}</span>
              </button>

              {renamingThreadId === thread.id ? (
                <div className="chat-thread-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void renameThread(thread.id)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setRenamingThreadId(null);
                      setRenameDraft('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setRenamingThreadId(thread.id);
                    setRenameDraft(thread.title);
                  }}
                >
                  Rename
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-main">
        <div className="panel chat-toolbar">
          <div>
            <h1>Chat</h1>
            <p className="notice">
              Thread: <span className="mono">{selectedThread?.title ?? 'New chat'}</span>
            </p>
          </div>

          <div className="chat-toolbar-controls">
            <label className="chat-toggle">
              <input
                type="checkbox"
                checked={streamResponses}
                onChange={(event) => setStreamResponses(event.target.checked)}
                disabled={sending}
              />
              Stream responses
            </label>
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                disabled={sending}
              >
                <option value="">(default)</option>
                <option value="openai">openai</option>
                <option value="grok2api">grok2api</option>
              </select>
            </label>
            <label>
              Model
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="use default if empty"
                disabled={sending}
              />
            </label>
          </div>
        </div>

        <div className="panel chat-messages-panel">
          <div className="chat-messages">
            {messages.length === 0 ? (
              <div className="notice">No messages yet. Start a new conversation.</div>
            ) : null}

            {messages.map((message) => (
              <article
                key={message.id}
                className={`chat-message ${message.role === 'assistant' ? 'assistant' : 'user'}`}
              >
                <div className="chat-message-role mono">{message.role}</div>

                {message.attachments.length > 0 ? (
                  <div className="chat-message-attachments">
                    {message.attachments.map((attachment) => (
                      <a
                        key={`${message.id}-${attachment.file_id}`}
                        href={attachment.content_url}
                        target="_blank"
                        rel="noreferrer"
                        className="chat-message-attachment"
                      >
                        <img src={attachment.content_url} alt={attachment.filename} loading="lazy" />
                      </a>
                    ))}
                  </div>
                ) : null}

                <div className="chat-message-content">{message.content}</div>
              </article>
            ))}

            <div ref={messageListEndRef} />
          </div>
        </div>

        <div className="panel chat-composer-panel">
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <label>
              Prompt
              <textarea
                rows={4}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Message new-chat..."
                disabled={sending}
              />
            </label>

            <label>
              Image attachment
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                disabled={sending}
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setImage(next);
                  setImagePreviewUrl((current) => {
                    if (current) {
                      URL.revokeObjectURL(current);
                    }
                    return next ? URL.createObjectURL(next) : null;
                  });
                }}
              />
            </label>

            {imagePreviewUrl ? (
              <div className="chat-image-preview">
                <img src={imagePreviewUrl} alt={image?.name ?? 'Selected image'} />
                <button className="ghost" type="button" onClick={clearImage} disabled={sending}>
                  Remove image
                </button>
              </div>
            ) : null}

            <div className="chat-composer-actions">
              <button className="primary" type="submit" disabled={sending}>
                {sending ? 'Sending...' : streamResponses ? 'Send & Stream' : 'Send'}
              </button>
              <button
                className="ghost"
                type="button"
                disabled={!sending || !activeAbortController}
                onClick={stopStreaming}
              >
                Stop
              </button>
              <button
                className="ghost"
                type="button"
                disabled={sending}
                onClick={() => {
                  setInput('');
                  clearImage();
                }}
              >
                Clear
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </section>
  );
}
