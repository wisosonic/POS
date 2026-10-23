import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { get } from '../../lib/api';
import { downloadCsv, type Cell } from '../../lib/csv';
import { fmtLbp, fmtMoney, trimQty } from '../../lib/money';
import type { Payable, ProductReportRow, Receivable, SalesReport, SessionSummary, ZReport } from '../../lib/types';
import { Icon } from '../../components/Icon';

type Tab = 'sales' | 'products' | 'customers' | 'suppliers' | 'sessions';
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'sales', label: 'Sales' },
  { tab: 'products', label: 'Products' },
  { tab: 'customers', label: 'Customers who owe' },
  { tab: 'suppliers', label: 'Owed to suppliers' },
  { tab: 'sessions', label: 'Closed registers' },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));
// A date typed by the manager means that day in the shop's own time, not in UTC.
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const signed = (n: number, fmt: (n: number) => string) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const NAME = { cash: 'Cash', whish: 'Whish', omt: 'OMT' } as const;

type Column<T> = { header: string; num?: boolean; cell: (row: T) => ReactNode; csv: (row: T) => Cell };

/** A report as a table, with a button that downloads exactly what is shown. */
function ReportTable<T>({
  rows,
  columns,
  filename,
  footer,
  empty,
  rowId,
}: {
  rows: T[];
  columns: Column<T>[];
  filename: string;
  footer?: ReactNode;
  empty: string;
  rowId: (row: T) => string;
}) {
  if (rows.length === 0) return <div className="card empty">{empty}</div>;
  return (
    <>
      <p>
        <button
          className="btn small"
          onClick={() => downloadCsv(filename, [columns.map((c) => c.header), ...rows.map((r) => columns.map((c) => c.csv(r)))])}
        >
          Download as spreadsheet
        </button>
      </p>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={c.num ? 'num' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowId(r)} data-testid="report-row">
              {columns.map((c) => (
                <td key={c.header} className={c.num ? 'num' : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
          {footer}
        </tbody>
      </table>
    </>
  );
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.tab === params.get('tab'))?.tab ?? 'sales') as Tab;
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(ymd(new Date()));

  const preset = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
  };
  const ranged = tab === 'sales' || tab === 'products';

  return (
    <main className="page">
      <h1>
        <Icon name="reports" size={26} />
        Reports
      </h1>
      <div className="tabs" role="tablist" aria-label="Report" style={{ flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.tab} role="tab" aria-selected={t.tab === tab} onClick={() => setParams({ tab: t.tab })}>
            {t.label}
          </button>
        ))}
      </div>

      {ranged && (
        <div className="toolbar">
          <label className="field">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="range">
            <button className="btn small" onClick={() => preset(ymd(new Date()), ymd(new Date()))}>
              Today
            </button>
            <button className="btn small" onClick={() => preset(daysAgo(6), ymd(new Date()))}>
              Last 7 days
            </button>
            <button
              className="btn small"
              onClick={() => preset(ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), ymd(new Date()))}
            >
              This month
            </button>
          </div>
        </div>
      )}

      {tab === 'sales' && <SalesTab from={from} to={to} />}
      {tab === 'products' && <ProductsTab from={from} to={to} />}
      {tab === 'customers' && <CustomersTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'sessions' && <SessionsTab />}
    </main>
  );
}

const rangeQuery = (from: string, to: string) => `from=${encodeURIComponent(dayStart(from))}&to=${encodeURIComponent(dayEnd(to))}`;

function SalesTab({ from, to }: { from: string; to: string }) {
  const [by, setBy] = useState<'day' | 'cashier' | 'category'>('day');
  const report = useQuery({
    queryKey: ['report-sales', by, from, to],
    queryFn: () => get<SalesReport>(`/reports/sales?groupBy=${by}&${rangeQuery(from, to)}`),
  });
  const heading = { day: 'Day', cashier: 'Cashier', category: 'Category' }[by];
  const r = report.data;
  return (
    <>
      <label className="field" style={{ maxWidth: 260 }}>
        Group by
        <select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
          <option value="day">Day</option>
          <option value="cashier">Cashier</option>
          <option value="category">Product category</option>
        </select>
      </label>
      {report.isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ReportTable
          rows={r?.data ?? []}
          rowId={(x) => x.key}
          filename={`sales-by-${by}-${from}-to-${to}.csv`}
          empty="No sales in these dates."
          columns={[
            { header: heading, cell: (x) => x.label, csv: (x) => x.label },
            { header: 'Sales', num: true, cell: (x) => x.count, csv: (x) => x.count },
            { header: 'Sold', num: true, cell: (x) => fmtLbp(x.grossLbp), csv: (x) => x.grossLbp },
            { header: 'Taken back', num: true, cell: (x) => fmtLbp(x.returnedLbp), csv: (x) => x.returnedLbp },
            { header: 'Net', num: true, cell: (x) => fmtLbp(x.netLbp), csv: (x) => x.netLbp },
            { header: 'Profit', num: true, cell: (x) => fmtLbp(x.profitLbp), csv: (x) => x.profitLbp },
          ]}
          footer={
            r && (
              <tr data-testid="report-total">
                <td>
                  <strong>Total</strong>
                </td>
                <td className="num">{r.totals.count}</td>
                <td className="num">{fmtLbp(r.totals.grossLbp)}</td>
                <td className="num">{fmtLbp(r.totals.returnedLbp)}</td>
                <td className="num">
                  <strong>{fmtLbp(r.totals.netLbp)}</strong>
                </td>
                <td className="num">{fmtLbp(r.totals.profitLbp)}</td>
              </tr>
            )
          }
        />
      )}
      {by === 'category' && r && r.data.length > 0 && (
        <p className="muted">
          A sale with items from two categories counts once in each, so the sales column can add up to more than the total.
        </p>
      )}
    </>
  );
}

