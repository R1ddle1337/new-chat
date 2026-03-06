'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentPropsWithoutRef,
} from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  STREAM_RESPONSES_STORAGE_KEY,
  readStreamResponsesPreference,
} from '../components/chat-preferences';
import MainHeader from '../components/main-header';
import { useChatShell } from '../components/chat-shell-context';
import ModelPicker from '../components/model-picker';
import ImageAttachment from './image-attachment';

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
  default_model: string | null;
};

type AllowedModelItem = {
  id: string;
  display_name?: string | null;
};

type ModelsPayload = {
  data: Array<{ id?: string; display_name?: string | null }>;
};

type ToastKind = 'info' | 'success' | 'error';

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

const autoScrollEnterThresholdPx = 56;
const autoScrollExitThresholdPx = 136;
const autoScrollResumeThresholdPx = 24;
const programmaticScrollAutoGuardMs = 140;
const programmaticScrollSmoothGuardMs = 720;
const streamingRenderIntervalMs = 50;
const maxComposerImages = 6;
const maxComposerDocs = 5;
const mobileViewportBreakpointPx = 980;
const mobileComposerMaxHeightPx = 160;
const desktopComposerMaxHeightPx = 220;
const chatModelStorageKey = 'nchat_last_model';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supportedDocumentMimeTypes = new Set(['text/plain', 'text/markdown', 'application/pdf']);
const supportedDocumentExtensions = new Set(['txt', 'md', 'pdf']);
const userMessagePlaceholderPattern = /^\[(?:image|images|file|files|attachments|non-text input)\]$/i;

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  inline?: boolean;
};

function resolveMarkdownPlugin<T>(plugin: T): T {
  return (plugin as unknown as { default?: T }).default ?? plugin;
}

const remarkMathPlugin = resolveMarkdownPlugin(remarkMath);
const rehypeKatexPlugin = resolveMarkdownPlugin(rehypeKatex);

type MarkdownFenceState = {
  markerChar: '`' | '~';
  markerLength: number;
  openerLine: string;
  isMathFence: boolean;
  body: string;
};

type InlineMathState = 'none' | 'inline-dollar' | 'block-dollar' | 'inline-paren' | 'block-bracket';

type SafeMarkdownScannerState = {
  index: number;
  safeBoundary: number;
  atLineStart: boolean;
  activeFence: { markerChar: '`' | '~'; markerLength: number } | null;
  inlineCodeTickCount: number;
  inlineMathState: InlineMathState;
};

const markdownFenceOpenPattern = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/;

const emojiOnlyTokenPattern =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/gu;

function isEscapedCharacter(input: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findUnescapedToken(input: string, token: string, fromIndex: number): number {
  let tokenIndex = input.indexOf(token, fromIndex);
  while (tokenIndex !== -1) {
    if (!isEscapedCharacter(input, tokenIndex)) {
      return tokenIndex;
    }
    tokenIndex = input.indexOf(token, tokenIndex + token.length);
  }
  return -1;
}

function replaceLatexDelimitedMath(
  input: string,
  openToken: string,
  closeToken: string,
  replacementToken: '$' | '$$',
): string {
  let cursor = 0;
  let output = '';

  while (cursor < input.length) {
    const openIndex = findUnescapedToken(input, openToken, cursor);
    if (openIndex === -1) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, openIndex);
    const contentStart = openIndex + openToken.length;
    const closeIndex = findUnescapedToken(input, closeToken, contentStart);
    if (closeIndex === -1) {
      output += input.slice(openIndex);
      break;
    }

    output += `${replacementToken}${input.slice(contentStart, closeIndex)}${replacementToken}`;
    cursor = closeIndex + closeToken.length;
  }

  return output;
}

function normalizeLatexMathDelimiters(content: string): string {
  const withDisplayMath = replaceLatexDelimitedMath(content, '\\[', '\\]', '$$');
  return replaceLatexDelimitedMath(withDisplayMath, '\\(', '\\)', '$');
}

function parseFenceLanguage(infoString: string): string {
  const token = infoString.trim().split(/\s+/)[0] ?? '';
  return token.replace(/^[{.]*/, '').replace(/[}]*$/, '').toLowerCase();
}

function renderMathFenceAsDisplayMath(body: string): string {
  const trimmedBody = body.replace(/(?:\r?\n)+$/, '');
  if (!trimmedBody.trim()) {
    return '$$\n$$\n';
  }
  return `$$\n${trimmedBody}\n$$\n`;
}

function normalizeMarkdownMath(content: string): string {
  const lines = content.match(/[^\r\n]*(?:\r?\n|$)/g);
  if (!lines) {
    return content;
  }

  const output: string[] = [];
  let outsideFenceBuffer = '';
  let activeFence: MarkdownFenceState | null = null;

  const flushOutsideFenceBuffer = () => {
    if (!outsideFenceBuffer) {
      return;
    }
    output.push(normalizeLatexMathDelimiters(outsideFenceBuffer));
    outsideFenceBuffer = '';
  };

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (!activeFence) {
      const openMatch = line.match(markdownFenceOpenPattern);
      if (!openMatch) {
        outsideFenceBuffer += line;
        continue;
      }

      const marker = openMatch[2];
      const markerChar = marker[0] as '`' | '~';
      const markerLength = marker.length;
      const language = parseFenceLanguage(openMatch[3] ?? '');
      const isMathFence = language === 'math' || language === 'latex' || language === 'tex';

      flushOutsideFenceBuffer();
      activeFence = {
        markerChar,
        markerLength,
        openerLine: line,
        isMathFence,
        body: '',
      };
      continue;
    }

    const fenceMarker = activeFence.markerChar === '`' ? '`' : '~';
    const closePattern = new RegExp(
      `^ {0,3}${fenceMarker}{${activeFence.markerLength},}[ \\t]*\\r?\\n?$`,
    );

    if (!closePattern.test(line)) {
      activeFence.body += line;
      continue;
    }

    if (activeFence.isMathFence) {
      output.push(renderMathFenceAsDisplayMath(activeFence.body));
    } else {
      output.push(activeFence.openerLine + activeFence.body + line);
    }

    activeFence = null;
  }

  if (activeFence) {
    output.push(activeFence.openerLine + activeFence.body);
  }

  flushOutsideFenceBuffer();
  return output.join('');
}

function countConsecutiveCharacter(input: string, fromIndex: number, character: string): number {
  let count = 0;
  while (fromIndex + count < input.length && input[fromIndex + count] === character) {
    count += 1;
  }
  return count;
}

