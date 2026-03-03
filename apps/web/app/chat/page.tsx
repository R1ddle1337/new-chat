'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import MainHeader from '../components/main-header';
import { useChatShell } from '../components/chat-shell-context';

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

type AllowedModelItem = {
  id: string;
  provider: string;
  display_name?: string | null;
};

type ModelsPayload = {
  data: Array<{ id?: string; provider?: string; display_name?: string | null }>;
};

type ToastKind = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const autoScrollThresholdPx = 120;

function sanitizeLinkHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) {
    return null;
  }

  if (href.startsWith('/')) {
    return href;
  }

  try {
    const parsed = new URL(href, 'https://example.com');
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' || protocol === 'tel:') {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  if (!text) {
    return [''];
  }

  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]+`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let cursor = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    if (match[1]) {
      nodes.push(
        <code key={`${keyPrefix}-code-${tokenIndex}`} className="chat-inline-code">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2] && match[3] && match[4]) {
      const safeHref = sanitizeLinkHref(match[4]);
      if (safeHref) {
        nodes.push(
          <a
            key={`${keyPrefix}-link-${tokenIndex}`}
            className="chat-markdown-link"
            href={safeHref}
            target="_blank"
            rel="noreferrer"
          >
            {match[3]}
          </a>,
        );
      } else {
        nodes.push(match[2]);
      }
    }

    cursor = tokenPattern.lastIndex;
    tokenIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function renderTextParagraphs(text: string, keyPrefix: string): ReactNode[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/).filter((paragraph) => paragraph.trim());
  return paragraphs.map((paragraph, paragraphIndex) => {
    const lines = paragraph.split('\n');
    const lineNodes: ReactNode[] = [];

    lines.forEach((line, lineIndex) => {
      lineNodes.push(
        ...renderInlineMarkdown(line, `${keyPrefix}-paragraph-${paragraphIndex}-line-${lineIndex}`),
      );

      if (lineIndex < lines.length - 1) {
        lineNodes.push(
          <br key={`${keyPrefix}-paragraph-${paragraphIndex}-linebreak-${lineIndex}`} />,
        );
      }
    });

    return <p key={`${keyPrefix}-paragraph-${paragraphIndex}`}>{lineNodes}</p>;
  });
}

function renderSimpleMarkdown(content: string): ReactNode[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const blocks: ReactNode[] = [];
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let sectionIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(normalized)) !== null) {
    const textBeforeCodeBlock = normalized.slice(cursor, match.index);
    blocks.push(...renderTextParagraphs(textBeforeCodeBlock, `section-${sectionIndex}-text`));

    const language = match[1].trim();
    const code = match[2].replace(/\n$/, '');
    blocks.push(
      <pre key={`section-${sectionIndex}-code`} className="chat-code-block">
        <code className={language ? `language-${language}` : undefined}>{code}</code>
      </pre>,
    );

    cursor = codeBlockPattern.lastIndex;
    sectionIndex += 1;
  }

  const trailingText = normalized.slice(cursor);
  blocks.push(...renderTextParagraphs(trailingText, `section-${sectionIndex}-tail`));

  return blocks;
}

function MessageMarkdown({ content }: { content: string }) {
  return <>{renderSimpleMarkdown(content)}</>;
}

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

function makeModelLabel(model: AllowedModelItem): string {
  const displayName = model.display_name?.trim();
  return displayName ? `${displayName} (${model.id})` : model.id;
}

function makeLocalMessageId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function imageFileExtensionFromMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    default:
      return 'png';
  }
}

function normalizePastedImageFile(file: File): File {
  if (file.name && file.name.trim().length > 0) {
    return file;
  }

  const mimeType = file.type || 'image/png';
  const extension = imageFileExtensionFromMimeType(mimeType);
  const now = Date.now();

  return new File([file], `pasted-image-${now}.${extension}`, {
    type: mimeType,
    lastModified: now,
  });
}

function isNearBottom(element: HTMLElement): boolean {
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distance <= autoScrollThresholdPx;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'absolute';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);

  if (!copied) {
    throw new Error('Clipboard unavailable');
  }
}

export default function ChatPage() {
  const router = useRouter();
  const { loading: shellLoading, selectedThreadId, selectedThread, refreshThreads, selectThread } =
    useChatShell();

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListEndRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const toastCounterRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seededMessageIdsRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [animatingMessageIds, setAnimatingMessageIds] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [allowedModels, setAllowedModels] = useState<AllowedModelItem[]>([]);
  const [streamResponses, setStreamResponses] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeAbortController, setActiveAbortController] = useState<AbortController | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const modelSelectionOptions = useMemo(() => {
    return allowedModels.map((entry) => ({
      ...entry,
      value: `${entry.provider}::${entry.id}`,
    }));
  }, [allowedModels]);

  const selectedModelValue = useMemo(() => {
    if (!provider || !model) {
      return '';
    }

    return `${provider}::${model}`;
  }, [provider, model]);

  const canSend =
    !sending && Boolean(provider.trim()) && Boolean(model.trim()) && (input.trim().length > 0 || Boolean(image));
  const composerActive = composerFocused || Boolean(input.trim()) || Boolean(image);

  const pushToast = (kind: ToastKind, message: string) => {
    const id = toastCounterRef.current + 1;
    toastCounterRef.current = id;

    setToasts((previous) => [...previous, { id, kind, message }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 4500);
  };

  const setAttachedImage = useCallback((nextImage: File | null) => {
    setImage(nextImage);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setImagePreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return nextImage ? URL.createObjectURL(nextImage) : null;
    });
  }, []);

  const clearImage = useCallback(() => {
    setAttachedImage(null);
  }, [setAttachedImage]);

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const clipboardItems = event.clipboardData?.items;
      if (!clipboardItems || clipboardItems.length === 0) {
        return;
      }

      let pastedImage: File | null = null;
      for (const item of Array.from(clipboardItems)) {
        if (!item.type.startsWith('image/')) {
          continue;
        }

        const rawFile = item.getAsFile();
        if (!rawFile) {
          continue;
        }

        pastedImage = normalizePastedImageFile(rawFile);
        break;
      }

      if (!pastedImage && event.clipboardData?.files?.length) {
        const imageFile = Array.from(event.clipboardData.files).find((file) =>
          file.type.startsWith('image/'),
        );
        if (imageFile) {
          pastedImage = normalizePastedImageFile(imageFile);
        }
      }

      if (pastedImage) {
        setAttachedImage(pastedImage);
      }
    },
    [setAttachedImage],
  );

  const adjustComposerHeight = useCallback(() => {
    const textarea = composerInputRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = '0px';
    const nextHeight = Math.min(textarea.scrollHeight, 220);
    textarea.style.height = `${Math.max(nextHeight, 44)}px`;
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    messageListEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    shouldAutoScrollRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  const updateAutoScrollState = useCallback(() => {
    const container = messageListRef.current;
    if (!container) {
      return;
    }

    const nearBottom = isNearBottom(container);
    shouldAutoScrollRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }, []);

  const loadAllowedModels = async (): Promise<AllowedModelItem[]> => {
    const response = await fetch('/api/v1/models', { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) {
        router.replace('/login');
      }
      throw new Error('Failed to load allowed models');
    }

    const payload = (await response.json()) as ModelsPayload;
    const list = payload.data
      .filter((item): item is { id: string; provider: string; display_name?: string | null } => {
        return typeof item.id === 'string' && typeof item.provider === 'string';
      })
      .map((item) => ({
        id: item.id,
        provider: item.provider,
        display_name: item.display_name ?? null,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

    setAllowedModels(list);
    return list;
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
        setLoading(false);
        return;
      }

      const me = (await meRes.json()) as MePayload;

      try {
        const models = await loadAllowedModels();
        const modelProviders = Array.from(new Set(models.map((entry) => entry.provider)));

        const preferredProvider = modelProviders.includes(me.default_provider)
          ? me.default_provider
          : modelProviders[0] ?? '';
        setProvider(preferredProvider);

        const providerModels = models.filter((entry) => entry.provider === preferredProvider);
        const preferredModel =
          me.default_model && providerModels.some((entry) => entry.id === me.default_model)
            ? me.default_model
            : providerModels[0]?.id ?? '';
        setModel(preferredModel);
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : 'Failed to load allowed models');
      } finally {
        setLoading(false);
      }
    };

    void bootstrap();
  }, [router]);

  useEffect(() => {
    if (!provider) {
      setModel('');
      return;
    }

    const providerModels = allowedModels.filter((entry) => entry.provider === provider);
    if (providerModels.length === 0) {
      setModel('');
      return;
    }

    if (!providerModels.some((entry) => entry.id === model)) {
      setModel(providerModels[0]!.id);
    }
  }, [allowedModels, provider, model]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    setShowJumpToLatest(false);
    seenMessageIdsRef.current = new Set();
    seededMessageIdsRef.current = false;
    setAnimatingMessageIds([]);

    if (!selectedThreadId) {
      setMessages([]);
      return;
    }

    void loadMessages(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!seededMessageIdsRef.current) {
      seenMessageIdsRef.current = new Set(messages.map((message) => message.id));
      seededMessageIdsRef.current = true;
      return;
    }

    if (messages.length === 0) {
      return;
    }

    const nextIds = messages
      .map((message) => message.id)
      .filter((messageId) => !seenMessageIdsRef.current.has(messageId));

    if (nextIds.length === 0) {
      return;
    }

    for (const messageId of nextIds) {
      seenMessageIdsRef.current.add(messageId);
    }

    setAnimatingMessageIds((current) => {
      const mergedIds = new Set(current);
      for (const messageId of nextIds) {
        mergedIds.add(messageId);
      }
      return Array.from(mergedIds);
    });

    const timeoutId = window.setTimeout(() => {
      setAnimatingMessageIds((current) => current.filter((messageId) => !nextIds.includes(messageId)));
    }, 340);

    return () => window.clearTimeout(timeoutId);
  }, [messages]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (shouldAutoScrollRef.current) {
        scrollToLatest('auto');
        return;
      }

      updateAutoScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [messages, scrollToLatest, updateAutoScrollState]);

  useEffect(() => {
    adjustComposerHeight();
  }, [adjustComposerHeight, input]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  const copyAssistantMessage = async (message: MessageItem) => {
    try {
      await copyTextToClipboard(message.content);
      pushToast('success', 'Copied response');
    } catch {
      pushToast('error', 'Failed to copy response');
    }
  };

  const stopStreaming = () => {
    if (!activeAbortController) {
      return;
    }
    activeAbortController.abort();
  };

  const sendMessage = async () => {
    const promptText = input.trim();
    if (sending || (!promptText && !image)) {
      return;
    }

    if (!provider.trim() || !model.trim()) {
      pushToast('error', 'Select a model from the allowlist');
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
      if (promptText) {
        content.push({
          type: 'input_text',
          text: promptText,
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
        provider: provider.trim(),
        model: model.trim(),
      };

      if (selectedThreadId) {
        body.thread_id = selectedThreadId;
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
          content: promptText || '[image]',
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
        selectThread(responseThreadId);
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

      await refreshThreads(latestThreadId);
      if (latestThreadId) {
        await loadMessages(latestThreadId);
      }

      pushToast('success', 'Response received');
    } catch (requestError) {
      setMessages((previous) => previous.filter((message) => !optimisticMessageIds.includes(message.id)));

      await refreshThreads(latestThreadId);
      if (latestThreadId) {
        await loadMessages(latestThreadId);
      }

      if (requestError instanceof Error && requestError.name === 'AbortError') {
        pushToast('info', 'Generation stopped');
      } else {
        pushToast('error', requestError instanceof Error ? requestError.message : 'Failed to send message');
      }
    } finally {
      setSending(false);
      setActiveAbortController(null);
    }
  };

  if (loading || shellLoading) {
    return <section className="panel page-loading">Loading chat...</section>;
  }

  return (
    <section className="chat-page app-page">
      <MainHeader
        title={selectedThread?.title ?? 'New chat'}
        subtitle={selectedThread ? 'Conversation' : 'Start a conversation'}
        right={
          <div className="chat-header-controls">
            <label className="inline-field">
              <span>Model</span>
              <select
                value={selectedModelValue}
                onChange={(event) => {
                  const [nextProvider, nextModel] = event.target.value.split('::');
                  if (!nextProvider || !nextModel) {
                    setProvider('');
                    setModel('');
                    return;
                  }

                  setProvider(nextProvider);
                  setModel(nextModel);
                }}
                disabled={sending || modelSelectionOptions.length === 0}
              >
                {modelSelectionOptions.length === 0 ? (
                  <option value="">No allowed models</option>
                ) : (
                  modelSelectionOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.provider}/{makeModelLabel(item)}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="chat-toggle-field">
              <input
                type="checkbox"
                checked={streamResponses}
                onChange={(event) => setStreamResponses(event.target.checked)}
                disabled={sending}
              />
              <span>Stream</span>
            </label>
          </div>
        }
      />

      {modelSelectionOptions.length === 0 ? (
        <p className="error chat-header-error">No allowed models are configured by admin.</p>
      ) : null}

      <div className="chat-surface">
        <div ref={messageListRef} className="chat-messages-scroll" onScroll={updateAutoScrollState}>
          {messages.length === 0 ? (
            <div className="chat-empty-state">No messages yet. Start a new conversation.</div>
          ) : null}

          {messages.map((message) => {
            const assistantMessage = message.role === 'assistant';
            const showGenerating = assistantMessage && sending && !message.content.trim();
            const isEntering = animatingMessageIds.includes(message.id);

            return (
              <article
                key={message.id}
                className={`chat-message-row ${assistantMessage ? 'assistant' : 'user'}${isEntering ? ' chat-message-enter' : ''}`}
              >
                <div className="chat-message-inner">
                  {message.attachments.length > 0 ? (
                    <div className="chat-message-attachments-row">
                      {message.attachments.map((attachment) => {
                        const imageAttachment = attachment.mime_type.startsWith('image/');

                        return (
                          <a
                            key={`${message.id}-${attachment.file_id}`}
                            href={attachment.content_url}
                            target="_blank"
                            rel="noreferrer"
                            className="chat-message-attachment"
                            title={attachment.filename}
                          >
                            {imageAttachment ? (
                              <img
                                src={attachment.content_url}
                                alt={attachment.filename}
                                loading="lazy"
                              />
                            ) : (
                              <div className="chat-message-attachment-fallback">FILE</div>
                            )}
                            <span className="chat-message-attachment-name">{attachment.filename}</span>
                          </a>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="chat-message-content">
                    {showGenerating ? (
                      <div className="chat-inline-streaming">
                        <span className="chat-streaming-dot" />
                        Generating...
                      </div>
                    ) : (
                      <MessageMarkdown content={message.content} />
                    )}
                  </div>

                  {assistantMessage && message.content.trim() ? (
                    <button
                      type="button"
                      className="chat-copy-button"
                      onClick={() => void copyAssistantMessage(message)}
                    >
                      Copy
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}

          <div ref={messageListEndRef} />
        </div>

        {showJumpToLatest && messages.length > 0 ? (
          <button type="button" className="chat-jump-latest" onClick={() => scrollToLatest('smooth')}>
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className="chat-composer-region">
        {imagePreviewUrl ? (
          <div className="chat-image-preview-row">
            <img src={imagePreviewUrl} alt={image?.name ?? 'Selected image'} />
            <button className="ghost" type="button" onClick={clearImage} disabled={sending}>
              Remove image
            </button>
          </div>
        ) : null}

        <form
          className={`chat-composer-bar${composerActive ? ' is-active' : ''}`}
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
              return;
            }
            setComposerFocused(false);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="image/*"
            disabled={sending}
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setAttachedImage(next);
            }}
          />

          <button
            type="button"
            className="chat-attach-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Attach image"
            title="Attach image"
          >
            +
          </button>

          <textarea
            ref={composerInputRef}
            className="chat-composer-input"
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) {
                  void sendMessage();
                }
              }
            }}
            placeholder="Message new-chat"
            disabled={sending}
          />

          {sending ? (
            <button
              className="chat-stop-button"
              type="button"
              disabled={!activeAbortController}
              onClick={stopStreaming}
            >
              Stop
            </button>
          ) : (
            <button className="chat-send-button" type="submit" disabled={!canSend}>
              Send
            </button>
          )}
        </form>

        <div className="chat-composer-status">
          <div className="chat-composer-status-left">
            {sending ? (
              <span className="chat-streaming-indicator" role="status" aria-live="polite">
                <span className="chat-streaming-dot" />
                Generating response
              </span>
            ) : (
              'Enter to send, Shift+Enter for newline'
            )}
          </div>

          <button
            className="ghost chat-clear-button"
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
