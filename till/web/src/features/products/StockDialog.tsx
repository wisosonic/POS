import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, post } from '../../lib/api';
import { trimQty } from '../../lib/money';
import type { ProductFull, StockMovement } from '../../lib/types';
import { toast } from '../../store/toast';

const REASONS = ['Miscount', 'Damaged or expired', 'Gift or sample', 'Found stock', 'Other'];
const QTY = /^\d+(\.\d{1,3})?$/;
const label = (m: StockMovement) =>
  m.refType === 'adjustment' ? (m.note ?? 'Adjustment') : ({ sale: 'Sale', return: 'Return', purchase: 'Purchase' }[m.reason] ?? m.reason);

/**
 * Correct what the shelf holds: a miscount, damage, a gift. It is added to the ledger as a new line, never an edit of
 * history, and it may take a product below zero. Below the form is the ledger that makes up the quantity.
 */
export function StockDialog({ product, onClose }: { product: ProductFull; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [preset, setPreset] = useState(REASONS[0]!);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const stock = useQuery({
    queryKey: ['stock-of', product.id],
    queryFn: () => get<{ data: { qty: string }[] }>(`/stock?productId=${product.id}`).then((r) => r.data[0]?.qty ?? '0'),
  });
  const ledger = useQuery({
    queryKey: ['stock-ledger', product.id],
    queryFn: () => get<{ data: StockMovement[] }>(`/stock/${product.id}/movements?limit=15`).then((r) => r.data),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = amount.trim();
    if (!QTY.test(q) || !(Number(q) > 0)) return setError('Type how many, as a positive number');
    if (preset === 'Other' && !note.trim()) return setError('Say what the reason is');
    setBusy(true);
    setError('');
    try {
      await post('/stock/adjustments', {
        productId: product.id,
        qtyDelta: `${direction === 'remove' ? '-' : ''}${q}`,
        reason: preset === 'Other' ? note.trim() : note.trim() ? `${preset}: ${note.trim()}` : preset,
      });
      toast.success(`Stock of ${product.name.trim()} updated`);
      setAmount('');
      setNote('');
      await Promise.all([
        stock.refetch(),
        ledger.refetch(),
        ...['products', 'alerts'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The stock could not be changed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={`Stock of ${product.name.trim()}`} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{product.name.trim()}</h2>
        <div className="due">
          <span>In stock now</span>
          <span className="amount num" data-testid="stock-now">
            {stock.data === undefined ? '…' : trimQty(stock.data)}
          </span>
        </div>
        <div className="tabs" role="tablist" aria-label="Direction">
          <button type="button" role="tab" aria-selected={direction === 'add'} onClick={() => setDirection('add')}>
            Add to stock
          </button>
          <button type="button" role="tab" aria-selected={direction === 'remove'} onClick={() => setDirection('remove')}>
            Take out of stock
          </button>
        </div>
        <div className="method">
          <label className="field">
            How many
            <input
              className="num"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </label>
          <label className="field">
            Reason
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          {preset === 'Other' ? 'What happened' : 'Note (optional)'}
          <input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}

        <h3>Recent movements</h3>
        {(ledger.data ?? []).length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              {(ledger.data ?? []).map((m) => (
                <tr key={m.id} data-testid="stock-movement">
                  <td className="muted">{m.createdAt.slice(0, 10)}</td>
                  <td>{label(m)}</td>
                  <td
                    className={`num ${m.qtyDelta.startsWith('-') ? 'variance-bad' : ''}`}
                  >{`${m.qtyDelta.startsWith('-') ? '' : '+'}${trimQty(m.qtyDelta)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            Save change
          </button>
        </div>
      </form>
    </Modal>
  );
}
