import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { useRate } from '../../hooks/useTillData';
import { ApiError, get, post } from '../../lib/api';
import { fmtLbp, fmtUsd, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, Customer, Method } from '../../lib/types';
import { toast } from '../../store/toast';
import { usdToLbp } from '@pos/shared';
import { Icon } from '../../components/Icon';
import { CustomerSalesDialog } from './CustomerSalesDialog';

/** Who owes the shop money, and a way to take a payment against what they owe (US-32, US-33). */
export function AccountsPage() {
  const [q, setQ] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [paying, setPaying] = useState<Customer | null>(null);
  const [browsing, setBrowsing] = useState<Customer | null>(null);
  const customers = useQuery({
    queryKey: ['customers', q, everyone],
    queryFn: () =>
      get<{ data: Customer[] }>(`/customers?limit=100&withBalance=${!everyone}&q=${encodeURIComponent(q.trim())}`).then((r) =>
        r.data.filter((c) => !c.isWalkIn),
      ),
  });
  const rows = customers.data ?? [];
  const owed = rows.reduce((sum, c) => sum + c.balanceLbp, 0);

  return (
    <main className="page">
      <h1>
        <Icon name="customers" size={26} />
        Customer accounts
      </h1>
      <div className="toolbar">
        <label className="field">
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone" />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} style={{ width: 20, height: 20 }} />
          Show everyone, not only those who owe
        </label>
        <span className="chip">{`Total owed ${fmtLbp(owed)}`}</span>
      </div>
      {customers.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">{everyone ? 'No customers found.' : 'Nobody owes anything.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th className="num">Owes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="muted">{c.phone ?? ''}</td>
                <td className="num">{fmtLbp(c.balanceLbp)}</td>
                <td className="num">
                  <button className="btn small" onClick={() => setBrowsing(c)} aria-label={`Browse sales of ${c.name}`}>
                    <Icon name="sales" size={16} />
                    Sales
                  </button>{' '}
                  {c.balanceLbp > 0 && (
                    <button className="btn small primary" onClick={() => setPaying(c)}>
                      Receive payment
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {browsing && <CustomerSalesDialog customer={browsing} onClose={() => setBrowsing(null)} />}
      {paying && <PaymentDialog customer={paying} onClose={() => setPaying(null)} />}
    </main>
  );
}

function PaymentDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const queryClient = useQueryClient();
  const rate = useRate().data;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [currency, setCurrency] = useState<Currency>('LBP');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id for this dialog: pressing Confirm twice (or a retry after a hiccup) can never take the payment twice.
  const [key] = useState(() => crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = currency === 'USD' ? parseUsdInput(amount) : parseLbpInput(amount);
    if (!(value > 0)) return setError('Enter the amount received');
    const inLbp = currency === 'USD' ? usdToLbp(value, rate ?? 90000) : value;
    if (inLbp > customer.balanceLbp)
      return setError(`${customer.name} owes ${fmtLbp(customer.balanceLbp)}, which is less than this payment`);
    setBusy(true);
    setError('');
    try {
      await post(`/customers/${customer.id}/payments`, { method, currency, amount: value }, { idempotencyKey: key });
      toast.success(`Payment recorded: ${currency === 'USD' ? fmtUsd(value) : fmtLbp(value)} from ${customer.name}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['register'] }),
      ]);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The payment could not be recorded');
      setBusy(false);
    }
  }

  return (
    <Modal label="Receive payment" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{`Payment from ${customer.name}`}</h2>
        <div className="due">
          <span>Owes</span>
          <span className="amount num">{fmtLbp(customer.balanceLbp)}</span>
        </div>
        <label className="field">
          Amount
          <input
            className="num"
            inputMode="decimal"
            autoFocus
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
          />
        </label>
        <div className="method">
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="LBP">LBP</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label className="field">
            Paid by
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              <option value="cash">Cash</option>
              <option value="whish">Whish</option>
              <option value="omt">OMT</option>
            </select>
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          It goes against their oldest unpaid sale first.
        </p>
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
            Confirm
          </button>
        </div>
      </form>
    </Modal>
  );
}
