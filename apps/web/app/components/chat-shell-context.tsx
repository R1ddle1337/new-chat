'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';

export type ThreadItem = {
  id: string;
  title: string;
  model: string | null;
  updated_at: string;
  created_at?: string;
};

type MePayload = {
  is_admin: boolean;
};

type ApiResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

type ChatShellContextValue = {
  loading: boolean;
  isAdmin: boolean;
  threads: ThreadItem[];
  selectedThreadId: string | null;
  selectedThread: ThreadItem | null;
  selectThread: (threadId: string | null) => void;
  refreshThreads: (preferredThreadId?: string | null) => Promise<void>;
  createThread: () => Promise<ApiResult<string>>;
  renameThread: (threadId: string, title: string) => Promise<ApiResult<ThreadItem>>;
  deleteThread: (threadId: string) => Promise<ApiResult<void>>;
};

const ChatShellContext = createContext<ChatShellContextValue | null>(null);

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

  if (record.error && typeof record.error === 'object') {
    const nestedError = record.error as Record<string, unknown>;
    if (typeof nestedError.message === 'string') {
      return nestedError.message;
    }
  }

  return fallback;
}

function pickSelectedThreadId(
  threads: ThreadItem[],
  previousSelectedId: string | null,
  preferredThreadId?: string | null,
): string | null {
  const preferred = preferredThreadId ?? previousSelectedId;
  if (preferred && threads.some((thread) => thread.id === preferred)) {
    return preferred;
  }

  return threads[0]?.id ?? null;
}

export function ChatShellProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  const refreshThreads = useCallback(
    async (preferredThreadId?: string | null) => {
      const response = await fetch('/api/me/threads', { credentials: 'include' });

      if (response.status === 401) {
        setThreads([]);
        setSelectedThreadId(null);
        router.replace('/login');
        return;
      }

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as { data: ThreadItem[] };
      setThreads(payload.data);
      setSelectedThreadId((current) =>
        pickSelectedThreadId(payload.data, current, preferredThreadId),
      );
    },
    [router],
  );

  const loadSession = useCallback(async () => {
    setLoading(true);

    const meResponse = await fetch('/api/me', { credentials: 'include' });
    if (meResponse.status === 401) {
      router.replace('/login');
      setLoading(false);
      return;
    }

    if (!meResponse.ok) {
      setLoading(false);
      return;
    }

    const me = (await meResponse.json()) as MePayload;
    setIsAdmin(Boolean(me.is_admin));
    await refreshThreads();
    setLoading(false);
  }, [refreshThreads, router]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const selectThread = useCallback(
    (threadId: string | null) => {
      setSelectedThreadId(threadId);
      if (threadId && pathname !== '/chat') {
        router.push('/chat');
      }
    },
    [pathname, router],
  );

  const createThread = useCallback(async (): Promise<ApiResult<string>> => {
    const response = await fetch('/api/me/threads', {
      method: 'POST',
      credentials: 'include',
    });

    if (response.status === 401) {
      router.replace('/login');
      return { ok: false, error: 'Your session expired. Please log in again.' };
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as unknown;
      return { ok: false, error: parseErrorMessage(body, 'Failed to create chat') };
    }

    const payload = (await response.json()) as { data: ThreadItem };
    const nextThread = payload.data;

    setThreads((current) => [nextThread, ...current.filter((thread) => thread.id !== nextThread.id)]);
    setSelectedThreadId(nextThread.id);

    if (pathname !== '/chat') {
      router.push('/chat');
    }

    await refreshThreads(nextThread.id);

    return { ok: true, value: nextThread.id };
  }, [pathname, refreshThreads, router]);

  const renameThread = useCallback(
    async (threadId: string, title: string): Promise<ApiResult<ThreadItem>> => {
      const normalizedTitle = title.replace(/\s+/g, ' ').trim();
      if (!normalizedTitle) {
        return { ok: false, error: 'Thread title cannot be empty' };
      }

      const response = await fetch(`/api/me/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: normalizedTitle }),
      });

      if (response.status === 401) {
        router.replace('/login');
        return { ok: false, error: 'Your session expired. Please log in again.' };
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as unknown;
        return { ok: false, error: parseErrorMessage(body, 'Failed to rename thread') };
      }

      const payload = (await response.json()) as { data: ThreadItem };
      setThreads((current) =>
        current.map((thread) => (thread.id === threadId ? payload.data : thread)),
      );

      return { ok: true, value: payload.data };
    },
    [router],
  );

  const deleteThread = useCallback(
    async (threadId: string): Promise<ApiResult<void>> => {
      const response = await fetch(`/api/me/threads/${threadId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.status === 401) {
        router.replace('/login');
        return { ok: false, error: 'Your session expired. Please log in again.' };
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as unknown;
        return { ok: false, error: parseErrorMessage(body, 'Failed to delete thread') };
      }

      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      setSelectedThreadId((current) => (current === threadId ? null : current));

      await refreshThreads(selectedThreadId === threadId ? null : selectedThreadId);

      return { ok: true, value: undefined };
    },
    [refreshThreads, router, selectedThreadId],
  );

  const contextValue = useMemo<ChatShellContextValue>(
    () => ({
      loading,
      isAdmin,
      threads,
      selectedThreadId,
      selectedThread,
      selectThread,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
    }),
    [
      loading,
      isAdmin,
      threads,
      selectedThreadId,
      selectedThread,
      selectThread,
      refreshThreads,
      createThread,
      renameThread,
      deleteThread,
    ],
  );

  return <ChatShellContext.Provider value={contextValue}>{children}</ChatShellContext.Provider>;
}

export function useChatShell(): ChatShellContextValue {
  const context = useContext(ChatShellContext);
  if (!context) {
    throw new Error('useChatShell must be used inside ChatShellProvider');
  }
  return context;
}
