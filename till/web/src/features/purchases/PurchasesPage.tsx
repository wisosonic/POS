import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../../lib/api';
import { fmtMoney } from '../../lib/money';
import type { Purchase, PurchaseStatus } from '../../lib/types';
import { PurchaseDialog } from './PurchaseDialog';
import { Icon } from '../../components/Icon';

type Page = { data: Purchase[]; nextCursor: number | null };
const LABEL: Record<PurchaseStatus, string> = { draft: 'Draft', ordered: 'Ordered', received: 'Received' };
const CHIP: Record<PurchaseStatus, string> = { draft: '', ordered: 'warn', received: 'ok' };
const day = (iso: string) => iso.slice(0, 10);

/** What was bought from suppliers: orders waiting to arrive, what has come in, and what is still owed. */
export function PurchasesPage() {
  const [status, setStatus] = useState<PurchaseStatus | ''>('');
  const [open, setOpen] = useState<Purchase | 'new' | null>(null);

  const purchases = useInfiniteQuery({
    queryKey: ['purchases', status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      get<Page>(`/purchases?limit=50${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = purchases.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <main className="page">
      <h1>
        <Icon name="purchases" size={26} />
        Purchases
      </h1>
      <div className="toolbar">
        <label className="field">
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value as PurchaseStatus | '')}>
            <option value="">All purchases</option>
            <option value="draft">Drafts</option>
            <option value="ordered">Ordered, not yet received</option>
            <option value="received">Received</option>
          </select>
        </label>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setOpen('new')}>
          New purchase
        </button>
      </div>

      {purchases.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">No purchases yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>Date</th>
              <th>Supplier</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Still owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} data-testid="purchase-row">
                <td>{p.ref}</td>
                <td className="muted">{day(p.createdAt)}</td>
                <td>{p.supplierName ?? <span className="muted">No supplier</span>}</td>
                <td>
                  <span className={`chip ${CHIP[p.status]}`}>{LABEL[p.status]}</span>
                </td>
                <td className="num">{fmtMoney(p.totalMinor, p.currency)}</td>
                <td className="num">{p.status !== 'draft' && p.owedMinor > 0 ? fmtMoney(p.owedMinor, p.currency) : ''}</td>
                <td className="num">
                  <button className="btn small" onClick={() => setOpen(p)} aria-label={`Open purchase ${p.ref}`}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {purchases.hasNextPage && (
        <p>
          <button className="btn" disabled={purchases.isFetchingNextPage} onClick={() => void purchases.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
      {open && <PurchaseDialog purchase={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
    </main>
  );
}
