import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import { fmtMoney, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, WalletCount, WalletEntry, WalletState } from '../../lib/types';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';

const keyOf = (w: { method: string; currency: Currency }) => `${w.method}/${w.currency}`;
const when = (iso: string) => `${iso.slice(0, 10)} ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
const signed = (n: number, c: Currency) => `${n > 0 ? '+' : ''}${fmtMoney(n, c)}`;
const parseAmount = (text: string, c: Currency) => (c === 'USD' ? parseUsdInput(text) : parseLbpInput(text));

const KIND: Record<WalletEntry['kind'], string> = {
  sale: 'Sale',
  customer_payment: 'Customer payment',
  refund: 'Refund',
  movement: 'Movement',
  correction: 'Correction',
};

/**
 * The branch's wallets (Whish, OMT): what the system expects each to hold, when a manager last counted it, and every sale, refund and
 * movement that changed it. One balance for the whole branch, whichever till took the payment (docs/13). Counting is never required.
 */
export function WalletsPage() {
  const t = useT();
  const [counting, setCounting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [tab, setTab] = useState<'ledger' | 'counts'>('ledger');
  const state = useQuery({ queryKey: ['wallets'], queryFn: () => get<{ data: WalletState[] }>('/wallets').then((r) => r.data) });
  const wallets = state.data ?? [];

  return (
    <main className="page">
      <h1>
        <Icon name="wallet" size={26} />
        {t('Wallets')}
      </h1>
      <div className="toolbar">
        <p className="muted" style={{ margin: 0 }}>
          {t('Whish and OMT belong to the whole branch, not to one till. Count them whenever you like: a count is never required.')}
        </p>
        <span className="spacer" />
        <button className="btn" onClick={() => setMoving(true)} disabled={wallets.length === 0}>
          {t('Record a movement')}
        </button>
        <button className="btn primary" onClick={() => setCounting(true)} disabled={wallets.length === 0}>
          {t('Count the wallets')}
        </button>
      </div>

      {state.isLoading ? (
        <p className="muted">{t('Loading…')}</p>
      ) : state.isError ? (
        <div className="warning" role="alert">
          {t('The wallets could not be loaded.')}
        </div>
      ) : wallets.length === 0 ? (
        <div className="card empty">{t('This branch has no wallet.')}</div>
      ) : (
        <table aria-label={t('Wallet balances')}>
          <thead>
            <tr>
              <th>{t('Wallet')}</th>
              <th className="num">{t('Should be')}</th>
              <th className="num">{t('Last counted')}</th>
              <th>{t('Counted by')}</th>
              <th className="num">{t('Difference then')}</th>
              <th className="num">{t('Moved since')}</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => {
              const diff = w.lastCount?.variance ?? null;
              return (
                <tr key={keyOf(w)} data-testid={`wallet-${keyOf(w)}`}>
                  <td>{`${w.methodName} ${w.currency}`}</td>
                  <td className="num" data-testid={`wallet-expected-${keyOf(w)}`}>
                    {fmtMoney(w.expected, w.currency)}
                  </td>
                  <td className="num">{w.lastCount ? fmtMoney(w.lastCount.counted, w.currency) : t('Never counted')}</td>
                  <td className="muted">{w.lastCount ? `${w.lastCount.countedByName ?? ''} · ${when(w.lastCount.countedAt)}` : ''}</td>
                  <td className={`num ${diff === null ? '' : diff === 0 ? 'variance-ok' : 'variance-bad'}`}>
                    {diff === null ? '' : diff === 0 ? t('OK') : signed(diff, w.currency)}
                  </td>
                  <td className="num muted">{`${signed(w.inSince, w.currency)} / ${signed(-w.outSince, w.currency)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="tabs" role="tablist" aria-label={t('History')} style={{ marginTop: 18 }}>
        <button type="button" role="tab" aria-selected={tab === 'ledger'} onClick={() => setTab('ledger')}>
          {t('Ledger')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'counts'} onClick={() => setTab('counts')}>
          {t('Counts')}
        </button>
      </div>
      {tab === 'ledger' ? <Ledger /> : <Counts />}

      {counting && <CountDialog wallets={wallets} onClose={() => setCounting(false)} />}
      {moving && <MovementDialog wallets={wallets} onClose={() => setMoving(false)} />}
    </main>
  );
}

