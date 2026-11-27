import { parseQtyMilli } from '@pos/shared';
import { z } from 'zod';
import type { Database, Queryable } from '../../db/adapter';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import { getBranchKind, type BranchKind } from '../branch/kind';
import { defaultWarehouseIdQ } from '../settings/context';
import type { Actor } from '../sales/service';

// Moving stock between branches (docs/15 §4, P5b). Two documents, each written by ONE party:
//   a SHIPMENT by the sending branch: stock leaves it at once (the ledger), with the sender's cost of each product;
//   a RECEIPT by the receiving branch, which confirms an INCOMING shipment (HQ relays each shipment to its receiver): stock enters it, a count that
//   differs from what was shipped becomes an adjustment (the shortfall or surplus is visible in the receiver's books, with its reason), and the
//   received cost is blended into the receiver's own cost by quantity.
// Directions: stock to sale (supply), stock to stock (rebalance), sale to stock (return). Never sale to sale. A manager ships and receives.
// Stock never blocks anything (rule 17): shipping more than the system thinks is there is allowed. History is append-only: a mistake is corrected
// by the receiver's count.

export const SHIPMENT_SCOPE = 'POST /shipments';
export const RECEIPT_SCOPE = 'POST /receipts';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');
// A count may be zero (nothing arrived).
const count = z.string().regex(/^\d+(\.\d{1,3})?$/, 'A count is a number with at most 3 decimals');

export const shipmentBody = z.object({
  toBranchId: z.number().int().positive(),
  note: z.string().trim().max(300).nullish(),
  items: z
    .array(z.object({ productId: z.number().int().positive(), qty }))
    .min(1, 'A shipment needs at least one item')
    .max(200),
});

export const receiptBody = z.object({
  incomingId: z.number().int().positive(),
  note: z.string().trim().max(300).nullish(),
  /** What was counted, for the products that differ from what was shipped. A product left out arrived as shipped. */
  items: z
    .array(z.object({ productId: z.number().int().positive(), counted: count, reason: z.string().trim().max(200).nullish() }))
    .max(200)
    .default([]),
});

export type Result = { statusCode: number; body: unknown; replay: boolean };
export type Reason = 'supply' | 'rebalance' | 'return';

/** What the stock movement is called, from the two kinds. A sale branch can only send to a stock branch. */
export function reasonFor(from: BranchKind, to: BranchKind): Reason {
  if (from === 'sale' && to === 'sale')
    throw new AppError(
      422,
      'DIRECTION_NOT_ALLOWED',
      'Stock cannot go from one sale branch to another. Send it back to a stock branch; the other branch can then request it.',
    );
  return from === 'stock' ? (to === 'sale' ? 'supply' : 'rebalance') : 'return';
}

export async function me(q: Queryable): Promise<{ hqId: number; kind: BranchKind }> {
  const link = await q.one<{ hq_branch_id: number }>('SELECT hq_branch_id FROM hq_link WHERE id = 1');
  if (!link) throw E.conflict('NOT_CONNECTED', 'Moving stock between branches needs this branch to be connected to HQ');
  return { hqId: link.hq_branch_id, kind: await getBranchKind(q) };
}

export type DirectoryRow = { id: number; code: string; name: string; kind: BranchKind; active: number };

/** Where this branch may send stock: every other active branch, with whether the direction is allowed. */
export async function destinations(q: Queryable) {
  const link = await q.one<{ hq_branch_id: number }>('SELECT hq_branch_id FROM hq_link WHERE id = 1');
  if (!link) return { connected: false, kind: await getBranchKind(q), data: [] };
  const kind = await getBranchKind(q);
  const rows = await q.all<DirectoryRow>(
    'SELECT id, code, name, kind, active FROM branch_directory WHERE active = 1 AND id <> ? ORDER BY name, id',
    [link.hq_branch_id],
  );
  return {
    connected: true,
    kind,
    data: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, allowed: !(kind === 'sale' && r.kind === 'sale') })),
  };
}

