import { roundDiv } from '@pos/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, api, get, patch, post } from '../../lib/api';
import { fmtMoney, parseLbpInput, parseUsdInput, trimQty } from '../../lib/money';
import { qtyToMilli } from '../../lib/qty';
import type { Currency, Product, Purchase } from '../../lib/types';
import { toast } from '../../store/toast';
import { minorToInput, useSuppliers } from '../products/lookups';

type Line = { productId: number; name: string; qty: string; cost: string };

const parseMoney = (text: string, currency: Currency) => (currency === 'USD' ? parseUsdInput(text) : parseLbpInput(text));
const QTY = /^\d+(\.\d{1,3})?$/;
const validQty = (q: string) => QTY.test(q.trim()) && Number(q) > 0;

/**
 * One purchase from a supplier. Until something arrives it is editable (lines, supplier, currency, draft or ordered).
 * Once ordered it can be received, in whole or in parts, and paid. Stock on hand never limits any of it.
 */
export function PurchaseDialog({ purchase, onClose }: { purchase: Purchase | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const suppliers = useSuppliers();
  const [p, setP] = useState<Purchase | null>(purchase);

  const editable = p === null || (p.status !== 'received' && p.items.every((i) => Number(i.received) === 0));
  const [supplierId, setSupplierId] = useState(String(purchase?.supplierId ?? ''));
  const [currency, setCurrency] = useState<Currency>(purchase?.currency ?? 'LBP');
  const [lines, setLines] = useState<Line[]>(
    (purchase?.items ?? []).map((i) => ({
      productId: i.productId ?? 0,
      name: i.name,
      qty: i.qty,
      cost: minorToInput(i.costMinor, purchase!.currency),
    })),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshLists = () =>
    Promise.all(['purchases', 'alerts', 'products', 'payables'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));

  const parsedLines = lines.map((l) => ({ ...l, costMinor: parseMoney(l.cost, currency) }));
  const total = parsedLines.reduce(
    (sum, l) => sum + (Number.isFinite(l.costMinor) && validQty(l.qty) ? roundDiv(l.costMinor * qtyToMilli(l.qty), 1000) : 0),
    0,
  );

  function changeCurrency(next: Currency) {
    if (next === currency) return;
    // Re-read each typed cost in the new currency so "4.50" never silently turns into 450 lira.
    setLines(
      lines.map((l) => {
        const v = parseMoney(l.cost, currency);
        return { ...l, cost: Number.isFinite(v) && l.cost.trim() !== '' ? minorToInput(v, next) : l.cost };
      }),
    );
    setCurrency(next);
  }

  function addProduct(product: Product) {
    const existing = lines.findIndex((l) => l.productId === product.id);
    if (existing >= 0) {
      setLines(lines.map((l, i) => (i === existing ? { ...l, qty: String(Number(l.qty) + 1) } : l)));
      return;
    }
    setLines([
      ...lines,
      {
        productId: product.id,
        name: product.name.trim(),
        qty: '1',
        cost: product.currency === currency ? minorToInput(product.costMinor, currency) : '',
      },
    ]);
  }

  const patchLine = (i: number, change: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...change } : l)));

  /** Run one change against the server. Returns whether it worked; the reason is shown in the dialog when it did not. */
  async function run(task: () => Promise<Purchase | void>, done?: string): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      const next = await task();
      if (next) setP(next);
      await refreshLists();
      if (done) toast.success(done);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(status: 'draft' | 'ordered') {
    if (lines.length === 0) return setError('Add at least one product');
    for (const l of parsedLines) {
      if (!validQty(l.qty)) return setError(`Enter a quantity for ${l.name}`);
      if (!Number.isFinite(l.costMinor)) return setError(`The cost of ${l.name} is not a valid amount`);
    }
    const body = {
      supplierId: supplierId ? Number(supplierId) : null,
      currency,
      status,
      items: parsedLines.map((l) => ({ productId: l.productId, qty: l.qty.trim(), costMinor: l.costMinor })),
    };
    const ok = await run(
      () => (p ? patch<Purchase>(`/purchases/${p.id}`, body) : post<Purchase>('/purchases', body)),
      status === 'ordered' ? 'Purchase ordered' : 'Draft saved',
    );
    // A draft is done once saved. An order stays open: its goods can now be received and paid.
    if (ok && status === 'draft') onClose();
  }

  async function discard() {
    if (!p || !window.confirm(`Delete draft purchase ${p.ref}?`)) return;
    const ok = await run(() => api<void>('DELETE', `/purchases/${p.id}`), 'Draft deleted');
    if (ok) onClose();
  }

  return (
    <Modal label={p ? `Purchase ${p.ref}` : 'New purchase'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <h2>{p ? `Purchase ${p.ref}` : 'New purchase'}</h2>
        {p && (
          <div className="muted">
            {`${p.status === 'draft' ? 'Draft' : p.status === 'ordered' ? 'Ordered' : 'Received'} · ${p.createdAt.slice(0, 10)}${p.supplierName ? ` · ${p.supplierName}` : ''}`}
          </div>
        )}

        {editable ? (
          <>
            <div className="method">
              <label className="field">
                Supplier
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">No supplier</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Currency of this purchase
                <select value={currency} onChange={(e) => changeCurrency(e.target.value as Currency)}>
                  <option value="LBP">LBP (lira)</option>
                  <option value="USD">USD (dollars)</option>
                </select>
              </label>
            </div>
            <ProductPicker onPick={addProduct} />
            {lines.length === 0 ? (
              <div className="card empty">Search for a product above to add it.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Quantity</th>
                    <th className="num">{`Cost each (${currency})`}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.productId} data-testid="purchase-line">
                      <td>{l.name}</td>
                      <td className="num">
                        <input
                          className="num"
                          aria-label={`Quantity of ${l.name}`}
                          inputMode="decimal"
                          value={l.qty}
                          onChange={(e) => patchLine(i, { qty: e.target.value })}
                          style={{ width: 90 }}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="num"
                          aria-label={`Cost of ${l.name}`}
                          inputMode="decimal"
                          value={l.cost}
                          onChange={(e) => patchLine(i, { cost: e.target.value })}
                          style={{ width: 120 }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Remove ${l.name}`}
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="due">
              <span>Total</span>
              <span className="amount num" data-testid="purchase-total">
                {fmtMoney(total, currency)}
              </span>
            </div>
          </>
        ) : (
          p && <ReadOnlyLines p={p} />
        )}

        {p && p.status === 'ordered' && <ReceiveSection p={p} busy={busy} run={run} />}
        {p && p.status !== 'draft' && p.owedMinor > 0 && <PaySection p={p} busy={busy} run={run} />}

        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {p?.status === 'draft' && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => void discard()} style={{ marginInlineEnd: 'auto' }}>
              Delete draft
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          {editable && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void save('draft')}>
                Save as draft
              </button>
              <button type="button" className="btn primary big" disabled={busy} onClick={() => void save('ordered')}>
                {p?.status === 'ordered' ? 'Save order' : 'Place order'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ReadOnlyLines({ p }: { p: Purchase }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th className="num">Ordered</th>
          <th className="num">Received</th>
          <th className="num">Cost each</th>
          <th className="num">Line total</th>
        </tr>
      </thead>
      <tbody>
        {p.items.map((i) => (
          <tr key={i.id} data-testid="purchase-line">
            <td>{i.name}</td>
            <td className="num">{trimQty(i.qty)}</td>
            <td className="num">{trimQty(i.received)}</td>
            <td className="num">{fmtMoney(i.costMinor, p.currency)}</td>
            <td className="num">{fmtMoney(i.lineTotalMinor, p.currency)}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={4}>
            <strong>Total</strong>
          </td>
          <td className="num">
            <strong>{fmtMoney(p.totalMinor, p.currency)}</strong>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

type Run = (task: () => Promise<Purchase | void>, done?: string) => Promise<boolean>;

/** Goods arrive: everything at once, or only what came on this delivery. */
function ReceiveSection({ p, busy, run }: { p: Purchase; busy: boolean; run: Run }) {
  const [now, setNow] = useState<Record<number, string>>({});
  const [updateCost, setUpdateCost] = useState(true);
  // One id per attempt: a double click or a retry after a network hiccup cannot receive the goods twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const open = p.items.filter((i) => Number(i.outstanding) > 0);

  const submit = (items?: { purchaseItemId: number; qty: string }[]) =>
    run(async () => {
      await post(`/purchases/${p.id}/receive`, items ? { items, updateCost } : { updateCost }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      setNow({});
      return get<Purchase>(`/purchases/${p.id}`);
    }, 'Goods received');

  function receivePart() {
    const items = open.flatMap((i) => {
      const q = (now[i.id] ?? '').trim();
      return q && validQty(q) ? [{ purchaseItemId: i.id, qty: q }] : [];
    });
    if (items.length === 0) return;
    void submit(items);
  }

  return (
    <section style={{ display: 'grid', gap: 10 }} aria-label="Receive goods">
      <h3>Goods arriving</h3>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th className="num">Still to come</th>
            <th className="num">Arrived now</th>
          </tr>
        </thead>
        <tbody>
          {open.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td className="num">{trimQty(i.outstanding)}</td>
              <td className="num">
                <input
                  className="num"
                  aria-label={`Arrived now: ${i.name}`}
                  inputMode="decimal"
                  placeholder="0"
                  value={now[i.id] ?? ''}
                  onChange={(e) => setNow({ ...now, [i.id]: e.target.value })}
                  style={{ width: 90 }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} style={{ width: 20, height: 20 }} />
        Update each product's cost to what was paid on this purchase
      </label>
      <div className="dialog-actions" style={{ position: 'static', margin: 0, padding: 0, border: 0 }}>
        <button type="button" className="btn" disabled={busy} onClick={receivePart}>
          Receive the quantities above
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          Receive everything
        </button>
      </div>
    </section>
  );
}

/** Money paid to the supplier. Part payments are fine, before or after the goods arrive. */
function PaySection({ p, busy, run }: { p: Purchase; busy: boolean; run: Run }) {
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');

  function pay() {
    const v = parseMoney(amount, p.currency);
    if (!(v > 0)) return setError('Enter the amount paid');
    if (v > p.owedMinor) return setError(`Only ${fmtMoney(p.owedMinor, p.currency)} is owed on this purchase`);
    setError('');
    void run(async () => {
      await post(`/purchases/${p.id}/payments`, { amountMinor: v }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      setAmount('');
      return get<Purchase>(`/purchases/${p.id}`);
    }, 'Payment recorded');
  }

  return (
    <section style={{ display: 'grid', gap: 10 }} aria-label="Pay the supplier">
      <h3>Paying the supplier</h3>
      <div className="due">
        <span>{`Paid ${fmtMoney(p.paidMinor, p.currency)}, still owed`}</span>
        <span className="amount num" data-testid="purchase-owed">
          {fmtMoney(p.owedMinor, p.currency)}
        </span>
      </div>
      <div className="toolbar">
        <label className="field">
          {`Amount paid (${p.currency})`}
          <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={busy} onClick={pay}>
          Record payment
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        This only notes the payment on the purchase. If it came out of the till drawer, record it as a cash movement too.
      </p>
      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

/** Type part of a name or scan a barcode, then pick the product. Stock is never checked. */
function ProductPicker({ onPick }: { onPick: (p: Product) => void }) {
  const [q, setQ] = useState('');
  const text = q.trim();
  const results = useQuery({
    queryKey: ['picker', text],
    enabled: text.length >= 2,
    queryFn: () => get<{ data: Product[] }>(`/products?limit=8&q=${encodeURIComponent(text)}`).then((r) => r.data),
  });
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label className="field">
        Add a product
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or barcode" autoComplete="off" />
      </label>
      {text.length >= 2 && (results.data ?? []).length > 0 && (
        <div role="listbox" aria-label="Matching products" style={{ display: 'grid', gap: 4 }}>
          {(results.data ?? []).map((r) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={false}
              className="btn"
              style={{ justifyContent: 'space-between', textAlign: 'start' }}
              onClick={() => {
                onPick(r);
                setQ('');
              }}
            >
              <span>{r.name.trim()}</span>
              <span className="muted">{r.barcode}</span>
            </button>
          ))}
        </div>
      )}
      {text.length >= 2 && results.data?.length === 0 && <span className="muted">No product matches.</span>}
    </div>
  );
}
