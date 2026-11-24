import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { requestApproval } from '../../lib/approval';
import { fmtLbp } from '../../lib/money';
import type { Role } from '../../lib/types';
import type { CartLine, PriceOverride } from '../../store/cart';

type Props = {
  line: CartLine;
  /** The catalogue's unit price in lira at today's rate. */
  catalogLbp: number;
  role: Role;
  onApply: (price: PriceOverride | null) => void;
  onClose: () => void;
};

/**
 * Sell one line at another price. A manager just types it. A cashier types it and a manager approves it here with their own
 * name and password (not a PIN): the approval is for this product at exactly this price, once, for ten minutes.
 */
export function PriceDialog({ line, catalogLbp, role, onApply, onClose }: Props) {
  const [text, setText] = useState(line.price ? String(line.price.lbp) : '');
  const [step, setStep] = useState<'price' | 'approve'>('price');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = /^\d{1,12}$/.test(text.trim());
  const price = valid ? Number(text.trim()) : null;
  const same = price === catalogLbp;
  const isManager = role === 'manager' || role === 'admin';
  const name = line.product.name.trim();

  function next(e: FormEvent) {
    e.preventDefault();
    if (price === null) return setError('Type the price in lira, as a whole number');
    setError('');
    if (same) return onApply(null);
    if (isManager) return onApply({ lbp: price });
    if (!navigator.onLine) return setError("A manager's approval needs the connection to the server, which is not there right now");
    setStep('approve');
  }

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (price === null || busy) return;
    if (!username.trim() || !password) return setError("Type the manager's name and password");
    setBusy(true);
    setError('');
    try {
      const result = await requestApproval(
        { username: username.trim(), password },
        { scope: 'price', productId: line.product.id, priceLbp: price },
      );
      onApply({ lbp: price, token: result.approvalToken, approvedBy: result.approvedBy.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The approval could not be checked');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal label="Change the price" onClose={onClose}>
      {step === 'price' ? (
        <form onSubmit={next} style={{ display: 'grid', gap: 14 }}>
          <h2>Change the price</h2>
          <p style={{ margin: 0 }}>{name}</p>
          <p className="muted" style={{ margin: 0 }}>{`Catalogue price: ${fmtLbp(catalogLbp)}`}</p>
          <label className="field">
            Price for one (lira)
            <input
              className="num"
              inputMode="numeric"
              autoFocus
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {!isManager && price !== null && !same && (
            <p className="muted" style={{ margin: 0 }}>
              A manager has to approve a price that is not the catalogue&apos;s.
            </p>
          )}
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            {line.price && (
              <button type="button" className="btn danger" style={{ marginInlineEnd: 'auto' }} onClick={() => onApply(null)}>
                Back to the catalogue price
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary big" disabled={price === null}>
              {!isManager && price !== null && !same ? 'Ask a manager' : 'Apply'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={approve} style={{ display: 'grid', gap: 14 }}>
          <h2>Manager approval</h2>
          <div className="banner warn">
            <div className="title">{`${name} at ${fmtLbp(price ?? 0)} (catalogue ${fmtLbp(catalogLbp)})`}</div>
            <div>A cashier cannot change a price alone. The manager types their own name and password below.</div>
          </div>
          <label className="field">
            Manager&apos;s name
            <input autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            Manager&apos;s password
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <div className="warning" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setStep('price')} disabled={busy}>
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
