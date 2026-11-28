import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, get, patch, post, postOnce } from '../lib/api';
import { ago, milliToQty, minorText, money, orderStatusText, parseMinor, parseQty, qtyText } from '../lib/format';
import { canCatalog, isAdmin, type Me } from '../lib/session';
import { useBranches } from './PeoplePage';

type OrderLine = {
  id: number;
  stockBranchId: number;
  stockBranch: string;
  productId: number;
  product: string;
  qtyMilli: number;
  receivedMilli: number;
  unitCostMinor: number;
  valueMinor: number;
};
export type Order = {
  id: number;
  supplierId: number | null;
  supplier: string | null;
  currency: 'USD' | 'LBP';
  status: 'draft' | 'ordered' | 'closed' | 'cancelled';
  note: string | null;
  createdAt: string;
  orderedAt: string | null;
  closedAt: string | null;
  lines: OrderLine[];
  orderedMinor: number;
  receivedMinor: number;
  paidMinor: number;
  payableMinor: number;
  outstandingMinor: number;
};
type Product = { id: number; name: string; barcode: string; costMinor: number; currency: string };
type Supplier = { id: number; name: string };

const useSuppliers = () =>
  useQuery({ queryKey: ['suppliers'], queryFn: () => get<{ data: Supplier[] }>('/suppliers').then((r) => r.data) });
const say = (e: unknown) => (e instanceof ApiError ? e.message : 'That could not be done.');
const pillOf = (s: string) => (s === 'ordered' ? 'ok' : s === 'cancelled' ? 'bad' : '');

/** HQ's orders to suppliers, delivered to stock branches. Anyone on staff reads; the catalog role makes and places orders; paying a supplier is admin only. */
export function PurchasingPage({ me }: { me: Me }) {
  const [params, setParams] = useSearchParams();
  const order = params.get('order');
  const editing = params.get('edit') === '1';
  const open = (id: number | 'new' | null, edit = false) => {
    const next = new URLSearchParams();
    if (id !== null) next.set('order', String(id));
    if (edit) next.set('edit', '1');
    setParams(next);
  };
  if (order === 'new') return <OrderEditor onDone={(id) => open(id)} onBack={() => open(null)} />;
  if (order && editing) return <OrderEditor id={Number(order)} onDone={(id) => open(id)} onBack={() => open(Number(order))} />;
  if (order) return <OrderView id={Number(order)} me={me} onBack={() => open(null)} onEdit={() => open(Number(order), true)} />;
  return <OrderList me={me} onOpen={(id) => open(id)} onNew={() => open('new')} />;
}

