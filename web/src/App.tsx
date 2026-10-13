import { useEffect, useState } from 'react';
import { api } from './api/client.ts';
import { Login } from './components/Login.tsx';
import { Practice } from './Practice.tsx';
import type { MeResponse } from '../../shared/api-types.ts';

export function App() {
  const [auth, setAuth] = useState<'loading' | 'in' | 'out' | 'offline'>('loading');

  useEffect(() => {
    api<MeResponse>('GET', '/me')
      .then((me) => setAuth(me.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('offline'));
  }, []);

  if (auth === 'loading') return <main className="center-screen muted">Loading…</main>;
  if (auth === 'offline')
    return (
      <main className="center-screen">
        <p>Cannot reach the server. Check your internet connection.</p>
        <button type="button" className="btn primary" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    );
  if (auth === 'out') return <Login onLoggedIn={() => setAuth('in')} />;
  return <Practice onLoggedOut={() => setAuth('out')} />;
}
