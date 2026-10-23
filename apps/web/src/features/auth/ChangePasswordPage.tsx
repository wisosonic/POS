import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, post, setAccessToken } from '../../lib/api';
import type { User } from '../../lib/types';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';

/**
 * Choose your own password. Shown on its own, before anything else, when the admin has given someone a first password
 * (`forced`), and from the menu for anyone who wants to change theirs. Changing it ends their other sessions.
 */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setError('The new password needs at least 8 characters');
    if (next !== again) return setError('The two new passwords are not the same');
    if (next === current) return setError('The new password must be different from the old one');
    setBusy(true);
    setError('');
    try {
      const res = await post<{ accessToken: string; user: User }>('/auth/change-password', { currentPassword: current, newPassword: next });
      setAccessToken(res.accessToken);
      useSession.setState({ user: res.user });
      toast.success('Your password is changed');
      if (!forced) navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The password could not be changed');
      setBusy(false);
    }
  }

  return (
    <main className={forced ? 'login' : 'page'}>
      <form onSubmit={submit} style={forced ? undefined : { display: 'grid', gap: 14, maxWidth: 420 }}>
        <h1>{forced ? 'Choose your password' : 'Change my password'}</h1>
        {forced && (
          <p className="muted" style={{ margin: 0 }}>
            {`${user?.name ?? 'Welcome'}, the admin gave you a first password. Choose your own before you start.`}
          </p>
        )}
        <label className="field">
          {forced ? 'The password the admin gave you' : 'Current password'}
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label className="field">
          New password (at least 8 characters)
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label className="field">
          New password again
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary big" type="submit" disabled={busy}>
          Save my password
        </button>
        {forced && (
          <button className="btn" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </form>
    </main>
  );
}