function OrderList({ me, onOpen, onNew }: { me: Me; onOpen: (id: number) => void; onNew: () => void }) {
  const [status, setStatus] = useState('all');
  const orders = useQuery({
    queryKey: ['po-list', status],
    queryFn: () => get<{ data: Order[] }>(`/purchase-orders?status=${status}`).then((r) => r.data),
  });
  const owed = useQuery({
    queryKey: ['payables'],
    queryFn: () =>
      get<{ data: { supplier: string | null; currency: string; outstandingMinor: number; orders: number }[] }>('/reports/payables').then(
        (r) => r.data,
      ),
  });
  return (
    <div className="stack">
      <h1>Purchasing</h1>
      {(owed.data ?? []).length > 0 && (
        <section className="card" data-testid="payables">
          <h2>What HQ owes suppliers</h2>
          <ul className="plain">
            {(owed.data ?? []).map((o, i) => (
              <li key={i}>
                {o.supplier ?? 'No supplier named'}: <strong>{money(o.outstandingMinor, o.currency)}</strong>{' '}
                <span className="muted small">
                  on {o.orders} order{o.orders === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <div className="row">
          <label className="field">
            Show
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All orders</option>
              <option value="draft">Drafts</option>
              <option value="ordered">Ordered</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          {canCatalog(me) && (
            <button className="btn primary" onClick={onNew}>
              New order
            </button>
          )}
        </div>
        {(orders.data ?? []).length === 0 ? (
          <p className="muted">{orders.isLoading ? 'Loading…' : 'No orders.'}</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Supplier</th>
                  <th>State</th>
                  <th className="num">Lines</th>
                  <th className="num">Ordered</th>
                  <th className="num">Still to pay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(orders.data ?? []).map((o) => (
                  <tr key={o.id} data-testid="order-row">
                    <td>#{o.id}</td>
                    <td>{o.supplier ?? <span className="muted">none</span>}</td>
                    <td>
                      <span className={`pill ${pillOf(o.status)}`}>{o.status}</span>
                    </td>
                    <td className="num">{o.lines.length}</td>
                    <td className="num">{money(o.orderedMinor, o.currency)}</td>
                    <td className="num">{money(o.outstandingMinor, o.currency)}</td>
                    <td className="actions">
                      <button className="btn" onClick={() => onOpen(o.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function OrderView({ id, me, onBack, onEdit }: { id: number; me: Me; onBack: () => void; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const order = useQuery({ queryKey: ['po', id], queryFn: () => get<Order>(`/purchase-orders/${id}`) });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['po', id] });
    await queryClient.invalidateQueries({ queryKey: ['po-list'] });
    await queryClient.invalidateQueries({ queryKey: ['payables'] });
  };
  const step = useMutation({
    mutationFn: (what: 'order' | 'cancel' | 'close') => post(`/purchase-orders/${id}/${what}`),
    onSuccess: async (_r, what) => {
      setError('');
      setNotice(what === 'order' ? 'Placed. Each stock branch is told what to expect.' : what === 'close' ? 'Closed.' : 'Cancelled.');
      await refresh();
    },
    onError: (e) => {
      setNotice('');
      setError(say(e));
    },
  });
  // One key per payment attempt: sending the same attempt twice (a slow answer, a second click) is ONE payment. A new key only after one went through.
  const key = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const o = order.data;
  const minor = o ? parseMinor(amount, o.currency) : null;
  const pay = useMutation({
    mutationFn: () => postOnce(`/purchase-orders/${id}/payments`, { amountMinor: minor, note: note.trim() || null }, key.current),
    onSuccess: async () => {
      key.current = crypto.randomUUID();
      setAmount('');
      setNote('');
      setError('');
      setNotice('The payment is recorded.');
      await refresh();
    },
    onError: (e) => {
      setNotice('');
      setError(say(e));
    },
  });

  if (order.isLoading) return <p className="muted">Loading&hellip;</p>;
  if (!o) return <p className="banner warn">That order could not be loaded.</p>;
  const edit = canCatalog(me);
  const sure = (what: 'order' | 'cancel' | 'close') => {
    const q =
      what === 'order'
        ? 'Place this order? The stock branches will expect these goods and it can no longer be changed.'
        : what === 'close'
          ? 'Close this order? What has arrived is accepted and the rest is dropped.'
          : 'Cancel this order?';
    if (window.confirm(q)) step.mutate(what);
  };
  return (
    <div className="stack">
      <p>
        <button className="btn ghost" onClick={onBack}>
          &larr; All orders
        </button>
      </p>
      <h1>Order #{o.id}</h1>
      <p>
        <span className={`pill ${pillOf(o.status)}`}>{o.status}</span> <span className="muted">{orderStatusText(o.status)}</span>
      </p>
      <p className="muted">
        {o.supplier ?? 'No supplier named'} · {o.currency} · made {ago(o.createdAt)}
        {o.orderedAt && ` · placed ${ago(o.orderedAt)}`}
        {o.note && ` · ${o.note}`}
      </p>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner ok">{notice}</div>}
      {edit && (
        <div className="actions">
          {o.status === 'draft' && (
            <>
              <button className="btn primary" disabled={step.isPending} onClick={() => sure('order')}>
                Place the order
              </button>
              <button className="btn" onClick={onEdit}>
                Change the lines
              </button>
            </>
          )}
          {o.status === 'ordered' && (
            <button className="btn" disabled={step.isPending} onClick={() => sure('close')}>
              Close (accept what arrived)
            </button>
          )}
          {(o.status === 'draft' || o.status === 'ordered') && (
            <button className="btn ghost" disabled={step.isPending} onClick={() => sure('cancel')}>
              Cancel the order
            </button>
          )}
        </div>
      )}
      <section className="card">
        <h2>Lines</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Goes to</th>
                <th>Product</th>
                <th className="num">Ordered</th>
                <th className="num">Arrived</th>
                <th className="num">Unit cost</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id} data-testid="order-line">
                  <td>{l.stockBranch}</td>
                  <td>{l.product}</td>
                  <td className="num">{qtyText(l.qtyMilli)}</td>
                  <td className="num">
                    {qtyText(l.receivedMilli)}
                    {l.receivedMilli >= l.qtyMilli && <span className="pill ok"> all</span>}
                  </td>
                  <td className="num">{money(l.unitCostMinor, o.currency)}</td>
                  <td className="num">{money(l.valueMinor, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tiles">
          <div className="tile">
            <span className="muted">Ordered</span>
            <strong>{money(o.orderedMinor, o.currency)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Arrived</span>
            <strong>{money(o.receivedMinor, o.currency)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Paid</span>
            <strong>{money(o.paidMinor, o.currency)}</strong>
          </div>
          <div className="tile">
            <span className="muted">Still to pay</span>
            <strong data-testid="outstanding">{money(o.outstandingMinor, o.currency)}</strong>
          </div>
        </div>
      </section>
      {isAdmin(me) && (o.status === 'ordered' || o.status === 'closed') && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            pay.mutate();
          }}
        >
          <h2>Pay the supplier</h2>
          <p className="muted small">A payment is recorded once, even if the button is pressed twice. Part payments are fine.</p>
          <div className="row">
            <label className="field">
              Amount ({o.currency})
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
            </label>
            <label className="field grow">
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
            </label>
            <button className="btn primary" type="submit" disabled={pay.isPending || minor === null || minor < 1}>
              Record the payment
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

type EditLine = { key: number; stockBranchId: string; product: Product; qty: string; cost: string };

function OrderEditor({ id, onDone, onBack }: { id?: number; onDone: (id: number) => void; onBack: () => void }) {
  const queryClient = useQueryClient();
  const branches = useBranches();
  const suppliers = useSuppliers();
  const existing = useQuery({ queryKey: ['po', id], queryFn: () => get<Order>(`/purchase-orders/${id}`), enabled: id !== undefined });
  const stock = (branches.data ?? []).filter((b) => b.kind === 'stock' && b.active);
  const [currency, setCurrency] = useState<'USD' | 'LBP'>('USD');
  const [supplierId, setSupplierId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [error, setError] = useState('');
  const next = useRef(1);
  const loaded = useRef(false);

  // Changing a draft starts from what it is now (once).
  useEffect(() => {
    const o = existing.data;
    if (!o || loaded.current) return;
    loaded.current = true;
    setCurrency(o.currency);
    setSupplierId(o.supplierId === null ? '' : String(o.supplierId));
    setNote(o.note ?? '');
    setLines(
      o.lines.map((l) => ({
        key: next.current++,
        stockBranchId: String(l.stockBranchId),
        product: { id: l.productId, name: l.product, barcode: '', costMinor: l.unitCostMinor, currency: o.currency },
        qty: milliToQty(l.qtyMilli),
        cost: minorText(l.unitCostMinor, o.currency),
      })),
    );
  }, [existing.data]);

  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['product-search', q.trim()],
    queryFn: () => get<{ data: Product[] }>(`/products?q=${encodeURIComponent(q.trim())}&limit=8`).then((r) => r.data),
    enabled: q.trim().length >= 2,
  });
  const addProduct = (p: Product) => {
    setLines((ls) => [
      ...ls,
      {
        key: next.current++,
        stockBranchId: String(stock[0]?.id ?? ''),
        product: p,
        qty: '',
        cost: p.currency === currency ? minorText(p.costMinor, currency) : '',
      },
    ]);
    setQ('');
  };
  const set = (key: number, patchLine: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patchLine } : l)));

  const parsed = lines.map((l) => ({ qty: parseQty(l.qty), cost: parseMinor(l.cost, currency), branch: Number(l.stockBranchId) }));
  const valid = lines.length > 0 && parsed.every((p) => p.qty !== null && p.cost !== null && p.branch > 0);
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        supplierId: supplierId === '' ? null : Number(supplierId),
        currency,
        note: note.trim() || null,
        lines: lines.map((l, i) => ({
          stockBranchId: parsed[i]!.branch,
          productId: l.product.id,
          qty: parsed[i]!.qty,
          unitCostMinor: parsed[i]!.cost,
        })),
      };
      if (id === undefined) return (await post<Order>('/purchase-orders', body)).id;
      await patch(`/purchase-orders/${id}`, body);
      return id;
    },
    onSuccess: async (orderId) => {
      await queryClient.invalidateQueries({ queryKey: ['po'] });
      await queryClient.invalidateQueries({ queryKey: ['po-list'] });
      onDone(orderId);
    },
    onError: (e) => setError(say(e)),
  });

  return (
    <div className="stack">
      <p>
        <button className="btn ghost" onClick={onBack}>
          &larr; Back
        </button>
      </p>
      <h1>{id === undefined ? 'New order' : `Change order #${id}`}</h1>
      <p className="muted">An order is saved as a draft. Nothing is ordered until you place it.</p>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <section className="card">
        <div className="row">
          <label className="field">
            Supplier
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">No supplier named</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value === 'LBP' ? 'LBP' : 'USD')}>
              <option value="USD">USD</option>
              <option value="LBP">LBP</option>
            </select>
          </label>
          <label className="field grow">
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
          </label>
        </div>
      </section>
      <section className="card">
        <h2>Lines</h2>
        {stock.length === 0 && (
          <p className="banner warn">There is no stock branch to deliver to. Add one on the Branches page (kind: Stock).</p>
        )}
        {lines.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Deliver to</th>
                  <th>Quantity</th>
                  <th>Unit cost ({currency})</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} data-testid="edit-line">
                    <td>
                      <strong>{l.product.name}</strong>
                    </td>
                    <td>
                      <select
                        aria-label={`Deliver ${l.product.name} to`}
                        value={l.stockBranchId}
                        onChange={(e) => set(l.key, { stockBranchId: e.target.value })}
                      >
                        {stock.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label={`Quantity of ${l.product.name}`}
                        value={l.qty}
                        onChange={(e) => set(l.key, { qty: e.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Unit cost of ${l.product.name}`}
                        value={l.cost}
                        onChange={(e) => set(l.key, { cost: e.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                      />
                    </td>
                    <td>
                      <button
                        className="link"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        aria-label={`Remove ${l.product.name}`}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <label className="field">
          Add a product (name or barcode)
          <input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </label>
        {q.trim().length >= 2 && (
          <ul className="plain" data-testid="product-results">
            {(found.data ?? []).length === 0 ? (
              <li className="muted">{found.isLoading ? 'Searching…' : 'No product found.'}</li>
            ) : (
              (found.data ?? []).map((p) => (
                <li key={p.id}>
                  <button className="btn" onClick={() => addProduct(p)} aria-label={`Add ${p.name}`}>
                    Add
                  </button>{' '}
                  {p.name} <span className="muted small">{p.barcode}</span>
                </li>
              ))
            )}
          </ul>
        )}
        <p>
          <button className="btn primary" disabled={save.isPending || !valid} onClick={() => save.mutate()}>
            Save as a draft
          </button>
        </p>
        {!valid && lines.length > 0 && (
          <p className="muted small">Each line needs a quantity (up to 3 decimals) and a cost that is a plain amount.</p>
        )}
      </section>
    </div>
  );
}
