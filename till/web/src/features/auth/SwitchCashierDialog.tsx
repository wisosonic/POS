import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get } from '../../lib/api';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';

type Person = { id: number; name: string };

/**
 * Hand the till to another cashier without typing a password: pick the name, type the PIN. Only cashiers have a PIN. The cart,
 * held carts and sales waiting to be sent stay as they are: they belong to the till, not to the person.
 */
export function SwitchCashierDialog({ onClose }: { onClose: () => void }) {
  const me = useSession((s) => s.user);
  const switchByPin = useSession((s) => s.switchByPin);
  const people = useQuery({ queryKey: ['pin-list'], queryFn: () => get<{ data: Person[] }>('/users/pin-list').then((r) => r.data) });
  const [who, setWho] = useState<Person | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const others = (people.data ?? []).filter((p) => p.id !== me?.id);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!who || busy) return;
    if (!/^\d{4,8}$/.test(pin)) return setError('The PIN is 4 to 8 digits');
    setBusy(true);
    setError('');
    try {
      await switchByPin(who.id, pin);
      toast.success(`${who.name} is signed in`);
      onClose();
    } catch (err) {
      setPin('');
      setBusy(false);
      if (err instanceof ApiError && err.code === 'LOCKED') setError(err.message);
      else if (err instanceof ApiError && err.isNetwork) setError('Cannot reach the server.');
      else setError('Wrong PIN.');
    }
  }

  return (
    <Modal label="Switch cashier" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>Switch cashier</h2>
        {!who ? (
          <>
            {people.isLoading && <p className="muted">Loading…</p>}
            {!people.isLoading && others.length === 0 && (
              <p className="muted">No other cashier has a PIN yet. The admin sets one in Menu → Users.</p>
            )}
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {others.map((p) => (
                <button key={p.id} type="button" className="btn big" onClick={() => setWho(p)}>
                  {p.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>{`PIN for ${who.name}`}</p>
            <input
              className="num"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              aria-label="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              style={{ fontSize: '1.6rem', textAlign: 'center', letterSpacing: '0.4em' }}
            />
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" className="btn big" onClick={() => setPin((p) => (p + d).slice(0, 8))}>
                  {d}
                </button>
              ))}
              <button type="button" className="btn big" onClick={() => setPin('')} aria-label="Clear the PIN">
                C
              </button>
              <button type="button" className="btn big" onClick={() => setPin((p) => p + '0')}>
                0
              </button>
              <button type="button" className="btn big" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete the last digit">
                ⌫
              </button>
            </div>
          </>
        )}
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {who && (
            <button type="button" className="btn" onClick={() => (setWho(null), setPin(''), setError(''))} disabled={busy}>
              Back
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {who && (
            <button type="submit" className="btn primary big" disabled={busy}>
              Sign in
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
