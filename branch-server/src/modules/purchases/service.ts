import { lbpToUsdCents, parseQtyMilli, roundDiv, usdToLbp } from '@pos/shared';
import { z } from 'zod';
import type { Database, Param, Queryable } from '../../db/adapter';
import { nextRefQ } from '../../db/counters';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import { currentRateQ, defaultWarehouseIdQ } from '../settings/context';
import type { Actor } from '../sales/service';

export const RECEIVE_SCOPE = 'POST /purchases/receive';
export const SUPPLIER_PAYMENT_SCOPE = 'POST /purchases/payments';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

const line = z.object({
  productId: z.number().int().positive(),
  qty,
  /** Unit cost in the purchase's currency (USD cents or whole LBP). */
  costMinor: z.number().int().min(0),
});

export const purchaseBody = z.object({
  supplierId: z.number().int().positive().nullish(),
  currency: z.enum(['USD', 'LBP']).default('LBP'),
  status: z.enum(['draft', 'ordered']).default('draft'),
  items: z.array(line).min(1, 'A purchase needs at least one item').max(200),
});
export const purchasePatchBody = z
  .object({
    supplierId: z.number().int().positive().nullable(),
    currency: z.enum(['USD', 'LBP']),
    status: z.enum(['draft', 'ordered']),
    items: z.array(line).min(1).max(200),
  })
  .partial();
export const receiveBody = z.object({
  /** Omit to receive everything still outstanding. */
  items: z
    .array(z.object({ purchaseItemId: z.number().int().positive(), qty }))
    .min(1)
    .max(200)
    .optional(),
  /** Update each product's cost to what was paid on this purchase. */
  updateCost: z.boolean().default(true),
});
export const supplierPaymentBody = z.object({ amountMinor: z.number().int().positive(), note: z.string().trim().max(200).optional() });

export type PurchaseRow = {
  id: number;
  ref: number;
  supplier_id: number | null;
  warehouse_id: number;
  status: 'draft' | 'ordered' | 'received';
  currency: 'USD' | 'LBP';
  total_minor: number;
  paid_minor: number;
  created_at: string;
  received_at: string | null;
};
type ItemRow = { id: number; product_id: number | null; name_snap: string; qty_milli: number; cost_minor: number; received_milli: number };

export const getPurchase = (q: Queryable, id: number) => q.one<PurchaseRow>('SELECT * FROM purchases WHERE id = ?', [id]);

const lineTotal = (costMinor: number, qtyMilli: number) => roundDiv(costMinor * qtyMilli, 1000);

export async function purchaseJson(q: Queryable, p: PurchaseRow) {
  const supplier = p.supplier_id ? await q.one<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', [p.supplier_id]) : undefined;
  const items = await q.all<ItemRow>(
    'SELECT id, product_id, name_snap, qty_milli, cost_minor, received_milli FROM purchase_items WHERE purchase_id = ? ORDER BY id',
    [p.id],
  );
  return {
    id: p.id,
    ref: p.ref,
    supplierId: p.supplier_id,
    supplierName: supplier?.name ?? null,
    status: p.status,
    currency: p.currency,
    totalMinor: p.total_minor,
    paidMinor: p.paid_minor,
    owedMinor: p.total_minor - p.paid_minor,
    createdAt: p.created_at,
    receivedAt: p.received_at,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: i.name_snap,
      qty: milliToQty(i.qty_milli),
      costMinor: i.cost_minor,
      lineTotalMinor: lineTotal(i.cost_minor, i.qty_milli),
      received: milliToQty(i.received_milli),
      outstanding: milliToQty(i.qty_milli - i.received_milli),
    })),
  };
}

/** Validate the lines against the catalog and price them. Stock on hand plays no part: any product can be ordered. */
async function priceLines(q: Queryable, items: z.infer<typeof purchaseBody>['items']) {
  const lines: { productId: number; name: string; qtyMilli: number; costMinor: number; total: number }[] = [];
  for (const i of items) {
    const p = await q.one<{ id: number; name: string }>('SELECT id, name FROM products WHERE id = ?', [i.productId]);
    if (!p) throw E.unprocessable('INVALID_REFERENCE', `Product ${i.productId} does not exist`);
    const qtyMilli = parseQtyMilli(i.qty);
    lines.push({ productId: p.id, name: p.name, qtyMilli, costMinor: i.costMinor, total: lineTotal(i.costMinor, qtyMilli) });
  }
  return { lines, total: lines.reduce((sum, l) => sum + l.total, 0) };
}

async function checkSupplier(q: Queryable, supplierId: number | null | undefined) {
  if (supplierId && !(await q.one('SELECT 1 FROM suppliers WHERE id = ?', [supplierId])))
    throw E.unprocessable('INVALID_REFERENCE', 'That supplier does not exist');
}

