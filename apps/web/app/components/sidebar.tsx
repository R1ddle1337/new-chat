'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatShell } from './chat-shell-context';

type SidebarProps = {
  collapsed: boolean;
  isMobile: boolean;
  mobileOpen: boolean;
  onOpenMobile: () => void;
  onCloseMobile: () => void;
  onToggleDesktopCollapse: () => void;
};

function formatThreadUpdatedAt(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const now = new Date();
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();

  if (sameDay) {
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  return parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Sidebar({
  collapsed,
  isMobile,
  mobileOpen,
  onOpenMobile,
  onCloseMobile,
  onToggleDesktopCollapse,
}: SidebarProps) {
  const pathname = usePathname();
  const {
    loading,
    isAdmin,
    threads,
    selectedThreadId,
    createThread,
    selectThread,
    renameThread,
    deleteThread,
    clearThreads,
  } = useChatShell();

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [mobileActionThreadId, setMobileActionThreadId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  const navItems = useMemo(() => {
    const baseItems: Array<{ href: string; label: string }> = [
      { href: '/settings', label: 'Settings' },
    ];

    if (isAdmin) {
      baseItems.push({ href: '/admin', label: 'Admin' });
    }

    return baseItems;
  }, [isAdmin]);

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return threads;
    }

    return threads.filter((thread) => thread.title.toLowerCase().includes(query));
  }, [searchQuery, threads]);

  const mobileActionThread = useMemo(
    () => threads.find((thread) => thread.id === mobileActionThreadId) ?? null,
    [mobileActionThreadId, threads],
  );
  const hasSearchQuery = searchQuery.trim().length > 0;
  const mobileSearchVisible = mobileSearchOpen || hasSearchQuery;
  const showSearchInput = !isMobile || mobileSearchVisible;

  useEffect(() => {
    if (!headerMenuOpen) {
      return;
    }

    const closeMenu = () => {
      setHeaderMenuOpen(false);
    };

    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [headerMenuOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) {
        return;
      }

      event.preventDefault();

      const focusSearchInput = () => {
        if (!searchInputRef.current) {
          return;
        }

        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current.blur();
          return;
        }

        searchInputRef.current.focus();
        searchInputRef.current.select();
      };

      const focusSearch = () => {
        if (isMobile) {
          setMobileSearchOpen(true);
          window.setTimeout(focusSearchInput, 40);
          return;
        }

        focusSearchInput();
      };

      const shouldOpenMobileFirst = isMobile && !mobileOpen;
      if (shouldOpenMobileFirst) {
        onOpenMobile();
        window.setTimeout(focusSearch, 220);
        return;
      }

      focusSearch();
    };

    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
    };
  }, [isMobile, mobileOpen, onOpenMobile]);

  useEffect(() => {
    if (!mobileActionThreadId) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileActionThreadId(null);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [mobileActionThreadId]);

  useEffect(() => {
    if (!isMobile || mobileOpen) {
      return;
    }

    setMobileSearchOpen(false);
  }, [isMobile, mobileOpen]);

  const handleCreateThread = async () => {
    setFeedback(null);
    const result = await createThread();

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    onCloseMobile();
  };

  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
    onCloseMobile();
  };

  const handleRenameStart = (threadId: string, title: string) => {
    setRenamingThreadId(threadId);
    setRenameDraft(title);
    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setFeedback(null);
  };

  const handleRenameSubmit = async (threadId: string, currentTitle: string) => {
    const normalizedDraft = renameDraft.replace(/\s+/g, ' ').trim();
    if (!normalizedDraft) {
      setFeedback('Thread title cannot be empty');
      return;
    }

    if (normalizedDraft === currentTitle) {
      setRenamingThreadId(null);
      setRenameDraft('');
      setFeedback(null);
      return;
    }

    const result = await renameThread(threadId, renameDraft);
    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
  };

  const handleDeleteThread = async (threadId: string, title: string) => {
    const confirmed = window.confirm(`Delete "${title}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    const result = await deleteThread(threadId);
    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
  };

  const handleClearAll = async () => {
    const confirmed = window.confirm('Clear all chats? This cannot be undone.');
    if (!confirmed) {
      return;
    }

    const result = await clearThreads();
    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
    onCloseMobile();
  };

  const handleNavClick = () => {
    onCloseMobile();
    setHeaderMenuOpen(false);
    setMobileActionThreadId(null);
    setRenamingThreadId(null);
  };
  const handleMobileSearchToggle = () => {
    if (!isMobile) {
      return;
    }

    if (mobileSearchVisible) {
      setSearchQuery('');
      setMobileSearchOpen(false);
      return;
    }

    setMobileSearchOpen(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 40);
  };

  const isNavItemActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const collapseButtonLabel = isMobile
    ? 'Close sidebar'
    : collapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar';
  const collapseButtonGlyph = isMobile ? '<' : collapsed ? '>' : '<';
  const handleCollapseButtonClick = () => {
    if (isMobile) {
      onCloseMobile();
      return;
    }

    onToggleDesktopCollapse();
  };
  const toolbarActions = (
    <div className="sidebar-toolbar-actions">
      <button type="button" className="sidebar-new-chat" onClick={() => void handleCreateThread()}>
        <span className="sidebar-new-chat-plus">+</span>
        <span className="sidebar-new-chat-label">New chat</span>
      </button>

      <div className="sidebar-header-menu-wrap" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sidebar-kebab"
          aria-label="Thread list actions"
          aria-expanded={headerMenuOpen}
          aria-haspopup="menu"
          onClick={() => setHeaderMenuOpen((current) => !current)}
        >
          ...
        </button>
        <div
          className={`sidebar-thread-menu sidebar-header-menu${headerMenuOpen ? ' open' : ''}`}
          role="menu"
          aria-hidden={!headerMenuOpen}
        >
          <button
            type="button"
            className="sidebar-thread-menu-item sidebar-thread-menu-item-danger"
            onClick={() => void handleClearAll()}
          >
            Clear all
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <aside className="app-sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand" aria-label="new-chat">
          <span className="sidebar-brand-mark">N</span>
          <span className="sidebar-brand-label">new-chat</span>
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={handleCollapseButtonClick}
          aria-label={collapseButtonLabel}
          title={collapseButtonLabel}
        >
          {collapseButtonGlyph}
        </button>
      </div>

      <div className="sidebar-toolbar">
        {isMobile ? (
          <>
            {toolbarActions}
            <button
              type="button"
              className={`sidebar-search-toggle${mobileSearchVisible ? ' active' : ''}`}
              onClick={handleMobileSearchToggle}
              aria-expanded={mobileSearchVisible}
              aria-controls="sidebar-thread-search"
            >
              <span>{mobileSearchVisible ? (hasSearchQuery ? 'Clear search' : 'Hide search') : 'Search chats'}</span>
              <span className="sidebar-search-toggle-state">{mobileSearchVisible ? 'On' : 'Off'}</span>
            </button>
            {showSearchInput ? (
              <div className="sidebar-search-row">
                <label htmlFor="sidebar-thread-search" className="sr-only">
                  Search chats
                </label>
                <input
                  id="sidebar-thread-search"
                  ref={searchInputRef}
                  className="sidebar-search-input"
                  placeholder="Search chats"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <label htmlFor="sidebar-thread-search" className="sr-only">
              Search chats
            </label>
            <input
              id="sidebar-thread-search"
              ref={searchInputRef}
              className="sidebar-search-input"
              placeholder="Search chats"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {toolbarActions}
          </>
        )}
      </div>

      <div className="sidebar-thread-list" aria-label="Conversations">
        {loading ? <div className="sidebar-state">Loading chats...</div> : null}
        {!loading && threads.length === 0 ? <div className="sidebar-state">No chats yet</div> : null}
        {!loading && threads.length > 0 && filteredThreads.length === 0 ? (
          <div className="sidebar-state">No chats match search</div>
        ) : null}

        {filteredThreads.map((thread) => {
          const isSelected = thread.id === selectedThreadId;
          const isRenaming = renamingThreadId === thread.id;
          const updatedAtLabel = formatThreadUpdatedAt(thread.updated_at);

          return (
            <div
              key={thread.id}
              className={`sidebar-thread-row${isSelected ? ' selected' : ''}${isRenaming ? ' renaming' : ''}`}
              onClick={() => handleSelectThread(thread.id)}
            >
              <div className="sidebar-thread-main">
                {isRenaming ? (
                  <div className="sidebar-rename-row" onClick={(event) => event.stopPropagation()}>
                    <input
                      className="sidebar-rename-input"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleRenameSubmit(thread.id, thread.title);
                        }

                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenamingThreadId(null);
                          setRenameDraft('');
                        }
                      }}
                    />
                    <div className="sidebar-rename-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void handleRenameSubmit(thread.id, thread.title)}
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
                  </div>
                ) : (
                  <>
                    <div className="sidebar-thread-title" title={thread.title}>
                      {thread.title}
                    </div>
                    {updatedAtLabel ? <div className="sidebar-thread-updated">{updatedAtLabel}</div> : null}
                  </>
                )}
              </div>

              {!isRenaming ? (
                <div className="sidebar-thread-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="sidebar-thread-action"
                    onClick={() => handleRenameStart(thread.id, thread.title)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="sidebar-thread-action danger"
                    onClick={() => void handleDeleteThread(thread.id, thread.title)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="sidebar-kebab sidebar-thread-mobile-kebab"
                    aria-label={`Thread actions for ${thread.title}`}
                    onClick={() => setMobileActionThreadId(thread.id)}
                  >
                    ...
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <footer className="sidebar-footer">
        <Link
          href="/chat"
          className={`sidebar-nav-link${isNavItemActive('/chat') ? ' active' : ''}`}
          onClick={handleNavClick}
        >
          <span className="sidebar-nav-icon">C</span>
          <span className="sidebar-nav-label">Chat</span>
        </Link>

        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-nav-link${isNavItemActive(item.href) ? ' active' : ''}`}
            onClick={handleNavClick}
          >
            <span className="sidebar-nav-icon">{item.label[0]}</span>
            <span className="sidebar-nav-label">{item.label}</span>
          </Link>
        ))}
      </footer>

      {feedback ? <div className="sidebar-feedback">{feedback}</div> : null}

      {mobileActionThread ? (
        <>
          <button
            type="button"
            className="sidebar-sheet-backdrop"
            aria-label="Close thread actions"
            onClick={() => setMobileActionThreadId(null)}
          />
          <div
            className="sidebar-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Thread actions for ${mobileActionThread.title}`}
          >
            <div className="sidebar-sheet-handle" />
            <div className="sidebar-sheet-title" title={mobileActionThread.title}>
              {mobileActionThread.title}
            </div>
            <button
              type="button"
              className="sidebar-sheet-action"
              onClick={() => handleRenameStart(mobileActionThread.id, mobileActionThread.title)}
            >
              Rename
            </button>
            <button
              type="button"
              className="sidebar-sheet-action danger"
              onClick={() => void handleDeleteThread(mobileActionThread.id, mobileActionThread.title)}
            >
              Delete
            </button>
            <button
              type="button"
              className="sidebar-sheet-action"
              onClick={() => setMobileActionThreadId(null)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </aside>
  );
}
