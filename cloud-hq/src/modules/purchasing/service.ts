import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { roundDiv } from '@pos/shared/money';
import { writeAudit } from '../staff/context';

// Central purchasing (docs/15 §6, P5d). HQ buys, and the goods are delivered to STOCK branches only. An order is a DRAFT until HQ places it; placing it
// sends each stock branch what it expects (expected_deliveries + items, down to that branch only). The stock branch receives against it (in parts, if the
// goods come in parts: po_receipts, written by the branch). The order closes by itself when every line has fully arrived, or by hand to accept a short
// delivery. HQ pays the suppliers: what is owed is what was ordered (what arrived, once the order is closed short) less what was paid.

const nowIso = () => new Date().toISOString();

export type OrderStatus = 'draft' | 'ordered' | 'closed' | 'cancelled';
export type LineInput = { stockBranchId: number; productId: number; qtyMilli: number; unitCostMinor: number };
export type OrderInput = { supplierId?: number | null; currency: 'USD' | 'LBP'; note?: string | null; lines: LineInput[] };

type OrderRow = {
  id: number;
  supplier_id: number | null;
  currency: 'USD' | 'LBP';
  status: OrderStatus;
  note: string | null;
  created_at: string;
  ordered_at: string | null;
  closed_at: string | null;
};

const ORDER = 'id, supplier_id, currency, status, note, created_at, ordered_at, closed_at';
const lineValue = (qtyMilli: number, unitCost: number) => roundDiv(qtyMilli * unitCost, 1000);

const log = (q: Queryable, tbl: string, pk: number, branchId: number) =>
  q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [tbl, pk, 'u', nowIso(), branchId]);

async function checkLines(q: Queryable, input: OrderInput): Promise<void> {
  if (input.lines.length === 0) throw new AppError(422, 'VALIDATION', 'An order needs at least one line');
  if (input.supplierId && !(await q.one('SELECT 1 AS x FROM suppliers WHERE id = ?', [input.supplierId])))
    throw new AppError(422, 'VALIDATION', `There is no supplier ${input.supplierId}`);
  const seen = new Set<string>();
  for (const l of input.lines) {
    const k = `${l.stockBranchId}:${l.productId}`;
    if (seen.has(k))
      throw new AppError(422, 'DUPLICATE_LINE', 'A product may appear once for each stock branch: add the quantities together');
    seen.add(k);
    const branch = await q.one<{ kind: string; active: number }>('SELECT kind, active FROM branch_directory WHERE id = ?', [
      l.stockBranchId,
    ]);
    if (!branch || branch.active !== 1) throw new AppError(422, 'UNKNOWN_BRANCH', `Branch ${l.stockBranchId} is not an active branch`);
    if (branch.kind !== 'stock')
      throw new AppError(422, 'NOT_A_STOCK_BRANCH', `Goods are delivered to stock branches only (branch ${l.stockBranchId} is a shop)`);
    const product = await q.one<{ active: number }>('SELECT active FROM products WHERE id = ?', [l.productId]);
    if (!product || product.active !== 1) throw new AppError(422, 'VALIDATION', `There is no active product ${l.productId}`);
  }
}

async function insertLines(q: Queryable, orderId: number, lines: LineInput[]): Promise<void> {
  for (const l of lines)
    await q.run(
      'INSERT INTO purchase_order_lines (order_id, stock_branch_id, product_id, qty_milli, unit_cost_minor) VALUES (?, ?, ?, ?, ?)',
      [orderId, l.stockBranchId, l.productId, l.qtyMilli, l.unitCostMinor],
    );
}

export async function createOrder(q: Queryable, input: OrderInput): Promise<number> {
  await checkLines(q, input);
  const order = (await q.one<{ id: number }>(
    `INSERT INTO purchase_orders (supplier_id, currency, status, note, created_at) VALUES (?, ?, 'draft', ?, ?) RETURNING id`,
    [input.supplierId ?? null, input.currency, input.note?.trim() || null, nowIso()],
  ))!;
  await insertLines(q, order.id, input.lines);
  await writeAudit(q, 'purchase-order.create', 'purchase-order', order.id, { lines: input.lines.length, currency: input.currency });
  return order.id;
}

