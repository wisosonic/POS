import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { get } from '../../lib/api';
import { fmtLbp, trimQty } from '../../lib/money';
import type { Customer, SaleDetail } from '../../lib/types';

type Row = { id: number; ref: number; status: string; totalLbp: number; paidLbp: number; restLbp: number; createdAt: string };

const STATUS: Record<string, string> = { paid: 'Paid', partial: 'Part-paid', unpaid: 'On account', void: 'Voided' };
const when = (iso: string) =>
  new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The sales behind what a customer owes: the unpaid ones, oldest first (the order a payment is applied in), or all of their
 * sales. A row opens to show what was bought.
 */
export function CustomerSalesDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const [only, setOnly] = useState<'unpaid' | 'all'>('unpaid');
  const [openId, setOpenId] = useState<number | null>(null);
  const sales = useQuery({
    queryKey: ['customer-sales', customer.id, only],
    queryFn: () =>
      get<{ data: Row[] }>(only === 'unpaid' ? `/customers/${customer.id}/open-sales` : `/customers/${customer.id}/sales?limit=100`).then(
        (r) => r.data,
      ),
  });
  const rows = sales.data ?? [];
  const owed = rows.reduce((sum, r) => sum + (r.status === 'void' ? 0 : r.restLbp), 0);

  return (
    <Modal label={`Sales of ${customer.name}`} onClose={onClose} wide>
      <div style={{ display: 'grid', gap: 14 }}>
        <h2>{`Sales of ${customer.name}`}</h2>
        <div className="toolbar" style={{ margin: 0 }}>
          <label className="field">
            Show
            <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
              <option value="unpaid">Sales not fully paid (the debt)</option>
              <option value="all">All their sales</option>
            </select>
          </label>
          <span className="chip">{`Owes ${fmtLbp(customer.balanceLbp)}`}</span>
        </div>
        {sales.isLoading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="card empty">{only === 'unpaid' ? 'No unpaid sales.' : 'No sales yet.'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>When</th>
                <th className="num">Total</th>
                <th className="num">Paid</th>
                <th className="num">Still owed</th>
                {only === 'all' && <th>Status</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <SaleRow
                  key={r.id}
                  row={r}
                  showStatus={only === 'all'}
                  open={openId === r.id}
                  onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                />
              ))}
            </tbody>
            {only === 'unpaid' && (
              <tfoot>
                <tr>
                  <td colSpan={4}>Total of these sales</td>
                  <td className="num" data-testid="debt-total">
                    {fmtLbp(owed)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SaleRow({ row, showStatus, open, onToggle }: { row: Row; showStatus: boolean; open: boolean; onToggle: () => void }) {
  const detail = useQuery({ queryKey: ['sale', row.id], queryFn: () => get<SaleDetail>(`/sales/${row.id}`), enabled: open });
  return (
    <>
      <tr data-testid="customer-sale-row">
        <td>{row.ref}</td>
        <td className="muted">{when(row.createdAt)}</td>
        <td className="num">{fmtLbp(row.totalLbp)}</td>
        <td className="num">{fmtLbp(row.paidLbp)}</td>
        <td className="num">{row.status === 'void' ? '' : fmtLbp(row.restLbp)}</td>
        {showStatus && <td>{STATUS[row.status] ?? row.status}</td>}
        <td className="num">
          <button
            className="btn small"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} items of receipt ${row.ref}`}
            onClick={onToggle}
          >
            {open ? 'Hide items' : 'Items'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={showStatus ? 7 : 6}>
            {detail.isLoading ? (
              <span className="muted">Loading…</span>
            ) : (
              <ul style={{ margin: 0, paddingInlineStart: 20 }} aria-label={`Items of receipt ${row.ref}`}>
                {(detail.data?.items ?? []).map((i) => (
                  <li key={i.id}>{`${trimQty(i.qty)} × ${i.name.trim()} · ${fmtLbp(i.lineTotalLbp)}`}</li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
