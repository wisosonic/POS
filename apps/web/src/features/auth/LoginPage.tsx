import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { tNow, useT } from '../../store/lang';
import { useSession } from '../../store/session';

export function LoginPage() {
  const t = useT();
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
      else if (err instanceof ApiError && err.isNetwork) setError(tNow('Cannot reach the server. Check that it is running.'));
      else setError(tNow('Wrong username or password.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-lang">
        <LanguageSwitch />
      </div>
      <form onSubmit={submit}>
        <div className="login-badge" aria-hidden="true">
          <Icon name="till" size={30} />
        </div>
        <h1>{t('Sign in')}</h1>
        <label className="field">
          {t('Username')}
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          {t('Password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary big" type="submit" disabled={busy}>
          {t('Sign in')}
        </button>
      </form>
    </main>
  );
}
