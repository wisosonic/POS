import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../../lib/api';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

export type CountSummary = {
  id: number;
  name: string;
  status: 'open' | 'committed' | 'cancelled';
  createdAt: string;
  finishedAt: string | null;
  lineCount: number;
  differenceCount: number;
  surplusQty: string;
  shortageQty: string;
};

const STATUS = { open: 'Counting', committed: 'Finished', cancelled: 'Cancelled' } as const;

/** Counts of the shelf. Start one, count what is there, and finish it: only the differences change the quantities. */
export function StocktakePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['stocktakes'], queryFn: () => get<{ data: CountSummary[] }>('/stocktakes').then((r) => r.data) });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = list.data ?? [];

  async function start() {
    setBusy(true);
    try {
      const made = await post<CountSummary>('/stocktakes', { name: name.trim() });
      await queryClient.invalidateQueries({ queryKey: ['stocktakes'] });
      navigate(`/stocktake/${made.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The count could not be started');
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>
        <Icon name="stocktake" size={26} />
        Stocktake
      </h1>
      <p className="muted">
        Count what is on the shelf, one product at a time (scanning counts one each time), then finish. Only the products you counted are
        changed, and only by the difference. It is never required, and a sale never waits for it.
      </p>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="field">
          Name of this count (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aisle 3, dairy…" autoComplete="off" />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          Start a count
        </button>
      </form>

      {list.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card empty">No count has been made yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Count</th>
              <th>Started</th>
              <th>Status</th>
              <th className="num">Counted</th>
              <th className="num">Different</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="count-row">
                <td>{r.name ? `${r.id} · ${r.name}` : `Count ${r.id}`}</td>
                <td>{r.createdAt.slice(0, 16).replace('T', ' ')}</td>
                <td>{STATUS[r.status]}</td>
                <td className="num">{r.lineCount}</td>
                <td className="num">{r.differenceCount}</td>
                <td className="num">
                  <Link className="btn small" to={`/stocktake/${r.id}`}>
                    {r.status === 'open' ? 'Continue' : 'View'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.some((r) => r.status === 'committed') && (
        <p className="muted">{`Each finished count's differences are in the product's stock ledger (Products → Stock) as adjustments called "Stocktake".`}</p>
      )}
    </main>
  );
}
