import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, patch, post } from '../../lib/api';
import type { Customer } from '../../lib/types';
import { toast } from '../../store/toast';

type Props = { customer: Customer | null; onClose: () => void; onSaved: () => unknown };

const orNull = (s: string) => (s.trim() === '' ? null : s.trim());

/** Add a customer, or change one's name and contact details. */
export function CustomerDialog({ customer, onClose, onSaved }: Props) {
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [address, setAddress] = useState(customer?.address ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Type the name');
    setBusy(true);
    setError('');
    try {
      if (customer) {
        await patch(`/customers/${customer.id}`, {
          name: name.trim(),
          phone: orNull(phone),
          address: orNull(address),
          email: orNull(email),
        });
        toast.success('Saved');
      } else {
        await post('/customers', {
          name: name.trim(),
          ...(orNull(phone) ? { phone: orNull(phone) } : {}),
          ...(orNull(address) ? { address: orNull(address) } : {}),
          ...(orNull(email) ? { email: orNull(email) } : {}),
        });
        toast.success(`${name.trim()} was added`);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
      setBusy(false);
    }
  }

  return (
    <Modal label={customer ? 'Edit customer' : 'New customer'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{customer ? `Edit ${customer.name}` : 'New customer'}</h2>
        <label className="field">
          Name
          <input autoFocus autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Phone
          <input autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
        </label>
        <label className="field">
          Address
          <input autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
        </label>
        <label className="field">
          Email
          <input autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
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
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
