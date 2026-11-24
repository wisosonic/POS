import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { getTillConfig, saveTillConfig, testBranchServer, type TestResult } from '../../lib/tillServer';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';

/**
 * Where this till's branch server is. The address is kept by the till's own server on this PC, so this page also works when the
 * branch server cannot be reached (it is linked from the sign-in screen for that reason). Only meaningful when the app is served by
 * the till's own server; otherwise it says so.
 */
export function ConnectionPage() {
  const t = useT();
  // At /connection (outside the signed-in screens) there is no menu around the page, so it offers the way back itself.
  const standalone = useLocation().pathname === '/connection';
  const config = useQuery({ queryKey: ['till-config'], queryFn: getTillConfig, staleTime: 0, retry: false });
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Fill the box once, when the saved address arrives.
  const saved = config.data?.branchServer ?? '';
  useEffect(() => setAddress(saved), [saved]);

  async function test() {
    setBusy(true);
    setError('');
    setResult(await testBranchServer(address.trim() || undefined));
    setBusy(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const done = await saveTillConfig(address);
      toast.success(t('Saved. The till now uses {address}.', { address: done.branchServer ?? '' }));
      // Whatever the screens knew came from the old server: start again with the new one.
      window.setTimeout(() => window.location.assign('/'), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save the address'));
      setBusy(false);
    }
  }

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

  return (
    <main className="page">
      <h1>
        <Icon name="network" size={26} />
        {t('Branch server')}
      </h1>
      {config.isLoading ? (
        <p className="muted">{t('Loading…')}</p>
      ) : config.data === null || config.data === undefined ? (
        <section className="card" style={{ padding: 16 }}>
          <p style={{ margin: 0 }}>
            {t('This till is served by the branch server itself, so there is no branch server address to set here.')}
          </p>
        </section>
      ) : (
        <form onSubmit={save} className="card" style={{ display: 'grid', gap: 12, padding: 16, maxWidth: 560 }}>
          <label className="field">
            {t('Address of the branch server')}
            <input
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setResult(null);
              }}
              placeholder="192.168.1.10:3000"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              autoFocus
            />
            <span className="hint">
              {t('The branch server is the PC in the shop that keeps the sales. Use its address on the shop network, with the port.')}
            </span>
          </label>
          {config.data.source === 'environment' && (
            <p className="hint" style={{ margin: 0 }}>
              {t('This address came from the start-up settings of the till. Saving here keeps a new one on this PC.')}
            </p>
          )}
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
            <button type="button" className="btn" disabled={busy} onClick={() => void test()}>
              {t('Test connection')}
            </button>
            <button className="btn primary" type="submit" disabled={busy || !address.trim()}>
              {t('Save')}
            </button>
            {standalone && (
              <Link className="btn" to="/login">
                {t('Back to sign in')}
              </Link>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