function ProductsTab({ from, to }: { from: string; to: string }) {
  const [sort, setSort] = useState<'revenue' | 'qty' | 'profit'>('revenue');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const report = useQuery({
    queryKey: ['report-products', sort, order, from, to],
    queryFn: () => get<{ data: ProductReportRow[] }>(`/reports/products?sort=${sort}&order=${order}&limit=200&${rangeQuery(from, to)}`),
  });
  return (
    <>
      <div className="toolbar">
        <label className="field">
          Rank by
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="revenue">Takings</option>
            <option value="qty">Quantity sold</option>
            <option value="profit">Profit</option>
          </select>
        </label>
        <label className="field">
          Show
          <select value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
            <option value="desc">Best first</option>
            <option value="asc">Slowest first</option>
          </select>
        </label>
      </div>
      {report.isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ReportTable
          rows={report.data?.data ?? []}
          rowId={(x) => `${x.productId ?? 'x'}`}
          filename={`products-${from}-to-${to}.csv`}
          empty="Nothing sold in these dates."
          columns={[
            { header: 'Product', cell: (x) => x.name, csv: (x) => x.name },
            { header: 'Quantity', num: true, cell: (x) => trimQty(x.qty), csv: (x) => x.qty },
            { header: 'Takings', num: true, cell: (x) => fmtLbp(x.revenueLbp), csv: (x) => x.revenueLbp },
            { header: 'Cost', num: true, cell: (x) => fmtLbp(x.costLbp), csv: (x) => x.costLbp },
            { header: 'Profit', num: true, cell: (x) => fmtLbp(x.profitLbp), csv: (x) => x.profitLbp },
          ]}
        />
      )}
      <p className="muted">Net of returns. Values are before any discount given on a whole sale.</p>
    </>
  );
}

function CustomersTab() {
  const report = useQuery({
    queryKey: ['report-receivables'],
    queryFn: () => get<{ data: Receivable[]; totalOwedLbp: number }>('/reports/receivables'),
  });
  if (report.isLoading) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="chip" data-testid="receivables-total">{`Total owed ${fmtLbp(report.data?.totalOwedLbp ?? 0)}`}</p>
      <ReportTable
        rows={report.data?.data ?? []}
        rowId={(x) => String(x.customerId)}
        filename="customers-who-owe.csv"
        empty="Nobody owes anything."
        columns={[
          { header: 'Customer', cell: (x) => x.name, csv: (x) => x.name },
          { header: 'Phone', cell: (x) => x.phone ?? '', csv: (x) => x.phone },
          { header: 'Unpaid sales', num: true, cell: (x) => x.openSales, csv: (x) => x.openSales },
          { header: 'Oldest unpaid', cell: (x) => x.oldestUnpaidAt?.slice(0, 10) ?? '', csv: (x) => x.oldestUnpaidAt?.slice(0, 10) },
          { header: 'Owes', num: true, cell: (x) => fmtLbp(x.balanceLbp), csv: (x) => x.balanceLbp },
        ]}
      />
    </>
  );
}

