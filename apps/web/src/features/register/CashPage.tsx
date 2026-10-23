import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { useRegister } from '../../hooks/useTillData';
import { ApiError, get, post } from '../../lib/api';
import { fmtMoney, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { CashMovement, Currency, Method } from '../../lib/types';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

const NAME: Record<Method, string> = { cash: 'Cash', whish: 'Whish', omt: 'OMT' };
const METHODS: Method[] = ['cash', 'whish', 'omt'];
const time = (iso: string) => `${iso.slice(0, 10)} ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

const describe = (m: CashMovement) => {
  const b = (x: NonNullable<CashMovement['from']>) => `${NAME[x.method]} ${x.currency}`;
  if (m.type === 'in') return `In to ${b(m.to!)}`;
  if (m.type === 'out') return `Out of ${b(m.from!)}`;
  return `${b(m.from!)} → ${b(m.to!)}`;
};

/** Money that moves in or out of the drawer and wallets apart from sales: a supplier paid in cash, a float topped up, cash moved to a wallet. */
export function CashPage() {
  const register = useRegister().data;
  const [moving, setMoving] = useState(false);
  const movements = useQuery({
    queryKey: ['cash-movements', register?.id],
    enabled: !!register,
    queryFn: () => get<{ data: CashMovement[] }>(`/registers/${register!.id}/cash-movements`).then((r) => r.data),
  });
  const rows = movements.data ?? [];

  return (
    <main className="page">
      <h1>
        <Icon name="cash" size={26} />
        Cash in and out
      </h1>
      <div className="toolbar">
        <p className="muted" style={{ margin: 0 }}>
          Record money that leaves or enters the drawer and wallets apart from sales, so the closing count agrees.
        </p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setMoving(true)}>
          Move money
        </button>
      </div>

      {register && (
        <table aria-label="Balances now">
          <thead>
            <tr>
              <th>Balance</th>
              <th className="num">Should be</th>
            </tr>
          </thead>
          <tbody>
            {register.balances.map((b) => (
              <tr key={`${b.method}/${b.currency}`}>
                <td>{`${NAME[b.method]} ${b.currency}`}</td>
                <td className="num">{fmtMoney(b.expected, b.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>This session’s movements</h2>
      {movements.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">Nothing has moved yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Reason</th>
              <th>By</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} data-testid="movement-row">
                <td className="muted">{time(m.createdAt)}</td>
                <td>{describe(m)}</td>
                <td>{m.reason}</td>
                <td className="muted">{m.userName ?? ''}</td>
                <td className="num">{fmtMoney(m.amount, (m.from ?? m.to)!.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {moving && register && <MoveDialog sessionId={register.id} onClose={() => setMoving(false)} />}
    </main>
  );
}

type Kind = 'in' | 'out' | 'transfer';

function MoveDialog({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind>('out');
  const [currency, setCurrency] = useState<Currency>('LBP');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState<Method>('cash');
  const [to, setTo] = useState<Method>('whish');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = currency === 'USD' ? parseUsdInput(amount) : parseLbpInput(amount);
    if (!(value > 0)) return setError('Enter the amount');
    if (!reason.trim()) return setError('Say why the money moved');
    if (kind === 'transfer' && from === to) return setError('Choose two different balances');
    setBusy(true);
    setError('');
    try {
      await post(`/registers/${sessionId}/cash-movements`, {
        type: kind,
        amount: value,
        reason: reason.trim(),
        ...(kind !== 'in' ? { from: { method: from, currency } } : {}),
        ...(kind !== 'out' ? { to: { method: kind === 'in' ? from : to, currency } } : {}),
      });
      toast.success('Recorded');
      await Promise.all(['register', 'cash-movements'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be recorded');
      setBusy(false);
    }
  }

  const methodSelect = (label: string, value: Method, set: (m: Method) => void) => (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => set(e.target.value as Method)}>
        {METHODS.map((m) => (
          <option key={m} value={m}>
            {NAME[m]}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal label="Move money" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>Move money</h2>
        <div className="tabs" role="tablist" aria-label="Kind of movement">
          {(
            [
              ['out', 'Money out'],
              ['in', 'Money in'],
              ['transfer', 'Between balances'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="method">
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="LBP">LBP (lira)</option>
              <option value="USD">USD (dollars)</option>
            </select>
          </label>
          <label className="field">
            {`Amount (${currency})`}
            <input
              className="num"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </label>
          {methodSelect(kind === 'in' ? 'Into' : 'Out of', from, setFrom)}
          {kind === 'transfer' && methodSelect('Into', to, setTo)}
        </div>
        <label className="field">
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: paid the bread supplier"
            autoComplete="off"
          />
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
            Record
          </button>
        </div>
      </form>
    </Modal>
  );
}
