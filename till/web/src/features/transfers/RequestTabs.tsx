import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError, get, post } from '../../lib/api';
import type { Product } from '../../lib/types';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';
import { ProductPicker } from './ProductPicker';

// Requests and pick lists (docs/15 §5, P5c). A shop's manager asks for items and follows each line; a stock branch's manager fills the pick list HQ sent it.

type Line = { productId: number; name: string; qty: string };
type RequestItem = {
  productId: number;
  name: string;
  wanted: string;
  shipped: string;
  unavailable: string;
  status: 'waiting' | 'picking' | 'done';
};
type StockRequest = { id: number; note: string | null; createdAt: string; status: 'routing' | 'open' | 'closed'; items: RequestItem[] };
type PickList = {
  id: number;
  forBranch: string;
  requestId: number;
  note: string | null;
  openedAt: string;
  status: 'open' | 'answered';
  items: { productId: number; name: string; asked: string; onHand: string; shipped: string | null }[];
};

const day = (iso: string) => iso.slice(0, 10);
const reasonText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const num = (v: string) => Number(v);

// ------------------------------------------------------------------ a shop asks

export function RequestsTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['stock-requests'],
    queryFn: () => get<{ data: StockRequest[] }>('/stock-requests?limit=30').then((r) => r.data),
  });

  function add(p: Product) {
    setLines((cur) => (cur.some((l) => l.productId === p.id) ? cur : [...cur, { productId: p.id, name: p.name.trim(), qty: '1' }]));
  }

  async function ask() {
    if (lines.length === 0) return setError(t('Add at least one product'));
    if (lines.some((l) => !/^\d+(\.\d{1,3})?$/.test(l.qty.trim()) || Number(l.qty) <= 0))
      return setError(t('Each quantity must be a number above zero'));
    setBusy(true);
    setError('');
    try {
      await post(
        '/stock-requests',
        { note: note.trim() || undefined, items: lines.map((l) => ({ productId: l.productId, qty: l.qty.trim() })) },
        { idempotencyKey: key.current },
      );
      toast.success(t('Requested. HQ will ask the stock branches for it.'));
      key.current = crypto.randomUUID(); // the next request is a new one
      setLines([]);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['stock-requests'] });
    } catch (e) {
      setError(reasonText(e, t('That could not be requested.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="card" style={{ display: 'grid', gap: 12, maxWidth: 720 }} data-testid="new-request">
        <h2 style={{ margin: 0 }}>{t('Ask for stock')}</h2>
        <ProductPicker onPick={add} />
        {lines.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('Product')}</th>
                <th className="num">{t('Quantity')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.productId} data-testid="request-line">
                  <td>{l.name}</td>
                  <td className="num">
                    <input
                      inputMode="decimal"
                      aria-label={t('Quantity of {name}', { name: l.name })}
                      value={l.qty}
                      onChange={(e) => setLines(lines.map((x) => (x.productId === l.productId ? { ...x, qty: e.target.value } : x)))}
                      style={{ width: 90, textAlign: 'end' }}
                    />
                  </td>
                  <td>
                    <button
                      className="btn small"
                      aria-label={t('Remove {name}', { name: l.name })}
                      onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label className="field">
          {t('Note (optional)')}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </label>
        {error && (
          <div className="banner warn" role="alert">
            {error}
          </div>
        )}
        <div>
          <button className="btn primary big" onClick={() => void ask()} disabled={busy}>
            {t('Ask')}
          </button>
        </div>
      </section>

      <section>
        <h2>{t('Your requests')}</h2>
        {(list.data ?? []).length === 0 ? (
          <div className="card empty">{t('No requests yet.')}</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {(list.data ?? []).map((r) => (
              <article key={r.id} className="card" data-testid="request">
                <div className="toolbar">
                  <strong>{t('Request {n}', { n: r.id })}</strong>
                  <span className={`chip ${r.status === 'closed' ? 'ok' : 'warn'}`}>
                    {r.status === 'closed' ? t('Done') : r.status === 'open' ? t('Being filled') : t('HQ is placing it')}
                  </span>
                  <span className="muted">{day(r.createdAt)}</span>
                </div>
                {r.note && <p className="muted">{r.note}</p>}
                <table>
                  <thead>
                    <tr>
                      <th>{t('Product')}</th>
                      <th className="num">{t('Asked')}</th>
                      <th className="num">{t('Shipped')}</th>
                      <th>{t('Where it stands')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((i) => (
                      <tr key={i.productId} data-testid="request-progress">
                        <td>{i.name.trim()}</td>
                        <td className="num">{i.wanted}</td>
                        <td className="num">{i.shipped}</td>
                        <td>
                          {i.status !== 'done'
                            ? i.status === 'picking'
                              ? t('A stock branch is picking it')
                              : t('Waiting for a stock branch')
                            : num(i.unavailable) > 0
                              ? t('{n} not available', { n: i.unavailable })
                              : t('Shipped')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ a stock branch picks

export function PickTab() {
  const t = useT();
  const lists = useQuery({
    queryKey: ['pick-lists'],
    queryFn: () => get<{ data: PickList[] }>('/pick-lists?status=open').then((r) => r.data),
  });
  const rows = lists.data ?? [];
  if (lists.isLoading) return <p className="muted">{t('Loading…')}</p>;
  if (rows.length === 0) return <div className="card empty">{t('Nothing to pick right now.')}</div>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {rows.map((l) => (
        <PickCard key={l.id} list={l} />
      ))}
    </div>
  );
}

/** Ship what is there. Each line starts at what is asked, or what is on the shelves if that is less; a line shipped short goes to the next stock branch. */
function PickCard({ list }: { list: PickList }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const start = (i: PickList['items'][number]) => String(Math.max(0, Math.min(num(i.asked), num(i.onHand))));
  const [shipped, setShipped] = useState<Record<number, string>>(Object.fromEntries(list.items.map((i) => [i.productId, start(i)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const short = list.items.filter((i) => num(shipped[i.productId] ?? '0') < num(i.asked));

  async function ship() {
    const bad = list.items.find(
      (i) => !/^\d+(\.\d{1,3})?$/.test((shipped[i.productId] ?? '').trim()) || num(shipped[i.productId]!) > num(i.asked),
    );
    if (bad) return setError(t('Each quantity is a number from zero up to what was asked'));
    setBusy(true);
    setError('');
    try {
      await post(
        `/pick-lists/${list.id}/fill`,
        { items: list.items.map((i) => ({ productId: i.productId, shipped: shipped[i.productId]!.trim() })) },
        { idempotencyKey: key.current },
      );
      toast.success(t('Done. What was shipped has left this branch.'));
      await Promise.all(
        ['pick-lists', 'alerts', 'products', 'stock', 'shipments'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
    } catch (e) {
      setError(reasonText(e, t('That could not be saved.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="pick-list">
      <div className="toolbar">
        <strong>{t('For {name}', { name: list.forBranch })}</strong>
        <span className="muted">{day(list.openedAt)}</span>
      </div>
      {list.note && <p className="muted">{list.note}</p>}
      <table>
        <thead>
          <tr>
            <th>{t('Product')}</th>
            <th className="num">{t('Asked')}</th>
            <th className="num">{t('On the shelves')}</th>
            <th className="num">{t('Ship')}</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((i) => (
            <tr key={i.productId} data-testid="pick-line">
              <td>{i.name.trim()}</td>
              <td className="num">{i.asked}</td>
              <td className="num">{i.onHand}</td>
              <td className="num">
                <input
                  inputMode="decimal"
                  aria-label={t('Ship: {name}', { name: i.name.trim() })}
                  value={shipped[i.productId] ?? ''}
                  onChange={(e) => setShipped({ ...shipped, [i.productId]: e.target.value })}
                  style={{ width: 90, textAlign: 'end' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {short.length > 0 && <p className="muted">{t('What is shipped short goes to the next stock branch.')}</p>}
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn primary big" onClick={() => void ship()} disabled={busy}>
          {t('Ship it')}
        </button>
      </div>
    </section>
  );
}
