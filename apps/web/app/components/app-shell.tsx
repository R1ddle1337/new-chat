'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ChatShellProvider } from './chat-shell-context';
import Sidebar from './sidebar';

type AppShellProps = {
  children: ReactNode;
};

const MOBILE_VIEWPORT_QUERY = '(max-width: 980px)';

function AppShellChrome({ children }: AppShellProps) {
  const pathname = usePathname();
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  const sidebarCollapsed = desktopSidebarCollapsed && !isMobileViewport;
  const mobileOpen = mobileDrawerOpen && isMobileViewport;

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const syncViewportMode = () => {
      setIsMobileViewport(mediaQuery.matches);
    };

    syncViewportMode();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncViewportMode);
      return () => {
        mediaQuery.removeEventListener('change', syncViewportMode);
      };
    }

    mediaQuery.addListener(syncViewportMode);
    return () => {
      mediaQuery.removeListener(syncViewportMode);
    };
  }, []);

  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }

    setMobileDrawerOpen(false);
  }, [isMobileViewport]);

  useEffect(() => {
    if (!mobileOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileOpen]);

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${mobileOpen ? ' mobile-open' : ''}`}
    >
      <Sidebar
        collapsed={desktopSidebarCollapsed}
        isMobile={isMobileViewport}
        mobileOpen={mobileOpen}
        onOpenMobile={() => {
          if (isMobileViewport) {
            setMobileDrawerOpen(true);
          }
        }}
        onCloseMobile={() => setMobileDrawerOpen(false)}
        onToggleDesktopCollapse={() => setDesktopSidebarCollapsed((current) => !current)}
      />

      <div className="app-main">
        <button
          type="button"
          className="app-mobile-toggle"
          onClick={() => {
            if (isMobileViewport) {
              setMobileDrawerOpen(true);
            }
          }}
          aria-label="Open sidebar"
        >
          <span className="app-mobile-toggle-bar" />
          <span className="app-mobile-toggle-bar" />
          <span className="app-mobile-toggle-bar" />
        </button>
        <div className="app-main-inner">{children}</div>
      </div>

      <button
        type="button"
        className={`app-mobile-overlay${mobileOpen ? ' open' : ''}`}
        onClick={() => setMobileDrawerOpen(false)}
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
