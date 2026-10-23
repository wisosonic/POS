import { lbpToUsdCents, parseQtyMilli, roundDiv, usdToLbp } from '@pos/shared';
import { z } from 'zod';
import { nextRef } from '../../db/counters';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError, E } from '../../errors';
import { findReplay, rememberResponse } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { writeAudit } from '../audit/service';
import { currentRate, defaultWarehouseId } from '../settings/context';
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

type PurchaseRow = {
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

export const getPurchase = (db: Db, id: number) => db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow | undefined;

const lineTotal = (costMinor: number, qtyMilli: number) => roundDiv(costMinor * qtyMilli, 1000);

export function purchaseJson(db: Db, p: PurchaseRow) {
  const supplier = p.supplier_id
    ? (db.prepare('SELECT name FROM suppliers WHERE id = ?').get(p.supplier_id) as { name: string } | undefined)
    : undefined;
  const items = db
    .prepare(
      'SELECT id, product_id, name_snap, qty_milli, cost_minor, received_milli FROM purchase_items WHERE purchase_id = ? ORDER BY id',
    )
    .all(p.id) as ItemRow[];
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
function priceLines(db: Db, items: z.infer<typeof purchaseBody>['items']) {
  const find = db.prepare('SELECT id, name FROM products WHERE id = ?');
  const lines = items.map((i) => {
    const p = find.get(i.productId) as { id: number; name: string } | undefined;
    if (!p) throw E.unprocessable('INVALID_REFERENCE', `Product ${i.productId} does not exist`);
    const qtyMilli = parseQtyMilli(i.qty);
    return { productId: p.id, name: p.name, qtyMilli, costMinor: i.costMinor, total: lineTotal(i.costMinor, qtyMilli) };
  });
  return { lines, total: lines.reduce((sum, l) => sum + l.total, 0) };
}

function checkSupplier(db: Db, supplierId: number | null | undefined) {
  if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId))
    throw E.unprocessable('INVALID_REFERENCE', 'That supplier does not exist');
}

function insertLines(db: Db, purchaseId: number, lines: ReturnType<typeof priceLines>['lines']) {
  const ins = db.prepare('INSERT INTO purchase_items (purchase_id, product_id, name_snap, qty_milli, cost_minor) VALUES (?, ?, ?, ?, ?)');
  for (const l of lines) ins.run(purchaseId, l.productId, l.name, l.qtyMilli, l.costMinor);
}

