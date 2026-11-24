import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import { fmtMoney, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, Method } from '../../lib/types';
import { toast } from '../../store/toast';
import { useLookup } from '../products/lookups';
import { Icon } from '../../components/Icon';

type Service = {
  id: number;
  reference: string;
  categoryName: string | null;
  customerName: string | null;
  note: string | null;
  costMinor: number;
  feeMinor: number;
  profitMinor: number;
  currency: Currency;
  receivedAtTill: boolean;
  createdAt: string;
};
type Totals = Record<Currency, { fee: number; cost: number; profit: number }>;
type Page = { data: Service[]; totals: Totals; nextCursor: number | null };

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/** What the shop earns that is not a product (IT support, a repair): what it cost, what the customer paid, and where the money went. */
export function ServicesPage() {
  const [categoryId, setCategoryId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [adding, setAdding] = useState(false);
  const types = useLookup('service-categories');

  const services = useInfiniteQuery({
    queryKey: ['services', categoryId, from, to],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (categoryId) q.set('categoryId', categoryId);
      if (from) q.set('from', dayStart(from));
      if (to) q.set('to', dayEnd(to));
      if (pageParam) q.set('cursor', String(pageParam));
      return get<Page>(`/services?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = services.data?.pages.flatMap((p) => p.data) ?? [];
  const totals = services.data?.pages[0]?.totals;

  return (
    <main className="page">
      <h1>
        <Icon name="services" size={26} />
        Services
      </h1>
      <div className="toolbar">
        <label className="field">
          Type
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All types</option>
            {(types.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {totals && (
          <span className="chip" data-testid="service-total">
            {`Earned ${fmtMoney(totals.LBP.fee, 'LBP')} + ${fmtMoney(totals.USD.fee, 'USD')} · profit ${fmtMoney(totals.LBP.profit, 'LBP')} + ${fmtMoney(totals.USD.profit, 'USD')}`}
          </span>
        )}
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          New service
        </button>
      </div>

      {services.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">No services recorded.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Ref</th>
              <th>What</th>
              <th>Paid</th>
              <th className="num">Cost</th>
              <th className="num">Customer paid</th>
              <th className="num">Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} data-testid="service-row">
                <td className="muted">{s.createdAt.slice(0, 10)}</td>
                <td>{s.reference}</td>
                <td>
                  {s.categoryName ?? 'Service'}
                  {s.note && <span className="muted">{` · ${s.note}`}</span>}
                  {s.customerName && <span className="muted">{` · ${s.customerName}`}</span>}
                </td>
                <td className="muted">{s.receivedAtTill ? 'At the till' : 'Elsewhere'}</td>
                <td className="num">{fmtMoney(s.costMinor, s.currency)}</td>
                <td className="num">{fmtMoney(s.feeMinor, s.currency)}</td>
                <td className={`num ${s.profitMinor < 0 ? 'variance-bad' : ''}`}>{fmtMoney(s.profitMinor, s.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {services.hasNextPage && (
        <p>
          <button className="btn" disabled={services.isFetchingNextPage} onClick={() => void services.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
      {adding && <ServiceDialog onClose={() => setAdding(false)} />}
    </main>
  );
}

const WHERE: { value: '' | Method; label: string }[] = [
  { value: '', label: 'Not at the till (paid elsewhere)' },
  { value: 'cash', label: 'Cash drawer' },
  { value: 'whish', label: 'Whish wallet' },
  { value: 'omt', label: 'OMT wallet' },
];

function ServiceDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const types = useLookup('service-categories');
  const [categoryId, setCategoryId] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [cost, setCost] = useState('');
  const [fee, setFee] = useState('');
  const [into, setInto] = useState<'' | Method>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per service: pressing the button twice, or retrying after a hiccup, can never record it twice.
  const [key] = useState(() => crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parse = currency === 'USD' ? parseUsdInput : parseLbpInput;
    const feeMinor = parse(fee);
    const costMinor = cost.trim() === '' ? 0 : parse(cost);
    if (!(feeMinor > 0)) return setError('Enter what the customer paid');
    if (!(costMinor >= 0)) return setError('The cost is not a valid amount');
    setBusy(true);
    setError('');
    try {
      await post(
        '/services',
        {
          categoryId: categoryId ? Number(categoryId) : null,
          currency,
          costMinor,
          feeMinor,
          note: note.trim() || null,
          ...(into ? { receivedInto: { method: into } } : {}),
        },
        { idempotencyKey: key },
      );
      toast.success('Service recorded');
      await Promise.all(['services', 'register', 'cash-movements'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The service could not be recorded');
      setBusy(false);
    }
  }

  return (
    <Modal label="New service" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>New service</h2>
        <div className="method">
          <label className="field">
            Type
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} autoFocus>
              <option value="">No type</option>
              {(types.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="USD">USD (dollars)</option>
              <option value="LBP">LBP (lira)</option>
            </select>
          </label>
          <label className="field">
            {`What the customer paid (${currency})`}
            <input className="num" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            {`What it cost you (${currency})`}
            <input
              className="num"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="0"
              autoComplete="off"
            />
          </label>
        </div>
        <label className="field">
          Money received
          <select value={into} onChange={(e) => setInto(e.target.value as '' | Method)}>
            {WHERE.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {into && (
          <p className="muted" style={{ margin: 0 }}>
            {`The ${currency} balance of this ${into === 'cash' ? 'drawer' : 'wallet'} goes up by what the customer paid, so tonight's count still agrees. The register must be open.`}
          </p>
        )}
        <label className="field">
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, for whom" autoComplete="off" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            Save service
          </button>
        </div>
      </form>
    </Modal>
  );
}
