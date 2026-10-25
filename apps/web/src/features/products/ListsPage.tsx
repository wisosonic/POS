import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, patch, post } from '../../lib/api';
import type { Lookup, LookupKind, SupplierLookup, UnitLookup } from '../../lib/types';
import { toast } from '../../store/toast';
import { useLookup } from './lookups';
import { Icon } from '../../components/Icon';

const TABS: { kind: LookupKind; label: string; one: string }[] = [
  { kind: 'categories', label: 'Categories', one: 'category' },
  { kind: 'brands', label: 'Brands', one: 'brand' },
  { kind: 'units', label: 'Units', one: 'unit' },
  { kind: 'suppliers', label: 'Suppliers', one: 'supplier' },
  { kind: 'expense-categories', label: 'Expense types', one: 'expense type' },
  { kind: 'service-categories', label: 'Service types', one: 'service type' },
];

/** The short lists the product form chooses from. Entries are renamed, never deleted, because products still point at them. */
export function ListsPage() {
  const [kind, setKind] = useState<LookupKind>('categories');
  const tab = TABS.find((t) => t.kind === kind)!;
  return (
    <main className="page">
      <h1>
        <Icon name="lists" size={26} />
        Lists
      </h1>
      <div className="tabs" role="tablist" aria-label="List" style={{ maxWidth: 560 }}>
        {TABS.map((t) => (
          <button key={t.kind} role="tab" aria-selected={t.kind === kind} onClick={() => setKind(t.kind)}>
            {t.label}
          </button>
        ))}
      </div>
      <LookupList key={kind} kind={kind} one={tab.one} />
    </main>
  );
}

function LookupList({ kind, one }: { kind: LookupKind; one: string }) {
  const queryClient = useQueryClient();
  const list = useLookup<Lookup & Partial<UnitLookup & SupplierLookup>>(kind);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [fractional, setFractional] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['lookup', kind] });
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'That could not be saved');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await post(`/${kind}`, {
        name: name.trim(),
        ...(kind === 'units' ? { fractional } : {}),
        ...(kind === 'suppliers' && phone.trim() ? { phone: phone.trim() } : {}),
      });
      setName('');
      setPhone('');
      setFractional(false);
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function rename(row: Lookup) {
    const next = window.prompt(`New name for ${row.name}`, row.name)?.trim();
    if (!next || next === row.name) return;
    try {
      await patch(`/${kind}/${row.id}`, { name: next });
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function setWeight(row: UnitLookup, value: boolean) {
    try {
      await patch(`/units/${row.id}`, { fractional: value });
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  const rows = list.data ?? [];
  return (
    <>
      <form className="toolbar" onSubmit={add}>
        <label className="field">
          {`New ${one}`}
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        {kind === 'suppliers' && (
          <label className="field">
            Phone
            <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
          </label>
        )}
        {kind === 'units' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={fractional}
              onChange={(e) => setFractional(e.target.checked)}
              style={{ width: 20, height: 20 }}
            />
            Sold by weight or volume
          </label>
        )}
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      {(kind === 'categories' || kind === 'brands' || kind === 'suppliers') && rows.length > 0 && (
        <p className="muted">{`Press a ${one} to see its products.`}</p>
      )}
      {list.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">{`Nothing in this list yet. Add the first ${one} above.`}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {kind === 'units' && <th>Sold by weight or volume</th>}
              {kind === 'suppliers' && <th>Phone</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="lookup-row">
                <td>
                  {kind === 'categories' || kind === 'brands' || kind === 'suppliers' ? (
                    // the products of this one: the Products page, with the filter already chosen
                    <Link
                      to={`/products?${kind === 'brands' ? 'brandId' : kind === 'suppliers' ? 'supplierId' : 'categoryId'}=${r.id}`}
                      aria-label={`Browse the products of ${r.name}`}
                    >
                      {r.name}
                    </Link>
                  ) : (
                    r.name
                  )}
                </td>
                {kind === 'units' && (
                  <td>
                    <input
                      type="checkbox"
                      checked={!!r.fractional}
                      onChange={(e) => void setWeight(r as UnitLookup, e.target.checked)}
                      aria-label={`${r.name} is sold by weight or volume`}
                      style={{ width: 20, height: 20 }}
                    />
                  </td>
                )}
                {kind === 'suppliers' && <td className="muted">{r.phone ?? ''}</td>}
                <td className="num">
                  <button className="btn small" onClick={() => void rename(r)}>
                    Rename
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