async function need(q: Queryable, id: number): Promise<OrderRow> {
  const o = await q.one<OrderRow>(`SELECT ${ORDER} FROM purchase_orders WHERE id = ?`, [id]);
  if (!o) throw new AppError(404, 'NOT_FOUND', 'No such purchase order');
  return o;
}

/** Change a DRAFT (its supplier, currency, note and all its lines). A placed order is never edited: cancel it and make a new one. */
export async function replaceDraft(q: Queryable, id: number, input: OrderInput): Promise<void> {
  const o = await need(q, id);
  if (o.status !== 'draft') throw new AppError(409, 'ORDER_PLACED', 'Only a draft can be changed. Cancel this order and make a new one.');
  await checkLines(q, input);
  await q.run('UPDATE purchase_orders SET supplier_id = ?, currency = ?, note = ? WHERE id = ?', [
    input.supplierId ?? null,
    input.currency,
    input.note?.trim() || null,
    id,
  ]);
  await q.run('DELETE FROM purchase_order_lines WHERE order_id = ?', [id]);
  await insertLines(q, id, input.lines);
  await writeAudit(q, 'purchase-order.update', 'purchase-order', id, { lines: input.lines.length });
}

/** Place a draft: each stock branch is sent what it expects (the header first, then its lines), and nothing more can be edited. */
export async function placeOrder(q: Queryable, id: number): Promise<void> {
  const o = await need(q, id);
  if (o.status !== 'draft') throw new AppError(409, 'ORDER_PLACED', 'This order is not a draft');
  const lines = await q.all<{ id: number; stock_branch_id: number; product_id: number; qty_milli: number; unit_cost_minor: number }>(
    'SELECT id, stock_branch_id, product_id, qty_milli, unit_cost_minor FROM purchase_order_lines WHERE order_id = ? ORDER BY id',
    [id],
  );
  if (lines.length === 0) throw new AppError(422, 'VALIDATION', 'An order needs at least one line');
  const now = nowIso();
  const byBranch = new Map<number, typeof lines>();
  for (const l of lines) byBranch.set(l.stock_branch_id, [...(byBranch.get(l.stock_branch_id) ?? []), l]);
  for (const [branchId, mine] of byBranch) {
    const delivery = (await q.one<{ id: number }>(
      `INSERT INTO expected_deliveries (order_id, stock_branch_id, supplier_id, currency, status, note, ordered_at, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
      [id, branchId, o.supplier_id, o.currency, o.note, now, now],
    ))!;
    const itemIds: number[] = [];
    for (const l of mine)
      itemIds.push(
        (await q.one<{ id: number }>(
          'INSERT INTO expected_delivery_items (delivery_id, line_id, product_id, qty_milli, unit_cost_minor) VALUES (?, ?, ?, ?, ?) RETURNING id',
          [delivery.id, l.id, l.product_id, l.qty_milli, l.unit_cost_minor],
        ))!.id,
      );
    await log(q, 'expected_deliveries', delivery.id, branchId);
    for (const itemId of itemIds) await log(q, 'expected_delivery_items', itemId, branchId);
  }
  await q.run(`UPDATE purchase_orders SET status = 'ordered', ordered_at = ? WHERE id = ?`, [now, id]);
  await writeAudit(q, 'purchase-order.place', 'purchase-order', id, { stockBranches: [...byBranch.keys()] });
}

/** Tell every stock branch that an order's expected deliveries are no longer open. */
async function endDeliveries(q: Queryable, orderId: number, status: 'closed' | 'cancelled'): Promise<void> {
  for (const d of await q.all<{ id: number; stock_branch_id: number }>(
    `SELECT id, stock_branch_id FROM expected_deliveries WHERE order_id = ? AND status = 'open'`,
    [orderId],
  )) {
    await q.run('UPDATE expected_deliveries SET status = ? WHERE id = ?', [status, d.id]);
    await log(q, 'expected_deliveries', d.id, d.stock_branch_id);
  }
}

async function receivedCount(q: Queryable, orderId: number): Promise<number> {
  return (await q.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM po_receipt_items ri JOIN expected_delivery_items i ON i.id = ri.item_id JOIN expected_deliveries d ON d.id = i.delivery_id AND d.stock_branch_id = ri.branch_id WHERE d.order_id = ?`,
    [orderId],
  ))!.n;
}

/** Cancel a draft, or a placed order nothing has been received on (a received order is closed, not cancelled). */
export async function cancelOrder(q: Queryable, id: number): Promise<void> {
  const o = await need(q, id);
  if (o.status === 'cancelled' || o.status === 'closed') throw new AppError(409, 'ORDER_ENDED', `This order is already ${o.status}`);
  if (o.status === 'ordered' && (await receivedCount(q, id)) > 0)
    throw new AppError(409, 'ORDER_RECEIVING', 'Goods have already arrived on this order: close it instead');
  await endDeliveries(q, id, 'cancelled');
  await q.run(`UPDATE purchase_orders SET status = 'cancelled', closed_at = ? WHERE id = ?`, [nowIso(), id]);
  await writeAudit(q, 'purchase-order.cancel', 'purchase-order', id);
}

/** Close a placed order: what has arrived is all there will be (a short delivery accepted). */
export async function closeOrder(q: Queryable, id: number, action = 'purchase-order.close'): Promise<void> {
  const o = await need(q, id);
  if (o.status !== 'ordered') throw new AppError(409, 'ORDER_NOT_OPEN', 'Only a placed order can be closed');
  await endDeliveries(q, id, 'closed');
  await q.run(`UPDATE purchase_orders SET status = 'closed', closed_at = ? WHERE id = ?`, [nowIso(), id]);
  await writeAudit(q, action, 'purchase-order', id);
}

type LineRow = { id: number; stock_branch_id: number; product_id: number; qty_milli: number; unit_cost_minor: number };

async function receivedByLine(q: Queryable, orderId: number): Promise<Map<number, number>> {
  const rows = await q.all<{ line_id: number; qty: number }>(
    `SELECT i.line_id, SUM(ri.qty_milli) AS qty FROM po_receipt_items ri
       JOIN expected_delivery_items i ON i.id = ri.item_id
       JOIN expected_deliveries d ON d.id = i.delivery_id AND d.stock_branch_id = ri.branch_id
     WHERE d.order_id = ? GROUP BY i.line_id`,
    [orderId],
  );
  return new Map(rows.map((r) => [r.line_id, r.qty]));
}

export async function orderJson(q: Queryable, id: number) {
  const o = await need(q, id);
  const lines = await q.all<LineRow & { product: string | null; branch: string | null }>(
    `SELECT l.id, l.stock_branch_id, l.product_id, l.qty_milli, l.unit_cost_minor, p.name AS product, d.name AS branch
     FROM purchase_order_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN branch_directory d ON d.id = l.stock_branch_id
     WHERE l.order_id = ? ORDER BY l.id`,
    [id],
  );
  const got = await receivedByLine(q, id);
  const supplier = o.supplier_id ? await q.one<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', [o.supplier_id]) : undefined;
  const ordered = lines.reduce((s, l) => s + lineValue(l.qty_milli, l.unit_cost_minor), 0);
  const received = lines.reduce((s, l) => s + lineValue(got.get(l.id) ?? 0, l.unit_cost_minor), 0);
  const paid = (await q.one<{ n: number }>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM supplier_payments WHERE order_id = ?', [id]))!
    .n;
  // What is owed: the whole order while it is open (it may be paid in advance), what really arrived once it was closed short, nothing for a cancelled one.
  const payable = o.status === 'cancelled' ? 0 : o.status === 'closed' ? received : ordered;
  return {
    id: o.id,
    supplierId: o.supplier_id,
    supplier: supplier?.name ?? null,
    currency: o.currency,
    status: o.status,
    note: o.note,
    createdAt: o.created_at,
    orderedAt: o.ordered_at,
    closedAt: o.closed_at,
    lines: lines.map((l) => ({
      id: l.id,
      stockBranchId: l.stock_branch_id,
      stockBranch: l.branch ?? `Branch ${l.stock_branch_id}`,
      productId: l.product_id,
      product: l.product ?? `Product ${l.product_id}`,
      qtyMilli: l.qty_milli,
      receivedMilli: got.get(l.id) ?? 0,
      unitCostMinor: l.unit_cost_minor,
      valueMinor: lineValue(l.qty_milli, l.unit_cost_minor),
    })),
    orderedMinor: ordered,
    receivedMinor: received,
    paidMinor: paid,
    payableMinor: payable,
    outstandingMinor: Math.max(payable - paid, 0),
  };
}

export async function listOrders(q: Queryable, opts: { status: 'all' | OrderStatus; limit: number }) {
  const rows = await q.all<{ id: number }>(
    `SELECT id FROM purchase_orders ${opts.status === 'all' ? '' : 'WHERE status = ?'} ORDER BY id DESC LIMIT ?`,
    [...(opts.status === 'all' ? [] : [opts.status]), opts.limit],
  );
  return Promise.all(rows.map((r) => orderJson(q, r.id)));
}

/** Pay a supplier on an order. A repeated request (the same key) is the same payment. Returns false when it was a repeat. */
export async function payOrder(q: Queryable, id: number, amountMinor: number, note: string | null, key: string | null): Promise<boolean> {
  if (key && (await q.one('SELECT 1 AS x FROM supplier_payments WHERE idempotency_key = ?', [key]))) return false;
  const o = await orderJson(q, id);
  if (o.status === 'draft' || o.status === 'cancelled') throw new AppError(409, 'ORDER_NOT_OPEN', 'Only a placed order is paid');
  if (amountMinor > o.outstandingMinor)
    throw new AppError(422, 'PAYMENT_EXCEEDS', `That is more than the ${o.outstandingMinor} still owed on this order`);
  await q.run('INSERT INTO supplier_payments (order_id, amount_minor, note, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    amountMinor,
    note?.trim() || null,
    key,
    nowIso(),
  ]);
  await writeAudit(q, 'purchase-order.pay', 'purchase-order', id, { amountMinor, currency: o.currency });
  return true;
}

/** What HQ owes suppliers: placed orders with something still to pay, by supplier and currency. */
export async function payables(q: Queryable) {
  const orders = await listOrders(q, { status: 'all', limit: 1000 });
  const owed = orders.filter((o) => o.outstandingMinor > 0);
  const by = new Map<
    string,
    { supplierId: number | null; supplier: string | null; currency: string; outstandingMinor: number; orders: number }
  >();
  for (const o of owed) {
    const k = `${o.supplierId ?? 0}:${o.currency}`;
    const row = by.get(k) ?? { supplierId: o.supplierId, supplier: o.supplier, currency: o.currency, outstandingMinor: 0, orders: 0 };
    row.outstandingMinor += o.outstandingMinor;
    row.orders += 1;
    by.set(k, row);
  }
  return {
    data: [...by.values()].sort((a, b) => (a.supplier ?? '').localeCompare(b.supplier ?? '') || a.currency.localeCompare(b.currency)),
    orders: owed.map((o) => ({
      id: o.id,
      supplier: o.supplier,
      currency: o.currency,
      status: o.status,
      outstandingMinor: o.outstandingMinor,
    })),
  };
}

/**
 * A stock branch's receipts that are complete and not yet looked at: an order whose every line has fully arrived is closed (its deliveries end), without
 * anyone having to. Call inside the transaction that stored its facts.
 */
export async function processPoReceipts(q: Queryable, stockBranchId: number): Promise<number> {
  const orders = await q.all<{ order_id: number }>(
    `SELECT DISTINCT d.order_id FROM po_receipts r JOIN expected_deliveries d ON d.id = r.delivery_id AND d.stock_branch_id = r.branch_id
     JOIN purchase_orders o ON o.id = d.order_id AND o.status = 'ordered' WHERE r.branch_id = ?`,
    [stockBranchId],
  );
  let closed = 0;
  for (const { order_id } of orders) {
    const lines = await q.all<LineRow>(
      'SELECT id, stock_branch_id, product_id, qty_milli, unit_cost_minor FROM purchase_order_lines WHERE order_id = ?',
      [order_id],
    );
    const got = await receivedByLine(q, order_id);
    if (lines.length > 0 && lines.every((l) => (got.get(l.id) ?? 0) >= l.qty_milli)) {
      await closeOrder(q, order_id, 'purchase-order.complete');
      closed += 1;
    }
  }
  return closed;
}
