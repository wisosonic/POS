import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { ApiError, api, get, post } from '../../lib/api';
import { trimQty } from '../../lib/money';
import type { ProductFull } from '../../lib/types';
import { toast } from '../../store/toast';
import type { CountSummary } from './StocktakePage';

type Line = {
  productId: number;
  name: string;
  barcode: string;
  unitName: string | null;
  systemQty: string;
  countedQty: string;
  differenceQty: string;
};
type Detail = CountSummary & { lines: Line[] };

/** One count. Scan or search a product to count it (a scan adds one), or type the quantity; finish when the shelf is done. */
export function StocktakeCountPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['stocktake', id], queryFn: () => get<Detail>(`/stocktakes/${id}`) });
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<ProductFull[]>([]);
  const [message, setMessage] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // One id for finishing: pressing the button twice, or retrying after a hiccup, can never post the differences twice.
  const [key] = useState(() => crypto.randomUUID());

  const d = detail.data;
  const open = d?.status === 'open';
  const refresh = () => Promise.all([detail.refetch(), queryClient.invalidateQueries({ queryKey: ['stocktakes'] })]);
  const fail = (err: unknown) => setMessage(err instanceof ApiError ? err.message : 'That could not be saved');

  async function countProduct(p: ProductFull, qty = '1', mode: 'set' | 'add' = 'add') {
    setMessage('');
    setChoices([]);
    try {
      const r = await api<{ line: Line }>('PUT', `/stocktakes/${id}/lines`, { productId: p.id, qty, mode });
      setText('');
      setMessage(`${r.line.name.trim()}: counted ${trimQty(r.line.countedQty)}`);
      await refresh();
    } catch (err) {
      fail(err);
    }
    input.current?.focus();
  }

  async function find(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || !open) return;
    setMessage('');
    setChoices([]);
    try {
      // A barcode first (a scanner types it and presses Enter); otherwise a name.
      let found: ProductFull[] = [];
      try {
        found = (await get<{ data: ProductFull[] }>(`/products/by-barcode/${encodeURIComponent(q)}`)).data;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      if (found.length === 0) found = (await get<{ data: ProductFull[] }>(`/products?limit=8&q=${encodeURIComponent(q)}`)).data;
      if (found.length === 0) return setMessage(`Nothing found for "${q}"`);
      if (found.length === 1) return void countProduct(found[0]!);
      setChoices(found);
    } catch (err) {
      fail(err);
    }
  }

  async function setQty(l: Line, value: string) {
    const v = value.trim();
    if (v === '' || v === l.countedQty) return;
    try {
      await api('PUT', `/stocktakes/${id}/lines`, { productId: l.productId, qty: v, mode: 'set' });
      setMessage('');
      await refresh();
    } catch (err) {
      fail(err);
      await refresh();
    }
  }

  async function remove(l: Line) {
    try {
      await api('DELETE', `/stocktakes/${id}/lines/${l.productId}`);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      const r = await post<{ adjusted: number }>(`/stocktakes/${id}/commit`, {}, { idempotencyKey: key });
      toast.success(
        r.adjusted === 0
          ? 'Finished: the counts matched, nothing changed'
          : `Finished: ${r.adjusted} product${r.adjusted === 1 ? '' : 's'} adjusted`,
      );
      await Promise.all(['alerts', 'products', 'stock', 'stocktakes'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      setFinishing(false);
      await detail.refetch();
    } catch (err) {
      fail(err);
      setFinishing(false);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await post(`/stocktakes/${id}/cancel`, {});
      await queryClient.invalidateQueries({ queryKey: ['stocktakes'] });
      navigate('/stocktake');
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  if (detail.isLoading) return <main className="page muted">Loading…</main>;
  if (!d)
    return (
      <main className="page">
        <div className="card empty">
          There is no such count. <Link to="/stocktake">Back to the counts</Link>
        </div>
      </main>
    );

  return (
    <main className="page">
      <p style={{ margin: 0 }}>
        <Link to="/stocktake">← All counts</Link>
      </p>
      <h1>{d.name ? `Count ${d.id} · ${d.name}` : `Count ${d.id}`}</h1>
      {!open && (
        <div className="banner">
          <div className="title">{d.status === 'committed' ? 'This count is finished' : 'This count was cancelled'}</div>
          <div>
            {d.status === 'committed'
              ? `${d.differenceCount} product(s) were adjusted. It can no longer be changed.`
              : 'Nothing was changed.'}
          </div>
        </div>
      )}

      {open && (
        <form className="toolbar" onSubmit={find}>
          <label className="field">
            Scan a barcode, or type part of a name
            <input ref={input} autoFocus autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <button className="btn primary" type="submit">
            Count it
          </button>
        </form>
      )}
      {message && (
        <div className="banner" role="status" data-testid="count-message">
          {message}
        </div>
      )}
      {choices.length > 0 && (
        <div className="card" role="group" aria-label="Which product?">
          <p style={{ margin: '0 0 8px' }}>More than one product matches. Which one?</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {choices.map((p) => (
              <button key={p.id} type="button" className="btn" onClick={() => void countProduct(p)}>
                {`${p.name.trim()}${p.barcode ? ` · ${p.barcode}` : ''}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {d.lines.length === 0 ? (
        <div className="card empty">{open ? 'Nothing counted yet. Scan the first product.' : 'Nothing was counted.'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">System said</th>
              <th className="num">Counted</th>
              <th className="num">Difference</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => {
              const diff = Number(l.differenceQty);
              return (
                <tr key={l.productId} data-testid="count-line">
                  <td>
                    {l.name.trim()}
                    {l.unitName ? <span className="muted">{` (${l.unitName})`}</span> : null}
                  </td>
                  <td className="num">{trimQty(l.systemQty)}</td>
                  <td className="num">
                    {open ? (
                      <input
                        className="num"
                        style={{ width: 100 }}
                        inputMode="decimal"
                        aria-label={`Counted: ${l.name.trim()}`}
                        defaultValue={l.countedQty}
                        key={`${l.productId}-${l.countedQty}`}
                        onBlur={(e) => void setQty(l, e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                      />
                    ) : (
                      trimQty(l.countedQty)
                    )}
                  </td>
                  <td className={`num ${diff < 0 ? 'variance-bad' : ''}`} data-testid="difference">
                    {diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${trimQty(l.differenceQty)}`}
                  </td>
                  <td className="num">
                    {open && (
                      <button
                        type="button"
                        className="btn ghost small"
                        aria-label={`Remove ${l.name.trim()} from the count`}
                        onClick={() => void remove(l)}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {open && (
        <div className="toolbar">
          <button className="btn danger" onClick={() => void cancel()} disabled={busy}>
            Cancel this count
          </button>
          <span className="spacer" />
          <button className="btn primary big" onClick={() => setFinishing(true)} disabled={busy || d.lineCount === 0}>
            Finish and adjust stock
          </button>
        </div>
      )}

      {finishing && (
        <Modal label="Finish the count" onClose={() => setFinishing(false)}>
          <div style={{ display: 'grid', gap: 14 }}>
            <h2>Finish this count?</h2>
            <div className="banner warn">
              <div className="title">{`${d.differenceCount} of ${d.lineCount} counted product${d.lineCount === 1 ? '' : 's'} differ from the system`}</div>
              <div>{`Missing in total: ${trimQty(d.shortageQty)}. Extra in total: ${trimQty(d.surplusQty)}.`}</div>
              <div>
                Their quantities are changed by the difference, with a note in each product's stock ledger. Products you did not count are
                not touched. A finished count cannot be undone.
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setFinishing(false)} disabled={busy}>
                Keep counting
              </button>
              <button className="btn primary big" onClick={() => void finish()} disabled={busy}>
                Finish and adjust
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
