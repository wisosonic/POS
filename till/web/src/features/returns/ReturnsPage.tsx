import { lbpToUsdCents } from '@pos/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRate } from '../../hooks/useTillData';
import { ApiError, get, post } from '../../lib/api';
import { fmtLbp, fmtUsd, trimQty } from '../../lib/money';
import { milliToQty, qtyToMilli } from '../../lib/qty';
import type { Currency, Method, SaleDetail } from '../../lib/types';
import { toast } from '../../store/toast';
import { ReturnApprovalDialog } from './ReturnApprovalDialog';
import { Icon } from '../../components/Icon';

const QTY = /^\d+(\.\d{1,3})?$/;
const METHODS: { value: Method; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'whish', label: 'Whish' },
  { value: 'omt', label: 'OMT' },
];

type RefundDue = { refundLbp: number; balanceReducedLbp: number };

/** Take goods back against a receipt: stock goes back, and the money goes back from the till or comes off what the customer owes. */
export function ReturnsPage() {
  const queryClient = useQueryClient();
  const rate = useRate().data ?? 90000;
  // Arriving from a receipt on the Sales screen (?ref=123) loads that sale straight away.
  const [params] = useSearchParams();
  const fromLink = Number(params.get('ref'));
  const linked = Number.isInteger(fromLink) && fromLink > 0 ? fromLink : null;
  const [refInput, setRefInput] = useState(linked ? String(linked) : '');
  const [ref, setRef] = useState<number | null>(linked);
  const [now, setNow] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState<RefundDue | null>(null);
  // A cashier cannot take goods back alone: the server says so, a manager approves, and the approval travels with the return.
  const [ask, setAsk] = useState<{ saleId: number; saleRef: number; valueLbp: number } | null>(null);
  const [approval, setApproval] = useState<{ token: string; managerName: string } | null>(null);
  const [method, setMethod] = useState<Method>('cash');
  const [currency, setCurrency] = useState<Currency>('LBP');
  // One id per return: pressing the button twice, or retrying after a hiccup, can never take the goods back twice.
  const [key, setKey] = useState(() => crypto.randomUUID());

  const sale = useQuery({
    queryKey: ['sale-by-ref', ref],
    enabled: ref !== null,
    retry: false,
    queryFn: () => get<SaleDetail>(`/sales/by-ref/${ref}`),
  });
  // What has already come back is part of the sale itself, so a cashier (who cannot read the returns list) sees it too.
  const returnedMilli = (itemId: number) => {
    const back = sale.data?.items.find((i) => i.id === itemId)?.returnedQty ?? '0';
    return Number(back) > 0 ? qtyToMilli(back) : 0; // qtyToMilli refuses zero
  };

  function find(e: FormEvent) {
    e.preventDefault();
    const n = Number(refInput.trim());
    if (!Number.isInteger(n) || n <= 0) return setError('Type the receipt number');
    setError('');
    setNow({});
    setDue(null);
    setRef(n);
  }

  const chosen = () =>
    (sale.data?.items ?? []).flatMap((i) => {
      const q = (now[i.id] ?? '').trim();
      return q === '' ? [] : [{ item: i, qty: q }];
    });

  async function submit(refund?: { method: Method; currency: Currency; amount: number }, token = approval?.token) {
    const s = sale.data;
    if (!s) return;
    const picked = chosen();
    if (picked.length === 0) return setError('Type how many of each item come back');
    for (const { item, qty } of picked) {
      if (!QTY.test(qty) || !(Number(qty) > 0)) return setError(`The quantity for ${item.name} is not valid`);
      const left = qtyToMilli(item.qty) - returnedMilli(item.id);
      if (qtyToMilli(qty) > left) return setError(`Only ${trimQty(milliToQty(left))} of ${item.name} can still be returned`);
    }
    setBusy(true);
    setError('');
    try {
      const done = await post<{ ref: number }>(
        '/returns',
        {
          saleId: s.id,
          items: picked.map((p) => ({ saleItemId: p.item.id, qty: p.qty })),
          reason: reason.trim(),
          refund,
          approvalToken: token,
        },
        { idempotencyKey: key },
      );
      toast.success(`Return ${done.ref} recorded`);
      setApproval(null);
      setKey(crypto.randomUUID());
      setNow({});
      setReason('');
      setDue(null);
      await Promise.all([
        sale.refetch(),
        ...['alerts', 'products', 'register', 'customers'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REFUND_REQUIRED' && typeof err.extra.refundLbp === 'number') {
        setDue({ refundLbp: err.extra.refundLbp, balanceReducedLbp: Number(err.extra.balanceReducedLbp ?? 0) });
      } else if (err instanceof ApiError && err.code === 'RETURN_NEEDS_APPROVAL' && typeof err.extra.valueLbp === 'number') {
        // No approval yet, or the one held no longer fits (expired, used, or for less than is being returned): ask again.
        setApproval(null);
        setAsk({ saleId: s.id, saleRef: s.ref, valueLbp: err.extra.valueLbp });
      } else setError(err instanceof ApiError ? err.message : 'The return could not be recorded');
    } finally {
      setBusy(false);
    }
  }

  const refundAmount = due ? (currency === 'USD' ? lbpToUsdCents(due.refundLbp, rate) : due.refundLbp) : 0;
  const notFound = sale.error instanceof ApiError && sale.error.status === 404;

  /** The manager has approved: keep the approval and send the return again (with the refund, if that step was already reached). */
  function approved(token: string, managerName: string) {
    setApproval({ token, managerName });
    setAsk(null);
    void submit(due ? { method, currency, amount: refundAmount } : undefined, token);
  }

  return (
    <main className="page">
      <h1>
        <Icon name="returns" size={26} />
        Returns
      </h1>
      {ask && <ReturnApprovalDialog {...ask} onApproved={approved} onClose={() => setAsk(null)} />}
      <form className="toolbar" onSubmit={find}>
        <label className="field">
          Receipt number
          <input value={refInput} onChange={(e) => setRefInput(e.target.value)} inputMode="numeric" autoComplete="off" autoFocus />
        </label>
        <button className="btn primary" type="submit">
          Find sale
        </button>
      </form>

      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}
      {ref !== null && sale.isLoading && <p className="muted">Loading…</p>}
      {notFound && <div className="card empty">{`There is no sale with receipt number ${ref}.`}</div>}

      {sale.data &&
        (sale.data.status === 'void' ? (
          <div className="card empty">{`Sale ${sale.data.ref} was voided, so nothing can be returned from it.`}</div>
        ) : (
          <>
            <div className="due">
              <span>{`Sale ${sale.data.ref} · ${sale.data.createdAt.slice(0, 10)}`}</span>
              <span className="amount num">{fmtLbp(sale.data.totalLbp)}</span>
            </div>
            {sale.data.restLbp > 0 && (
              <p className="muted">{`${fmtLbp(sale.data.restLbp)} of this sale is still unpaid, so what comes back is taken off that first.`}</p>
            )}
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Sold</th>
                  <th className="num">Already returned</th>
                  <th className="num">Price</th>
                  <th className="num">Bringing back</th>
                </tr>
              </thead>
              <tbody>
                {sale.data.items.map((i) => {
                  const back = returnedMilli(i.id);
                  const full = back >= qtyToMilli(i.qty);
                  return (
                    <tr key={i.id} data-testid="return-line">
                      <td>{i.name.trim()}</td>
                      <td className="num">{trimQty(i.qty)}</td>
                      <td className="num">{back > 0 ? trimQty(milliToQty(back)) : ''}</td>
                      <td className="num">{fmtLbp(i.unitPriceLbp)}</td>
                      <td className="num">
                        <input
                          className="num"
                          aria-label={`Bringing back: ${i.name.trim()}`}
                          inputMode="decimal"
                          placeholder={full ? 'All returned' : '0'}
                          disabled={full || due !== null}
                          value={now[i.id] ?? ''}
                          onChange={(e) => setNow({ ...now, [i.id]: e.target.value })}
                          style={{ width: 100 }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <label className="field" style={{ maxWidth: 420 }}>
              Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" disabled={due !== null} />
            </label>

            {due ? (
              <section className="banner warn" aria-label="Hand the money back">
                <div className="title">{`Hand back ${currency === 'USD' ? fmtUsd(refundAmount) : fmtLbp(refundAmount)}`}</div>
                {due.balanceReducedLbp > 0 && <div>{`${fmtLbp(due.balanceReducedLbp)} was taken off what the customer owes.`}</div>}
                <div className="method">
                  <label className="field">
                    Paid back from
                    <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                      {METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    In
                    <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                      <option value="LBP">LBP (lira)</option>
                      <option value="USD">USD (dollars)</option>
                    </select>
                  </label>
                </div>
                <div className="buttons">
                  <button className="btn" disabled={busy} onClick={() => setDue(null)}>
                    Back
                  </button>
                  <button
                    className="btn primary big"
                    disabled={busy}
                    onClick={() => void submit({ method, currency, amount: refundAmount })}
                  >
                    Confirm refund
                  </button>
                </div>
              </section>
            ) : (
              <div>
                <button className="btn primary big" disabled={busy} onClick={() => void submit()}>
                  Return the items
                </button>
              </div>
            )}
          </>
        ))}
    </main>
  );
}
