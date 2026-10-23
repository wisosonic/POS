import { useAlerts } from '../../hooks/useTillData';
import { trimQty } from '../../lib/money';
import { Icon } from '../../components/Icon';

/** Products at or below the threshold the owner set for each. A reminder of what to order: it never stops a sale. */
export function LowStockPage() {
  const alerts = useAlerts();
  const rows = alerts.data ?? [];
  return (
    <main className="page">
      <h1>
        <Icon name="lowstock" size={26} />
        Low stock
      </h1>
      <p className="muted">Products at or below their own reorder level, most urgent first.</p>
      {alerts.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">Nothing is running low.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">In stock</th>
              <th className="num">Reorder level</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.productId} data-testid="low-stock-row">
                <td>{r.name.trim()}</td>
                <td className={`num ${Number(r.qty) <= 0 ? 'variance-bad' : ''}`}>{trimQty(r.qty)}</td>
                <td className="num">{r.threshold === null ? '' : trimQty(String(r.threshold))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
