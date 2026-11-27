import { parseQtyMilli } from '@pos/shared';
import { z } from 'zod';
import type { Database, Queryable } from '../../db/adapter';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import { costInProductCurrency } from '../purchases/service';
import type { Actor } from '../sales/service';
import { defaultWarehouseIdQ } from '../settings/context';
import { me, type Result } from '../transfers/service';

// Expected deliveries (docs/15 §6, P5d). HQ buys; the goods are delivered to STOCK branches only. HQ sends this branch what it expects from a supplier
// (expected_deliveries + items, filled only from HQ) and a manager RECEIVES against it, all at once or in parts as the goods arrive: stock enters through
// the ledger (`purchase` movements) and the product's cost follows the price paid, as for any received purchase. A receipt is a fact sent up to HQ, which
// closes the order when every line has fully arrived. A delivery HQ has closed or cancelled can no longer be received.

export const RECEIVE_SCOPE = 'POST /deliveries/receive';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

export const receiveBody = z.object({
  note: z.string().trim().max(300).nullish(),
  /** What arrived, by expected line. Left out: everything still to arrive. */
  items: z
    .array(z.object({ itemId: z.number().int().positive(), qty }))
    .max(500)
    .optional(),
});

type DeliveryRow = {
  id: number;
  order_id: number;
  supplier_id: number | null;
  currency: 'USD' | 'LBP';
  status: 'open' | 'closed' | 'cancelled';
  note: string | null;
  ordered_at: string;
};

const DELIVERY = 'SELECT id, order_id, supplier_id, currency, status, note, ordered_at FROM expected_deliveries';

export async function deliveryJson(q: Queryable, d: DeliveryRow) {
  const supplier = d.supplier_id ? await q.one<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', [d.supplier_id]) : undefined;
  const items = await q.all<{
    id: number;
    product_id: number;
    name: string | null;
    qty_milli: number;
    unit_cost_minor: number;
    received: number;
  }>(
    `SELECT i.id, i.product_id, p.name, i.qty_milli, i.unit_cost_minor,
            COALESCE((SELECT SUM(ri.qty_milli) FROM po_receipt_items ri WHERE ri.item_id = i.id), 0) AS received
     FROM expected_delivery_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.delivery_id = ? ORDER BY i.id`,
    [d.id],
  );
  const outstanding = items.reduce((n, i) => n + Math.max(i.qty_milli - i.received, 0), 0);
  return {
    id: d.id,
    orderId: d.order_id,
    supplier: supplier?.name ?? null,
    currency: d.currency,
    note: d.note,
    orderedAt: d.ordered_at,
    // `open`: still expected. `closed`: HQ closed the order (complete, or accepted short). `cancelled`: HQ cancelled it.
    status: d.status,
    complete: outstanding === 0,
    items: items.map((i) => ({
      itemId: i.id,
      productId: i.product_id,
      name: i.name ?? `Product ${i.product_id}`,
      ordered: milliToQty(i.qty_milli),
      received: milliToQty(i.received),
      outstanding: milliToQty(Math.max(i.qty_milli - i.received, 0)),
      unitCostMinor: i.unit_cost_minor,
    })),
  };
}

export async function listDeliveries(q: Queryable, status: 'open' | 'all', limit: number) {
  const rows = await q.all<DeliveryRow>(`${DELIVERY} ${status === 'open' ? `WHERE status = 'open'` : ''} ORDER BY id DESC LIMIT ?`, [
    limit,
  ]);
  return { data: await Promise.all(rows.map((r) => deliveryJson(q, r))) };
}

export async function getDelivery(q: Queryable, id: number) {
  const row = await q.one<DeliveryRow>(`${DELIVERY} WHERE id = ?`, [id]);
  if (!row) throw E.notFound('Delivery');
  return deliveryJson(q, row);
}

