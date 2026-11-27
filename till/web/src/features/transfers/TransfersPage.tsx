import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import type { Product } from '../../lib/types';
import { useT } from '../../store/lang';
import { useSettings } from '../../hooks/useTillData';
import { PickTab, RequestsTab } from './RequestTabs';
import { ProductPicker } from './ProductPicker';
import { toast } from '../../store/toast';

// Moving stock between branches (docs/15 §4, P5b). A manager confirms what HQ says is on its way, sends stock to another branch, and looks back.

type Reason = 'supply' | 'rebalance' | 'return';
type Incoming = {
  id: number;
  fromBranch: string;
  reason: Reason;
  note: string | null;
  shippedAt: string;
  status: 'on_the_way' | 'received';
  receivedAt: string | null;
  items: { productId: number; name: string; qty: string; counted: string | null; reason: string | null }[];
};
type Shipment = {
  id: number;
  toBranch: string;
  reason: Reason;
  note: string | null;
  createdAt: string;
  items: { productId: number; name: string; qty: string }[];
};
type Destinations = {
  connected: boolean;
  kind: 'sale' | 'stock';
  data: { id: number; code: string; name: string; kind: 'sale' | 'stock'; allowed: boolean }[];
};

const day = (iso: string) => iso.slice(0, 10);
const reasonLabel = (t: ReturnType<typeof useT>, r: Reason) =>
  r === 'supply' ? t('Supply') : r === 'rebalance' ? t('Rebalance') : t('Return');
const reasonText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** What this branch does with stock between branches: a shop asks and gets sent stock; a stock branch picks and ships. */
export function TransfersPage() {
  const t = useT();
  const isStock = useSettings().data?.branchKind === 'stock';
  type Tab = 'requests' | 'pick' | 'incoming' | 'send' | 'history';
  const [tab, setTab] = useState<Tab>(isStock ? 'pick' : 'requests');
  const incoming = useQuery({
    queryKey: ['incoming', 'on_the_way'],
    queryFn: () => get<{ data: Incoming[] }>('/incoming?status=on_the_way').then((r) => r.data),
  });
  const picking = useQuery({
    queryKey: ['pick-lists'],
    enabled: isStock,
    queryFn: () => get<{ data: unknown[] }>('/pick-lists?status=open').then((r) => r.data),
  });
  const waiting = incoming.data?.length ?? 0;
  const toPick = picking.data?.length ?? 0;
  const first: Tab = isStock ? 'pick' : 'requests';

  return (
    <main className="page" data-testid="transfers">
      <h1>
        <Icon name="transfer" size={26} />
        {t('Transfers')}
      </h1>
      <div className="tabs" role="tablist" aria-label={t('Transfers')} style={{ maxWidth: 720 }}>
        {isStock ? (
          <button role="tab" aria-selected={tab === 'pick'} onClick={() => setTab('pick')}>
            {toPick > 0 ? t('To pick ({n})', { n: toPick }) : t('To pick')}
          </button>
        ) : (
          <button role="tab" aria-selected={tab === 'requests'} onClick={() => setTab('requests')}>
            {t('Requests')}
          </button>
        )}
        <button role="tab" aria-selected={tab === 'incoming'} onClick={() => setTab('incoming')}>
          {waiting > 0 ? t('Coming in ({n})', { n: waiting }) : t('Coming in')}
        </button>
        <button role="tab" aria-selected={tab === 'send'} onClick={() => setTab('send')}>
          {isStock ? t('Send stock') : t('Send back')}
        </button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
          {t('History')}
        </button>
      </div>
      {tab === first && (isStock ? <PickTab /> : <RequestsTab />)}
      {tab === 'incoming' && <IncomingTab rows={incoming.data} loading={incoming.isLoading} />}
      {tab === 'send' && <SendTab />}
      {tab === 'history' && <HistoryTab />}
    </main>
  );
}

// ------------------------------------------------------------------ coming in

