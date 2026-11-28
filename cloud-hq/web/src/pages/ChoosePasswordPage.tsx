import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import type { Me } from '../lib/session';

type Answer = { token: string; user: { id: number; username: string; name: string; role: Me['role']; mustResetPassword: boolean } };

/** A new account has a password someone else chose: the person picks their own (at least 12 characters) before doing anything else. */
export function ChoosePasswordPage({ me, onDone, onCancel }: { me: Me; onDone: (token: string, me: Me) => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError('The two new passwords are different.');
    if (next.length < 12) return setError('Use at least 12 characters.');
    setBusy(true);
    setError('');
    try {
      const r = await api<Answer>('POST', '/auth/password', { current, password: next });
      onDone(r.token, { id: r.user.id, username: r.user.username, name: r.user.name, role: r.user.role, mustResetPassword: false });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The password could not be changed.');
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1>Choose your own password</h1>
        <p className="muted">Hello, {me.name}. The password you were given is temporary. Choose one only you know.</p>
        <label className="field">
          The password you were given
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
        <label className="field">
          New password (at least 12 characters)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="field">
          New password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </label>
        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button className="btn" type="button" onClick={onCancel}>
            Sign out
          </button>
          <button className="btn primary" type="submit" disabled={busy || current === '' || next === ''}>
            Save password
          </button>
        </div>
      </form>
    </main>
  );
}