async function insertLines(q: Queryable, purchaseId: number, lines: Awaited<ReturnType<typeof priceLines>>['lines']) {
  for (const l of lines)
    await q.run('INSERT INTO purchase_items (purchase_id, product_id, name_snap, qty_milli, cost_minor) VALUES (?, ?, ?, ?, ?)', [
      purchaseId,
      l.productId,
      l.name,
      l.qtyMilli,
      l.costMinor,
    ]);
}

export function createPurchase(db: Database, actor: Actor, body: z.infer<typeof purchaseBody>): Promise<number> {
  return db.tx(async (q) => {
    await checkSupplier(q, body.supplierId);
    const { lines, total } = await priceLines(q, body.items);
    const ref = await nextRefQ(q, 'purchase_ref');
    const created = await q.one<{ id: number }>(
      'INSERT INTO purchases (ref, supplier_id, warehouse_id, status, currency, total_minor) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [ref, body.supplierId ?? null, await defaultWarehouseIdQ(q), body.status, body.currency, total],
    );
    const id = created!.id;
    await insertLines(q, id, lines);
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'purchase.create',
      entity: 'purchase',
      entityId: id,
      after: { ref, currency: body.currency, totalMinor: total, items: lines.length },
    });
    return id;
  });
}

/** Editing is only for orders nothing has arrived on yet. */
export function updatePurchase(db: Database, actor: Actor, id: number, body: z.infer<typeof purchasePatchBody>): Promise<void> {
  return db.tx(async (q) => {
    const before = await getPurchase(q, id);
    if (!before) throw E.notFound('Purchase');
    if (before.status === 'received') throw E.conflict('PURCHASE_RECEIVED', 'A received purchase cannot be changed');
    const arrived = await q.one('SELECT 1 FROM purchase_items WHERE purchase_id = ? AND received_milli > 0 LIMIT 1', [id]);
    if (arrived) throw E.conflict('PURCHASE_PARTLY_RECEIVED', 'Goods have already arrived on this purchase, so it can no longer be edited');
    if (body.supplierId !== undefined) await checkSupplier(q, body.supplierId);

    const sets: string[] = [];
    const vals: Param[] = [];
    const set = (col: string, v: Param) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (body.supplierId !== undefined) set('supplier_id', body.supplierId);
    if (body.currency !== undefined) set('currency', body.currency);
    if (body.status !== undefined) set('status', body.status);
    if (body.items) {
      const { lines, total } = await priceLines(q, body.items);
      await q.run('DELETE FROM purchase_items WHERE purchase_id = ?', [id]);
      await insertLines(q, id, lines);
      set('total_minor', total);
    }
    if (sets.length) await q.run(`UPDATE purchases SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'purchase.update',
      entity: 'purchase',
      entityId: id,
      before: { status: before.status, totalMinor: before.total_minor },
      after: body,
    });
  });
}

/** Convert a cost between currencies for a product that is priced in the other one. */
export async function costInProductCurrency(q: Queryable, costMinor: number, from: 'USD' | 'LBP', to: 'USD' | 'LBP'): Promise<number> {
  if (from === to) return costMinor;
  const rate = await currentRateQ(q);
  return from === 'USD' ? usdToLbp(costMinor, rate) : lbpToUsdCents(costMinor, rate);
}

/**
 * Receive goods (US-16). One transaction: stock goes up through the ledger, the line records what arrived, the order
 * becomes `received` when everything has, and (by default) each product's cost follows what was paid. Receiving is
 * never blocked by the quantity on hand, including zero or negative. Idempotent, and it can be done in parts.
 */
export function receivePurchase(
  db: Database,
  actor: Actor,
  id: number,
  body: z.infer<typeof receiveBody>,
  idem: { key: string; hash: string },
) {
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, RECEIVE_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const purchase = await getPurchase(q, id);
    if (!purchase) throw E.notFound('Purchase');
    if (purchase.status === 'received') throw E.conflict('PURCHASE_RECEIVED', 'Everything on this purchase has already been received');

    const all = await q.all<ItemRow>(
      'SELECT id, product_id, name_snap, qty_milli, cost_minor, received_milli FROM purchase_items WHERE purchase_id = ? ORDER BY id',
      [id],
    );
    const byId = new Map(all.map((i) => [i.id, i]));

    let toReceive: { item: ItemRow; qtyMilli: number }[];
    if (body.items) {
      const seen = new Set<number>();
      toReceive = body.items.map((r) => {
        if (seen.has(r.purchaseItemId)) throw E.validation('Each line may appear only once; combine the quantities');
        seen.add(r.purchaseItemId);
        const item = byId.get(r.purchaseItemId);
        if (!item) throw E.unprocessable('INVALID_REFERENCE', `Line ${r.purchaseItemId} is not part of this purchase`);
        const qtyMilli = parseQtyMilli(r.qty);
        const outstanding = item.qty_milli - item.received_milli;
        if (qtyMilli > outstanding) {
          throw new AppError(422, 'RECEIVE_EXCEEDS_ORDERED', `Only ${milliToQty(outstanding)} of "${item.name_snap}" is still to arrive`, {
            purchaseItemId: item.id,
            outstanding: milliToQty(outstanding),
          });
        }
        return { item, qtyMilli };
      });
    } else {
      toReceive = all
        .filter((i) => i.qty_milli > i.received_milli)
        .map((item) => ({ item, qtyMilli: item.qty_milli - item.received_milli }));
    }

    const costUpdates: { productId: number; before: number; after: number; currency: string }[] = [];

    for (const { item, qtyMilli } of toReceive) {
      await q.run('UPDATE purchase_items SET received_milli = received_milli + ? WHERE id = ?', [qtyMilli, item.id]);
      if (item.product_id === null) continue;
      await q.run(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id) VALUES (?, ?, ?, 'purchase', 'purchase', ?, ?)`,
        [item.product_id, purchase.warehouse_id, qtyMilli, purchase.id, actor.id],
      );
      await q.run(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
        [item.product_id, purchase.warehouse_id, qtyMilli],
      );

      if (body.updateCost) {
        const product = await q.one<{ cost_minor: number; price_minor: number; currency: 'USD' | 'LBP' }>(
          'SELECT cost_minor, price_minor, currency FROM products WHERE id = ?',
          [item.product_id],
        );
        if (product) {
          const newCost = await costInProductCurrency(q, item.cost_minor, purchase.currency, product.currency);
          if (newCost !== product.cost_minor) {
            await q.run('UPDATE products SET cost_minor = ?, updated_at = ? WHERE id = ?', [newCost, nowIso(), item.product_id]);
            await writeAuditQ(q, {
              userId: actor.id,
              action: 'product.price.update',
              entity: 'product',
              entityId: item.product_id,
              before: { priceMinor: product.price_minor, costMinor: product.cost_minor, currency: product.currency },
              after: { priceMinor: product.price_minor, costMinor: newCost, currency: product.currency, via: `purchase ${purchase.ref}` },
            });
            costUpdates.push({ productId: item.product_id, before: product.cost_minor, after: newCost, currency: product.currency });
          }
        }
      }
    }

    const remaining = (await q.one<{ n: number }>(
      'SELECT count(*) AS n FROM purchase_items WHERE purchase_id = ? AND received_milli < qty_milli',
      [id],
    ))!;
    if (remaining.n === 0) await q.run(`UPDATE purchases SET status = 'received', received_at = ? WHERE id = ?`, [nowIso(), id]);
    else if (purchase.status === 'draft') await q.run(`UPDATE purchases SET status = 'ordered' WHERE id = ?`, [id]);

    await writeAuditQ(q, {
      userId: actor.id,
      action: 'purchase.receive',
      entity: 'purchase',
      entityId: id,
      after: { lines: toReceive.map((r) => ({ id: r.item.id, qty: milliToQty(r.qtyMilli) })), complete: remaining.n === 0 },
    });

    const response = {
      ...(await purchaseJson(q, (await getPurchase(q, id))!)),
      receivedNow: toReceive.map((r) => ({ purchaseItemId: r.item.id, productId: r.item.product_id, qty: milliToQty(r.qtyMilli) })),
      costUpdates,
    };
    await rememberResponseQ(q, RECEIVE_SCOPE, idem.key, idem.hash, 200, response);
    return { statusCode: 200, body: response as unknown, replay: false };
  });
}