function IncomingTab({ rows, loading }: { rows: Incoming[] | undefined; loading: boolean }) {
  const t = useT();
  const [open, setOpen] = useState<Incoming | null>(null);
  if (loading) return <p className="muted">{t('Loading…')}</p>;
  if (!rows || rows.length === 0) return <div className="card empty">{t('Nothing is on its way to this branch.')}</div>;
  return (
    <>
      <div style={{ display: 'grid', gap: 12 }}>
        {rows.map((r) => (
          <section key={r.id} className="card" data-testid="incoming">
            <div className="toolbar">
              <strong>{t('From {name}', { name: r.fromBranch })}</strong>
              <span className="chip warn">{reasonLabel(t, r.reason)}</span>
              <span className="muted">{day(r.shippedAt)}</span>
              <span className="spacer" />
              <button className="btn primary" onClick={() => setOpen(r)}>
                {t('Confirm what arrived…')}
              </button>
            </div>
            {r.note && <p className="muted">{r.note}</p>}
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {r.items.map((i) => (
                <li key={i.productId}>{`${i.qty} × ${i.name.trim()}`}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && <ReceiveDialog incoming={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Count what arrived. A line left as shipped needs nothing; a different count needs its reason. The same request can never be sent twice. */
function ReceiveDialog({ incoming, onClose }: { incoming: Incoming; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [counted, setCounted] = useState<Record<number, string>>(Object.fromEntries(incoming.items.map((i) => [i.productId, i.qty])));
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const differs = (i: Incoming['items'][number]) => (counted[i.productId] ?? i.qty).trim() !== i.qty;

  async function confirm() {
    const changed = incoming.items.filter(differs);
    const missing = changed.find((i) => !(reasons[i.productId] ?? '').trim());
    if (missing) return setError(t('Say why the count of {name} differs from what was shipped', { name: missing.name.trim() }));
    setBusy(true);
    setError('');
    try {
      await post(
        '/receipts',
        {
          incomingId: incoming.id,
          items: changed.map((i) => ({
            productId: i.productId,
            counted: counted[i.productId]!.trim(),
            reason: reasons[i.productId]!.trim(),
          })),
        },
        { idempotencyKey: key.current },
      );
      toast.success(t('The stock is in.'));
      await Promise.all(['incoming', 'alerts', 'products', 'stock'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (e) {
      setError(reasonText(e, t('That could not be saved.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={t('Confirm what arrived')} onClose={onClose} wide>
      <h2>{t('From {name}', { name: incoming.fromBranch })}</h2>
      <table>
        <thead>
          <tr>
            <th>{t('Product')}</th>
            <th className="num">{t('Shipped')}</th>
            <th className="num">{t('Counted')}</th>
          </tr>
        </thead>
        <tbody>
          {incoming.items.map((i) => (
            <tr key={i.productId} data-testid="receive-line">
              <td>
                {i.name.trim()}
                {differs(i) && (
                  <input
                    aria-label={t('Why it differs: {name}', { name: i.name.trim() })}
                    placeholder={t('Why it differs')}
                    value={reasons[i.productId] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [i.productId]: e.target.value })}
                    style={{ display: 'block', marginTop: 4, width: '100%' }}
                  />
                )}
              </td>
              <td className="num">{i.qty}</td>
              <td className="num">
                <input
                  inputMode="decimal"
                  aria-label={t('Counted: {name}', { name: i.name.trim() })}
                  value={counted[i.productId] ?? i.qty}
                  onChange={(e) => setCounted({ ...counted, [i.productId]: e.target.value })}
                  style={{ width: 90, textAlign: 'end' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          {t('Cancel')}
        </button>
        <button className="btn primary big" onClick={() => void confirm()} disabled={busy}>
          {t('Confirm')}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ send

type Line = { productId: number; name: string; qty: string };

function SendTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const dest = useQuery({ queryKey: ['transfer-destinations'], queryFn: () => get<Destinations>('/transfers/destinations') });
  const key = useRef(crypto.randomUUID());
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = dest.data?.kind ?? 'sale';
  const chosen = dest.data?.data.find((d) => String(d.id) === to);
  const isReturn = kind === 'sale';

  if (dest.isLoading) return <p className="muted">{t('Loading…')}</p>;
  if (!dest.data?.connected) return <div className="card empty">{t('Sending stock needs this branch to be connected to HQ.')}</div>;

  function add(p: Product) {
    setLines((cur) => (cur.some((l) => l.productId === p.id) ? cur : [...cur, { productId: p.id, name: p.name.trim(), qty: '1' }]));
  }

  async function send() {
    if (!chosen) return setError(t('Choose where to send it'));
    if (lines.length === 0) return setError(t('Add at least one product'));
    if (lines.some((l) => !/^\d+(\.\d{1,3})?$/.test(l.qty.trim()) || Number(l.qty) <= 0))
      return setError(t('Each quantity must be a number above zero'));
    if (isReturn && !note.trim()) return setError(t('Say why the stock is going back'));
    setBusy(true);
    setError('');
    try {
      await post(
        '/shipments',
        { toBranchId: chosen.id, note: note.trim() || undefined, items: lines.map((l) => ({ productId: l.productId, qty: l.qty.trim() })) },
        { idempotencyKey: key.current },
      );
      toast.success(t('Sent to {name}. Its stock has left this branch.', { name: chosen.name }));
      key.current = crypto.randomUUID(); // the next shipment is a new one
      setLines([]);
      setNote('');
      await Promise.all(['shipments', 'alerts', 'products', 'stock'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError(reasonText(e, t('That could not be sent.')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ display: 'grid', gap: 12, maxWidth: 720 }} data-testid="send-stock">
      <label className="field">
        {t('Send to')}
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t('Choose a branch')}</option>
          {dest.data.data
            .filter((d) => d.allowed)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {`${d.name} (${d.kind === 'stock' ? t('stock branch') : t('shop')})`}
              </option>
            ))}
        </select>
      </label>
      {isReturn && <p className="muted">{t('A shop can send stock back to a stock branch, never to another shop.')}</p>}
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
              <tr key={l.productId} data-testid="send-line">
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
        {isReturn ? t('Why is it going back?') : t('Note (optional)')}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <div>
        <button className="btn primary big" onClick={() => void send()} disabled={busy}>
          {t('Send')}
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ history

function HistoryTab() {
  const t = useT();
  const sent = useQuery({ queryKey: ['shipments'], queryFn: () => get<{ data: Shipment[] }>('/shipments?limit=30').then((r) => r.data) });
  const got = useQuery({
    queryKey: ['incoming', 'received'],
    queryFn: () => get<{ data: Incoming[] }>('/incoming?status=received&limit=30').then((r) => r.data),
  });
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section>
        <h2>{t('Sent')}</h2>
        {(sent.data ?? []).length === 0 ? (
          <div className="card empty">{t('Nothing sent yet.')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th>{t('To')}</th>
                <th>{t('What')}</th>
              </tr>
            </thead>
            <tbody>
              {(sent.data ?? []).map((s) => (
                <tr key={s.id} data-testid="sent-row">
                  <td>{day(s.createdAt)}</td>
                  <td>
                    {s.toBranch} <span className="chip">{reasonLabel(t, s.reason)}</span>
                  </td>
                  <td>{s.items.map((i) => `${i.qty} × ${i.name.trim()}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h2>{t('Received')}</h2>
        {(got.data ?? []).length === 0 ? (
          <div className="card empty">{t('Nothing received yet.')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th>{t('From')}</th>
                <th>{t('What')}</th>
              </tr>
            </thead>
            <tbody>
              {(got.data ?? []).map((r) => (
                <tr key={r.id} data-testid="received-row">
                  <td>{day(r.receivedAt ?? r.shippedAt)}</td>
                  <td>{r.fromBranch}</td>
                  <td>
                    {r.items
                      .map((i) =>
                        i.counted !== null && i.counted !== i.qty
                          ? `${i.counted} of ${i.qty} × ${i.name.trim()}`
                          : `${i.qty} × ${i.name.trim()}`,
                      )
                      .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
