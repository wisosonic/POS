import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { groupThousands, parseLbpInput } from '../../lib/money';
import type { RateRow } from '../../lib/types';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

const when = (iso: string) => `${iso.slice(0, 10)} ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
/** A new rate this far from the old one is more likely a typo (an extra zero) than a real move. */
const SUSPICIOUS = 0.1;

/** How many lira one dollar is worth today. Every sale made from now on uses it; sales already made keep theirs forever. */
export function RatePage() {
  const queryClient = useQueryClient();
  const history = useQuery({ queryKey: ['rates'], queryFn: () => get<{ data: RateRow[] }>('/exchange-rates').then((r) => r.data) });
  const [value, setValue] = useState('');
  const [later, setLater] = useState(false);
  const [start, setStart] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const now = Date.now();
  const rows = history.data ?? [];
  // The rate in force is the newest one that has already started.
  const current = rows.find((r) => Date.parse(r.effectiveFrom) <= now);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const rate = parseLbpInput(value);
    if (!(rate >= 1)) return setError('Type how many lira one dollar is worth, for example 90,000');
    if (later && !start) return setError('Choose when the new rate starts');
    if (current && Math.abs(rate - current.rateLbpPerUsd) / current.rateLbpPerUsd > SUSPICIOUS) {
      const ok = window.confirm(
        `This changes the rate from ${groupThousands(current.rateLbpPerUsd)} to ${groupThousands(rate)}, more than ${SUSPICIOUS * 100}%. Is that right?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/exchange-rates', { rateLbpPerUsd: rate, ...(later ? { effectiveFrom: new Date(start).toISOString() } : {}) });
      toast.success(later ? 'The new rate is saved and starts at the time you chose' : `1$ = ${groupThousands(rate)} LL from now on`);
      setValue('');
      setLater(false);
      setStart('');
      await Promise.all(['rates', 'rate'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The rate could not be saved');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>
        <Icon name="rate" size={26} />
        Exchange rate
      </h1>
      <div className="card stat" style={{ maxWidth: 420 }}>
        <div className="muted">Right now</div>
        <div className="big-number num" data-testid="current-rate">
          {current ? `1$ = ${groupThousands(current.rateLbpPerUsd)} LL` : '…'}
        </div>
        {current && <div className="muted">{`Since ${when(current.effectiveFrom)}`}</div>}
      </div>

      <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 420, marginBlock: 16 }}>
        <label className="field">
          New rate (LL for one dollar)
          <input className="num" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          <span className="hint">Every sale from now on uses this. Sales already made keep the rate they were made at.</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} style={{ width: 20, height: 20 }} />
          Start it later
        </label>
        {later && (
          <label className="field">
            Starts at
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
        )}
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div>
          <button type="submit" className="btn primary big" disabled={busy}>
            Set the rate
          </button>
        </div>
      </form>

      <h2>Earlier rates</h2>
      {history.isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th className="num">1$ =</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 30).map((r) => (
              <tr key={r.id} data-testid="rate-row">
                <td className="muted">{when(r.effectiveFrom)}</td>
                <td className="num">{`${groupThousands(r.rateLbpPerUsd)} LL`}</td>
                <td className="muted">{Date.parse(r.effectiveFrom) > now ? 'Not in force yet' : r.id === current?.id ? 'In force' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
