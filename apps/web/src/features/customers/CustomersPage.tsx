import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError, api, get } from '../../lib/api';
import { fmtLbp } from '../../lib/money';
import type { Customer } from '../../lib/types';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';
import { CustomerDialog } from './CustomerDialog';
import { CustomerSalesDialog } from './CustomerSalesDialog';

type Page = { data: Customer[]; nextCursor: number | null };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Every customer, whether or not they owe anything: find one, add one, change their details, see their sales, delete one. */
export function CustomersPage() {
  const queryClient = useQueryClient();
  const role = useSession((s) => s.user?.role) ?? 'cashier';
  const isManager = role === 'manager' || role === 'admin'; // changing or deleting a customer is for managers; any cashier may add one
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [browsing, setBrowsing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const search = useDebounced(q.trim(), 250);

  const customers = useInfiniteQuery({
    queryKey: ['customers', 'all', search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => get<Page>(`/customers?limit=50&q=${encodeURIComponent(search)}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = (customers.data?.pages.flatMap((p) => p.data) ?? []).filter((c) => !c.isWalkIn);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['customers'] });

  return (
    <main className="page">
      <h1>
        <Icon name="customers" size={26} />
        Customer accounts
      </h1>
      <div className="toolbar">
        <label className="field">
          Search
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone" autoFocus />
        </label>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          New customer
        </button>
      </div>

      {customers.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">{search ? 'No customer matches.' : 'No customers yet. Add the first one.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Address</th>
              <th>Email</th>
              <th className="num">Owes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} data-testid="customer-row">
                <td>{c.name}</td>
                <td className="muted">{c.phone ?? ''}</td>
                <td className="muted">{c.address ?? ''}</td>
                <td className="muted">{c.email ?? ''}</td>
                <td className="num">{c.balanceLbp > 0 ? fmtLbp(c.balanceLbp) : ''}</td>
                <td className="num">
                  <div className="row-actions">
                    <button className="btn small" onClick={() => setBrowsing(c)} aria-label={`Browse sales of ${c.name}`}>
                      <Icon name="sales" size={16} />
                      Sales
                    </button>
                    {isManager && (
                      <>
                        <button className="btn small" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                          <Icon name="edit" size={16} />
                          Edit
                        </button>
                        <button className="btn small danger" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>
                          <Icon name="trash" size={16} />
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {customers.hasNextPage && (
        <p>
          <button className="btn" disabled={customers.isFetchingNextPage} onClick={() => void customers.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}

      {editing && <CustomerDialog customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {browsing && <CustomerSalesDialog customer={browsing} onClose={() => setBrowsing(null)} />}
      {deleting && <DeleteDialog customer={deleting} onClose={() => setDeleting(null)} onDeleted={refresh} />}
    </main>
  );
}

function DeleteDialog({ customer, onClose, onDeleted }: { customer: Customer; onClose: () => void; onDeleted: () => unknown }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api('DELETE', `/customers/${customer.id}`);
      toast.success(`${customer.name} was deleted`);
      await onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The customer could not be deleted');
      setBusy(false);
    }
  }
  return (
    <Modal label="Delete customer" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <h2>{`Delete ${customer.name}?`}</h2>
        <p style={{ margin: 0 }}>
          They disappear from this list and cannot be chosen for a new sale. Their past sales stay as they are, with their name on them.
          This cannot be undone.
        </p>
        {customer.balanceLbp > 0 && (
          <div className="warning">{`${customer.name} still owes ${fmtLbp(customer.balanceLbp)}. Take their payment first: a customer who owes money cannot be deleted.`}</div>
        )}
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
