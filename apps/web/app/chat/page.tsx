'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type ThreadItem = {
  id: string;
  title: string;
  model: string | null;
  updated_at: string;
};

type MessageItem = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
};

type MePayload = {
  default_provider: string;
  default_model: string | null;
};

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') {
    return record.output_text;
  }

  if (Array.isArray(record.output)) {
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

  return '';
}

export default function ChatPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  const loadThreads = async () => {
    const res = await fetch('/api/me/threads', { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) {
        router.replace('/login');
      }
      return;
    }
    const payload = (await res.json()) as { data: ThreadItem[] };
    setThreads(payload.data);

    if (!selectedThreadId && payload.data.length > 0) {
      setSelectedThreadId(payload.data[0]!.id);
    }
  };

  const loadMessages = async (threadId: string) => {
    const res = await fetch(`/api/me/threads/${threadId}/messages`, { credentials: 'include' });
    if (!res.ok) {
      return;
    }
    const payload = (await res.json()) as { data: MessageItem[] };
    setMessages(payload.data);
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

  const sendMessage = async () => {
    if (!input.trim() && !image) {
      return;
    }

    setSending(true);
    setError(null);
    setStatus(null);

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
        });

        if (!uploadRes.ok) {
          const body = (await uploadRes.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? 'Image upload failed');
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
        stream: false,
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

      const res = await fetch('/api/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'include',
      });

      if (!res.ok) {
        const errorBody = (await res.json().catch(() => null)) as
          | { error?: string; message?: string; error_description?: string }
          | null;
        throw new Error(
          errorBody?.error ?? errorBody?.message ?? errorBody?.error_description ?? 'Request failed',
        );
      }

      const payload = (await res.json()) as unknown;
      const maybeThreadId = res.headers.get('x-thread-id');
      const assistantText = extractAssistantText(payload);

      setInput('');
      setImage(null);

      if (maybeThreadId) {
        setSelectedThreadId(maybeThreadId);
      }

      await loadThreads();
      if (maybeThreadId) {
        await loadMessages(maybeThreadId);
      } else if (selectedThreadId) {
        await loadMessages(selectedThreadId);
      }

      setStatus(assistantText ? 'Response received' : 'Response received (empty text)');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const startNewThread = () => {
    setSelectedThreadId(null);
    setMessages([]);
    setStatus('New thread will be created on next message');
  };

  if (loading) {
    return <section className="panel">Loading chat...</section>;
  }

  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        gap: '1rem',
      }}
    >
      <aside className="panel" style={{ display: 'grid', gap: '.75rem', alignContent: 'start' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Threads</h2>
          <button className="secondary" onClick={startNewThread} type="button">
            New
          </button>
        </div>
        <div style={{ maxHeight: '65vh', overflow: 'auto', display: 'grid', gap: '.4rem' }}>
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className={thread.id === selectedThreadId ? 'secondary' : 'ghost'}
              style={{ textAlign: 'left' }}
              onClick={() => setSelectedThreadId(thread.id)}
            >
              <div style={{ fontWeight: 600 }}>{thread.title}</div>
              <div className="notice mono" style={{ fontSize: '.8rem' }}>
                {thread.model ?? 'model not set'}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div style={{ display: 'grid', gap: '1rem' }}>
        <div className="panel" style={{ display: 'grid', gap: '.7rem' }}>
          <h1 style={{ margin: 0 }}>Chat</h1>
          <div className="notice">
            Thread: <span className="mono">{selectedThread?.title ?? 'new thread'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
            <label>
              Provider override
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="">(default)</option>
                <option value="openai">openai</option>
                <option value="grok2api">grok2api</option>
              </select>
            </label>
            <label>
              Model override
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="use default if empty"
              />
            </label>
          </div>
        </div>

        <div className="panel" style={{ minHeight: '48vh', maxHeight: '48vh', overflow: 'auto' }}>
          <div style={{ display: 'grid', gap: '.8rem' }}>
            {messages.length === 0 ? <div className="notice">No messages yet.</div> : null}
            {messages.map((message) => (
              <article
                key={message.id}
                style={{
                  background: message.role === 'assistant' ? '#f8f5e8' : '#eef4fd',
                  border: '1px solid #c9d8e9',
                  borderRadius: 12,
                  padding: '.75rem',
                }}
              >
                <div className="mono" style={{ fontSize: '.8rem', marginBottom: '.3rem' }}>
                  {message.role}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <form
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
                placeholder="Ask anything..."
              />
            </label>
            <label>
              Image (optional)
              <input
                type="file"
                accept="image/*"
                onChange={(event) => setImage(event.target.files?.[0] ?? null)}
              />
            </label>
            <div style={{ display: 'flex', gap: '.7rem' }}>
              <button className="primary" type="submit" disabled={sending}>
                {sending ? 'Sending...' : 'Send'}
              </button>
              <button
                className="ghost"
                type="button"
                disabled={sending}
                onClick={() => {
                  setInput('');
                  setImage(null);
                }}
              >
                Clear
              </button>
            </div>
          </form>
        </div>

        {status ? <div className="notice">{status}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </div>
    </section>
  );
}
