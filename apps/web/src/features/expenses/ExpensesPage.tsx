import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import { fmtLbp, fmtMoney, fmtUsd, parseLbpInput, parseUsdInput } from '../../lib/money';
import type { Currency, Expense, Method } from '../../lib/types';
import { toast } from '../../store/toast';
import { useLookup } from '../products/lookups';
import { Icon } from '../../components/Icon';

type Page = { data: Expense[]; totals: { USD: number; LBP: number }; nextCursor: number | null };

// A date typed by the manager means that day in the shop's own time, not in UTC.
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/** What the shop spends that is not stock: rent, electricity, a delivery. Never edited afterwards. */
export function ExpensesPage() {
  const [categoryId, setCategoryId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [adding, setAdding] = useState(false);
  const categories = useLookup('expense-categories');

  const expenses = useInfiniteQuery({
    queryKey: ['expenses', categoryId, from, to],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (categoryId) q.set('categoryId', categoryId);
      if (from) q.set('from', dayStart(from));
      if (to) q.set('to', dayEnd(to));
      if (pageParam) q.set('cursor', String(pageParam));
      return get<Page>(`/expenses?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = expenses.data?.pages.flatMap((p) => p.data) ?? [];
  const totals = expenses.data?.pages[0]?.totals ?? { USD: 0, LBP: 0 };

  return (
    <main className="page">
      <h1>
        <Icon name="expenses" size={26} />
        Expenses
      </h1>
      <div className="toolbar">
        <label className="field">
          Type
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All types</option>
            {(categories.data ?? []).map((c) => (
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
        <span className="chip" data-testid="expense-total">{`Total ${fmtLbp(totals.LBP)} + ${fmtUsd(totals.USD)}`}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          New expense
        </button>
      </div>

      {expenses.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">No expenses recorded.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>What</th>
              <th>Type</th>
              <th>Paid</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} data-testid="expense-row">
                <td className="muted">{e.createdAt.slice(0, 10)}</td>
                <td>
                  {e.title}
                  {e.reference && <span className="muted">{` · ${e.reference}`}</span>}
                </td>
                <td className="muted">{e.categoryName ?? ''}</td>
                <td className="muted">{e.paidFromRegister ? 'From the till' : 'Elsewhere'}</td>
                <td className="num">{fmtMoney(e.amountMinor, e.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {expenses.hasNextPage && (
        <p>
          <button className="btn" disabled={expenses.isFetchingNextPage} onClick={() => void expenses.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
      {adding && <ExpenseDialog onClose={() => setAdding(false)} />}
    </main>
  );
}

const WHERE: { value: '' | Method; label: string }[] = [
  { value: '', label: 'Not from the till (paid elsewhere)' },
  { value: 'cash', label: 'Cash drawer' },
  { value: 'whish', label: 'Whish wallet' },
  { value: 'omt', label: 'OMT wallet' },
];

function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const categories = useLookup('expense-categories');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [currency, setCurrency] = useState<Currency>('LBP');
  const [amount, setAmount] = useState('');
  const [payFrom, setPayFrom] = useState<'' | Method>('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = currency === 'USD' ? parseUsdInput(amount) : parseLbpInput(amount);
    if (!title.trim()) return setError('Say what it was for');
    if (!(amountMinor > 0)) return setError('Enter the amount');
    setBusy(true);
    setError('');
    try {
      await post('/expenses', {
        title: title.trim(),
        categoryId: categoryId ? Number(categoryId) : null,
        currency,
        amountMinor,
        reference: reference.trim(),
        note: note.trim() || null,
        ...(payFrom ? { payFrom: { method: payFrom } } : {}),
      });
      toast.success(`Expense recorded: ${title.trim()}`);
      await Promise.all(['expenses', 'register', 'cash-movements'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The expense could not be recorded');
      setBusy(false);
    }
  }

  return (
    <Modal label="New expense" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>New expense</h2>
        <label className="field">
          What was it for
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus autoComplete="off" />
        </label>
        <div className="method">
          <label className="field">
            Type
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">No type</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="LBP">LBP (lira)</option>
              <option value="USD">USD (dollars)</option>
            </select>
          </label>
          <label className="field">
            {`Amount (${currency})`}
            <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Paid from
            <select value={payFrom} onChange={(e) => setPayFrom(e.target.value as '' | Method)}>
              {WHERE.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {payFrom && (
          <p className="muted" style={{ margin: 0 }}>
            {`The ${currency} balance of this ${payFrom === 'cash' ? 'drawer' : 'wallet'} goes down by the same amount, so tonight's count still agrees. The register must be open.`}
          </p>
        )}
        <label className="field">
          Invoice or reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" autoComplete="off" />
        </label>
        <label className="field">
          Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" autoComplete="off" />
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
            Save expense
          </button>
        </div>
      </form>
    </Modal>
  );
}
