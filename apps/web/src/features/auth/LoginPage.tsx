import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { useSession } from '../../store/session';

export function LoginPage() {
  const status = useSession((s) => s.status);
  const login = useSession((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'LOCKED') setError(err.message);
      else if (err instanceof ApiError && err.isNetwork) setError('Cannot reach the server. Check that it is running.');
      else setError('Wrong username or password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="login-badge" aria-hidden="true">
          <Icon name="till" size={30} />
        </div>
        <h1>Sign in</h1>
        <label className="field">
          Username
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary big" type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}
