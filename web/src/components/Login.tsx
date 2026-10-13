import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { MeResponse } from '../../../shared/api-types.ts';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<MeResponse>('POST', '/login', { token: token.trim() });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unlock failed.');
    } finally {
      setBusy(false);
      setToken('');
    }
  };

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>English Voice Practice</h1>
        <p className="muted">Enter your access token to unlock this device.</p>
        <label>
          Access token
          <input
            type="password"
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="xxxxx-xxxxx-xxxxx-…"
            required
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