/** Pay a supplier, in part or in full. Bookkeeping on the purchase: a payment from the till is a cash movement as well. */
export function paySupplier(
  db: Database,
  actor: Actor,
  id: number,
  body: z.infer<typeof supplierPaymentBody>,
  idem: { key: string; hash: string },
) {
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, SUPPLIER_PAYMENT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const purchase = await getPurchase(q, id);
    if (!purchase) throw E.notFound('Purchase');
    if (purchase.status === 'draft') throw E.unprocessable('PURCHASE_NOT_ORDERED', 'Order the purchase before paying for it');
    const owed = purchase.total_minor - purchase.paid_minor;
    if (body.amountMinor > owed) throw E.unprocessable('PAYMENT_EXCEEDS_TOTAL', `Only ${owed} is still owed on this purchase`);

    const created = await q.one<{ id: number }>(
      'INSERT INTO purchase_payments (purchase_id, amount_minor, note, user_id, idempotency_key) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [id, body.amountMinor, body.note ?? null, actor.id, idem.key],
    );
    await q.run('UPDATE purchases SET paid_minor = paid_minor + ? WHERE id = ?', [body.amountMinor, id]);
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'purchase.payment',
      entity: 'purchase',
      entityId: id,
      after: { amountMinor: body.amountMinor, note: body.note ?? null },
    });

    const response = { paymentId: created!.id, ...(await purchaseJson(q, (await getPurchase(q, id))!)) };
    await rememberResponseQ(q, SUPPLIER_PAYMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
