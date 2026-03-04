'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import MainHeader from '../components/main-header';
import type { MePayload } from './_components/types';

const adminNavItems: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: '/admin', label: '概览', exact: true },
  { href: '/admin/users', label: '用户' },
  { href: '/admin/chat', label: '聊天' },
  { href: '/admin/providers', label: '提供商' },
  { href: '/admin/models', label: '模型' },
  { href: '/admin/rate-limits', label: '速率限制' },
  { href: '/admin/audit', label: '审计' },
];

function isNavItemActive(pathname: string, href: string, exact = false): boolean {
  if (exact) {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      setLoading(true);
      setSessionError(null);

      const meRes = await fetch('/api/me', { credentials: 'include' });
      if (meRes.status === 401) {
        router.replace('/login');
        return;
      }

      if (!meRes.ok) {
        if (!active) {
          return;
        }
        setAuthorized(false);
        setSessionError('加载会话失败');
        setLoading(false);
        return;
      }

      const me = (await meRes.json()) as MePayload;
      if (!active) {
        return;
      }

      if (!me.is_admin) {
        setAuthorized(false);
        setLoading(false);
        return;
      }

      setAuthorized(true);
      setLoading(false);
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, [router]);

  const subtitle = useMemo(() => {
    const activeItem = adminNavItems.find((item) => isNavItemActive(pathname, item.href, item.exact));
    return activeItem ? `${activeItem.label}页面` : '运营控制台';
  }, [pathname]);

  if (loading) {
    return <section className="panel page-loading">正在加载管理后台...</section>;
  }

  if (!authorized) {
    return (
      <section className="admin-page app-page">
        <MainHeader title="管理后台" subtitle="未找到" />
        <div className="page-stack">
          <div className="card">
            <p className="error">404 未找到。</p>
            {sessionError ? <p className="error">{sessionError}</p> : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="admin-page app-page">
      <MainHeader title="管理后台" subtitle={subtitle} />

      <div className="page-stack">
        <nav className="admin-subnav" aria-label="管理分区">
          {adminNavItems.map((item) => {
            const active = isNavItemActive(pathname, item.href, item.exact);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`admin-subnav-link${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {sessionError ? <div className="error">{sessionError}</div> : null}
        {children}
      </div>
    </section>
  );
}
