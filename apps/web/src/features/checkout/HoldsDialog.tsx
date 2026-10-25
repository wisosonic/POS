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
import { tNow, useT } from '../../store/lang';
import { useUi } from '../../store/ui';

/** Carts parked while the cashier served someone else. Recalling one puts it back in the cart. */
export function HoldsDialog() {
  const t = useT();
  const holds = useHolds();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const close = () => useUi.getState().setHoldsOpen(false);

  async function recall(id: number) {
    if (useCart.getState().lines.length > 0) return toast.warning(tNow('Finish or hold the current cart first'));
    try {
      const held = await post<RecalledHold>(`/holds/${id}/recall`);
      const lines: { product: Product; qty: string }[] = [];
      for (const item of held.items) {
        const product = catalog.get(item.productId);
        if (!product) toast.warning(tNow('"{name}" is no longer in the catalog and was left out', { name: item.name }));
        else lines.push({ product, qty: item.qty });
        if (product && !item.active) toast.warning(tNow('"{name}" has been withdrawn', { name: item.name }));
      }
      const changed = held.items.filter((i) => i.priceChanged && i.active);
      if (changed.length)
        toast.warning(
          changed.length === 1
            ? tNow('A price changed since this cart was held')
            : tNow('{n} prices changed since this cart was held', { n: changed.length }),
        );
      useCart.getState().restore(lines, null);
      await queryClient.invalidateQueries({ queryKey: ['holds'] });
      close();
      navigate('/');
    } catch (e) {
      // Someone else recalled it a moment ago, or it was discarded.
      if (e instanceof ApiError && e.status === 404) {
        toast.info(tNow('That held cart is gone'));
        await queryClient.invalidateQueries({ queryKey: ['holds'] });
      } else toast.error(e instanceof ApiError ? e.message : tNow('Could not recall the cart'));
    }
  }

  async function discard(id: number) {
    try {
      await api('DELETE', `/holds/${id}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return toast.error(tNow('Could not discard the cart'));
    }
    await queryClient.invalidateQueries({ queryKey: ['holds'] });
  }

  const list = holds.data ?? [];
  return (
    <Modal label={t('Held carts')} onClose={close}>
      <h2>{t('Held carts')}</h2>
      {list.length === 0 && <div className="empty">{t('No carts are on hold.')}</div>}
      <ul className="options" style={{ maxHeight: 'none' }}>
        {list.map((h) => (
          <li key={h.id} data-testid="hold-item" style={{ cursor: 'default', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <strong>
                {h.itemCount === 1 ? t('1 item') : t('{n} items', { n: h.itemCount })} · {fmtLbp(h.totalLbp)}
              </strong>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {h.items.map((i) => `${trimQty(i.qty)} × ${i.name.trim()}`).join(', ')}
              </div>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {[
                  h.customerName,
                  h.note,
                  h.userName && t('by {name}', { name: h.userName }),
                  new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <button className="btn small primary" onClick={() => void recall(h.id)}>
              {t('Recall')}
            </button>
            <button className="btn small danger" onClick={() => void discard(h.id)}>
              {t('Discard')}
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>
          {t('Close')}
        </button>
      </div>
    </Modal>
  );
}