export function createPurchase(db: Db, actor: Actor, body: z.infer<typeof purchaseBody>) {
  checkSupplier(db, body.supplierId);
  return inWriteTransaction(db, () => {
    const { lines, total } = priceLines(db, body.items);
    const ref = nextRef(db, 'purchase_ref');
    const id = Number(
      db
        .prepare('INSERT INTO purchases (ref, supplier_id, warehouse_id, status, currency, total_minor) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ref, body.supplierId ?? null, defaultWarehouseId(db), body.status, body.currency, total).lastInsertRowid,
    );
    insertLines(db, id, lines);
    writeAudit(db, {
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
export function updatePurchase(db: Db, actor: Actor, id: number, body: z.infer<typeof purchasePatchBody>) {
  const before = getPurchase(db, id);
  if (!before) throw E.notFound('Purchase');
  if (before.status === 'received') throw E.conflict('PURCHASE_RECEIVED', 'A received purchase cannot be changed');
  const arrived = db.prepare('SELECT 1 FROM purchase_items WHERE purchase_id = ? AND received_milli > 0 LIMIT 1').get(id);
  if (arrived) throw E.conflict('PURCHASE_PARTLY_RECEIVED', 'Goods have already arrived on this purchase, so it can no longer be edited');
  if (body.supplierId !== undefined) checkSupplier(db, body.supplierId);

  inWriteTransaction(db, () => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (body.supplierId !== undefined) set('supplier_id', body.supplierId);
    if (body.currency !== undefined) set('currency', body.currency);
    if (body.status !== undefined) set('status', body.status);
    if (body.items) {
      const { lines, total } = priceLines(db, body.items);
      db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(id);
      insertLines(db, id, lines);
      set('total_minor', total);
    }
    if (sets.length) db.prepare(`UPDATE purchases SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    writeAudit(db, {
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
function costInProductCurrency(db: Db, costMinor: number, from: 'USD' | 'LBP', to: 'USD' | 'LBP'): number {
  if (from === to) return costMinor;
  const rate = currentRate(db);
  return from === 'USD' ? usdToLbp(costMinor, rate) : lbpToUsdCents(costMinor, rate);
}

/**
 * Receive goods (US-16). One transaction: stock goes up through the ledger, the line records what arrived, the order
 * becomes `received` when everything has, and (by default) each product's cost follows what was paid. Receiving is
 * never blocked by the quantity on hand, including zero or negative. Idempotent, and it can be done in parts.
 */
export function receivePurchase(db: Db, actor: Actor, id: number, body: z.infer<typeof receiveBody>, idem: { key: string; hash: string }) {
  return inWriteTransaction(db, () => {
    const replay = findReplay(db, RECEIVE_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const purchase = getPurchase(db, id);
    if (!purchase) throw E.notFound('Purchase');
    if (purchase.status === 'received') throw E.conflict('PURCHASE_RECEIVED', 'Everything on this purchase has already been received');

    const all = db
      .prepare(
        'SELECT id, product_id, name_snap, qty_milli, cost_minor, received_milli FROM purchase_items WHERE purchase_id = ? ORDER BY id',
      )
      .all(id) as ItemRow[];
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

    const insertMovement = db.prepare(
      `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id) VALUES (?, ?, ?, 'purchase', 'purchase', ?, ?)`,
    );
    const upsertLevel = db.prepare(
      `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
    );
    const markReceived = db.prepare('UPDATE purchase_items SET received_milli = received_milli + ? WHERE id = ?');
    const costUpdates: { productId: number; before: number; after: number; currency: string }[] = [];

    for (const { item, qtyMilli } of toReceive) {
      markReceived.run(qtyMilli, item.id);
      if (item.product_id === null) continue;
      insertMovement.run(item.product_id, purchase.warehouse_id, qtyMilli, purchase.id, actor.id);
      upsertLevel.run(item.product_id, purchase.warehouse_id, qtyMilli);

      if (body.updateCost) {
        const product = db.prepare('SELECT cost_minor, price_minor, currency FROM products WHERE id = ?').get(item.product_id) as
          { cost_minor: number; price_minor: number; currency: 'USD' | 'LBP' } | undefined;
        if (product) {
          const newCost = costInProductCurrency(db, item.cost_minor, purchase.currency, product.currency);
          if (newCost !== product.cost_minor) {
            db.prepare('UPDATE products SET cost_minor = ?, updated_at = ? WHERE id = ?').run(newCost, nowIso(), item.product_id);
            writeAudit(db, {
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

    const remaining = db
      .prepare('SELECT count(*) AS n FROM purchase_items WHERE purchase_id = ? AND received_milli < qty_milli')
      .get(id) as { n: number };
    if (remaining.n === 0) db.prepare(`UPDATE purchases SET status = 'received', received_at = ? WHERE id = ?`).run(nowIso(), id);
    else if (purchase.status === 'draft') db.prepare(`UPDATE purchases SET status = 'ordered' WHERE id = ?`).run(id);

    writeAudit(db, {
      userId: actor.id,
      action: 'purchase.receive',
      entity: 'purchase',
      entityId: id,
      after: { lines: toReceive.map((r) => ({ id: r.item.id, qty: milliToQty(r.qtyMilli) })), complete: remaining.n === 0 },
    });

    const response = {
      ...purchaseJson(db, getPurchase(db, id)!),
      receivedNow: toReceive.map((r) => ({ purchaseItemId: r.item.id, productId: r.item.product_id, qty: milliToQty(r.qtyMilli) })),
      costUpdates,
    };
    rememberResponse(db, RECEIVE_SCOPE, idem.key, idem.hash, 200, response);
    return { statusCode: 200, body: response as unknown, replay: false };
  });
}

/** Pay a supplier, in part or in full. Bookkeeping on the purchase: a payment from the till is a cash movement as well. */
export function paySupplier(
  db: Db,
  actor: Actor,
  id: number,
  body: z.infer<typeof supplierPaymentBody>,
  idem: { key: string; hash: string },
) {
  return inWriteTransaction(db, () => {
    const replay = findReplay(db, SUPPLIER_PAYMENT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const purchase = getPurchase(db, id);
    if (!purchase) throw E.notFound('Purchase');
    if (purchase.status === 'draft') throw E.unprocessable('PURCHASE_NOT_ORDERED', 'Order the purchase before paying for it');
    const owed = purchase.total_minor - purchase.paid_minor;
    if (body.amountMinor > owed) throw E.unprocessable('PAYMENT_EXCEEDS_TOTAL', `Only ${owed} is still owed on this purchase`);

    const paymentId = Number(
      db
        .prepare('INSERT INTO purchase_payments (purchase_id, amount_minor, note, user_id, idempotency_key) VALUES (?, ?, ?, ?, ?)')
        .run(id, body.amountMinor, body.note ?? null, actor.id, idem.key).lastInsertRowid,
    );
    db.prepare('UPDATE purchases SET paid_minor = paid_minor + ? WHERE id = ?').run(body.amountMinor, id);
    writeAudit(db, {
      userId: actor.id,
      action: 'purchase.payment',
      entity: 'purchase',
      entityId: id,
      after: { amountMinor: body.amountMinor, note: body.note ?? null },
    });

    const response = { paymentId, ...purchaseJson(db, getPurchase(db, id)!) };
    rememberResponse(db, SUPPLIER_PAYMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
