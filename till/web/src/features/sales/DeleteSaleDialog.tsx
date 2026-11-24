import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, post } from '../../lib/api';
import { requestApproval } from '../../lib/approval';
import { fmtLbp } from '../../lib/money';
import { toast } from '../../store/toast';
import type { SaleListItem } from '../../lib/types';

type Props = { sale: SaleListItem; voided: boolean; onClose: () => void; onDone: () => void };

const WORD = 'DELETE';

/**
 * Delete a cancelled sale, or one that has had items taken back, for good. It cannot be undone, so it says what will change, asks
 * why, and wants the word typed. A cashier cannot do it alone: the server says so, and the manager types their own name and
 * password here, for this sale only.
 */
export function DeleteSaleDialog({ sale, voided, onClose, onDone }: Props) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<'confirm' | 'approve'>('confirm');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per deletion: pressing the button twice, or retrying after a hiccup, can never delete twice.
  const [key] = useState(() => crypto.randomUUID());

  async function send(token?: string) {
    setBusy(true);
    setError('');
    try {
      await post(`/sales/${sale.id}/delete`, { reason: reason.trim(), approvalToken: token }, { idempotencyKey: key });
      toast.success(`Sale ${sale.ref} was deleted`);
      await Promise.all(
        ['sales', 'sale', 'receipt', 'register', 'alerts', 'products', 'customers', 'stock', 'reports', 'dashboard'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DELETE_NEEDS_APPROVAL') setStep('approve');
      else setError(err instanceof ApiError ? err.message : 'The sale could not be deleted');
      setBusy(false);
    }
  }

  function confirm(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!reason.trim()) return setError('Say why the sale is being deleted');
    if (typed.trim() !== WORD) return setError(`Type ${WORD} to confirm`);
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
      const result = await requestApproval({ username: username.trim(), password }, { scope: 'delete', saleId: sale.id });
      await send(result.approvalToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The approval could not be checked');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal label="Delete this sale" onClose={onClose}>
      {step === 'confirm' ? (
        <form onSubmit={confirm} style={{ display: 'grid', gap: 14 }}>
          <h2>{`Delete sale ${sale.ref} for good`}</h2>
          <div className="banner warn">
            <div className="title">This cannot be undone.</div>
            <div>
              {voided
                ? `The sale (${fmtLbp(sale.totalLbp)}) and its lines and payments are removed. It was already cancelled, so the stock and the register do not change.`
                : `The sale (${fmtLbp(sale.totalLbp)}) and the items taken back from it are removed as if neither had happened: the stock goes back, the money it took and refunded comes out of the register's figures (a register that was already counted will show a different difference), and the customer no longer owes what it left owing.`}
            </div>
            <div>The audit log keeps a note of what it was, who deleted it and why.</div>
          </div>
          <label className="field">
            Why?
            <input autoFocus autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="field">
            {`Type ${WORD} to confirm`}
            <input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
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
              Delete it for good
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={approve} style={{ display: 'grid', gap: 14 }}>
          <h2>Manager approval</h2>
          <div className="banner warn">
            <div className="title">{`Delete sale ${sale.ref} for good: ${fmtLbp(sale.totalLbp)}`}</div>
            <div>A cashier cannot delete a sale alone. The manager types their own name and password below.</div>
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
            <button type="button" className="btn" onClick={() => setStep('confirm')} disabled={busy}>
              Back
            </button>
            <button type="submit" className="btn danger big" disabled={busy}>
              Approve and delete
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