function normalizeLineForFenceChecks(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function looksLikeInlineMathStart(input: string, index: number): boolean {
  const next = input[index + 1];
  if (!next || /\s/.test(next)) {
    return false;
  }

  const prev = index > 0 ? input[index - 1] : '';
  if (/\d/.test(prev) && /\d/.test(next)) {
    return false;
  }

  return true;
}

function createSafeMarkdownScannerState(): SafeMarkdownScannerState {
  return {
    index: 0,
    safeBoundary: 0,
    atLineStart: true,
    activeFence: null,
    inlineCodeTickCount: 0,
    inlineMathState: 'none',
  };
}

function scanMarkdownSafeBoundaryIncremental(input: string, state: SafeMarkdownScannerState): number {
  let index = state.index;
  let safeBoundary = state.safeBoundary;
  let atLineStart = state.atLineStart;
  let activeFence = state.activeFence;
  let inlineCodeTickCount = state.inlineCodeTickCount;
  let inlineMathState = state.inlineMathState;

  while (index < input.length) {
    if (atLineStart) {
      const lineEnd = input.indexOf('\n', index);
      const segmentEnd = lineEnd === -1 ? input.length : lineEnd;
      const rawLine = input.slice(index, segmentEnd);
      const line = normalizeLineForFenceChecks(rawLine);

      if (activeFence) {
        const closePattern = new RegExp(
          `^ {0,3}${activeFence.markerChar}{${activeFence.markerLength},}[ \\t]*$`,
        );
        if (closePattern.test(line)) {
          activeFence = null;
          inlineCodeTickCount = 0;
          inlineMathState = 'none';
          safeBoundary = lineEnd === -1 ? segmentEnd : segmentEnd + 1;
        }
        index = lineEnd === -1 ? segmentEnd : segmentEnd + 1;
        atLineStart = true;
        continue;
      }

      if (inlineCodeTickCount === 0 && inlineMathState === 'none') {
        const openMatch = line.match(markdownFenceOpenPattern);
        if (openMatch) {
          const marker = openMatch[2];
          activeFence = {
            markerChar: marker[0] as '`' | '~',
            markerLength: marker.length,
          };
          index = lineEnd === -1 ? segmentEnd : segmentEnd + 1;
          atLineStart = true;
          continue;
        }
      }
    }

    if (activeFence) {
      const character = input[index];
      index += 1;
      atLineStart = character === '\n';
      continue;
    }

    if (inlineCodeTickCount > 0) {
      if (input[index] === '`' && !isEscapedCharacter(input, index)) {
        const tickCount = countConsecutiveCharacter(input, index, '`');
        if (tickCount === inlineCodeTickCount) {
          inlineCodeTickCount = 0;
          index += tickCount;
          safeBoundary = index;
          atLineStart = false;
          continue;
        }
        index += tickCount;
        atLineStart = false;
        continue;
      }

      const character = input[index];
      index += 1;
      atLineStart = character === '\n';
      continue;
    }

    if (inlineMathState !== 'none') {
      if (inlineMathState === 'inline-dollar') {
        if (input[index] === '$' && !isEscapedCharacter(input, index) && input[index + 1] !== '$') {
          inlineMathState = 'none';
          index += 1;
          safeBoundary = index;
          atLineStart = false;
          continue;
        }
      } else if (inlineMathState === 'block-dollar') {
        if (
          input[index] === '$' &&
          input[index + 1] === '$' &&
          !isEscapedCharacter(input, index)
        ) {
          inlineMathState = 'none';
          index += 2;
          safeBoundary = index;
          atLineStart = false;
          continue;
        }
      } else if (inlineMathState === 'inline-paren') {
        if (
          input[index] === '\\' &&
          input[index + 1] === ')' &&
          !isEscapedCharacter(input, index)
        ) {
          inlineMathState = 'none';
          index += 2;
          safeBoundary = index;
          atLineStart = false;
          continue;
        }
      } else if (inlineMathState === 'block-bracket') {
        if (
          input[index] === '\\' &&
          input[index + 1] === ']' &&
          !isEscapedCharacter(input, index)
        ) {
          inlineMathState = 'none';
          index += 2;
          safeBoundary = index;
          atLineStart = false;
          continue;
        }
      }

      const character = input[index];
      index += 1;
      atLineStart = character === '\n';
      continue;
    }

    if (input[index] === '`' && !isEscapedCharacter(input, index)) {
      inlineCodeTickCount = countConsecutiveCharacter(input, index, '`');
      index += inlineCodeTickCount;
      atLineStart = false;
      continue;
    }

    if (
      input[index] === '\\' &&
      !isEscapedCharacter(input, index) &&
      (input[index + 1] === '(' || input[index + 1] === '[')
    ) {
      inlineMathState = input[index + 1] === '(' ? 'inline-paren' : 'block-bracket';
      index += 2;
      atLineStart = false;
      continue;
    }

    if (input[index] === '$' && !isEscapedCharacter(input, index)) {
      if (input[index + 1] === '$') {
        inlineMathState = 'block-dollar';
        index += 2;
        atLineStart = false;
        continue;
      }
      if (looksLikeInlineMathStart(input, index)) {
        inlineMathState = 'inline-dollar';
        index += 1;
        atLineStart = false;
        continue;
      }
    }

    const character = input[index];
    index += 1;
    atLineStart = character === '\n';
    if (character === '\n' || character === ' ' || character === '\t' || character === '\r') {
      safeBoundary = index;
    }
  }

  state.index = index;
  state.safeBoundary = safeBoundary;
  state.atLineStart = atLineStart;
  state.activeFence = activeFence;
  state.inlineCodeTickCount = inlineCodeTickCount;
  state.inlineMathState = inlineMathState;

  return safeBoundary;
}

function sanitizeLinkHref(rawHref: string | undefined): string | null {
  if (!rawHref) {
    return null;
  }

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

const markdownComponents = {
  a({
    href,
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<'a'>) {
    const safeHref = sanitizeLinkHref(href);
    if (!safeHref) {
      return <span>{children}</span>;
    }

    const mergedClassName = className
      ? `chat-markdown-link ${className}`
      : 'chat-markdown-link';

    return (
      <a
        {...props}
        href={safeHref}
        className={mergedClassName}
        target="_blank"
        rel="noreferrer"
      >
        {children}
      </a>
    );
  },
  pre({
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<'pre'>) {
    const mergedClassName = className ? `chat-code-block ${className}` : 'chat-code-block';
    return (
      <pre {...props} className={mergedClassName}>
        {children}
      </pre>
    );
  },
  code({
    inline,
    className,
    children,
    ...props
  }: MarkdownCodeProps) {
    if (inline) {
      const mergedClassName = className
        ? `chat-inline-code ${className}`
        : 'chat-inline-code';
      return (
        <code {...props} className={mergedClassName}>
          {children}
        </code>
      );
    }

    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
};

const ParsedMessageMarkdown = memo(function ParsedMessageMarkdown({ content }: { content: string }) {
  if (!content) {
    return null;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMathPlugin]}
      rehypePlugins={[rehypeKatexPlugin]}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});

function MessageMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const normalizedContent = useMemo(
    () => (streaming ? '' : normalizeMarkdownMath(content)),
    [content, streaming],
  );
  const streamingSourceRef = useRef(content);
  const scannerStateRef = useRef<SafeMarkdownScannerState>(createSafeMarkdownScannerState());
  const normalizedPrefixCacheRef = useRef<{ rawPrefixLength: number; normalizedPrefix: string }>({
    rawPrefixLength: 0,
    normalizedPrefix: '',
  });
  const splitFrameRef = useRef<number | null>(null);
  const lastSplitAtRef = useRef(0);
  const [renderablePrefix, setRenderablePrefix] = useState(() => normalizedContent);
  const [pendingSuffix, setPendingSuffix] = useState('');

  const resetStreamingSplitState = useCallback(() => {
    scannerStateRef.current = createSafeMarkdownScannerState();
    normalizedPrefixCacheRef.current = {
      rawPrefixLength: 0,
      normalizedPrefix: '',
    };
  }, []);

  const runStreamingSplit = useCallback(() => {
    const source = streamingSourceRef.current;
    if (source.length < scannerStateRef.current.index) {
      resetStreamingSplitState();
    }

    const boundary = scanMarkdownSafeBoundaryIncremental(source, scannerStateRef.current);
    const prefixCache = normalizedPrefixCacheRef.current;
    let nextPrefix = prefixCache.normalizedPrefix;

    if (boundary === 0) {
      if (prefixCache.rawPrefixLength !== 0 || prefixCache.normalizedPrefix.length > 0) {
        nextPrefix = '';
        normalizedPrefixCacheRef.current = {
          rawPrefixLength: 0,
          normalizedPrefix: '',
        };
      }
    } else if (boundary < prefixCache.rawPrefixLength) {
      const safeRawPrefix = source.slice(0, boundary);
      nextPrefix = normalizeMarkdownMath(safeRawPrefix);
      normalizedPrefixCacheRef.current = {
        rawPrefixLength: boundary,
        normalizedPrefix: nextPrefix,
      };
    } else if (boundary > prefixCache.rawPrefixLength) {
      const safeRawDelta = source.slice(prefixCache.rawPrefixLength, boundary);
      nextPrefix = prefixCache.normalizedPrefix + normalizeMarkdownMath(safeRawDelta);
      normalizedPrefixCacheRef.current = {
        rawPrefixLength: boundary,
        normalizedPrefix: nextPrefix,
      };
    }

    const nextSuffix = source.slice(boundary);

    setRenderablePrefix((previous) => (previous === nextPrefix ? previous : nextPrefix));
    setPendingSuffix((previous) => (previous === nextSuffix ? previous : nextSuffix));
  }, [resetStreamingSplitState]);

  const scheduleStreamingSplit = useCallback(() => {
    if (splitFrameRef.current !== null) {
      return;
    }

    const minSplitIntervalMs = streamingRenderIntervalMs;
    const scheduleFrame = (timestamp: number) => {
      if (timestamp - lastSplitAtRef.current < minSplitIntervalMs) {
        splitFrameRef.current = window.requestAnimationFrame(scheduleFrame);
        return;
      }

      splitFrameRef.current = null;
      lastSplitAtRef.current = timestamp;
      runStreamingSplit();
    };

    splitFrameRef.current = window.requestAnimationFrame(scheduleFrame);
  }, [runStreamingSplit]);

  useEffect(() => {
    streamingSourceRef.current = content;
    if (!streaming) {
      setRenderablePrefix((previous) => (previous === normalizedContent ? previous : normalizedContent));
      setPendingSuffix((previous) => (previous ? '' : previous));
      return;
    }
    scheduleStreamingSplit();
  }, [content, normalizedContent, scheduleStreamingSplit, streaming]);

  useEffect(() => {
    if (!streaming) {
      if (splitFrameRef.current !== null) {
        window.cancelAnimationFrame(splitFrameRef.current);
        splitFrameRef.current = null;
      }
      resetStreamingSplitState();
      return;
    }

    resetStreamingSplitState();
    lastSplitAtRef.current = 0;
    runStreamingSplit();
    scheduleStreamingSplit();
  }, [resetStreamingSplitState, runStreamingSplit, scheduleStreamingSplit, streaming]);

  useEffect(() => {
    return () => {
      if (splitFrameRef.current !== null) {
        window.cancelAnimationFrame(splitFrameRef.current);
        splitFrameRef.current = null;
      }
    };
  }, []);

  if (!streaming) {
    return <ParsedMessageMarkdown content={normalizedContent} />;
  }

  return (
    <>
      <ParsedMessageMarkdown content={renderablePrefix} />
      {pendingSuffix ? <span className="chat-markdown-pending">{pendingSuffix}</span> : null}
    </>
  );
}

type ChatMessageRowProps = {
  message: MessageItem;
  isEntering: boolean;
  isStreaming: boolean;
  streamingContent: string | null;
  onCopyAssistantMessage: (message: MessageItem, content: string) => void;
  showRegenerateAction: boolean;
  regenerateDisabled: boolean;
  regenerateBusy: boolean;
  onRegenerateAssistantMessage: (message: MessageItem) => void;
  showEditAction: boolean;
  editDisabled: boolean;
  onEditUserMessage: (message: MessageItem) => void;
};

const ChatMessageRow = memo(
  function ChatMessageRow({
    message,
    isEntering,
    isStreaming,
    streamingContent,
    onCopyAssistantMessage,
    showRegenerateAction,
    regenerateDisabled,
    regenerateBusy,
    onRegenerateAssistantMessage,
    showEditAction,
    editDisabled,
    onEditUserMessage,
  }: ChatMessageRowProps) {
    const assistantMessage = message.role === 'assistant';
    const renderedContent =
      assistantMessage && isStreaming && streamingContent !== null ? streamingContent : message.content;
    const showGenerating = assistantMessage && isStreaming && !renderedContent.trim();
    const emojiOnly = !showGenerating && isEmojiOnlyMessage(renderedContent);
    const showCopyAction = assistantMessage && renderedContent.trim().length > 0;
    const showActions = showCopyAction || showRegenerateAction || showEditAction;

    return (
      <article
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
                      <ImageAttachment url={attachment.content_url} alt={attachment.filename} />
                    ) : (
                      <div className="chat-message-attachment-fallback">FILE</div>
                    )}
                    <span className="chat-message-attachment-name">{attachment.filename}</span>
                  </a>
                );
              })}
            </div>
          ) : null}

          <div className={`chat-message-content${emojiOnly ? ' emoji-only' : ''}`}>
            {showGenerating ? (
              <div className="chat-inline-streaming">
                <span className="chat-streaming-dot" />
                Generating...
              </div>
            ) : (
              <MessageMarkdown content={renderedContent} streaming={isStreaming} />
            )}
          </div>

          {showActions ? (
            <div className="chat-message-actions">
              {showCopyAction ? (
                <button
                  type="button"
                  className="chat-copy-button chat-message-action-button"
                  onClick={() => onCopyAssistantMessage(message, renderedContent)}
                >
                  Copy
                </button>
              ) : null}

              {showRegenerateAction ? (
                <button
                  type="button"
                  className="chat-regenerate-button chat-message-action-button"
                  disabled={regenerateDisabled}
                  onClick={() => onRegenerateAssistantMessage(message)}
                >
                  {regenerateBusy ? 'Regenerating...' : 'Regenerate'}
                </button>
              ) : null}

              {showEditAction ? (
                <button
                  type="button"
                  className="chat-edit-button chat-message-action-button"
                  disabled={editDisabled}
                  onClick={() => onEditUserMessage(message)}
                >
                  Edit
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.isEntering === next.isEntering &&
    previous.isStreaming === next.isStreaming &&
    previous.streamingContent === next.streamingContent &&
    previous.onCopyAssistantMessage === next.onCopyAssistantMessage &&
    previous.showRegenerateAction === next.showRegenerateAction &&
    previous.regenerateDisabled === next.regenerateDisabled &&
    previous.regenerateBusy === next.regenerateBusy &&
    previous.onRegenerateAssistantMessage === next.onRegenerateAssistantMessage &&
    previous.showEditAction === next.showEditAction &&
    previous.editDisabled === next.editDisabled &&
    previous.onEditUserMessage === next.onEditUserMessage,
);

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

function isPersistedUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function normalizeUserMessageTextForInput(content: string): string {
  const trimmed = content.trim();
  if (!trimmed || userMessagePlaceholderPattern.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function buildUserMessagePreview(content: string, attachments: MessageAttachment[]): string {
  if (content) {
    return content;
  }

  if (attachments.length === 0) {
    return '[non-text input]';
  }

  const imageCount = attachments.filter((attachment) => attachment.mime_type.startsWith('image/')).length;
  const docCount = attachments.length - imageCount;

  if (docCount > 0 && imageCount > 0) {
    return '[attachments]';
  }

  if (imageCount > 1) {
    return '[images]';
  }

  if (imageCount === 1) {
    return '[image]';
  }

  if (docCount > 1) {
    return '[files]';
  }

  return '[file]';
}

function findLatestUserMessage(messages: MessageItem[]): MessageItem | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === 'user') {
      return candidate;
    }
  }
  return null;
}

function findLatestAssistantWithSourceUser(
  messages: MessageItem[],
): { assistant: MessageItem; sourceUser: MessageItem | null } | null {
  for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    const assistant = messages[assistantIndex];
    if (!assistant || assistant.role !== 'assistant') {
      continue;
    }

    for (let sourceIndex = assistantIndex - 1; sourceIndex >= 0; sourceIndex -= 1) {
      const sourceCandidate = messages[sourceIndex];
      if (sourceCandidate?.role === 'user') {
        return { assistant, sourceUser: sourceCandidate };
      }
    }

    return { assistant, sourceUser: null };
  }

  return null;
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

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function getFileExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  if (index === -1) {
    return '';
  }
  return fileName.slice(index + 1).toLowerCase();
}

function inferDocumentMimeType(fileName: string): string | null {
  const extension = getFileExtension(fileName);
  if (extension === 'txt') {
    return 'text/plain';
  }
  if (extension === 'md') {
    return 'text/markdown';
  }
  if (extension === 'pdf') {
    return 'application/pdf';
  }
  return null;
}

function normalizeDocumentUploadFile(file: File): File {
  const normalizedMimeType = file.type.toLowerCase();
  if (supportedDocumentMimeTypes.has(normalizedMimeType)) {
    return file;
  }

  const inferredMimeType = inferDocumentMimeType(file.name);
  if (!inferredMimeType) {
    return file;
  }

  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified || Date.now(),
  });
}

