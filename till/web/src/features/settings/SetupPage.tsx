import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { ApiError, post } from '../../lib/api';
import { getTillConfig, saveTillConfig, testBranchServer, type TestResult } from '../../lib/tillServer';
import { setTerminalToken } from '../../lib/terminal';
import { useSession } from '../../store/session';
import { useT } from '../../store/lang';

type Enrolled = { token: string; terminal: { id: number; code: string; name: string } };
type Step = 'address' | 'code' | 'done';

/**
 * Set up a new till in one flow (docs/14 §7): 1 where the branch server is (tested before going on), 2 the admin's sign-in and the
 * one-time code from Settings → Tills, 3 done. The admin is signed in only for the moment it takes to trade the code for this
 * computer's device token, then signed out again, so nobody is left signed in as the admin on a till. No IP field of its own: the
 * address is the one the connection page already keeps on this PC. A page served by the branch server itself has no address to set.
 */
export function SetupPage() {
  const t = useT();
  const config = useQuery({ queryKey: ['till-config'], queryFn: getTillConfig, staleTime: 0, retry: false });
  const [step, setStep] = useState<Step | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const hasAddress = config.data !== null && config.data !== undefined;
  const shownStep: Step = step ?? (hasAddress ? 'address' : 'code');
  const addressValue = address ?? config.data?.branchServer ?? '';
  const stepNumber = hasAddress ? (shownStep === 'address' ? 1 : shownStep === 'code' ? 2 : 3) : shownStep === 'code' ? 1 : 2;
  const stepTotal = hasAddress ? 3 : 2;

  const reasonText: Record<string, string> = {
    REFUSED: t('The PC answered, but no branch server is running on that port.'),
    TIMEOUT: t('Nothing answered in time. Check the address and that the branch server PC is switched on.'),
    UNKNOWN_NAME: t('That server name is not known on this network. Try its number, like 192.168.1.10.'),
    HOST_NOT_ALLOWED: t(
      'The branch server is there but does not accept this address. Ask the person who set it up to add it to ALLOWED_HOSTS.',
    ),
    BAD_ANSWER: t('Something answered, but it is not a branch server.'),
    TILL_DOWN: t('The till program on this PC does not answer.'),
    NOT_CONFIGURED: t('No address is set yet.'),
  };

  async function test() {
    setBusy(true);
    setError('');
    setResult(await testBranchServer(addressValue.trim() || undefined));
    setBusy(false);
  }

  // Test first, then keep the address; only an answering branch server lets the person go on.
  async function next(e: FormEvent) {
    e.preventDefault();
    if (busy || !addressValue.trim()) return;
    setBusy(true);
    setError('');
    const tried = await testBranchServer(addressValue.trim());
    setResult(tried);
    if (tried.ok) {
      try {
        await saveTillConfig(addressValue);
        setStep('code');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('Could not save the address'));
      }
    }
    setBusy(false);
  }

  async function enrol(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const session = useSession.getState();
    try {
      await session.login(username.trim(), password);
      try {
        const done = await post<Enrolled>('/terminals/enrol', { code: code.trim() });
        setTerminalToken(done.token);
        setName(done.terminal.name);
        setPassword('');
        setStep('done');
      } finally {
        await session.logout().catch(() => undefined); // never leave the admin signed in on a till
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t('Only an admin can set up a till.'));
      else if (err instanceof ApiError && err.status === 0) setError(t('Cannot reach the branch server. Check the address and try again.'));
      else setError(err instanceof ApiError ? err.message : t('That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" data-testid="setup-page">
      <h1>
        <Icon name="till" size={26} />
        {t('Set up this computer as a till')}
      </h1>
      <p className="muted" data-testid="setup-step">
        {t('Step {n} of {total}', { n: String(stepNumber), total: String(stepTotal) })}
      </p>

      {config.isLoading ? (
        <p className="muted">{t('Loading…')}</p>
      ) : shownStep === 'address' ? (
        <form onSubmit={next} className="card" style={{ display: 'grid', gap: 12, padding: 16, maxWidth: 560 }}>
          <label className="field">
            {t('Address of the branch server')}
            <input
              value={addressValue}
              onChange={(e) => {
                setAddress(e.target.value);
                setResult(null);
              }}
              placeholder="192.168.1.10:3000"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              autoFocus
              data-testid="setup-address"
            />
            <span className="hint">
              {t('The branch server is the PC in the shop that keeps the sales. Use its address on the shop network, with the port.')}
            </span>
          </label>
          {result && (
            <div role="status" className={result.ok ? 'ok-text' : 'error-text'}>
              {result.ok
                ? t('Connected: the branch server answered in {ms} ms.', { ms: String(result.ms ?? 0) })
                : (reasonText[result.reason ?? ''] ?? result.detail ?? t('Cannot reach that address.'))}
            </div>
          )}
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
          <div className="toolbar" style={{ margin: 0 }}>
            <button type="button" className="btn" disabled={busy || !addressValue.trim()} onClick={() => void test()}>
              {t('Test connection')}
            </button>
            <button className="btn primary" type="submit" disabled={busy || !addressValue.trim()} data-testid="setup-next">
              {t('Next')}
            </button>
            <Link className="btn" to="/login">
              {t('Back to sign in')}
            </Link>
          </div>
        </form>
      ) : shownStep === 'code' ? (
        <form onSubmit={enrol} className="card" style={{ display: 'grid', gap: 12, padding: 16, maxWidth: 560 }}>
          <p style={{ margin: 0 }}>
            {t(
              'On a computer that already works, open Settings → Tills, add this till and copy its code. Then type the admin’s sign-in and the code here.',
            )}
          </p>
          <label className="field">
            {t('Username')}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              data-testid="setup-username"
            />
          </label>
          <label className="field">
            {t('Password')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              data-testid="setup-password"
            />
          </label>
          <label className="field">
            {t('Enrolment code')}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXXX-XXXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              dir="ltr"
              required
              data-testid="setup-code"
            />
          </label>
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          <div className="toolbar" style={{ margin: 0 }}>
            {hasAddress && (
              <button type="button" className="btn" disabled={busy} onClick={() => setStep('address')}>
                {t('Back')}
              </button>
            )}
            <button
              className="btn primary"
              type="submit"
              disabled={busy || !username.trim() || !password || !code.trim()}
              data-testid="setup-enrol"
            >
              {t('Set up this computer')}
            </button>
          </div>
        </form>
      ) : (
        <section className="card" style={{ display: 'grid', gap: 12, padding: 16, maxWidth: 560 }} data-testid="setup-done">
          <p style={{ margin: 0 }} className="ok-text">
            {t('This computer is now {name}', { name })}
          </p>
          <p style={{ margin: 0 }}>{t('It is ready. Sign in to start selling.')}</p>
          <div>
            <button className="btn primary" onClick={() => window.location.assign('/login')}>
              {t('Go to sign in')}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
