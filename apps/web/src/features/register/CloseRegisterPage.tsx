import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRegister } from '../../hooks/useTillData';
import { ApiError, post } from '../../lib/api';
import { fmtLbp, fmtMoney, fmtUsd, groupThousands, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, Method } from '../../lib/types';
import { useConnection } from '../../store/connection';
import { Icon } from '../../components/Icon';

const NAMES: Record<Method, string> = { cash: 'Cash', whish: 'Whish', omt: 'OMT' };
const ORDER: Method[] = ['cash', 'whish', 'omt'];
const keyOf = (m: Method, c: Currency) => `${m}/${c}`;

type Closed = {
  closedAt: string;
  balances: {
    method: Method;
    currency: Currency;
    opening: number;
    salesIn: number;
    changeOut: number;
    customerPaymentsIn: number;
    refundsOut: number;
    movementsNet: number;
    expected: number;
    counted: number;
    variance: number;
  }[];
  totals: { salesCount: number; salesTotalLbp: number; customerPaymentsCount: number; refundsCount: number; owedOnAccountLbp: number };
};

/**
 * End of the day: count each balance (cash, Whish and OMT, in dollars and in lira), see what the till expected, and close.
 * A closed register can never be changed.
 */
export function CloseRegisterPage() {
  const register = useRegister();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const waiting = useConnection((s) => s.waiting);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState<Closed | null>(null);

  const session = register.data;
  const balances = session
    ? [...session.balances].sort((a, b) => ORDER.indexOf(a.method) - ORDER.indexOf(b.method) || (a.currency === 'USD' ? -1 : 1))
    : [];
  const parse = (m: Method, c: Currency) =>
    c === 'USD' ? parseUsdInput(counted[keyOf(m, c)] ?? '') : parseLbpInput(counted[keyOf(m, c)] ?? '');
  const typed = (m: Method, c: Currency) => (counted[keyOf(m, c)] ?? '').trim() !== '';

  async function close() {
    if (!session) return;
    const countedBalances = [];
    for (const b of balances) {
      if (!typed(b.method, b.currency)) return setError(`Count ${NAMES[b.method]} ${b.currency} (type 0 if it is empty)`);
      const amount = parse(b.method, b.currency);
      if (Number.isNaN(amount)) return setError(`Check the amount in ${NAMES[b.method]} ${b.currency}`);
      countedBalances.push({ method: b.method, currency: b.currency, amount });
    }
    setBusy(true);
    setError('');
    try {
      const z = await post<Closed>(`/registers/${session.id}/close`, { countedBalances });
      setClosed(z);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not close the register');
    }
    setBusy(false);
  }

  async function startNewDay() {
    await queryClient.invalidateQueries({ queryKey: ['register'] }); // the till then asks for the new opening balances
    navigate('/');
  }

  if (closed) {
    const bad = closed.balances.filter((b) => b.variance !== 0);
    return (
      <main className="page">
        <h1>Register closed</h1>
        <div className={`banner ${bad.length ? 'warn' : 'ok'}`} style={{ marginBottom: 12 }}>
          <div className="title">
            {bad.length ? `${bad.length} ${bad.length === 1 ? 'balance is' : 'balances are'} out` : 'Everything balanced'}
          </div>
          <div className="muted">{`${closed.totals.salesCount} sales · ${fmtLbp(closed.totals.salesTotalLbp)} · ${closed.totals.customerPaymentsCount} account payments · ${closed.totals.refundsCount} refunds`}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Balance</th>
              <th className="num">Opening</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {closed.balances.map((b) => (
              <tr key={keyOf(b.method, b.currency)}>
                <td>{`${NAMES[b.method]} ${b.currency}`}</td>
                <td className="num">{fmtMoney(b.opening, b.currency)}</td>
                <td className="num">{fmtMoney(b.expected, b.currency)}</td>
                <td className="num">{fmtMoney(b.counted, b.currency)}</td>
                <td className={`num ${b.variance === 0 ? 'variance-ok' : 'variance-bad'}`}>
                  {b.variance === 0 ? 'OK' : `${b.variance > 0 ? '+' : ''}${fmtMoney(b.variance, b.currency)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions" style={{ marginTop: 14, gridTemplateColumns: '1fr 1fr', maxWidth: 520 }}>
          <button className="btn big" onClick={() => window.print()}>
            Print this report
          </button>
          <button className="btn big primary" onClick={() => void startNewDay()}>
            Open a new register
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>
        <Icon name="register" size={26} />
        Close the register
      </h1>
      <p className="muted">
        Count the cash in the drawer and each wallet’s balance, and type what you counted. The till shows what it expected.
      </p>
      {waiting > 0 && (
        <div className="warning" role="alert" style={{ marginBottom: 12 }}>
          {`${waiting} ${waiting === 1 ? 'sale is' : 'sales are'} still waiting to be sent to the server. Wait until they are sent before closing, or they will be missing from this report.`}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Balance</th>
            <th className="num">Opening</th>
            <th className="num">Expected</th>
            <th className="num">Counted</th>
            <th className="num">Difference</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => {
            const name = `${NAMES[b.method]} ${b.currency}`;
            const value = parse(b.method, b.currency);
            const diff = typed(b.method, b.currency) && !Number.isNaN(value) ? value - b.expected : null;
            return (
              <tr key={keyOf(b.method, b.currency)}>
                <td>{name}</td>
                <td className="num">{fmtMoney(b.opening, b.currency)}</td>
                <td className="num" data-testid={`expected-${NAMES[b.method]}-${b.currency}`}>
                  {fmtMoney(b.expected, b.currency)}
                </td>
                <td className="num">
                  <input
                    aria-label={`${name} counted`}
                    className="num"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={b.currency === 'USD' ? '0.00' : '0'}
                    value={counted[keyOf(b.method, b.currency)] ?? ''}
                    onChange={(e) => setCounted((c) => ({ ...c, [keyOf(b.method, b.currency)]: e.target.value }))}
                    style={{
                      width: 150,
                      minHeight: 44,
                      padding: '0 10px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      background: 'var(--bg)',
                    }}
                  />
                </td>
                <td className={`num ${diff === null ? '' : diff === 0 ? 'variance-ok' : 'variance-bad'}`}>
                  {diff === null
                    ? ''
                    : diff === 0
                      ? 'OK'
                      : `${diff > 0 ? '+' : ''}${b.currency === 'USD' ? fmtUsd(diff) : groupThousands(diff)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && (
        <div className="warning" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <div className="actions" style={{ marginTop: 14, gridTemplateColumns: '1fr 1fr', maxWidth: 520 }}>
        <button className="btn big" onClick={() => navigate('/')}>
          Back to checkout
        </button>
        <button className="btn big primary" onClick={() => void close()} disabled={busy || waiting > 0 || !session}>
          Close register
        </button>
      </div>
    </main>
  );
}
