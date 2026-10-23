import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../../lib/api';
import { fmtLbp, fmtUsd, trimQty } from '../../lib/money';
import type { Dashboard } from '../../lib/types';
import { Icon } from '../../components/Icon';

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** How the day is going, with what was taken back already off. Refreshes itself every half minute. */
export function DashboardPage() {
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => get<Dashboard>('/reports/dashboard'), refetchInterval: 30_000 });
  const d = dash.data;
  if (!d) return <main className="page muted">{dash.isError ? 'The dashboard could not be loaded.' : 'Loading…'}</main>;

  // Show the hours the shop actually traded, with an hour either side, and at least a working day.
  const busy = d.hourly.filter((h) => h.count > 0).map((h) => h.hour);
  const first = Math.max(0, Math.min(8, ...busy.map((h) => h - 1)));
  const last = Math.min(23, Math.max(20, ...busy.map((h) => h + 1)));
  const hours = d.hourly.slice(first, last + 1);
  const peak = Math.max(1, ...hours.map((h) => h.totalLbp));

  return (
    <main className="page">
      <h1>
        <Icon name="dashboard" size={26} />
        Today
      </h1>
      <div className="stats">
        <div className="card stat">
          <div className="muted">Sales today, returns taken off</div>
          <div className="big-number num" data-testid="net-today">
            {fmtLbp(d.today.netLbp)}
          </div>
          {d.today.returnedLbp > 0 && (
            <div className="muted">{`${fmtLbp(d.today.grossLbp)} sold, ${fmtLbp(d.today.returnedLbp)} taken back`}</div>
          )}
        </div>
        <div className="card stat">
          <div className="muted">Profit</div>
          <div className="big-number num" data-testid="profit-today">
            {fmtLbp(d.today.profitLbp)}
          </div>
        </div>
        <div className="card stat">
          <div className="muted">Sales made</div>
          <div className="big-number num" data-testid="count-today">
            {d.today.salesCount}
          </div>
          <div className="muted">{`Average ${fmtLbp(d.today.averageBasketLbp)}`}</div>
        </div>
        <div className="card stat">
          <div className="muted">Returns</div>
          <div className="big-number num">{d.today.returnsCount}</div>
        </div>
      </div>

      <div className="stats">
        <div className="card stat">
          <div className="muted">Customers owe you</div>
          <div className="big-number num" data-testid="owed-by-customers">
            {fmtLbp(d.owedByCustomersLbp)}
          </div>
          <Link to="/customers">See who</Link>
        </div>
        <div className="card stat">
          <div className="muted">You owe suppliers</div>
          <div className="big-number num" data-testid="owed-to-suppliers">
            {[d.owedToSuppliers.LBP > 0 && fmtLbp(d.owedToSuppliers.LBP), d.owedToSuppliers.USD > 0 && fmtUsd(d.owedToSuppliers.USD)]
              .filter(Boolean)
              .join(' + ') || fmtLbp(0)}
          </div>
          <Link to="/reports?tab=suppliers">See which orders</Link>
        </div>
        <div className="card stat">
          <div className="muted">Running low</div>
          <div className="big-number num">{d.lowStockCount}</div>
          <Link to="/low-stock">See the list</Link>
        </div>
      </div>

      <h2>By the hour</h2>
      <div className="card bars" role="img" aria-label="Takings for each hour of the day">
        {hours.map((h) => (
          <div key={h.hour} className="bar-col" title={`${hourLabel(h.hour)}: ${fmtLbp(h.totalLbp)} in ${h.count} sales`}>
            <div className="bar" style={{ height: `${Math.round((h.totalLbp / peak) * 100)}%` }} />
            <div className="bar-label">{String(h.hour).padStart(2, '0')}</div>
          </div>
        ))}
      </div>

      <h2>Best sellers today</h2>
      {d.topItems.length === 0 ? (
        <div className="card empty">Nothing sold yet today.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Sold</th>
              <th className="num">Takings</th>
            </tr>
          </thead>
          <tbody>
            {d.topItems.map((i) => (
              <tr key={`${i.productId ?? 'x'}-${i.name}`} data-testid="top-item">
                <td>{i.name}</td>
                <td className="num">{trimQty(i.qty)}</td>
                <td className="num">{fmtLbp(i.totalLbp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
