import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { requestApproval } from '../../lib/approval';
import { fmtLbp } from '../../lib/money';

type Props = {
  saleId: number;
  saleRef: number;
  /** What the server worked out this return is worth. The manager approves exactly this, and no more. */
  valueLbp: number;
  onApproved: (token: string, managerName: string) => void;
  onClose: () => void;
};

/** A cashier cannot take goods back alone: the manager types their own name and password here (not a PIN) and sees what they approve. */
export function ReturnApprovalDialog({ saleId, saleRef, valueLbp, onApproved, onClose }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!navigator.onLine) return setError("A manager's approval needs the connection to the server, which is not there right now");
    if (!username.trim() || !password) return setError("Type the manager's name and password");
    setBusy(true);
    setError('');
    try {
      const result = await requestApproval({ username: username.trim(), password }, { scope: 'return', saleId, maxLbp: valueLbp });
      onApproved(result.approvalToken, result.approvedBy.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The approval could not be checked');
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <Modal label="Manager approval" onClose={onClose}>
      <form onSubmit={approve} style={{ display: 'grid', gap: 14 }}>
        <h2>Manager approval</h2>
        <div className="banner warn">
          <div className="title">{`Goods back from sale ${saleRef}: ${fmtLbp(valueLbp)}`}</div>
          <div>A cashier cannot take goods back alone. The manager types their own name and password below.</div>
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
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            Approve
          </button>
        </div>
      </form>
    </Modal>
  );
}
