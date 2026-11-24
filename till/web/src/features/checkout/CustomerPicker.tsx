import { useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { fmtLbp } from '../../lib/money';
import type { Customer } from '../../lib/types';
import { tNow, useT } from '../../store/lang';

/**
 * Choose who is paying. Walk-In is the default and cannot owe anything. A registered customer can pay part now and the rest
 * later (decision Q4), so this is where a credit sale gets its customer.
 */
export function CustomerPicker({ value, onChange }: { value: Customer | null; onChange: (c: Customer | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [problem, setProblem] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Search as the cashier types, after a short pause so a fast typist sends one request, not ten.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      get<{ data: Customer[] }>(`/customers?limit=8&q=${encodeURIComponent(text.trim())}`)
        .then((r) => {
          setFound(r.data.filter((c) => !c.isWalkIn));
          setProblem('');
        })
        .catch((e) =>
          setProblem(
            e instanceof ApiError && e.isNetwork ? tNow('Cannot search customers while offline') : tNow('Could not search customers'),
          ),
        );
    }, 200);
    return () => clearTimeout(timer);
  }, [text, open]);

  const choose = (c: Customer | null) => {
    onChange(c);
    setOpen(false);
    setText('');
    setAdding(false);
  };

  async function addCustomer() {
    if (!newName.trim()) return;
    try {
      choose(await post<Customer>('/customers', { name: newName.trim(), phone: newPhone.trim() || undefined }));
      setNewName('');
      setNewPhone('');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : tNow('Could not add the customer'));
    }
  }

  return (
    <div className="picker">
      <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {`${t('Customer: {name}', { name: value ? value.name : t('Walk-In') })} ▾`}
      </button>
      {open && (
        <>
          <input
            ref={input}
            placeholder={t('Search customer')}
            aria-label={t('Search customer')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter here must pick a customer, not submit the payment form around it.
              if (e.key === 'Enter') {
                e.preventDefault();
                if (found[0]) choose(found[0]);
              }
            }}
            style={{ minHeight: 48, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--bg)' }}
          />
          <ul className="options" role="listbox" aria-label={t('Customers')}>
            <li role="option" aria-selected={!value} onClick={() => choose(null)}>
              <span>{t('Walk-In')}</span>
              <span className="muted">{t('no account')}</span>
            </li>
            {found.map((c) => (
              <li key={c.id} role="option" aria-selected={value?.id === c.id} onClick={() => choose(c)}>
                <span>{c.name}</span>
                <span className="muted">
                  {[c.phone, c.balanceLbp > 0 ? t('owes {amount}', { amount: fmtLbp(c.balanceLbp) }) : null].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          {problem && <div className="error-text">{problem}</div>}
          {!adding ? (
            <button type="button" className="btn small" onClick={() => setAdding(true)}>
              {t('+ New customer')}
            </button>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <label className="field">
                {t('Name')}
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
              <label className="field">
                {t('Phone (optional)')}
                <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              </label>
              <button type="button" className="btn small primary" onClick={() => void addCustomer()} disabled={!newName.trim()}>
                {t('Add and select')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