/** Receive goods against an expected delivery, in whole or in part. Stock goes up and each product's cost follows the price paid. Idempotent. */
export async function receiveDelivery(
  db: Database,
  actor: Actor,
  id: number,
  body: z.infer<typeof receiveBody>,
  idem: { key: string; hash: string },
): Promise<Result> {
  const given = new Map<number, number>();
  for (const i of body.items ?? []) {
    if (given.has(i.itemId)) throw new AppError(422, 'DUPLICATE_LINE', 'Each line may appear once');
    given.set(i.itemId, parseQtyMilli(i.qty));
  }
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, RECEIVE_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };
    const mine = await me(q);
    if (mine.kind !== 'stock')
      throw E.conflict('ONLY_A_STOCK_BRANCH_RECEIVES', 'Goods from suppliers are delivered to stock branches only');
    const delivery = await q.one<DeliveryRow>(`${DELIVERY} WHERE id = ?`, [id]);
    if (!delivery) throw E.notFound('Delivery');
    if (delivery.status !== 'open')
      throw E.conflict(
        'DELIVERY_ENDED',
        `HQ has ${delivery.status === 'cancelled' ? 'cancelled' : 'closed'} this order: nothing more can be received on it`,
      );

    const items = await q.all<{ id: number; product_id: number; qty_milli: number; unit_cost_minor: number; received: number }>(
      `SELECT i.id, i.product_id, i.qty_milli, i.unit_cost_minor, COALESCE((SELECT SUM(ri.qty_milli) FROM po_receipt_items ri WHERE ri.item_id = i.id), 0) AS received
       FROM expected_delivery_items i WHERE i.delivery_id = ? ORDER BY i.id`,
      [id],
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const itemId of given.keys())
      if (!byId.has(itemId)) throw new AppError(422, 'NOT_IN_DELIVERY', `Line ${itemId} is not part of this delivery`);
    const toReceive = (
      body.items === undefined
        ? items.map((i) => ({ item: i, qtyMilli: i.qty_milli - i.received }))
        : [...given].map(([itemId, qtyMilli]) => ({ item: byId.get(itemId)!, qtyMilli }))
    ).filter((r) => r.qtyMilli > 0);
    if (toReceive.length === 0) throw new AppError(422, 'NOTHING_TO_RECEIVE', 'Nothing is still to arrive on this delivery');
    for (const r of toReceive) {
      const outstanding = r.item.qty_milli - r.item.received;
      if (r.qtyMilli > outstanding)
        throw new AppError(422, 'RECEIVE_EXCEEDS_ORDERED', `Only ${milliToQty(outstanding)} of line ${r.item.id} is still to arrive`, {
          itemId: r.item.id,
          outstanding: milliToQty(outstanding),
        });
      if (!(await q.one('SELECT 1 AS x FROM products WHERE id = ?', [r.item.product_id])))
        throw new AppError(
          422,
          'UNKNOWN_PRODUCT',
          'A product of this delivery has not reached this branch from HQ yet. Try again in a moment.',
        );
    }

    const receipt = (await q.one<{ id: number }>(
      'INSERT INTO po_receipts (delivery_id, note, item_count, user_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [id, body.note?.trim() || null, toReceive.length, actor.id, nowIso()],
    ))!;
    const warehouseId = await defaultWarehouseIdQ(q);
    const costUpdates: { productId: number; before: number; after: number }[] = [];
    for (const { item, qtyMilli } of toReceive) {
      await q.run('INSERT INTO po_receipt_items (receipt_id, item_id, product_id, qty_milli) VALUES (?, ?, ?, ?)', [
        receipt.id,
        item.id,
        item.product_id,
        qtyMilli,
      ]);
      await q.run(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id) VALUES (?, ?, ?, 'purchase', 'po_receipt', ?, ?)`,
        [item.product_id, warehouseId, qtyMilli, receipt.id, actor.id],
      );
      await q.run(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
        [item.product_id, warehouseId, qtyMilli],
      );
      // The cost follows the price paid, in the product's own currency (as for any received purchase).
      const product = (await q.one<{ cost_minor: number; currency: 'USD' | 'LBP' }>(
        'SELECT cost_minor, currency FROM products WHERE id = ?',
        [item.product_id],
      ))!;
      const newCost = await costInProductCurrency(q, item.unit_cost_minor, delivery.currency, product.currency);
      if (newCost !== product.cost_minor) {
        await q.run('UPDATE products SET cost_minor = ?, updated_at = ? WHERE id = ?', [newCost, nowIso(), item.product_id]);
        costUpdates.push({ productId: item.product_id, before: product.cost_minor, after: newCost });
      }
    }
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'delivery.receive',
      entity: 'delivery',
      entityId: id,
      after: { orderId: delivery.order_id, lines: toReceive.map((r) => ({ itemId: r.item.id, qty: milliToQty(r.qtyMilli) })), costUpdates },
    });
    const response = { receiptId: receipt.id, delivery: await getDelivery(q, id), costUpdates };
    await rememberResponseQ(q, RECEIVE_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
