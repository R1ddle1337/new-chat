'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useChatShell } from './chat-shell-context';

type SidebarProps = {
  collapsed: boolean;
  onCloseMobile: () => void;
  onToggleCollapse: () => void;
};

export default function Sidebar({ collapsed, onCloseMobile, onToggleCollapse }: SidebarProps) {
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
  } = useChatShell();

  const [feedback, setFeedback] = useState<string | null>(null);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const navItems = useMemo(() => {
    const baseItems: Array<{ href: string; label: string }> = [
      { href: '/settings', label: 'Settings' },
    ];

    if (isAdmin) {
      baseItems.push({ href: '/admin', label: 'Admin' });
    }

    return baseItems;
  }, [isAdmin]);

  useEffect(() => {
    if (!menuThreadId) {
      return;
    }

    const closeMenu = () => {
      setMenuThreadId(null);
    };

    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, [menuThreadId]);

  const handleCreateThread = async () => {
    setFeedback(null);
    const result = await createThread();

    if (!result.ok) {
      setFeedback(result.error);
      return;
    }

    setMenuThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    onCloseMobile();
  };

  const handleSelectThread = (threadId: string) => {
    selectThread(threadId);
    setMenuThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
    onCloseMobile();
  };

  const handleRenameStart = (threadId: string, title: string) => {
    setRenamingThreadId(threadId);
    setRenameDraft(title);
    setMenuThreadId(null);
    setFeedback(null);
  };

  const handleRenameSubmit = async (threadId: string) => {
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

    setMenuThreadId(null);
    setRenamingThreadId(null);
    setRenameDraft('');
    setFeedback(null);
  };

  const handleNavClick = () => {
    onCloseMobile();
    setMenuThreadId(null);
    setRenamingThreadId(null);
  };

  const isNavItemActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

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
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '>' : '<'}
        </button>
      </div>

      <button type="button" className="sidebar-new-chat" onClick={() => void handleCreateThread()}>
        <span className="sidebar-new-chat-plus">+</span>
        <span className="sidebar-new-chat-label">New chat</span>
      </button>

      <div className="sidebar-thread-list" aria-label="Conversations">
        {loading ? <div className="sidebar-state">Loading chats...</div> : null}
        {!loading && threads.length === 0 ? <div className="sidebar-state">No chats yet</div> : null}

        {threads.map((thread) => {
          const isSelected = thread.id === selectedThreadId;
          const isRenaming = renamingThreadId === thread.id;

          return (
            <div
              key={thread.id}
              className={`sidebar-thread-row${isSelected ? ' selected' : ''}`}
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
                          void handleRenameSubmit(thread.id);
                        }

                        if (event.key === 'Escape') {
                          setRenamingThreadId(null);
                          setRenameDraft('');
                        }
                      }}
                    />
                    <div className="sidebar-rename-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void handleRenameSubmit(thread.id)}
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
                    <div className="sidebar-thread-model" title={thread.model ?? undefined}>
                      {thread.model ?? 'Default model'}
                    </div>
                  </>
                )}
              </div>

              {!isRenaming ? (
                <div className="sidebar-thread-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    className="sidebar-kebab"
                    aria-label={`Thread actions for ${thread.title}`}
                    aria-expanded={menuThreadId === thread.id}
                    aria-haspopup="menu"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuThreadId((current) => (current === thread.id ? null : thread.id));
                    }}
                  >
                    ...
                  </button>
                  <div
                    className={`sidebar-thread-menu${menuThreadId === thread.id ? ' open' : ''}`}
                    onClick={(event) => event.stopPropagation()}
                    role="menu"
                    aria-hidden={menuThreadId !== thread.id}
                  >
                    <button
                      type="button"
                      className="sidebar-thread-menu-item"
                      onClick={() => handleRenameStart(thread.id, thread.title)}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="sidebar-thread-menu-item sidebar-thread-menu-item-danger"
                      onClick={() => void handleDeleteThread(thread.id, thread.title)}
                    >
                      Delete
                    </button>
                  </div>
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
    </aside>
  );
}
