import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { ApiError, get, patch, post } from '../../lib/api';
import { fmtMoney, trimQty } from '../../lib/money';
import type { Currency } from '../../lib/types';
import { useSession } from '../../store/session';
import { toast } from '../../store/toast';
import { Icon } from '../../components/Icon';

type Member = {
  id: number;
  name: string;
  priceMinor: number;
  currency: Currency;
  qty: string;
  soldLines: number;
  lastSoldAt: string | null;
};
type Group = { barcode: string; products: Member[] };
type Report = { data: Group[]; enforced: boolean; duplicateGroups: number; duplicateProducts: number };

/**
 * Barcodes that several products share (left over from the old app). For each: give one of them a new barcode, or keep one and
 * fold the others into it. When none are left, the rule can be turned on and the system refuses new duplicates from then on.
 */
export function BarcodesPage() {
  const queryClient = useQueryClient();
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const report = useQuery({ queryKey: ['barcode-duplicates'], queryFn: () => get<Report>('/barcodes/duplicates') });
  const [recoding, setRecoding] = useState<Member | null>(null);
  const [merging, setMerging] = useState<{ keep: Member; others: Member[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const r = report.data;

  const refresh = () => Promise.all(['barcode-duplicates', 'products'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'That could not be done');

  async function setRule(enabled: boolean) {
    setBusy(true);
    try {
      await post('/barcodes/enforce', { enabled });
      toast.success(enabled ? 'From now on no two active products can share a barcode' : 'The rule is off');
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>
        <Icon name="barcode" size={26} />
        Duplicate barcodes
      </h1>
      <p className="muted">
        A scan finds every product with that barcode, so the cashier has to pick. Clean them up here, and when none are left, turn the rule
        on so it cannot happen again.
      </p>

      {r?.enforced ? (
        <div className="banner" data-testid="barcode-status">
          <div className="title">The rule is on</div>
          <div>No two active products can have the same barcode. A product that is hidden may keep an old code.</div>
          {isAdmin && (
            <p style={{ margin: '8px 0 0' }}>
              <button className="btn small" onClick={() => void setRule(false)} disabled={busy}>
                Turn the rule off
              </button>
            </p>
          )}
        </div>
      ) : r && r.duplicateGroups === 0 ? (
        <div className="banner" data-testid="barcode-status">
          <div className="title">No barcode is shared</div>
          <div>You can turn the rule on now. The system will then refuse a second active product with the same barcode.</div>
          <p style={{ margin: '8px 0 0' }}>
            <button className="btn primary" onClick={() => void setRule(true)} disabled={busy}>
              Turn the rule on
            </button>
          </p>
        </div>
      ) : r ? (
        <div className="banner warn" data-testid="barcode-status">
          <div className="title">{`${r.duplicateGroups} barcode${r.duplicateGroups === 1 ? ' is' : 's are'} shared by ${r.duplicateProducts} products`}</div>
          <div>For each, either give one of the products its own barcode, or keep one and fold the others into it.</div>
        </div>
      ) : null}

      {report.isLoading && <p className="muted">Loading…</p>}
      {(r?.data ?? []).map((g) => (
        <section key={g.barcode} className="card" aria-label={`Barcode ${g.barcode}`} data-testid="barcode-group">
          <h2 style={{ marginTop: 0 }}>{g.barcode}</h2>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Price</th>
                <th className="num">In stock</th>
                <th className="num">Sold</th>
                <th>Last sold</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.products.map((p) => (
                <tr key={p.id} data-testid="barcode-product">
                  <td>{p.name.trim()}</td>
                  <td className="num">{fmtMoney(p.priceMinor, p.currency)}</td>
                  <td className="num">{trimQty(p.qty)}</td>
                  <td className="num">{p.soldLines}</td>
                  <td className="muted">{p.lastSoldAt ? p.lastSoldAt.slice(0, 10) : 'never'}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" onClick={() => setRecoding(p)} aria-label={`New barcode for ${p.name.trim()}`}>
                      New barcode…
                    </button>{' '}
                    <button
                      className="btn small"
                      onClick={() => setMerging({ keep: p, others: g.products.filter((o) => o.id !== p.id) })}
                      aria-label={`Keep ${p.name.trim()} and fold the others into it`}
                    >
                      Keep this one…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {recoding && <RecodeDialog product={recoding} onClose={() => setRecoding(null)} onDone={() => (setRecoding(null), void refresh())} />}
      {merging && (
        <MergeDialog
          keep={merging.keep}
          others={merging.others}
          onClose={() => setMerging(null)}
          onDone={() => {
            setMerging(null);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

function RecodeDialog({ product, onClose, onDone }: { product: Member; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await patch(`/products/${product.id}`, { barcode: code.trim() });
      toast.success(code.trim() ? `${product.name.trim()} now has its own barcode` : `${product.name.trim()} has no barcode now`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The barcode could not be changed');
      setBusy(false);
    }
  }

  return (
    <Modal label="New barcode" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        <h2>New barcode</h2>
        <p style={{ margin: 0 }}>{product.name.trim()}</p>
        <label className="field">
          Barcode (scan it, or leave empty for none)
          <input autoFocus autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary big" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MergeDialog({ keep, others, onClose, onDone }: { keep: Member; others: Member[]; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per merge: pressing the button twice, or retrying after a hiccup, can never move the stock twice.
  const [key] = useState(() => crypto.randomUUID());

  async function go() {
    setBusy(true);
    setError('');
    try {
      await post('/products/merge', { keepId: keep.id, retireIds: others.map((o) => o.id) }, { idempotencyKey: key });
      toast.success(`${others.length} product${others.length === 1 ? '' : 's'} folded into ${keep.name.trim()}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The products could not be merged');
      setBusy(false);
    }
  }

  return (
    <Modal label="Keep this product" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <h2>{`Keep ${keep.name.trim()}?`}</h2>
        <div className="banner warn">
          <div className="title">{`${others.map((o) => o.name.trim()).join(', ')} will be hidden`}</div>
          <div>
            Their stock is added to {keep.name.trim()} (with a note in the stock ledger) and their barcode is freed. Old sales keep showing
            what was sold. Nothing is deleted, but this cannot be undone from here.
          </div>
        </div>
        {error && (
          <div className="warning" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary big" onClick={() => void go()} disabled={busy}>
            Fold them into this one
          </button>
        </div>
      </div>
    </Modal>
  );
}
