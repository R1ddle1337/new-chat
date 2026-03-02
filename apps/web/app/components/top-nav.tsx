'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type MePayload = {
  is_admin?: boolean;
  admin_enabled?: boolean;
};

export default function TopNav() {
  const [showAdminLink, setShowAdminLink] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadMe = async () => {
      try {
        const response = await fetch('/api/me', { credentials: 'include' });
        if (!response.ok) {
          if (!cancelled) {
            setShowAdminLink(false);
          }
          return;
        }

        const me = (await response.json()) as MePayload;
        if (!cancelled) {
          setShowAdminLink(Boolean(me.admin_enabled && me.is_admin));
        }
      } catch {
        if (!cancelled) {
          setShowAdminLink(false);
        }
      }
    };

    void loadMe();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <nav>
      <Link href="/chat">Chat</Link>
      <Link href="/settings">Settings</Link>
      {showAdminLink ? <Link href="/admin">Admin</Link> : null}
      <Link href="/login">Login</Link>
    </nav>
  );
}
