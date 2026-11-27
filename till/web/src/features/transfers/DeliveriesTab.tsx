import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { useT } from '../../store/lang';
import { toast } from '../../store/toast';

// Expected deliveries (docs/15 §6, P5d): what HQ bought for this stock branch. A manager receives it, all at once or in parts as the goods arrive.

type Delivery = {
  id: number;
  orderId: number;
  supplier: string | null;
  currency: string;
  note: string | null;
  orderedAt: string;
  status: 'open' | 'closed' | 'cancelled';
  complete: boolean;
  items: { itemId: number; productId: number; name: string; ordered: string; received: string; outstanding: string }[];
};

const day = (iso: string) => iso.slice(0, 10);
const num = (v: string) => Number(v);

export function DeliveriesTab() {
  const t = useT();
  const list = useQuery({
    queryKey: ['deliveries'],
    queryFn: () => get<{ data: Delivery[] }>('/deliveries?status=open').then((r) => r.data),
  });
  const rows = list.data ?? [];
  if (list.isLoading) return <p className="muted">{t('Loading…')}</p>;
  if (rows.length === 0) return <div className="card empty">{t('No deliveries are expected.')}</div>;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {rows.map((d) => (
        <DeliveryCard key={d.id} delivery={d} />
      ))}
    </div>
  );
}

/** Each line starts at what is still to arrive. Lower it (or make it 0) for goods that have not come yet; the rest can be received later. */
function DeliveryCard({ delivery }: { delivery: Delivery }) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = useRef(crypto.randomUUID());
  const [arrived, setArrived] = useState<Record<number, string>>(Object.fromEntries(delivery.items.map((i) => [i.itemId, i.outstanding])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function receive() {
    const lines = delivery.items.filter((i) => num(arrived[i.itemId] ?? '0') > 0);
    const bad = delivery.items.find(
      (i) => !/^\d+(\.\d{1,3})?$/.test((arrived[i.itemId] ?? '').trim()) || num(arrived[i.itemId]!) > num(i.outstanding),
    );
    if (bad) return setError(t('Each quantity is a number from zero up to what is still to arrive'));
    if (lines.length === 0) return setError(t('Enter what arrived'));
    setBusy(true);
    setError('');
    try {
      await post(
        `/deliveries/${delivery.id}/receive`,
        { items: lines.map((i) => ({ itemId: i.itemId, qty: arrived[i.itemId]!.trim() })) },
        { idempotencyKey: key.current },
      );
      toast.success(t('The goods are in stock.'));
      key.current = crypto.randomUUID(); // a later part is a new receipt
      await Promise.all(['deliveries', 'alerts', 'products', 'stock'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('That could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="delivery">
      <div className="toolbar">
        <strong>{delivery.supplier ? t('From {name}', { name: delivery.supplier }) : t('Order {n}', { n: delivery.orderId })}</strong>
        <span className="muted">{t('Order {n}', { n: delivery.orderId })}</span>
        <span className="muted">{day(delivery.orderedAt)}</span>
      </div>
      {delivery.note && <p className="muted">{delivery.note}</p>}
      <table>
        <thead>
          <tr>
            <th>{t('Product')}</th>
            <th className="num">{t('Ordered')}</th>
            <th className="num">{t('Received so far')}</th>
            <th className="num">{t('Arrived now')}</th>
          </tr>
        </thead>
        <tbody>
          {delivery.items.map((i) => (
            <tr key={i.itemId} data-testid="delivery-line">
              <td>{i.name.trim()}</td>
              <td className="num">{i.ordered}</td>
              <td className="num">{i.received}</td>
              <td className="num">
                <input
                  inputMode="decimal"
                  disabled={num(i.outstanding) === 0}
                  aria-label={t('Arrived: {name}', { name: i.name.trim() })}
                  value={arrived[i.itemId] ?? ''}
                  onChange={(e) => setArrived({ ...arrived, [i.itemId]: e.target.value })}
                  style={{ width: 90, textAlign: 'end' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <div className="banner warn" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn primary big" onClick={() => void receive()} disabled={busy}>
          {t('Receive')}
        </button>
      </div>
    </section>
  );
}
