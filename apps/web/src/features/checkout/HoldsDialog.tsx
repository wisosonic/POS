import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { useHolds } from '../../hooks/useTillData';
import { ApiError, api, post } from '../../lib/api';
import { catalog } from '../../lib/catalog';
import { fmtLbp, trimQty } from '../../lib/money';
import type { Product, RecalledHold } from '../../lib/types';
import { useCart } from '../../store/cart';
import { toast } from '../../store/toast';
import { useUi } from '../../store/ui';

/** Carts parked while the cashier served someone else. Recalling one puts it back in the cart. */
export function HoldsDialog() {
  const holds = useHolds();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const close = () => useUi.getState().setHoldsOpen(false);

  async function recall(id: number) {
    if (useCart.getState().lines.length > 0) return toast.warning('Finish or hold the current cart first');
    try {
      const held = await post<RecalledHold>(`/holds/${id}/recall`);
      const lines: { product: Product; qty: string }[] = [];
      for (const item of held.items) {
        const product = catalog.get(item.productId);
        if (!product) toast.warning(`"${item.name}" is no longer in the catalog and was left out`);
        else lines.push({ product, qty: item.qty });
        if (product && !item.active) toast.warning(`"${item.name}" has been withdrawn`);
      }
      const changed = held.items.filter((i) => i.priceChanged && i.active);
      if (changed.length)
        toast.warning(`${changed.length === 1 ? 'A price' : `${changed.length} prices`} changed since this cart was held`);
      useCart.getState().restore(lines, null);
      await queryClient.invalidateQueries({ queryKey: ['holds'] });
      close();
      navigate('/');
    } catch (e) {
      // Someone else recalled it a moment ago, or it was discarded.
      if (e instanceof ApiError && e.status === 404) {
        toast.info('That held cart is gone');
        await queryClient.invalidateQueries({ queryKey: ['holds'] });
      } else toast.error(e instanceof ApiError ? e.message : 'Could not recall the cart');
    }
  }

  async function discard(id: number) {
    try {
      await api('DELETE', `/holds/${id}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return toast.error('Could not discard the cart');
    }
    await queryClient.invalidateQueries({ queryKey: ['holds'] });
  }

  const list = holds.data ?? [];
  return (
    <Modal label="Held carts" onClose={close}>
      <h2>Held carts</h2>
      {list.length === 0 && <div className="empty">No carts are on hold.</div>}
      <ul className="options" style={{ maxHeight: 'none' }}>
        {list.map((h) => (
          <li key={h.id} data-testid="hold-item" style={{ cursor: 'default', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <strong>
                {h.itemCount} {h.itemCount === 1 ? 'item' : 'items'} · {fmtLbp(h.totalLbp)}
              </strong>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {h.items.map((i) => `${trimQty(i.qty)} × ${i.name.trim()}`).join(', ')}
              </div>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {[
                  h.customerName,
                  h.note,
                  h.userName && `by ${h.userName}`,
                  new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <button className="btn small primary" onClick={() => void recall(h.id)}>
              Recall
            </button>
            <button className="btn small danger" onClick={() => void discard(h.id)}>
              Discard
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}