/** Pages of a newest-first list, with a button for the next page. */
function usePaged<T>(key: string, path: string) {
  return useInfiniteQuery({
    queryKey: ['wallets', key],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<{ data: T[]; nextCursor: number | null }>(`${path}?limit=30${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function Ledger() {
  const t = useT();
  const q = usePaged<WalletEntry>('entries', '/wallets/entries');
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  if (q.isLoading) return <p className="muted">{t('Loading…')}</p>;
  if (rows.length === 0) return <div className="card empty">{t('Nothing has moved in a wallet yet.')}</div>;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>{t('When')}</th>
            <th>{t('Wallet')}</th>
            <th>{t('What')}</th>
            <th>{t('Reason')}</th>
            <th>{t('By')}</th>
            <th className="num">{t('Amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} data-testid="wallet-entry">
              <td className="muted">{when(e.createdAt)}</td>
              <td>{`${e.method.toUpperCase()} ${e.currency}`}</td>
              <td>{t(KIND[e.kind])}</td>
              <td>{e.reason ?? (e.refType && e.refId ? `${e.refType} #${e.refId}` : '')}</td>
              <td className="muted">{e.userName ?? ''}</td>
              <td className="num">{signed(e.amount, e.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {t('Show older')}
        </button>
      )}
    </>
  );
}

function Counts() {
  const t = useT();
  const q = usePaged<WalletCount>('counts', '/wallets/counts');
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  if (q.isLoading) return <p className="muted">{t('Loading…')}</p>;
  if (rows.length === 0) return <div className="card empty">{t('No wallet has been counted yet.')}</div>;
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>{t('When')}</th>
            <th>{t('Wallet')}</th>
            <th className="num">{t('Should have been')}</th>
            <th className="num">{t('Counted')}</th>
            <th className="num">{t('Difference')}</th>
            <th>{t('By')}</th>
            <th>{t('Note')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} data-testid="wallet-count">
              <td className="muted">{when(c.countedAt)}</td>
              <td>{`${c.method.toUpperCase()} ${c.currency}`}</td>
              <td className="num">{c.expected === null ? t('First count') : fmtMoney(c.expected, c.currency)}</td>
              <td className="num">{fmtMoney(c.counted, c.currency)}</td>
              <td className={`num ${c.variance === null ? '' : c.variance === 0 ? 'variance-ok' : 'variance-bad'}`}>
                {c.variance === null ? '' : c.variance === 0 ? t('OK') : signed(c.variance, c.currency)}
              </td>
              <td className="muted">{c.countedByName ?? ''}</td>
              <td>{c.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {t('Show older')}
        </button>
      )}
    </>
  );
}

const refresh = (queryClient: ReturnType<typeof useQueryClient>) => queryClient.invalidateQueries({ queryKey: ['wallets'] });

/** Type what each wallet account really holds. Every wallet is counted at once, like a register; type 0 if it is empty. */
function CountDialog({ wallets, onClose }: { wallets: WalletState[]; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const balances = [];
    for (const w of wallets) {
      const text = amounts[keyOf(w)] ?? '';
      if (text.trim() === '') return setError(t('Count {name} (type 0 if it is empty)', { name: `${w.methodName} ${w.currency}` }));
      const amount = parseAmount(text, w.currency);
      if (Number.isNaN(amount)) return setError(t('Check the amount in {name}', { name: `${w.methodName} ${w.currency}` }));
      balances.push({ method: w.method, currency: w.currency, amount });
    }
    setBusy(true);
    setError('');
    try {
      const done = await post<{ variances: Record<string, number> }>('/wallets/counts', {
        purpose: 'check',
        ...(note.trim() ? { note: note.trim() } : {}),
        balances,
      });
      const out = Object.keys(done.variances).length;
      toast.success(out ? t('Counted: {n} out', { n: out }) : t('Counted'));
      await refresh(queryClient);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('That could not be recorded'));
      setBusy(false);
    }
  }

  return (
    <Modal label={t('Count the wallets')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{t('Count the wallets')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t('Open each wallet account and type the balance it shows now.')}
        </p>
        {wallets.map((w, i) => (
          <label key={keyOf(w)} className="field">
            {`${w.methodName} ${w.currency}`}
            <input
              className="num"
              inputMode="decimal"
              autoComplete="off"
              autoFocus={i === 0}
              placeholder={w.currency === 'USD' ? '0.00' : '0'}
              value={amounts[keyOf(w)] ?? ''}
              onChange={(e) => setAmounts((a) => ({ ...a, [keyOf(w)]: e.target.value }))}
            />
          </label>
        ))}
        <label className="field">
          {t('Note (optional)')}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            {t('Record the count')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A change to a wallet that no till caused: a top-up from the bank, a fee the provider took. A reason is required. */
function MovementDialog({ wallets, onClose }: { wallets: WalletState[]; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [which, setWhich] = useState(keyOf(wallets[0]!));
  const [type, setType] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const wallet = wallets.find((w) => keyOf(w) === which)!;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseAmount(amount, wallet.currency);
    if (!(value > 0)) return setError(t('Enter the amount'));
    if (!reason.trim()) return setError(t('Say why the money moved'));
    setBusy(true);
    setError('');
    try {
      await post('/wallets/movements', {
        bucket: { method: wallet.method, currency: wallet.currency },
        type,
        amount: value,
        reason: reason.trim(),
      });
      toast.success(t('Recorded'));
      await refresh(queryClient);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('That could not be recorded'));
      setBusy(false);
    }
  }

  return (
    <Modal label={t('Record a movement')} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{t('Record a movement')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            'For money that reached or left a wallet without a sale: a top-up from the bank, or a fee the provider took. To move cash between a till and a wallet, use Cash in and out.',
          )}
        </p>
        <div className="tabs" role="tablist" aria-label={t('Kind of movement')}>
          {(
            [
              ['in', 'Money in'],
              ['out', 'Money out'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={type === k} onClick={() => setType(k)}>
              {t(label)}
            </button>
          ))}
        </div>
        <div className="method">
          <label className="field">
            {t('Wallet')}
            <select value={which} onChange={(e) => setWhich(e.target.value)}>
              {wallets.map((w) => (
                <option key={keyOf(w)} value={keyOf(w)}>
                  {`${w.methodName} ${w.currency}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('Amount ({currency})', { currency: wallet.currency })}
            <input
              className="num"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </label>
        </div>
        <label className="field">
          {t('Reason')}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            {t('Record')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
