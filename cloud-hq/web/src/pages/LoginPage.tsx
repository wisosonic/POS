import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import type { Me } from '../lib/session';

type LoginAnswer = { token: string; user: { id: number; username: string; name: string; role: Me['role']; mustResetPassword: boolean } };

export function LoginPage({ onSignedIn }: { onSignedIn: (token: string, me: Me) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<LoginAnswer>('POST', '/auth/login', { username, password }, { auth: false });
      onSignedIn(r.token, {
        id: r.user.id,
        username: r.user.username,
        name: r.user.name,
        role: r.user.role,
        mustResetPassword: r.user.mustResetPassword,
      });
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1>HQ sign in</h1>
        <label className="field">
          Name
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={busy || username.trim() === '' || password === ''}>
          Sign in
        </button>
      </form>
    </main>
  );
}