async function putStock(q: Queryable, productId: number, warehouseId: number, delta: number): Promise<void> {
  await q.run(
    `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
    [productId, warehouseId, delta],
  );
}

// ------------------------------------------------------------------ shipments

export async function shipmentJson(q: Queryable, id: number) {
  const s = await q.one<{
    id: number;
    to_branch_id: number;
    reason: Reason;
    note: string | null;
    item_count: number;
    user_id: number | null;
    created_at: string;
  }>('SELECT id, to_branch_id, reason, note, item_count, user_id, created_at FROM shipments WHERE id = ?', [id]);
  if (!s) throw E.notFound('Shipment');
  const to = await q.one<{ name: string; kind: string }>('SELECT name, kind FROM branch_directory WHERE id = ?', [s.to_branch_id]);
  const items = await q.all<{ id: number; product_id: number; name: string; qty_milli: number; unit_cost: number }>(
    `SELECT x.id, x.product_id, p.name, x.qty_milli, x.unit_cost FROM shipment_items x JOIN products p ON p.id = x.product_id WHERE x.shipment_id = ? ORDER BY x.id`,
    [id],
  );
  return {
    id: s.id,
    toBranchId: s.to_branch_id,
    toBranch: to?.name ?? `Branch ${s.to_branch_id}`,
    reason: s.reason,
    note: s.note,
    userId: s.user_id,
    createdAt: s.created_at,
    items: items.map((i) => ({ productId: i.product_id, name: i.name, qty: milliToQty(i.qty_milli), unitCost: i.unit_cost })),
  };
}

/**
 * Write a shipment and take its stock out, inside the caller's transaction (docs/15 §4). Shared by `createShipment` and by filling a pick list
 * (modules/requests). The caller has already checked the direction and the destination.
 */
export async function shipInTx(
  q: Queryable,
  actor: Actor,
  to: { id: number; name: string },
  reason: Reason,
  note: string | null,
  items: { productId: number; qtyMilli: number }[],
): Promise<number> {
  const now = nowIso();
  const shipment = (await q.one<{ id: number }>(
    'INSERT INTO shipments (to_branch_id, reason, note, item_count, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [to.id, reason, note, items.length, actor.id, now],
  ))!;
  const warehouseId = await defaultWarehouseIdQ(q);
  for (const item of items) {
    const product = await q.one<{ cost_minor: number }>('SELECT cost_minor FROM products WHERE id = ?', [item.productId]);
    if (!product) throw E.notFound('Product');
    await q.run('INSERT INTO shipment_items (shipment_id, product_id, qty_milli, unit_cost) VALUES (?, ?, ?, ?)', [
      shipment.id,
      item.productId,
      item.qtyMilli,
      product.cost_minor,
    ]);
    await q.run(
      `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
       VALUES (?, ?, ?, 'transfer', 'shipment', ?, ?, ?)`,
      [item.productId, warehouseId, -item.qtyMilli, shipment.id, actor.id, `to ${to.name}`],
    );
    await putStock(q, item.productId, warehouseId, -item.qtyMilli);
  }
  await writeAuditQ(q, {
    userId: actor.id,
    action: 'shipment.create',
    entity: 'shipment',
    entityId: shipment.id,
    after: { toBranch: to.name, reason, lines: items.length },
  });
  return shipment.id;
}

/** Send stock to another branch. Stock leaves this branch now; HQ relays the shipment to its receiver. Idempotent. */
export async function createShipment(
  db: Database,
  actor: Actor,
  body: z.infer<typeof shipmentBody>,
  idem: { key: string; hash: string },
): Promise<Result> {
  const quantities = body.items.map((i) => parseQtyMilli(i.qty)); // parse before the transaction
  if (new Set(body.items.map((i) => i.productId)).size !== body.items.length)
    throw new AppError(422, 'DUPLICATE_PRODUCT', 'Each product may appear once in a shipment');
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, SHIPMENT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const mine = await me(q);
    const to = await q.one<DirectoryRow>('SELECT id, code, name, kind, active FROM branch_directory WHERE id = ?', [body.toBranchId]);
    if (!to || to.active !== 1) throw new AppError(422, 'UNKNOWN_BRANCH', 'There is no such branch to send to');
    if (to.id === mine.hqId) throw new AppError(422, 'SAME_BRANCH', 'This is the branch itself');
    const reason = reasonFor(mine.kind, to.kind);
    const note = body.note?.trim() || null;
    if (reason === 'return' && !note)
      throw new AppError(422, 'RETURN_NEEDS_REASON', 'Say why the stock is going back (slow selling, a surplus, a wrong order)');

    const shipmentId = await shipInTx(
      q,
      actor,
      to,
      reason,
      note,
      body.items.map((it, i) => ({ productId: it.productId, qtyMilli: quantities[i]! })),
    );
    const response = await shipmentJson(q, shipmentId);
    await rememberResponseQ(q, SHIPMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}

export async function listShipments(q: Queryable, opts: { limit: number; cursor?: number }) {
  const rows = await q.all<{ id: number }>(`SELECT id FROM shipments ${opts.cursor ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, [
    ...(opts.cursor ? [opts.cursor] : []),
    opts.limit + 1,
  ]);
  const page = rows.slice(0, opts.limit);
  return {
    data: await Promise.all(page.map((r) => shipmentJson(q, r.id))),
    nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}

// ------------------------------------------------------------------ incoming and receipts

type IncomingRow = {
  id: number;
  from_branch_id: number;
  to_branch_id: number;
  shipment_id: number;
  reason: Reason;
  note: string | null;
  shipped_at: string;
  receipt_id: number | null;
  received_at: string | null;
};

const INCOMING = `SELECT i.id, i.from_branch_id, i.to_branch_id, i.shipment_id, i.reason, i.note, i.shipped_at, r.id AS receipt_id, r.created_at AS received_at
  FROM incoming_shipments i LEFT JOIN receipts r ON r.incoming_id = i.id`;

export async function incomingJson(q: Queryable, i: IncomingRow) {
  const from = await q.one<{ name: string }>('SELECT name FROM branch_directory WHERE id = ?', [i.from_branch_id]);
  const items = await q.all<{
    product_id: number;
    name: string | null;
    qty_milli: number;
    unit_cost: number;
    counted: number | null;
    reason: string | null;
  }>(
    `SELECT x.product_id, p.name, x.qty_milli, x.unit_cost, ri.qty_counted_milli AS counted, ri.reason
     FROM incoming_shipment_items x LEFT JOIN products p ON p.id = x.product_id
          LEFT JOIN receipt_items ri ON ri.receipt_id = ? AND ri.product_id = x.product_id
     WHERE x.incoming_id = ? ORDER BY x.id`,
    [i.receipt_id ?? 0, i.id],
  );
  return {
    id: i.id,
    fromBranchId: i.from_branch_id,
    fromBranch: from?.name ?? `Branch ${i.from_branch_id}`,
    reason: i.reason,
    note: i.note,
    shippedAt: i.shipped_at,
    status: i.receipt_id === null ? ('on_the_way' as const) : ('received' as const),
    receivedAt: i.received_at,
    items: items.map((x) => ({
      productId: x.product_id,
      name: x.name ?? `Product ${x.product_id}`,
      qty: milliToQty(x.qty_milli),
      unitCost: x.unit_cost,
      counted: x.counted === null ? null : milliToQty(x.counted),
      reason: x.reason,
    })),
  };
}

export async function listIncoming(q: Queryable, status: 'on_the_way' | 'received' | 'all', limit: number) {
  const where = status === 'on_the_way' ? 'WHERE r.id IS NULL' : status === 'received' ? 'WHERE r.id IS NOT NULL' : '';
  const rows = await q.all<IncomingRow>(`${INCOMING} ${where} ORDER BY i.id DESC LIMIT ?`, [limit]);
  return { data: await Promise.all(rows.map((r) => incomingJson(q, r))) };
}

export async function getIncoming(q: Queryable, id: number) {
  const row = await q.one<IncomingRow>(`${INCOMING} WHERE i.id = ?`, [id]);
  if (!row) throw E.notFound('Incoming shipment');
  return incomingJson(q, row);
}

const parseCount = (v: string): number => (/^0+(\.0+)?$/.test(v) ? 0 : parseQtyMilli(v));

/**
 * The received cost is blended into this branch's own by quantity (an assumption of docs/15 #32): the stock already here keeps its cost, what arrives
 * brings the sender's. With nothing (or less than nothing) on the shelves, the received cost simply becomes the cost.
 */
export function blendedCost(oldQtyMilli: number, oldCost: number, inQtyMilli: number, inCost: number): number {
  const have = Math.max(oldQtyMilli, 0);
  if (inQtyMilli <= 0) return oldCost;
  if (have === 0) return inCost;
  return Math.round((have * oldCost + inQtyMilli * inCost) / (have + inQtyMilli));
}

/** Confirm an incoming shipment. Stock enters this branch; a difference between the count and the shipment is an adjustment with its reason. Idempotent. */
export async function createReceipt(
  db: Database,
  actor: Actor,
  body: z.infer<typeof receiptBody>,
  idem: { key: string; hash: string },
): Promise<Result> {
  const counted = new Map<number, { milli: number; reason: string | null }>();
  for (const c of body.items) {
    if (counted.has(c.productId)) throw new AppError(422, 'DUPLICATE_PRODUCT', 'Each product may appear once in a receipt');
    counted.set(c.productId, { milli: parseCount(c.counted), reason: c.reason?.trim() || null });
  }
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, RECEIPT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const mine = await me(q);
    const incoming = await q.one<IncomingRow>(`${INCOMING} WHERE i.id = ?`, [body.incomingId]);
    if (!incoming || incoming.to_branch_id !== mine.hqId) throw E.notFound('Incoming shipment');
    if (incoming.receipt_id !== null) throw E.conflict('ALREADY_RECEIVED', 'This shipment has already been confirmed');
    const lines = await q.all<{ product_id: number; qty_milli: number; unit_cost: number }>(
      'SELECT product_id, qty_milli, unit_cost FROM incoming_shipment_items WHERE incoming_id = ? ORDER BY id',
      [incoming.id],
    );
    const inShipment = new Set(lines.map((l) => l.product_id));
    for (const productId of counted.keys())
      if (!inShipment.has(productId)) throw new AppError(422, 'NOT_IN_SHIPMENT', `Product ${productId} is not part of this shipment`);

    // Every difference needs its reason, and every product must be known here (the catalog comes from HQ).
    for (const l of lines) {
      const c = counted.get(l.product_id);
      if (!(await q.one('SELECT 1 AS x FROM products WHERE id = ?', [l.product_id])))
        throw new AppError(
          422,
          'UNKNOWN_PRODUCT',
          'A product of this shipment has not reached this branch from HQ yet. Try again in a moment.',
        );
      if (c && c.milli !== l.qty_milli && !c.reason)
        throw new AppError(422, 'DIFFERENCE_NEEDS_REASON', `Say why the count of product ${l.product_id} differs from what was shipped`, {
          productId: l.product_id,
        });
    }

    const now = nowIso();
    const receipt = (await q.one<{ id: number }>(
      'INSERT INTO receipts (incoming_id, from_branch_id, user_id, note, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [incoming.id, incoming.from_branch_id, actor.id, body.note?.trim() || null, now],
    ))!;
    const from = await q.one<{ name: string }>('SELECT name FROM branch_directory WHERE id = ?', [incoming.from_branch_id]);
    const warehouseId = await defaultWarehouseIdQ(q);
    const costUpdates: { productId: number; before: number; after: number }[] = [];
    let differences = 0;
    for (const l of lines) {
      const c = counted.get(l.product_id);
      const got = c ? c.milli : l.qty_milli;
      const diff = got - l.qty_milli;
      await q.run(
        'INSERT INTO receipt_items (receipt_id, product_id, qty_expected_milli, qty_counted_milli, reason) VALUES (?, ?, ?, ?, ?)',
        [receipt.id, l.product_id, l.qty_milli, got, diff === 0 ? null : c!.reason],
      );
      // The cost, blended with what is on the shelves BEFORE this arrives.
      const product = (await q.one<{ cost_minor: number }>('SELECT cost_minor FROM products WHERE id = ?', [l.product_id]))!;
      const onHand = (await q.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', [
        l.product_id,
      ]))!.n;
      const newCost = blendedCost(onHand, product.cost_minor, got, l.unit_cost);
      // The shipment comes in at the quantity shipped, then a difference is booked as an adjustment with its reason: both are in the receiver's books.
      await q.run(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
         VALUES (?, ?, ?, 'transfer', 'receipt', ?, ?, ?)`,
        [l.product_id, warehouseId, l.qty_milli, receipt.id, actor.id, `from ${from?.name ?? `branch ${incoming.from_branch_id}`}`],
      );
      await putStock(q, l.product_id, warehouseId, l.qty_milli);
      if (diff !== 0) {
        differences += 1;
        await q.run(
          `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
           VALUES (?, ?, ?, 'adjustment', 'receipt', ?, ?, ?)`,
          [l.product_id, warehouseId, diff, receipt.id, actor.id, c!.reason],
        );
        await putStock(q, l.product_id, warehouseId, diff);
      }
      if (newCost !== product.cost_minor) {
        await q.run('UPDATE products SET cost_minor = ?, updated_at = ? WHERE id = ?', [newCost, now, l.product_id]);
        costUpdates.push({ productId: l.product_id, before: product.cost_minor, after: newCost });
      }
    }
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'receipt.create',
      entity: 'receipt',
      entityId: receipt.id,
      after: { incomingId: incoming.id, fromBranch: from?.name ?? incoming.from_branch_id, lines: lines.length, differences, costUpdates },
    });
    const response = { id: receipt.id, incoming: await getIncomingQ(q, incoming.id), costUpdates };
    await rememberResponseQ(q, RECEIPT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}

const getIncomingQ = (q: Queryable, id: number) => getIncoming(q, id);

export async function listReceipts(q: Queryable, limit: number) {
  const rows = await q.all<{ incoming_id: number }>('SELECT incoming_id FROM receipts ORDER BY id DESC LIMIT ?', [limit]);
  return { data: await Promise.all(rows.map((r) => getIncoming(q, r.incoming_id))) };
}
