'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleOauthEnabled, setGoogleOauthEnabled] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const displayError = error ?? (oauthError ? oauthError.replace(/_/g, ' ') : null);

  useEffect(() => {
    const check = async () => {
      const res = await fetch('/api/me', { credentials: 'include' });
      if (res.ok) {
        router.replace('/chat');
      }
    };
    void check();
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      try {
        const response = await fetch('/api/auth/oauth/providers', { credentials: 'include' });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json().catch(() => null)) as
          | { data?: Array<{ code?: string }> }
          | null;
        const providers = Array.isArray(payload?.data) ? payload.data : [];
        const hasGoogleProvider = providers.some((provider) => provider?.code === 'google');
        if (!cancelled) {
          setGoogleOauthEnabled(hasGoogleProvider);
        }
      } catch {
        if (!cancelled) {
          setGoogleOauthEnabled(false);
        }
      }
    };

    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const queryParams = new URLSearchParams(window.location.search);
    setOauthError(queryParams.get('error'));
  }, []);

  const submit = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to ${mode}`);
        return;
      }

      router.push('/chat');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel" style={{ maxWidth: 460, margin: '2rem auto' }}>
      <h1 style={{ marginTop: 0 }}>{mode === 'login' ? 'Login' : 'Register'}</h1>
      <p className="notice">Session is cookie-based and scoped to this web app origin.</p>
      {googleOauthEnabled ? (
        <button
          className="secondary"
          type="button"
          onClick={() => {
            window.location.assign('/api/auth/oauth/google/start');
          }}
          style={{ marginBottom: '0.75rem', width: '100%' }}
        >
          Continue with Google
        </button>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Email
          <input
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            required
          />
        </label>
        <label>
          Password
          <input
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            minLength={8}
            required
          />
        </label>
        {displayError ? <div className="error">{displayError}</div> : null}
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Working...' : mode === 'login' ? 'Login' : 'Create account'}
        </button>
      </form>

      <div style={{ marginTop: '1rem', display: 'flex', gap: '.5rem' }}>
        <button
          className={mode === 'login' ? 'secondary' : 'ghost'}
          onClick={() => setMode('login')}
          type="button"
        >
          Login mode
        </button>
        <button
          className={mode === 'register' ? 'secondary' : 'ghost'}
          onClick={() => setMode('register')}
          type="button"
        >
          Register mode
        </button>
      </div>
    </section>
  );
}
