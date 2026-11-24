import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { requestApproval } from '../../lib/approval';
import { approvalPct, discountPct, needsApproval, parseDiscountInput, type Approval, type Discount } from '../../lib/discount';
import { fmtLbp } from '../../lib/money';
import type { Role } from '../../lib/types';
import type { CartTotals } from '../../store/cart';

type Props = {
  /** The cart priced with a given discount, so the dialog can show the effect before it is applied. */
  preview: (discount: Discount) => CartTotals;
  limitPct: number;
  role: Role;
  initial: Discount | null;
  onApply: (discount: Discount, approval: Approval | null) => void;
  onRemove: () => void;
  onClose: () => void;
};

const QUICK = [5, 10, 15, 20];

/**
 * A discount on the whole cart. Within a cashier's limit it applies at once. Above it, a manager types their name and
 * password here (not a PIN) and sees exactly what they are approving; the approval covers that discount and nothing more.
 */
export function DiscountDialog({ preview, limitPct, role, initial, onApply, onRemove, onClose }: Props) {
  const [kind, setKind] = useState<Discount['type']>(initial?.type ?? 'percent');
  const [text, setText] = useState(initial ? String(initial.value) : '');
  const [step, setStep] = useState<'amount' | 'approve'>('amount');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = parseDiscountInput(kind, text);
  const shown = parsed.ok ? preview(parsed.discount) : null;
  const tooBig = shown?.discountInvalid === true;
  const pct = shown && !tooBig ? discountPct(shown.discountLbp, shown.subtotalLbp) : 0;
  const approvalNeeded = parsed.ok && !tooBig && needsApproval(role, pct, limitPct);

  function next(e: FormEvent) {
    e.preventDefault();
    if (!parsed.ok) return setError(parsed.error);
    if (tooBig) return setError('That is more than the cart is worth');
    setError('');
    if (approvalNeeded) setStep('approve');
    else onApply(parsed.discount, null);
  }

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (!parsed.ok || busy) return;
    if (!navigator.onLine) return setError("A manager's approval needs the connection to the server, which is not there right now");
    if (!username.trim() || !password) return setError("Type the manager's name and password");
    setBusy(true);
    setError('');
    const maxPct = approvalPct(pct);
    try {
      const result = await requestApproval({ username: username.trim(), password }, { scope: 'discount', pct: maxPct });
      onApply(parsed.discount, { token: result.approvalToken, managerName: result.approvedBy.name, maxPct });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The approval could not be checked');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal label="Discount" onClose={onClose}>
      {step === 'amount' ? (
        <form onSubmit={next} style={{ display: 'grid', gap: 14 }}>
          <h2>Discount</h2>
          <div className="tabs" role="tablist" aria-label="Kind of discount">
            <button type="button" role="tab" aria-selected={kind === 'percent'} onClick={() => setKind('percent')}>
              Percent (%)
            </button>
            <button type="button" role="tab" aria-selected={kind === 'amount'} onClick={() => setKind('amount')}>
              Amount (LL)
            </button>
          </div>
          <label className="field">
            {kind === 'percent' ? 'Percent off the whole cart' : 'Lira off the whole cart'}
            <input
              className="num"
              inputMode="decimal"
              autoFocus
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {kind === 'percent' && (
            <div className="buttons" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {QUICK.map((q) => (
                <button key={q} type="button" className="btn small" onClick={() => setText(String(q))}>
                  {`${q}%`}
                </button>
              ))}
            </div>
          )}
          {shown && !tooBig && (
            <div className="totals" aria-live="polite">
              <div className="row">
                <span>{`Discount (${Number(pct.toFixed(2))}%)`}</span>
                <span className="num" data-testid="discount-preview">{`−${fmtLbp(shown.discountLbp)}`}</span>
              </div>
              <div className="row">
                <span>New total</span>
                <span className="num" data-testid="discount-new-total">
                  {fmtLbp(shown.totalLbp)}
                </span>
              </div>
            </div>
          )}
          {role === 'cashier' && (
            <p className="muted" style={{ margin: 0 }}>
              {approvalNeeded
                ? `Your limit is ${limitPct}%. A manager has to approve this one.`
                : `You can give up to ${limitPct}% yourself. Above that a manager has to approve.`}
            </p>
          )}
          {(error || tooBig) && (
            <div className="warning" role="alert">
              {tooBig ? 'That is more than the cart is worth' : error}
            </div>
          )}
          <div className="dialog-actions">
            {initial && (
              <button type="button" className="btn danger" onClick={onRemove} style={{ marginInlineEnd: 'auto' }}>
                Remove discount
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary big" disabled={!parsed.ok || tooBig}>
              {approvalNeeded ? 'Ask a manager' : 'Apply'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={approve} style={{ display: 'grid', gap: 14 }}>
          <h2>Manager approval</h2>
          <div className="banner warn">
            <div className="title">{`${Number(pct.toFixed(2))}% off  (−${shown ? fmtLbp(shown.discountLbp) : ''})`}</div>
            <div>{`That is above the cashier's limit of ${limitPct}%. The manager types their own name and password below.`}</div>
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
            <button type="button" className="btn" onClick={() => setStep('amount')} disabled={busy}>
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
