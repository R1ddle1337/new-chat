'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'login' | 'register';
type AuthMethodProvider = { code: string; name: string };
type AuthMethodsResponse = {
  password_login_enabled?: boolean;
  password_register_enabled?: boolean;
  oauth_providers?: Array<{ code?: string; name?: string }>;
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methodsLoading, setMethodsLoading] = useState(true);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(false);
  const [passwordRegisterEnabled, setPasswordRegisterEnabled] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<AuthMethodProvider[]>([]);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const displayError = error ?? methodsError ?? (oauthError ? oauthError.replace(/_/g, ' ') : null);
  const hasAnyOauthProvider = oauthProviders.length > 0;
  const showPasswordForm = mode === 'login' ? passwordLoginEnabled : passwordRegisterEnabled;
  const showModeToggleButtons = passwordLoginEnabled && passwordRegisterEnabled;
  const hasAnyMethod = passwordLoginEnabled || passwordRegisterEnabled || hasAnyOauthProvider;

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

    const loadMethods = async () => {
      try {
        const response = await fetch('/api/auth/methods', { credentials: 'include' });
        if (!response.ok) {
          throw new Error('Unable to load available sign-in methods');
        }

        const payload = (await response.json().catch(() => null)) as AuthMethodsResponse | null;
        const passwordLogin = payload?.password_login_enabled === true;
        const passwordRegister = payload?.password_register_enabled === true;
        const providers = (Array.isArray(payload?.oauth_providers) ? payload.oauth_providers : [])
          .map((provider) => {
            const code = typeof provider?.code === 'string' ? provider.code.trim().toLowerCase() : '';
            const name = typeof provider?.name === 'string' ? provider.name.trim() : '';
            if (!code || !name) {
              return null;
            }
            return { code, name };
          })
          .filter((provider): provider is AuthMethodProvider => provider !== null);

        if (!cancelled) {
          setPasswordLoginEnabled(passwordLogin);
          setPasswordRegisterEnabled(passwordRegister);
          setOauthProviders(providers);
          setMethodsError(null);
          if (!passwordLogin && passwordRegister) {
            setMode('register');
          } else if (passwordLogin) {
            setMode('login');
          }
        }
      } catch {
        if (!cancelled) {
          setPasswordLoginEnabled(false);
          setPasswordRegisterEnabled(false);
          setOauthProviders([]);
          setMethodsError('Unable to load available sign-in methods. Please try again.');
        }
      } finally {
        if (!cancelled) {
          setMethodsLoading(false);
        }
      }
    };

    void loadMethods();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const queryParams = new URLSearchParams(window.location.search);
    setOauthError(queryParams.get('error'));
  }, []);

  const submit = async () => {
    if (!showPasswordForm) {
      setError('Password sign-in is not available');
      return;
    }

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
      {methodsLoading ? <p className="notice">Loading sign-in methods...</p> : null}

      {hasAnyOauthProvider ? (
        <div style={{ display: 'grid', gap: '0.5rem', marginBottom: showPasswordForm ? '0.75rem' : 0 }}>
          {oauthProviders.map((provider) => (
            <button
              key={provider.code}
              className="secondary"
              type="button"
              onClick={() => {
                window.location.assign(`/api/auth/oauth/${provider.code}/start`);
              }}
              style={{ width: '100%' }}
            >
              {provider.code === 'google' ? 'Continue with Google' : `Continue with ${provider.name}`}
            </button>
          ))}
        </div>
      ) : null}

      {showPasswordForm ? (
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
      ) : null}

      {!showPasswordForm && displayError ? <div className="error">{displayError}</div> : null}
      {!hasAnyMethod && !methodsLoading ? (
        <div className="error">No authentication methods are currently available.</div>
      ) : null}

      {showModeToggleButtons ? (
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
      ) : null}
    </section>
  );
}
