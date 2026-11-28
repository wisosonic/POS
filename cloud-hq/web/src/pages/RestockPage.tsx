import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../lib/api';
import { milliToQty, qtyText } from '../lib/format';
import { canCatalog, type Me } from '../lib/session';
import { useBranches } from './PeoplePage';

type Reorder = {
  productId: number;
  name: string;
  barcode: string;
  branchId: number;
  branch: string;
  alertMilli: number;
  qtyMilli: number;
  inTransitMilli: number;
  onOrderMilli: number;
  suggestMilli: number;
  unmetMilli: number;
};
type Rebalance = {
  productId: number;
  name: string;
  branchId: number;
  branch: string;
  qtyMilli: number;
  perDayMilli: number;
  coverDays: number | null;
  suggestMilli: number;
};
type Cover = { sendBack: Rebalance[]; requestMore: Rebalance[] };

const TABS = ['What to buy', 'Slow shops', 'Fast shops'] as const;
type Tab = (typeof TABS)[number];

/** What HQ suggests. It only suggests: nothing is bought, shipped or changed until a person does it. */
export function RestockPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('What to buy');
  const branches = useBranches();
  const [branchId, setBranchId] = useState('');
  return (
    <div className="stack">
      <h1>Stock suggestions</h1>
      <p className="muted">These are suggestions only. HQ buys nothing and moves nothing by itself; a person decides.</p>
      <div className="row">
        <div className="tabs" role="tablist" aria-label="Suggestions">
          {TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <label className="field">
          Branch
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">All branches</option>
            {(branches.data ?? [])
              .filter((b) => b.active)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {tab === 'What to buy' ? (
        <BuyTab me={me} branchId={branchId} />
      ) : (
        <MoveTab which={tab === 'Slow shops' ? 'sendBack' : 'requestMore'} branchId={branchId} />
      )}
    </div>
  );
}

function BuyTab({ me, branchId }: { me: Me; branchId: string }) {
  const navigate = useNavigate();
  const rows = useQuery({
    queryKey: ['reorder', branchId],
    queryFn: () => get<{ data: Reorder[] }>(`/reports/reorder${branchId ? `?branchId=${branchId}` : ''}`).then((r) => r.data),
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const rowKey = (r: Reorder) => `${r.branchId}|${r.productId}`;
  const list = rows.data ?? [];
  const chosen = list.filter((r) => picked.includes(rowKey(r)));
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  // A draft from the chosen rows: each line goes to the stock branch that is short, at the product's own cost (an order has one currency).
  const draft = useMutation({
    mutationFn: async () => {
      const products = await Promise.all(
        [...new Set(chosen.map((r) => r.productId))].map((id) =>
          get<{ id: number; costMinor: number; currency: string }>(`/products/${id}`),
        ),
      );
      const currencies = new Set(products.map((p) => p.currency));
      if (currencies.size > 1)
        throw new ApiError(
          0,
          'MIXED',
          'These products are priced in different currencies, and an order has one. Choose rows in one currency.',
        );
      const cost = new Map(products.map((p) => [p.id, p.costMinor]));
      const made = await post<{ id: number }>('/purchase-orders', {
        currency: [...currencies][0] === 'LBP' ? 'LBP' : 'USD',
        note: 'From the stock suggestions',
        lines: chosen.map((r) => ({
          stockBranchId: r.branchId,
          productId: r.productId,
          qty: milliToQty(r.suggestMilli),
          unitCostMinor: cost.get(r.productId) ?? 0,
        })),
      });
      return made.id;
    },
    onSuccess: (id) => navigate(`/purchasing?order=${id}`),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'The draft could not be made.'),
  });

  return (
    <section className="card">
      <p className="muted small">
        Stock branches at or under a product&rsquo;s alert, counting what is on the way and already on order. The suggestion brings the
        branch to twice the alert. A product with no alert is never listed.
      </p>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      {list.length === 0 ? (
        <p className="muted">{rows.isLoading ? 'Loading…' : 'Nothing needs buying right now.'}</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {canCatalog(me) && <th />}
                <th>Product</th>
                <th>Branch</th>
                <th className="num">Holds</th>
                <th className="num">Alert</th>
                <th className="num">On the way</th>
                <th className="num">On order</th>
                <th className="num">Suggest</th>
                <th className="num">Shops could not get</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={rowKey(r)} data-testid="reorder-row">
                  {canCatalog(me) && (
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.includes(rowKey(r))}
                        onChange={() => toggle(rowKey(r))}
                        aria-label={`Choose ${r.name} for ${r.branch}`}
                      />
                    </td>
                  )}
                  <td>
                    <strong>{r.name}</strong> <span className="muted small">{r.barcode}</span>
                  </td>
                  <td>{r.branch}</td>
                  <td className="num">{qtyText(r.qtyMilli)}</td>
                  <td className="num">{qtyText(r.alertMilli)}</td>
                  <td className="num">{qtyText(r.inTransitMilli)}</td>
                  <td className="num">{qtyText(r.onOrderMilli)}</td>
                  <td className="num">
                    <strong>{qtyText(r.suggestMilli)}</strong>
                  </td>
                  <td className="num">{r.unmetMilli > 0 ? qtyText(r.unmetMilli) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canCatalog(me) && list.length > 0 && (
        <p>
          <button className="btn primary" disabled={chosen.length === 0 || draft.isPending} onClick={() => draft.mutate()}>
            Make a draft order from {chosen.length} chosen
          </button>{' '}
          <span className="muted small">You will see the draft and can change it before anything is ordered.</span>
        </p>
      )}
    </section>
  );
}

function MoveTab({ which, branchId }: { which: 'sendBack' | 'requestMore'; branchId: string }) {
  const [windowDays, setWindowDays] = useState('30');
  const [slowDays, setSlowDays] = useState('60');
  const [fastDays, setFastDays] = useState('7');
  const [targetDays, setTargetDays] = useState('30');
  const ok = (v: string) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 365;
  const valid = [windowDays, slowDays, fastDays, targetDays].every(ok);
  const q = new URLSearchParams({ windowDays, slowDays, fastDays, targetDays });
  if (branchId) q.set('branchId', branchId);
  const rows = useQuery({
    queryKey: ['rebalance', q.toString()],
    queryFn: () => get<Cover>(`/reports/rebalance?${q.toString()}`),
    enabled: valid,
  });
  const list = rows.data?.[which] ?? [];
  const slow = which === 'sendBack';
  return (
    <section className="card">
      <p className="muted small">
        {slow
          ? 'Shops holding more than they will sell: stock lasts longer than the “slow” days at the recent pace. They would send the extra back to a stock branch, keeping the “keep” days of cover.'
          : 'Shops that will run out soon: stock lasts the “fast” days or less at the recent pace. They would ask a stock branch for enough to cover the “keep” days. Stock never moves from shop to shop.'}
      </p>
      <div className="row">
        <label className="field">
          Pace measured over (days)
          <input value={windowDays} onChange={(e) => setWindowDays(e.target.value)} inputMode="numeric" />
        </label>
        {slow ? (
          <label className="field">
            Slow if it lasts more than (days)
            <input value={slowDays} onChange={(e) => setSlowDays(e.target.value)} inputMode="numeric" />
          </label>
        ) : (
          <label className="field">
            Fast if it lasts (days) or less
            <input value={fastDays} onChange={(e) => setFastDays(e.target.value)} inputMode="numeric" />
          </label>
        )}
        <label className="field">
          Keep (days of cover)
          <input value={targetDays} onChange={(e) => setTargetDays(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      {!valid && <p className="banner warn">Each number of days is a whole number from 1 to 365.</p>}
      {list.length === 0 ? (
        <p className="muted">{rows.isLoading ? 'Loading…' : slow ? 'No shop is holding too much.' : 'No shop is about to run out.'}</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Shop</th>
                <th className="num">Holds</th>
                <th className="num">Sells a day</th>
                <th className="num">Lasts (days)</th>
                <th className="num">{slow ? 'Send back' : 'Ask for'}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={`${r.branchId}|${r.productId}`} data-testid="move-row">
                  <td>
                    <strong>{r.name}</strong>
                  </td>
                  <td>{r.branch}</td>
                  <td className="num">{qtyText(r.qtyMilli)}</td>
                  <td className="num">{qtyText(r.perDayMilli)}</td>
                  <td className="num">
                    {r.coverDays === null ? 'no sales' : r.coverDays.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                  </td>
                  <td className="num">
                    <strong>{qtyText(r.suggestMilli)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
