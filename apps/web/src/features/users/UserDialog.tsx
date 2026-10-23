import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, patch, post } from '../../lib/api';
import type { Role } from '../../lib/types';
import { toast } from '../../store/toast';
import type { UserRow } from './UsersPage';

type Props = { user: UserRow | null; isMe: boolean; onClose: () => void; onSaved: () => unknown };

/**
 * Add a person, or change one. A first password given here is only a first one: unless the box is unticked, the person is made
 * to choose their own the first time they sign in, so the admin never needs to know it afterwards.
 */
export function UserDialog({ user, isMe, onClose, onSaved }: Props) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'cashier');
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState('');
  const [mustReset, setMustReset] = useState(true);
  const [pin, setPin] = useState('');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const showPin = role === 'cashier';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Type the name');
    if (!user && !/^[A-Za-z0-9._-]{3,32}$/.test(username.trim()))
      return setError('The username is 3 to 32 letters, digits, dots, dashes or underscores');
    if ((!user || password) && password.length < 8) return setError('The password needs at least 8 characters');
    if (pin && !/^\d{4,8}$/.test(pin)) return setError('The PIN is 4 to 8 digits');
    setBusy(true);
    setError('');
    try {
      if (!user) {
        const made = await post<UserRow>('/users', {
          username: username.trim(),
          name: name.trim(),
          role,
          password,
          ...(showPin && pin ? { pin } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        });
        if (mustReset) await patch(`/users/${made.id}`, { mustResetPassword: true });
        toast.success(`${name.trim()} can sign in`);
      } else {
        await patch(`/users/${user.id}`, {
          name: name.trim(),
          role,
          active,
          phone: phone.trim() || null,
          ...(password ? { password, mustResetPassword: mustReset } : {}),
          ...(showPin && pin ? { pin } : {}),
        });
        toast.success('Saved');
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
      setBusy(false);
    }
  }

  async function removePin() {
    if (!user || busy) return;
    setBusy(true);
    try {
      await patch(`/users/${user.id}`, { pin: null });
      toast.success('PIN removed');
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The PIN could not be removed');
      setBusy(false);
    }
  }

  return (
    <Modal label={user ? 'Edit user' : 'New user'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>{user ? `Edit ${user.username}` : 'New user'}</h2>
        {!user && (
          <label className="field">
            Username (what they type to sign in)
            <input autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
        )}
        <label className="field">
          Name (printed on receipts)
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!!user} />
        </label>
        <label className="field">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="cashier">Cashier: sells, takes payments, opens and closes the register</option>
            <option value="manager">Manager: also products, purchases, returns, reports, and approves at the till</option>
            <option value="admin">Admin: also users, settings, exchange rate, backups</option>
          </select>
        </label>
        {user && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={active}
              disabled={isMe}
              onChange={(e) => setActive(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            Can sign in{isMe ? ' (you cannot switch yourself off)' : ''}
          </label>
        )}
        <label className="field">
          {user ? 'New password (leave empty to keep theirs)' : 'First password (at least 8 characters)'}
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {(!user || password) && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={mustReset} onChange={(e) => setMustReset(e.target.checked)} style={{ width: 20, height: 20 }} />
            They choose their own password the first time they sign in
          </label>
        )}
        {showPin && (
          <label className="field">
            {user?.hasPin
              ? 'New PIN (4 to 8 digits, leave empty to keep theirs)'
              : 'PIN for switching at the till (4 to 8 digits, optional)'}
            <input inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
          </label>
        )}
        <label className="field">
          Phone
          <input autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {user?.hasPin && showPin && (
            <button
              type="button"
              className="btn danger"
              style={{ marginInlineEnd: 'auto' }}
              onClick={() => void removePin()}
              disabled={busy}
            >
              Remove PIN
            </button>
          )}
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
