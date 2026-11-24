import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, post } from '../../lib/api';
import { requestApproval } from '../../lib/approval';
import { fmtLbp } from '../../lib/money';
import { toast } from '../../store/toast';
import type { SaleListItem } from '../../lib/types';

type Props = { sale: SaleListItem; onClose: () => void; onDone: () => void };

/**
 * Cancel a sale that was just made, while its register is still open. A reason is required. A cashier cannot do it alone: the
 * server says so, and the manager types their own name and password here, for this sale only.
 */
export function VoidSaleDialog({ sale, onClose, onDone }: Props) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<'reason' | 'approve'>('reason');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per cancellation: pressing the button twice, or retrying after a hiccup, can never cancel it twice.
  const [key] = useState(() => crypto.randomUUID());

  async function send(token?: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/sales/${sale.id}/void`, { reason: reason.trim(), approvalToken: token }, { idempotencyKey: key });
      toast.success(`Sale ${sale.ref} is cancelled`);
      await Promise.all(
        ['sales', 'sale', 'receipt', 'register', 'alerts', 'products', 'customers'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VOID_NEEDS_APPROVAL') setStep('approve');
      else setError(err instanceof ApiError ? err.message : 'The sale could not be cancelled');
      setBusy(false);
    }
  }

  function askReason(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setError('Say why the sale is being cancelled');
    void send();
  }

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!navigator.onLine) return setError("A manager's approval needs the connection to the server, which is not there right now");
    if (!username.trim() || !password) return setError("Type the manager's name and password");
    setBusy(true);
    setError('');
    try {
      const result = await requestApproval({ username: username.trim(), password }, { scope: 'void', saleId: sale.id });
      await send(result.approvalToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The approval could not be checked');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal label="Cancel this sale" onClose={onClose}>
      {step === 'reason' ? (
        <form onSubmit={askReason} style={{ display: 'grid', gap: 14 }}>
          <h2>{`Cancel sale ${sale.ref}`}</h2>
          <div className="banner warn">
            <div className="title">{`${fmtLbp(sale.totalLbp)} will come out of the register and the goods go back on the shelf.`}</div>
            <div>
              It stays in the records as cancelled. This only works while the register that took the sale is still open; after that, use
              Return items.
            </div>
          </div>
          <label className="field">
            Why?
            <input autoFocus autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Keep the sale
            </button>
            <button type="submit" className="btn danger big" disabled={busy}>
              Cancel the sale
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={approve} style={{ display: 'grid', gap: 14 }}>
          <h2>Manager approval</h2>
          <div className="banner warn">
            <div className="title">{`Cancel sale ${sale.ref}: ${fmtLbp(sale.totalLbp)}`}</div>
            <div>A cashier cannot cancel a sale alone. The manager types their own name and password below.</div>
          </div>
          <label className="field">
            Manager's name
            <input autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            Manager's password
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setStep('reason')} disabled={busy}>
              Back
            </button>
            <button type="submit" className="btn primary big" disabled={busy}>
              Approve
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
