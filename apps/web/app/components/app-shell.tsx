'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ChatShellProvider } from './chat-shell-context';
import Sidebar from './sidebar';

type AppShellProps = {
  children: ReactNode;
};

function AppShellChrome({ children }: AppShellProps) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}
    >
      <Sidebar
        collapsed={sidebarCollapsed}
        onCloseMobile={() => setMobileOpen(false)}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
      />

      <div className="app-main">
        <button
          type="button"
          className="app-mobile-toggle"
          onClick={() => setMobileOpen(true)}
          aria-label="Open sidebar"
        >
          =
        </button>
        <div className="app-main-inner">{children}</div>
      </div>

      <button
        type="button"
        className={`app-mobile-overlay${mobileOpen ? ' open' : ''}`}
        onClick={() => setMobileOpen(false)}
        aria-label="Close sidebar"
        aria-hidden={!mobileOpen}
        tabIndex={mobileOpen ? 0 : -1}
      />
    </div>
  );
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <div className="auth-shell">{children}</div>;
  }

  return (
    <ChatShellProvider>
      <AppShellChrome>{children}</AppShellChrome>
    </ChatShellProvider>
  );
}