function SuppliersTab() {
  const report = useQuery({
    queryKey: ['report-payables'],
    queryFn: () => get<{ data: Payable[]; totalOwed: { USD: number; LBP: number } }>('/reports/payables'),
  });
  if (report.isLoading) return <p className="muted">Loading…</p>;
  const t = report.data?.totalOwed ?? { USD: 0, LBP: 0 };
  return (
    <>
      <p className="chip" data-testid="payables-total">{`Total owed ${fmtMoney(t.LBP, 'LBP')} + ${fmtMoney(t.USD, 'USD')}`}</p>
      <ReportTable
        rows={report.data?.data ?? []}
        rowId={(x) => String(x.purchaseId)}
        filename="owed-to-suppliers.csv"
        empty="You do not owe any supplier."
        columns={[
          { header: 'Order', cell: (x) => x.ref, csv: (x) => x.ref },
          { header: 'Supplier', cell: (x) => x.supplierName ?? 'No supplier', csv: (x) => x.supplierName },
          { header: 'Date', cell: (x) => x.createdAt.slice(0, 10), csv: (x) => x.createdAt.slice(0, 10) },
          { header: 'Status', cell: (x) => x.status, csv: (x) => x.status },
          {
            header: 'Total',
            num: true,
            cell: (x) => fmtMoney(x.totalMinor, x.currency),
            csv: (x) => `${x.totalMinor / (x.currency === 'USD' ? 100 : 1)} ${x.currency}`,
          },
          {
            header: 'Paid',
            num: true,
            cell: (x) => fmtMoney(x.paidMinor, x.currency),
            csv: (x) => `${x.paidMinor / (x.currency === 'USD' ? 100 : 1)} ${x.currency}`,
          },
          {
            header: 'Owed',
            num: true,
            cell: (x) => fmtMoney(x.owedMinor, x.currency),
            csv: (x) => `${x.owedMinor / (x.currency === 'USD' ? 100 : 1)} ${x.currency}`,
          },
        ]}
      />
    </>
  );
}

function SessionsTab() {
  const [open, setOpen] = useState<number | null>(null);
  const sessions = useQuery({ queryKey: ['report-sessions'], queryFn: () => get<{ data: SessionSummary[] }>('/registers?limit=60') });
  if (sessions.isLoading) return <p className="muted">Loading…</p>;
  const differences = (s: SessionSummary) =>
    s.balances
      .filter((b) => b.variance)
      .map((b) => `${NAME[b.method]} ${b.currency} ${signed(b.variance!, (n) => fmtMoney(n, b.currency))}`)
      .join(', ');
  return (
    <>
      <ReportTable
        rows={sessions.data?.data ?? []}
        rowId={(s) => String(s.id)}
        filename="registers.csv"
        empty="No registers yet."
        columns={[
          { header: 'No.', cell: (s) => s.id, csv: (s) => s.id },
          { header: 'Opened', cell: (s) => s.openedAt.slice(0, 16).replace('T', ' '), csv: (s) => s.openedAt },
          { header: 'Closed', cell: (s) => s.closedAt?.slice(0, 16).replace('T', ' ') ?? 'Still open', csv: (s) => s.closedAt },
          {
            header: 'Differences when counted',
            cell: (s) => (s.status === 'open' ? '' : differences(s) || 'None'),
            csv: (s) => differences(s),
          },
          {
            header: '',
            num: true,
            cell: (s) => (
              <button className="btn small" onClick={() => setOpen(s.id)} aria-label={`Report for register ${s.id}`}>
                Report
              </button>
            ),
            csv: () => '',
          },
        ]}
      />
      {open !== null && <ZDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ZDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const z = useQuery({ queryKey: ['z-report', id], queryFn: () => get<ZReport>(`/reports/register/${id}`) });
  const r = z.data;
  return (
    <Modal label={`Register ${id} report`} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <h2>{`Register ${id}`}</h2>
        {!r ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {`${r.totals.salesCount} sales · ${fmtLbp(r.totals.salesTotalLbp)} · profit ${fmtLbp(r.totals.salesProfitLbp)}${
                r.totals.owedOnAccountLbp ? ` · ${fmtLbp(r.totals.owedOnAccountLbp)} left on account` : ''
              }`}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Balance</th>
                  <th className="num">Opening</th>
                  <th className="num">Sales in</th>
                  <th className="num">Change out</th>
                  <th className="num">Account payments</th>
                  <th className="num">Refunds</th>
                  <th className="num">Moved</th>
                  <th className="num">Expected</th>
                  <th className="num">Counted</th>
                  <th className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {r.balances.map((b) => {
                  const m = (n: number) => fmtMoney(n, b.currency);
                  return (
                    <tr key={`${b.method}/${b.currency}`}>
                      <td>{`${NAME[b.method]} ${b.currency}`}</td>
                      <td className="num">{m(b.opening)}</td>
                      <td className="num">{m(b.salesIn)}</td>
                      <td className="num">{m(b.changeOut)}</td>
                      <td className="num">{m(b.customerPaymentsIn)}</td>
                      <td className="num">{m(b.refundsOut)}</td>
                      <td className="num">{m(b.movementsNet)}</td>
                      <td className="num">{m(b.expected)}</td>
                      <td className="num">{typeof b.counted === 'number' ? m(b.counted) : ''}</td>
                      <td className={`num ${b.variance ? 'variance-bad' : ''}`}>
                        {typeof b.variance === 'number' ? signed(b.variance, m) : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
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