function isDocumentFile(file: File): boolean {
  const normalizedMimeType = file.type.toLowerCase();
  if (supportedDocumentMimeTypes.has(normalizedMimeType)) {
    return true;
  }

  const extension = getFileExtension(file.name);
  return extension.length > 0 && supportedDocumentExtensions.has(extension);
}

function readStoredChatModelId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.localStorage.getItem(chatModelStorageKey);
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function writeStoredChatModelId(modelId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(chatModelStorageKey, modelId);
  } catch {
    // Ignore localStorage write failures.
  }
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

function isNearBottom(element: HTMLElement, thresholdPx: number): boolean {
  return distanceFromBottom(element) <= thresholdPx;
}

function detectCoarsePointerDevice(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function detectMobileViewport(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth <= mobileViewportBreakpointPx;
}

function addMediaListener(query: MediaQueryList, listener: () => void): void {
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
    return;
  }

  query.addListener(listener);
}

function removeMediaListener(query: MediaQueryList, listener: () => void): void {
  if (typeof query.removeEventListener === 'function') {
    query.removeEventListener('change', listener);
    return;
  }

  query.removeListener(listener);
}

function isEmojiOnlyMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  const compact = trimmed.replace(/\s+/g, '');
  if (!compact) {
    return false;
  }

  return compact.replace(emojiOnlyTokenPattern, '').length === 0;
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
  const composerRegionRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isAtBottomRef = useRef(true);
  const userPausedAutoScrollRef = useRef(false);
  const lastKnownScrollTopRef = useRef(0);
  const programmaticScrollUntilRef = useRef(0);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingScrollStateFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const toastCounterRef = useRef(0);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seededMessageIdsRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const latestAssistantTextRef = useRef('');
  const streamBufferedAssistantTextRef = useRef('');
  const streamRenderedAssistantTextRef = useRef('');
  const streamFlushFrameRef = useRef<number | null>(null);
  const streamLastFlushAtRef = useRef(0);

  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [docs, setDocs] = useState<File[]>([]);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<string[]>([]);
  const [composerFocused, setComposerFocused] = useState(false);
  const [animatingMessageIds, setAnimatingMessageIds] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [allowedModels, setAllowedModels] = useState<AllowedModelItem[]>([]);
  const [streamResponses, setStreamResponses] = useState(true);
  const [sending, setSending] = useState(false);
  const [generationActive, setGenerationActive] = useState(false);
  const [desktopComposerEnterSends, setDesktopComposerEnterSends] = useState(
    () => !detectCoarsePointerDevice(),
  );
  const [isMobileViewport, setIsMobileViewport] = useState(() => detectMobileViewport());
  const [activeAbortController, setActiveAbortController] = useState<AbortController | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [streamingAssistantContent, setStreamingAssistantContent] = useState('');
  const [regeneratingAssistantId, setRegeneratingAssistantId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraftText, setEditDraftText] = useState('');
  const [editDraftAttachments, setEditDraftAttachments] = useState<MessageAttachment[]>([]);
  const [editSavePending, setEditSavePending] = useState(false);

  const editingActive = editingMessageId !== null;
  const canSend =
    !sending &&
    !editingActive &&
    Boolean(model.trim()) &&
    (input.trim().length > 0 || images.length > 0 || docs.length > 0);
  const composerActive = composerFocused || Boolean(input.trim()) || images.length > 0 || docs.length > 0;

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = toastCounterRef.current + 1;
    toastCounterRef.current = id;

    setToasts((previous) => [...previous, { id, kind, message }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const appendImages = useCallback((nextFiles: File[]) => {
    if (nextFiles.length === 0) {
      return;
    }
    setImages((previous) => {
      if (previous.length >= maxComposerImages) {
        return previous;
      }

      const remainingSlots = maxComposerImages - previous.length;
      if (remainingSlots <= 0) {
        return previous;
      }

      return [...previous, ...nextFiles.slice(0, remainingSlots)];
    });
  }, []);

  const appendDocs = useCallback((nextFiles: File[]) => {
    if (nextFiles.length === 0) {
      return;
    }

    setDocs((previous) => {
      if (previous.length >= maxComposerDocs) {
        return previous;
      }

      const remainingSlots = maxComposerDocs - previous.length;
      if (remainingSlots <= 0) {
        return previous;
      }

      return [...previous, ...nextFiles.slice(0, remainingSlots)];
    });
  }, []);

  const appendSelectedFiles = useCallback(
    (nextFiles: File[]) => {
      const imageFiles = nextFiles.filter((file) => isImageFile(file));
      const docFiles = nextFiles
        .filter((file) => !isImageFile(file) && isDocumentFile(file))
        .map((file) => normalizeDocumentUploadFile(file));

      appendImages(imageFiles);
      appendDocs(docFiles);

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [appendDocs, appendImages],
  );

  const removeImageAtIndex = useCallback((indexToRemove: number) => {
    setImages((previous) =>
      previous.filter((_file, index) => index !== indexToRemove),
    );
  }, []);

  const removeDocAtIndex = useCallback((indexToRemove: number) => {
    setDocs((previous) =>
      previous.filter((_file, index) => index !== indexToRemove),
    );
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  const clearDocs = useCallback(() => {
    setDocs([]);
  }, []);

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      if (editingActive) {
        return;
      }

      const pastedImages: File[] = [];
      const seenPastedSignatures = new Set<string>();
      const addPastedImage = (file: File): boolean => {
        if (!isImageFile(file)) {
          return false;
        }

        const normalized = normalizePastedImageFile(file);
        const signature = `${normalized.name}:${normalized.size}:${normalized.lastModified}:${normalized.type}`;
        if (seenPastedSignatures.has(signature)) {
          return false;
        }

        seenPastedSignatures.add(signature);
        pastedImages.push(normalized);
        return true;
      };

      let addedImageFromItems = false;
      const clipboardItems = event.clipboardData?.items;
      if (clipboardItems?.length) {
        for (const item of Array.from(clipboardItems)) {
          if (!item.type.startsWith('image/')) {
            continue;
          }
          const rawFile = item.getAsFile();
          if (!rawFile) {
            continue;
          }
          if (addPastedImage(rawFile)) {
            addedImageFromItems = true;
          }
        }
      }

      const clipboardFiles = event.clipboardData?.files;
      if (!addedImageFromItems && clipboardFiles?.length) {
        for (const file of Array.from(clipboardFiles)) {
          addPastedImage(file);
        }
      }

      if (pastedImages.length > 0) {
        appendImages(pastedImages);
      }
    },
    [appendImages, editingActive],
  );

  const adjustComposerHeight = useCallback(() => {
    const textarea = composerInputRef.current;
    if (!textarea) {
      return;
    }

    const maxHeight = isMobileViewport ? mobileComposerMaxHeightPx : desktopComposerMaxHeightPx;
    const computedMinHeight = Number.parseFloat(window.getComputedStyle(textarea).minHeight);
    const minHeight = Number.isFinite(computedMinHeight) ? computedMinHeight : 44;

    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(contentHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, minHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [isMobileViewport]);

  const markProgrammaticScroll = useCallback((durationMs: number) => {
    const now =
      typeof window !== 'undefined' && typeof window.performance !== 'undefined'
        ? window.performance.now()
        : Date.now();
    programmaticScrollUntilRef.current = now + durationMs;
  }, []);

  const setAutoScrollState = useCallback((atBottom: boolean) => {
    shouldAutoScrollRef.current = atBottom;
    isAtBottomRef.current = atBottom;
    setShowJumpToLatest((previous) => {
      const next = !atBottom;
      return previous === next ? previous : next;
    });
  }, []);

  const resolveAtBottomState = useCallback((container: HTMLElement): boolean => {
    const atAbsoluteBottom = isNearBottom(container, autoScrollResumeThresholdPx);
    if (atAbsoluteBottom) {
      userPausedAutoScrollRef.current = false;
    }

    if (userPausedAutoScrollRef.current && !atAbsoluteBottom) {
      return false;
    }

    const threshold = isAtBottomRef.current ? autoScrollExitThresholdPx : autoScrollEnterThresholdPx;
    return isNearBottom(container, threshold);
  }, []);

  const syncAutoScrollStateFromContainer = useCallback((): boolean => {
    const container = messageListRef.current;
    if (!container) {
      return false;
    }

    const atBottom = resolveAtBottomState(container);
    setAutoScrollState(atBottom);
    lastKnownScrollTopRef.current = container.scrollTop;
    return atBottom;
  }, [resolveAtBottomState, setAutoScrollState]);

  const scheduleAutoScrollStateSync = useCallback(() => {
    if (pendingScrollStateFrameRef.current !== null) {
      return;
    }

    pendingScrollStateFrameRef.current = window.requestAnimationFrame(() => {
      pendingScrollStateFrameRef.current = null;
      syncAutoScrollStateFromContainer();
    });
  }, [syncAutoScrollStateFromContainer]);

  const scheduleAutoScrollIfNeeded = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) {
      return;
    }

    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      const container = messageListRef.current;
      if (!container) {
        return;
      }

      if (!shouldAutoScrollRef.current) {
        scheduleAutoScrollStateSync();
        return;
      }

      markProgrammaticScroll(programmaticScrollAutoGuardMs);
      container.scrollTop = container.scrollHeight;
      lastKnownScrollTopRef.current = container.scrollTop;
      setAutoScrollState(true);
    });
  }, [markProgrammaticScroll, scheduleAutoScrollStateSync, setAutoScrollState]);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const container = messageListRef.current;
      if (!container) {
        return;
      }

      userPausedAutoScrollRef.current = false;
      markProgrammaticScroll(
        behavior === 'smooth' ? programmaticScrollSmoothGuardMs : programmaticScrollAutoGuardMs,
      );

      if (behavior === 'smooth') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else {
        container.scrollTop = container.scrollHeight;
      }

      lastKnownScrollTopRef.current = container.scrollTop;
      setAutoScrollState(true);
    },
    [markProgrammaticScroll, setAutoScrollState],
  );

  const updateAutoScrollState = useCallback(() => {
    const container = messageListRef.current;
    if (!container) {
      return;
    }

    const now =
      typeof window !== 'undefined' && typeof window.performance !== 'undefined'
        ? window.performance.now()
        : Date.now();
    const isProgrammaticScroll = now <= programmaticScrollUntilRef.current;
    const nextScrollTop = container.scrollTop;
    const previousScrollTop = lastKnownScrollTopRef.current;

    if (!isProgrammaticScroll) {
      const isUserScrollingUp = nextScrollTop < previousScrollTop - 2;
      if (isUserScrollingUp && !isNearBottom(container, autoScrollResumeThresholdPx)) {
        userPausedAutoScrollRef.current = true;
      }
    }

    lastKnownScrollTopRef.current = nextScrollTop;

    if (isProgrammaticScroll) {
      return;
    }

    scheduleAutoScrollStateSync();
  }, [scheduleAutoScrollStateSync]);

  const handleMessageListLayoutShift = useCallback(() => {
    if (shouldAutoScrollRef.current) {
      scheduleAutoScrollIfNeeded();
      return;
    }

    scheduleAutoScrollStateSync();
  }, [scheduleAutoScrollIfNeeded, scheduleAutoScrollStateSync]);

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
      .filter((item): item is { id: string; display_name?: string | null } => {
        return typeof item.id === 'string';
      })
      .map((item) => ({
        id: item.id,
        display_name: item.display_name ?? null,
      }))
      .sort((a, b) => {
        const nameA = (a.display_name ?? a.id).toLowerCase();
        const nameB = (b.display_name ?? b.id).toLowerCase();
        if (nameA !== nameB) {
          return nameA.localeCompare(nameB);
        }
        return a.id.localeCompare(b.id);
      });

    setAllowedModels(list);
    return list;
  };

  const loadMessages = async (threadId: string): Promise<MessageItem[] | null> => {
    const res = await fetch(`/api/me/threads/${threadId}/messages`, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 404) {
        return [];
      } else if (res.status === 401) {
        router.replace('/login');
        return null;
      } else {
        pushToast('error', 'Failed to load messages');
        return null;
      }
    }

    const payload = (await res.json()) as { data: MessageItem[] };
    return payload.data.map((message) => ({
      ...message,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    }));
  };

  useEffect(() => {
    const syncStreamResponsesPreference = () => {
      setStreamResponses(readStreamResponsesPreference());
    };

    syncStreamResponsesPreference();

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }
      if (event.key !== null && event.key !== STREAM_RESPONSES_STORAGE_KEY) {
        return;
      }
      syncStreamResponsesPreference();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mobileViewportQuery = window.matchMedia(`(max-width: ${mobileViewportBreakpointPx}px)`);
    const syncMobileViewport = () => {
      setIsMobileViewport((previous) => {
        const next = mobileViewportQuery.matches;
        return previous === next ? previous : next;
      });
    };

    syncMobileViewport();
    addMediaListener(mobileViewportQuery, syncMobileViewport);

    return () => {
      removeMediaListener(mobileViewportQuery, syncMobileViewport);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const pointerCoarseQuery = window.matchMedia('(pointer: coarse)');
    const hoverNoneAndPointerCoarseQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

    const syncDesktopComposerEnterSends = () => {
      const pointerIsCoarse =
        pointerCoarseQuery.matches || hoverNoneAndPointerCoarseQuery.matches;
      const nextDesktopBehavior = !pointerIsCoarse;
      setDesktopComposerEnterSends((previous) =>
        previous === nextDesktopBehavior ? previous : nextDesktopBehavior,
      );
    };

    syncDesktopComposerEnterSends();

    addMediaListener(pointerCoarseQuery, syncDesktopComposerEnterSends);
    addMediaListener(hoverNoneAndPointerCoarseQuery, syncDesktopComposerEnterSends);

    return () => {
      removeMediaListener(pointerCoarseQuery, syncDesktopComposerEnterSends);
      removeMediaListener(hoverNoneAndPointerCoarseQuery, syncDesktopComposerEnterSends);
    };
  }, []);

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
        const storedModelId = readStoredChatModelId();
        const models = await loadAllowedModels();
        const preferredModel =
          storedModelId && models.some((entry) => entry.id === storedModelId)
            ? storedModelId
            : me.default_model && models.some((entry) => entry.id === me.default_model)
            ? me.default_model
            : models[0]?.id ?? '';
        setModel(preferredModel);
        if (preferredModel) {
          writeStoredChatModelId(preferredModel);
        }
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : 'Failed to load allowed models');
      } finally {
        setLoading(false);
      }
    };

    void bootstrap();
  }, [router]);

  useEffect(() => {
    if (allowedModels.length === 0) {
      setModel('');
      return;
    }

    if (!allowedModels.some((entry) => entry.id === model)) {
      const fallbackModelId = allowedModels[0]!.id;
      setModel(fallbackModelId);
      writeStoredChatModelId(fallbackModelId);
    }
  }, [allowedModels, model]);

  useEffect(() => {
    let cancelled = false;

    shouldAutoScrollRef.current = true;
    isAtBottomRef.current = true;
    userPausedAutoScrollRef.current = false;
    lastKnownScrollTopRef.current = 0;
    programmaticScrollUntilRef.current = 0;
    setShowJumpToLatest(false);
    seenMessageIdsRef.current = new Set();
    seededMessageIdsRef.current = false;
    setAnimatingMessageIds([]);
    setGenerationActive(false);
    setStreamingAssistantId(null);
    setStreamingAssistantContent('');
    setRegeneratingAssistantId(null);
    setEditingMessageId(null);
    setEditDraftText('');
    setEditDraftAttachments([]);
    setEditSavePending(false);
    latestAssistantTextRef.current = '';
    streamBufferedAssistantTextRef.current = '';
    streamRenderedAssistantTextRef.current = '';
    streamLastFlushAtRef.current = 0;
    if (streamFlushFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFlushFrameRef.current);
      streamFlushFrameRef.current = null;
    }
    if (pendingAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingAutoScrollFrameRef.current);
      pendingAutoScrollFrameRef.current = null;
    }
    if (pendingScrollStateFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingScrollStateFrameRef.current);
      pendingScrollStateFrameRef.current = null;
    }
    stopRequestedRef.current = false;

    if (!selectedThreadId) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    setMessages([]);
    setMessagesLoading(true);

    void (async () => {
      const nextMessages = await loadMessages(selectedThreadId);
      if (cancelled) {
        return;
      }
      if (nextMessages) {
        setMessages(nextMessages);
      }
      setMessagesLoading(false);
    })();

    return () => {
      cancelled = true;
    };
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
    return () => {
      if (streamFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFlushFrameRef.current);
        streamFlushFrameRef.current = null;
      }
      if (pendingAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAutoScrollFrameRef.current);
        pendingAutoScrollFrameRef.current = null;
      }
      if (pendingScrollStateFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollStateFrameRef.current);
        pendingScrollStateFrameRef.current = null;
      }
    };
  }, []);

  const animatingMessageIdSet = useMemo(() => new Set(animatingMessageIds), [animatingMessageIds]);
  const latestUserMessage = useMemo(() => findLatestUserMessage(messages), [messages]);
  const latestAssistantWithSourceUser = useMemo(
    () => findLatestAssistantWithSourceUser(messages),
    [messages],
  );

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scheduleAutoScrollIfNeeded();
      return;
    }

    scheduleAutoScrollStateSync();
  }, [messages, scheduleAutoScrollIfNeeded, scheduleAutoScrollStateSync, streamingAssistantContent]);

  useEffect(() => {
    adjustComposerHeight();
  }, [adjustComposerHeight, input]);

  useEffect(() => {
    if (!isMobileViewport) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      adjustComposerHeight();
      handleMessageListLayoutShift();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    adjustComposerHeight,
    docs.length,
    editingActive,
    generationActive,
    handleMessageListLayoutShift,
    images.length,
    isMobileViewport,
  ]);

  useEffect(() => {
    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }

      frame = window.requestAnimationFrame(() => {
        frame = null;
        adjustComposerHeight();
        handleMessageListLayoutShift();
      });
    };

    scheduleSync();
    window.addEventListener('resize', scheduleSync);

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', scheduleSync);
    visualViewport?.addEventListener('scroll', scheduleSync);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', scheduleSync);
      visualViewport?.removeEventListener('resize', scheduleSync);
      visualViewport?.removeEventListener('scroll', scheduleSync);
    };
  }, [adjustComposerHeight, handleMessageListLayoutShift]);

  useEffect(() => {
    const composerRegion = composerRegionRef.current;
    if (!composerRegion) {
      return;
    }

    let frame: number | null = null;
    const scheduleSync = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }

      frame = window.requestAnimationFrame(() => {
        frame = null;
        handleMessageListLayoutShift();
      });
    };

    scheduleSync();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', scheduleSync);
      return () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
        }
        window.removeEventListener('resize', scheduleSync);
      };
    }

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(composerRegion);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
    };
  }, [handleMessageListLayoutShift]);

  useEffect(() => {
    const nextPreviewUrls = images.map((file) => URL.createObjectURL(file));
    setImagePreviewUrls(nextPreviewUrls);

    return () => {
      for (const previewUrl of nextPreviewUrls) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [images]);

  const copyAssistantMessage = useCallback(
    async (_message: MessageItem, content: string) => {
      try {
        await copyTextToClipboard(content);
        pushToast('success', 'Copied response');
      } catch {
        pushToast('error', 'Failed to copy response');
      }
    },
    [pushToast],
  );

  const handleCopyAssistantMessage = useCallback(
    (message: MessageItem, content: string) => {
      void copyAssistantMessage(message, content);
    },
    [copyAssistantMessage],
  );

  const handleModelChange = useCallback((nextModelId: string) => {
    setModel(nextModelId);
    writeStoredChatModelId(nextModelId);
  }, []);

  const updateMessageContent = useCallback((messageId: string, nextContent: string) => {
    setMessages((previous) => {
      const targetIndex = previous.findIndex((message) => message.id === messageId);
      if (targetIndex === -1) {
        return previous;
      }

      const targetMessage = previous[targetIndex]!;
      if (targetMessage.content === nextContent) {
        return previous;
      }

      const nextMessages = previous.slice();
      nextMessages[targetIndex] = {
        ...targetMessage,
        content: nextContent,
      };
      return nextMessages;
    });
  }, []);

  const stopStreaming = () => {
    if (!activeAbortController) {
      return;
    }

    stopRequestedRef.current = true;
    setGenerationActive(false);
    const stoppedText =
      latestAssistantTextRef.current ||
      streamBufferedAssistantTextRef.current ||
      streamRenderedAssistantTextRef.current;
    if (streamingAssistantId && stoppedText.trim()) {
      updateMessageContent(streamingAssistantId, stoppedText.trim());
    }
    activeAbortController.abort();
  };

  const truncateThreadFromMessage = useCallback(
    async (threadId: string, fromMessageId: string): Promise<number> => {
      const response = await fetch(`/api/me/threads/${threadId}/truncate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          from_message_id: fromMessageId,
        }),
      });

      if (response.status === 401) {
        router.replace('/login');
        throw new Error('Your session expired. Please log in again.');
      }

      const payload = (await response.json().catch(() => null)) as
        | { deleted_count?: unknown }
        | null
        | unknown;
      if (!response.ok) {
        throw new Error(parseErrorMessage(payload, 'Failed to truncate thread'));
      }

      const record = (payload ?? {}) as { deleted_count?: unknown };
      return typeof record.deleted_count === 'number' ? record.deleted_count : 0;
    },
    [router],
  );

  const sendPreparedInput = useCallback(
    async (params: {
      threadId: string | null;
      promptText: string;
      imageFiles?: File[];
      docFiles?: File[];
      existingAttachments?: MessageAttachment[];
      clearComposerOnStart?: boolean;
    }): Promise<void> => {
      const normalizedPromptText = params.promptText.trim();
      const imageFiles = params.imageFiles ?? [];
      const docFiles = params.docFiles ?? [];
      const preloadedAttachments = params.existingAttachments ?? [];
      if (
        sending ||
        (!normalizedPromptText && imageFiles.length === 0 && docFiles.length === 0 && preloadedAttachments.length === 0)
      ) {
        return;
      }

      if (!model.trim()) {
        pushToast('error', 'Select a model from the allowlist');
        return;
      }

      setSending(true);
      stopRequestedRef.current = false;
      latestAssistantTextRef.current = '';

      const requestAbortController = new AbortController();
      setActiveAbortController(requestAbortController);

      const optimisticMessageIds: string[] = [];
      let optimisticAssistantId: string | null = null;
      let latestThreadId = params.threadId;

      try {
        const uploadedAttachments: MessageAttachment[] = [...preloadedAttachments];

        const uploadAttachment = async (
          file: File,
          fallbackMimeType: string,
          failureMessage: string,
        ): Promise<MessageAttachment> => {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('purpose', 'vision');

          const uploadRes = await fetch('/api/v1/files', {
            method: 'POST',
            body: formData,
            credentials: 'include',
            signal: requestAbortController.signal,
          });

          if (!uploadRes.ok) {
            const uploadBody = (await uploadRes.json().catch(() => null)) as unknown;
            throw new Error(parseErrorMessage(uploadBody, failureMessage));
          }

          const uploadBody = (await uploadRes.json()) as { id: string };
          return {
            file_id: uploadBody.id,
            filename: file.name || 'attachment',
            mime_type: file.type || fallbackMimeType,
            content_url: `/api/v1/files/${uploadBody.id}/content`,
          };
        };

        for (const image of imageFiles) {
          uploadedAttachments.push(await uploadAttachment(image, 'image/*', 'Image upload failed'));
        }

        for (const doc of docFiles) {
          uploadedAttachments.push(
            await uploadAttachment(
              doc,
              inferDocumentMimeType(doc.name) ?? 'application/octet-stream',
              'File upload failed',
            ),
          );
        }

        const content: Array<Record<string, unknown>> = [];
        if (normalizedPromptText) {
          content.push({
            type: 'input_text',
            text: normalizedPromptText,
          });
        }

        for (const attachment of uploadedAttachments) {
          if (attachment.mime_type.startsWith('image/')) {
            content.push({
              type: 'input_image',
              file_id: attachment.file_id,
            });
            continue;
          }

          content.push({
            type: 'input_file',
            file_id: attachment.file_id,
          });
        }

        if (content.length === 0) {
          throw new Error('Message cannot be empty');
        }

        const body: Record<string, unknown> = {
          input: [
            {
              role: 'user',
              content,
            },
          ],
          stream: streamResponses,
          model: model.trim(),
        };

        if (params.threadId) {
          body.thread_id = params.threadId;
        }

        const optimisticUserId = makeLocalMessageId('local-user');
        const optimisticAssistantMessageId = makeLocalMessageId('local-assistant');
        optimisticAssistantId = optimisticAssistantMessageId;
        optimisticMessageIds.push(optimisticUserId, optimisticAssistantMessageId);
        setGenerationActive(true);
        setStreamingAssistantId(optimisticAssistantMessageId);
        setStreamingAssistantContent('');
        streamBufferedAssistantTextRef.current = '';
        streamRenderedAssistantTextRef.current = '';
        streamLastFlushAtRef.current = 0;
        if (streamFlushFrameRef.current !== null) {
          window.cancelAnimationFrame(streamFlushFrameRef.current);
          streamFlushFrameRef.current = null;
        }

        setMessages((previous) => [
          ...previous,
          {
            id: optimisticUserId,
            role: 'user',
            content: buildUserMessagePreview(normalizedPromptText, uploadedAttachments),
            created_at: new Date().toISOString(),
            attachments: uploadedAttachments,
          },
          {
            id: optimisticAssistantMessageId,
            role: 'assistant',
            content: '',
            created_at: new Date().toISOString(),
            attachments: [],
          },
        ]);

        if (params.clearComposerOnStart) {
          setInput('');
          clearImages();
          clearDocs();
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }

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
          const decoder = new TextDecoder();

          const flushAssistantContent = (force: boolean) => {
            const bufferedAssistantText = streamBufferedAssistantTextRef.current;
            if (!force && bufferedAssistantText === streamRenderedAssistantTextRef.current) {
              return;
            }
            streamRenderedAssistantTextRef.current = bufferedAssistantText;
            latestAssistantTextRef.current = bufferedAssistantText;
            streamLastFlushAtRef.current = performance.now();
            setStreamingAssistantContent((previous) =>
              previous === bufferedAssistantText ? previous : bufferedAssistantText,
            );
          };

          const scheduleAssistantFlush = () => {
            if (streamFlushFrameRef.current !== null) {
              return;
            }

            const flushFrame = (timestamp: number) => {
              if (timestamp - streamLastFlushAtRef.current < streamingRenderIntervalMs) {
                streamFlushFrameRef.current = window.requestAnimationFrame(flushFrame);
                return;
              }
              streamFlushFrameRef.current = null;
              flushAssistantContent(false);
            };

            streamFlushFrameRef.current = window.requestAnimationFrame(flushFrame);
          };

          try {
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

              streamBufferedAssistantTextRef.current += parsed.assistantDelta;
              latestAssistantTextRef.current = streamBufferedAssistantTextRef.current;
              scheduleAssistantFlush();
            }

            const tail = decoder.decode();
            if (tail) {
              parserBuffer += tail;
              const parsedTail = parseResponsesSseBuffer(parserBuffer);
              streamBufferedAssistantTextRef.current += parsedTail.assistantDelta;
            }

            flushAssistantContent(true);
            const finalizedAssistantText =
              streamBufferedAssistantTextRef.current || '[stream ended without text]';
            latestAssistantTextRef.current = finalizedAssistantText;
            setStreamingAssistantContent((previous) =>
              previous === finalizedAssistantText ? previous : finalizedAssistantText,
            );
            updateMessageContent(optimisticAssistantMessageId, finalizedAssistantText);
          } finally {
            if (streamFlushFrameRef.current !== null) {
              window.cancelAnimationFrame(streamFlushFrameRef.current);
              streamFlushFrameRef.current = null;
            }
          }
        } else {
          const payload = (await res.json()) as unknown;
          const assistantText = extractAssistantText(payload) || '[empty response]';
          latestAssistantTextRef.current = assistantText;
          updateMessageContent(optimisticAssistantMessageId, assistantText);
        }

        await refreshThreads(latestThreadId);
        if (latestThreadId) {
          const nextMessages = await loadMessages(latestThreadId);
          if (nextMessages) {
            setMessages(nextMessages);
          }
        }

        pushToast('success', 'Response received');
      } catch (requestError) {
        const isAbortError = requestError instanceof Error && requestError.name === 'AbortError';
        if (isAbortError) {
          const stoppedText = (
            latestAssistantTextRef.current ||
            streamBufferedAssistantTextRef.current ||
            streamRenderedAssistantTextRef.current
          ).trim();
          if (optimisticAssistantId && stoppedText) {
            updateMessageContent(optimisticAssistantId, stoppedText);
          } else if (optimisticAssistantId) {
            setMessages((previous) =>
              previous.filter((message) => message.id !== optimisticAssistantId),
            );
          }

          await refreshThreads(latestThreadId);
          pushToast('info', 'Generation stopped');
        } else {
          setMessages((previous) =>
            previous.filter((message) => !optimisticMessageIds.includes(message.id)),
          );

          await refreshThreads(latestThreadId);
          if (latestThreadId) {
            const nextMessages = await loadMessages(latestThreadId);
            if (nextMessages) {
              setMessages(nextMessages);
            }
          }

          pushToast(
            'error',
            requestError instanceof Error ? requestError.message : 'Failed to send message',
          );
        }
      } finally {
        setSending(false);
        setGenerationActive(false);
        setActiveAbortController(null);
        setStreamingAssistantId(null);
        setStreamingAssistantContent('');
        if (streamFlushFrameRef.current !== null) {
          window.cancelAnimationFrame(streamFlushFrameRef.current);
          streamFlushFrameRef.current = null;
        }
        streamBufferedAssistantTextRef.current = '';
        streamRenderedAssistantTextRef.current = '';
        streamLastFlushAtRef.current = 0;
        stopRequestedRef.current = false;
        latestAssistantTextRef.current = '';
      }
    },
    [
      clearDocs,
      clearImages,
      loadMessages,
      model,
      pushToast,
      refreshThreads,
      selectThread,
      sending,
      streamResponses,
      updateMessageContent,
    ],
  );

  const sendMessage = async () => {
    if (editingActive) {
      return;
    }

    await sendPreparedInput({
      threadId: selectedThreadId,
      promptText: input,
      imageFiles: images,
      docFiles: docs,
      clearComposerOnStart: true,
    });
  };

  const startEditingUserMessage = useCallback(
    (message: MessageItem) => {
      if (sending || !selectedThreadId) {
        return;
      }

      if (!latestUserMessage || latestUserMessage.id !== message.id) {
        return;
      }

      const draftText = normalizeUserMessageTextForInput(message.content);
      setEditingMessageId(message.id);
      setEditDraftText(draftText);
      setEditDraftAttachments(message.attachments);
      setInput(draftText);
      clearImages();
      clearDocs();

      window.requestAnimationFrame(() => {
        composerInputRef.current?.focus();
      });
    },
    [clearDocs, clearImages, latestUserMessage, selectedThreadId, sending],
  );

  const cancelEditMode = useCallback(() => {
    setEditingMessageId(null);
    setEditDraftText('');
    setEditDraftAttachments([]);
    setInput('');
    clearImages();
    clearDocs();
  }, [clearDocs, clearImages]);

  const regenerateLatestAssistant = useCallback(
    async (assistantMessage: MessageItem) => {
      if (sending || !selectedThreadId) {
        return;
      }

      setRegeneratingAssistantId(assistantMessage.id);

      try {
        let sourceUser =
          latestAssistantWithSourceUser?.assistant.id === assistantMessage.id
            ? latestAssistantWithSourceUser.sourceUser
            : null;
        if (!sourceUser) {
          sourceUser = latestUserMessage;
        }

        if (!sourceUser || !isPersistedUuid(sourceUser.id)) {
          const refreshedMessages = await loadMessages(selectedThreadId);
          if (refreshedMessages === null) {
            throw new Error('Failed to refresh messages before regenerating');
          }

          setMessages(refreshedMessages);
          const refreshedPair = findLatestAssistantWithSourceUser(refreshedMessages);
          sourceUser = refreshedPair?.sourceUser ?? findLatestUserMessage(refreshedMessages);
        }

        if (!sourceUser || !isPersistedUuid(sourceUser.id)) {
          throw new Error('Could not resolve a saved user message to regenerate from');
        }

        const sourceText = normalizeUserMessageTextForInput(sourceUser.content);
        const sourceAttachments = sourceUser.attachments;

        await truncateThreadFromMessage(selectedThreadId, sourceUser.id);

        const reloadedMessages = await loadMessages(selectedThreadId);
        if (reloadedMessages === null) {
          throw new Error('Failed to reload messages after truncate');
        }
        setMessages(reloadedMessages);

        await sendPreparedInput({
          threadId: selectedThreadId,
          promptText: sourceText,
          existingAttachments: sourceAttachments,
          clearComposerOnStart: false,
        });
      } catch (error) {
        pushToast('error', error instanceof Error ? error.message : 'Failed to regenerate response');
      } finally {
        setRegeneratingAssistantId(null);
      }
    },
    [
      latestAssistantWithSourceUser,
      latestUserMessage,
      loadMessages,
      pushToast,
      selectedThreadId,
      sendPreparedInput,
      sending,
      truncateThreadFromMessage,
    ],
  );

  const saveEditedMessageAndRegenerate = useCallback(async () => {
    if (!selectedThreadId || !editingMessageId || sending || editSavePending) {
      return;
    }

    const normalizedDraftText = editDraftText.trim();
    if (!normalizedDraftText && editDraftAttachments.length === 0) {
      pushToast('error', 'Message cannot be empty');
      return;
    }

    setEditSavePending(true);

    try {
      let targetUserMessage =
        messages.find((message) => message.id === editingMessageId && message.role === 'user') ?? null;
      if (!targetUserMessage || !isPersistedUuid(targetUserMessage.id)) {
        const refreshedMessages = await loadMessages(selectedThreadId);
        if (refreshedMessages === null) {
          throw new Error('Failed to refresh messages before saving edit');
        }

        setMessages(refreshedMessages);
        targetUserMessage = findLatestUserMessage(refreshedMessages);
      }

      if (!targetUserMessage || !isPersistedUuid(targetUserMessage.id)) {
        throw new Error('Could not resolve the latest saved user message for editing');
      }

      await truncateThreadFromMessage(selectedThreadId, targetUserMessage.id);

      const reloadedMessages = await loadMessages(selectedThreadId);
      if (reloadedMessages === null) {
        throw new Error('Failed to reload messages after truncate');
      }
      setMessages(reloadedMessages);

      setEditingMessageId(null);
      setEditDraftText('');
      setEditDraftAttachments([]);

      await sendPreparedInput({
        threadId: selectedThreadId,
        promptText: normalizedDraftText,
        existingAttachments: editDraftAttachments,
        clearComposerOnStart: true,
      });
    } catch (error) {
      pushToast(
        'error',
        error instanceof Error ? error.message : 'Failed to save edit and regenerate',
      );
    } finally {
      setEditSavePending(false);
    }
  }, [
    editDraftAttachments,
    editDraftText,
    editingMessageId,
    editSavePending,
    loadMessages,
    messages,
    pushToast,
    selectedThreadId,
    sendPreparedInput,
    sending,
    truncateThreadFromMessage,
  ]);

  const showHomeState = !selectedThreadId || (!messagesLoading && messages.length === 0);
  const latestAssistantId = latestAssistantWithSourceUser?.assistant.id ?? null;
  const canRegenerateLatestAssistant = Boolean(latestAssistantWithSourceUser?.sourceUser);

  const chatHeaderControls = (
    <div className="chat-header-controls">
      <ModelPicker
        options={allowedModels}
        value={model}
        onChange={handleModelChange}
        disabled={sending || allowedModels.length === 0}
      />
    </div>
  );

  const composerRegion = (
    <div
      ref={composerRegionRef}
      className={`chat-composer-region${showHomeState ? ' chat-composer-region-home' : ''}`}
    >
      {imagePreviewUrls.length > 0 ? (
        <div className="chat-image-preview-row">
          <div className="chat-image-preview-grid">
            {imagePreviewUrls.map((previewUrl, index) => {
              const file = images[index];
              const fileName = file?.name || `Image ${index + 1}`;

              return (
                <div key={previewUrl} className="chat-image-preview-item">
                  <img src={previewUrl} alt={fileName} />
                  <button
                    type="button"
                    className="chat-image-preview-remove"
                    onClick={() => removeImageAtIndex(index)}
                    disabled={sending}
                    aria-label={`Remove ${fileName}`}
                    title={`Remove ${fileName}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="chat-image-preview-footer">
            <span className="chat-image-preview-meta">
              {images.length}/{maxComposerImages} selected
            </span>
            <button
              className="ghost"
              type="button"
              onClick={clearImages}
              disabled={sending || editingActive}
            >
              Clear images
            </button>
          </div>
        </div>
      ) : null}

      {docs.length > 0 ? (
        <div className="chat-doc-preview-row">
          <div className="chat-doc-chip-list">
            {docs.map((doc, index) => (
              <div
                key={`${doc.name}-${doc.size}-${doc.lastModified}-${index}`}
                className="chat-doc-chip"
                title={doc.name}
              >
                <span className="chat-doc-chip-name">{doc.name}</span>
                <button
                  type="button"
                  className="chat-doc-chip-remove"
                  onClick={() => removeDocAtIndex(index)}
                  disabled={sending}
                  aria-label={`Remove ${doc.name}`}
                  title={`Remove ${doc.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="chat-doc-preview-footer">
            <span className="chat-image-preview-meta">
              {docs.length}/{maxComposerDocs} selected
            </span>
            <button
              className="ghost"
              type="button"
              onClick={clearDocs}
              disabled={sending || editingActive}
            >
              Clear files
            </button>
          </div>
        </div>
      ) : null}

      <form
        className={`chat-composer-bar${composerActive ? ' is-active' : ''}`}
        onFocusCapture={() => setComposerFocused(true)}
        onBlurCapture={(event) => {
          const currentTarget = event.currentTarget;
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && currentTarget.contains(nextTarget)) {
            return;
          }

          window.requestAnimationFrame(() => {
            const activeElement = document.activeElement;
            if (activeElement instanceof Node && currentTarget.contains(activeElement)) {
              return;
            }
            setComposerFocused(false);
          });
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
          accept="image/*,.pdf,.txt,.md,text/plain,text/markdown,application/pdf"
          multiple
          disabled={sending || editingActive}
          onChange={(event) => {
            appendSelectedFiles(Array.from(event.target.files ?? []));
          }}
        />

        <button
          type="button"
          className="chat-attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={
            sending ||
            editingActive ||
            (images.length >= maxComposerImages && docs.length >= maxComposerDocs)
          }
          aria-label="Attach files"
          title={
            images.length >= maxComposerImages && docs.length >= maxComposerDocs
              ? `Maximum ${maxComposerImages} images and ${maxComposerDocs} files`
              : editingActive
                ? 'Editing uses the original attachments'
                : 'Attach image or file'
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span className="sr-only">Attach files</span>
        </button>

        <textarea
          ref={composerInputRef}
          className="chat-composer-input"
          rows={1}
          value={input}
          onChange={(event) => {
            const nextValue = event.target.value;
            setInput(nextValue);
            if (editingActive) {
              setEditDraftText(nextValue);
            }
          }}
          onPaste={handleComposerPaste}
          onFocus={() => {
            window.requestAnimationFrame(() => {
              adjustComposerHeight();
              if (!isMobileViewport) {
                return;
              }

              if (shouldAutoScrollRef.current) {
                scheduleAutoScrollIfNeeded();
                return;
              }

              scheduleAutoScrollStateSync();
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
              return;
            }
            if (!desktopComposerEnterSends || editingActive) {
              return;
            }
            event.preventDefault();
            if (canSend) {
              void sendMessage();
            }
          }}
          placeholder={editingActive ? 'edit your message' : 'ask anything'}
          disabled={sending}
        />

        <div className="chat-composer-action-group">
          {generationActive ? (
            <button
              className="chat-stop-button"
              type="button"
              disabled={!activeAbortController}
              onClick={stopStreaming}
              aria-label="Stop generation"
              title="Stop generation"
            >
              <span className="chat-stop-icon" aria-hidden="true" />
              <span className="sr-only">Stop generation</span>
            </button>
          ) : (
            <button
              className="chat-send-button"
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 17V7" />
                <path d="m7 12 5-5 5 5" />
              </svg>
              <span className="sr-only">Send message</span>
            </button>
          )}
        </div>
      </form>

      {generationActive ? (
        <div className="chat-composer-status">
          <span className="chat-streaming-indicator" role="status" aria-live="polite">
            <span className="chat-streaming-dot" />
            Generating response
          </span>
        </div>
      ) : null}

      {editingActive ? (
        <div className="chat-edit-region">
          <p className="chat-edit-label">Editing last user message</p>
          {editDraftAttachments.length > 0 ? (
            <p className="chat-edit-note">Editing will resend with the same attachments.</p>
          ) : null}
          <div className="chat-edit-actions">
            <button
              type="button"
              className="ghost"
              onClick={cancelEditMode}
              disabled={sending || editSavePending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void saveEditedMessageAndRegenerate()}
              disabled={sending || editSavePending}
            >
              {editSavePending ? 'Saving...' : 'Save & regenerate'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (loading || shellLoading) {
    return <section className="panel page-loading">Loading chat...</section>;
  }

  return (
    <section className="chat-page app-page">
      <MainHeader
        title={selectedThread?.title ?? 'New chat'}
        subtitle={showHomeState ? 'Start a conversation' : 'Conversation'}
        right={chatHeaderControls}
      />

      {allowedModels.length === 0 ? (
        <p className="error chat-header-error">No allowed models are configured by admin.</p>
      ) : null}

      {showHomeState ? (
        <div className="chat-home-shell">
          <div className="chat-home-card chat-message-enter">
            <h2 className="chat-home-title">How can I help you today?</h2>
            <p className="chat-home-subtitle">Start a chat with text or images.</p>
            {composerRegion}
          </div>
        </div>
      ) : (
        <>
          <div className="chat-surface">
            <div
              ref={messageListRef}
              className="chat-messages-scroll"
              onScroll={updateAutoScrollState}
              onLoadCapture={handleMessageListLayoutShift}
              onErrorCapture={handleMessageListLayoutShift}
            >
              {messagesLoading ? (
                <div className="chat-empty-state">Loading conversation...</div>
              ) : null}

              {messages.map((message) => {
                const isEntering = animatingMessageIdSet.has(message.id);
                const isStreaming = generationActive && message.id === streamingAssistantId;
                const rowStreamingContent = isStreaming && streamResponses ? streamingAssistantContent : null;
                const showRegenerateAction =
                  message.role === 'assistant' &&
                  message.id === latestAssistantId &&
                  canRegenerateLatestAssistant;
                const showEditAction =
                  message.role === 'user' &&
                  Boolean(selectedThreadId) &&
                  message.id === latestUserMessage?.id;
                const regenerateBusy = regeneratingAssistantId === message.id;

                return (
                  <ChatMessageRow
                    key={message.id}
                    message={message}
                    isEntering={isEntering}
                    isStreaming={isStreaming}
                    streamingContent={rowStreamingContent}
                    onCopyAssistantMessage={handleCopyAssistantMessage}
                    showRegenerateAction={showRegenerateAction}
                    regenerateDisabled={sending || regenerateBusy || editSavePending}
                    regenerateBusy={regenerateBusy}
                    onRegenerateAssistantMessage={regenerateLatestAssistant}
                    showEditAction={showEditAction}
                    editDisabled={
                      sending ||
                      editSavePending ||
                      regeneratingAssistantId !== null ||
                      editingActive
                    }
                    onEditUserMessage={startEditingUserMessage}
                  />
                );
              })}
            </div>

            {showJumpToLatest && messages.length > 0 ? (
              <button type="button" className="chat-jump-latest" onClick={() => scrollToLatest('smooth')}>
                Jump to bottom
              </button>
            ) : null}
          </div>
          {composerRegion}
        </>
      )}

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
