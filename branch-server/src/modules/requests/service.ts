import { parseQtyMilli } from '@pos/shared';
import { z } from 'zod';
import type { Database, Queryable } from '../../db/adapter';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import type { Actor } from '../sales/service';
import { me, reasonFor, shipInTx, type DirectoryRow, type Result } from '../transfers/service';

// Requests and pick lists (docs/15 §5, P5c).
//   A SHOP's manager makes a REQUEST (what it wants). It changes no stock: HQ routes it down the shop's ordered list of stock branches.
//   A STOCK branch's manager fills the PICK LIST HQ sent it, with ONE command: it ships what it has (a shipment, as in P5b) and records, line by line,
//   what was asked and what was shipped. What it could not ship is "cannot supply": HQ asks the next stock branch, and when none is left the line is
//   closed as not available. The shop sees each line's progress (request_status, sent down by HQ).

export const REQUEST_SCOPE = 'POST /stock-requests';
export const FILL_SCOPE = 'POST /pick-lists/fill';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');
const shippedQty = z.string().regex(/^\d+(\.\d{1,3})?$/, 'A quantity is a number with at most 3 decimals'); // zero is allowed: nothing could be shipped

export const requestBody = z.object({
  note: z.string().trim().max(300).nullish(),
  items: z
    .array(z.object({ productId: z.number().int().positive(), qty }))
    .min(1, 'A request needs at least one item')
    .max(200),
});
export const fillBody = z.object({
  /** EVERY line of the pick list, with how much is shipped (0 to the quantity asked). */
  items: z
    .array(z.object({ productId: z.number().int().positive(), shipped: shippedQty }))
    .min(1)
    .max(200),
});

const parseShipped = (v: string): number => (/^0+(\.0+)?$/.test(v) ? 0 : parseQtyMilli(v));

// ------------------------------------------------------------------ requests (a shop)

type RequestStatus = 'routing' | 'open' | 'closed';

export async function requestJson(q: Queryable, id: number) {
  const r = await q.one<{ id: number; note: string | null; item_count: number; user_id: number | null; created_at: string }>(
    'SELECT id, note, item_count, user_id, created_at FROM stock_requests WHERE id = ?',
    [id],
  );
  if (!r) throw E.notFound('Request');
  const lines = await q.all<{
    product_id: number;
    name: string;
    qty_milli: number;
    shipped: number | null;
    unavailable: number | null;
    status: 'waiting' | 'picking' | 'done' | null;
  }>(
    `SELECT x.product_id, p.name, x.qty_milli, s.shipped_milli AS shipped, s.unavailable_milli AS unavailable, s.status
     FROM stock_request_items x JOIN products p ON p.id = x.product_id
          LEFT JOIN request_status s ON s.request_id = x.request_id AND s.product_id = x.product_id
     WHERE x.request_id = ? ORDER BY x.id`,
    [id],
  );
  const routed = lines.every((l) => l.status !== null);
  const status: RequestStatus = !routed ? 'routing' : lines.every((l) => l.status === 'done') ? 'closed' : 'open';
  return {
    id: r.id,
    note: r.note,
    createdAt: r.created_at,
    status,
    items: lines.map((l) => ({
      productId: l.product_id,
      name: l.name,
      wanted: milliToQty(l.qty_milli),
      shipped: milliToQty(l.shipped ?? 0),
      unavailable: milliToQty(l.unavailable ?? 0),
      // `waiting`: HQ has not placed it (or is looking for the next stock branch). `picking`: a stock branch has it. `done`: shipped or not available.
      status: l.status ?? ('waiting' as const),
    })),
  };
}

/** A shop's manager asks for items. No stock moves; HQ routes it. Idempotent. */
export async function createRequest(
  db: Database,
  actor: Actor,
  body: z.infer<typeof requestBody>,
  idem: { key: string; hash: string },
): Promise<Result> {
  const quantities = body.items.map((i) => parseQtyMilli(i.qty));
  if (new Set(body.items.map((i) => i.productId)).size !== body.items.length)
    throw new AppError(422, 'DUPLICATE_PRODUCT', 'Each product may appear once in a request');
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, REQUEST_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };
    const mine = await me(q);
    if (mine.kind !== 'sale')
      throw E.conflict(
        'ONLY_A_SHOP_REQUESTS',
        'A stock branch is supplied by what HQ buys and by other stock branches: only a shop makes a request',
      );
    for (const item of body.items)
      if (!(await q.one('SELECT 1 AS x FROM products WHERE id = ?', [item.productId]))) throw E.notFound('Product');
    const request = (await q.one<{ id: number }>(
      'INSERT INTO stock_requests (note, item_count, user_id, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      [body.note?.trim() || null, body.items.length, actor.id, nowIso()],
    ))!;
    for (const [i, item] of body.items.entries())
      await q.run('INSERT INTO stock_request_items (request_id, product_id, qty_milli) VALUES (?, ?, ?)', [
        request.id,
        item.productId,
        quantities[i]!,
      ]);
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'request.create',
      entity: 'stock-request',
      entityId: request.id,
      after: { lines: body.items.length },
    });
    const response = await requestJson(q, request.id);
    await rememberResponseQ(q, REQUEST_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}

export async function listRequests(q: Queryable, opts: { limit: number; cursor?: number }) {
  const rows = await q.all<{ id: number }>(`SELECT id FROM stock_requests ${opts.cursor ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, [
    ...(opts.cursor ? [opts.cursor] : []),
    opts.limit + 1,
  ]);
  const page = rows.slice(0, opts.limit);
  return {
    data: await Promise.all(page.map((r) => requestJson(q, r.id))),
    nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}

// ------------------------------------------------------------------ pick lists (a stock branch)

type ListRow = {
  id: number;
  for_branch_id: number;
  request_id: number;
  status: 'open' | 'answered';
  note: string | null;
  opened_at: string;
};

export async function pickListJson(q: Queryable, l: ListRow) {
  const shop = await q.one<{ name: string }>('SELECT name FROM branch_directory WHERE id = ?', [l.for_branch_id]);
  const items = await q.all<{ product_id: number; name: string | null; qty_milli: number; on_hand: number; shipped: number | null }>(
    `SELECT i.product_id, p.name, i.qty_milli,
            COALESCE((SELECT SUM(s.qty_milli) FROM stock_levels s WHERE s.product_id = i.product_id), 0) AS on_hand,
            (SELECT x.qty_shipped_milli FROM pick_result_items x JOIN pick_results r ON r.id = x.result_id WHERE r.pick_list_id = ? AND x.product_id = i.product_id) AS shipped
     FROM pick_list_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.pick_list_id = ? ORDER BY i.id`,
    [l.id, l.id],
  );
  return {
    id: l.id,
    forBranchId: l.for_branch_id,
    forBranch: shop?.name ?? `Branch ${l.for_branch_id}`,
    requestId: l.request_id,
    note: l.note,
    openedAt: l.opened_at,
    status: l.status,
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.name ?? `Product ${i.product_id}`,
      asked: milliToQty(i.qty_milli),
      onHand: milliToQty(i.on_hand),
      shipped: i.shipped === null ? null : milliToQty(i.shipped),
    })),
  };
}

const LISTS = 'SELECT id, for_branch_id, request_id, status, note, opened_at FROM pick_lists';

export async function listPickLists(q: Queryable, status: 'open' | 'answered' | 'all', limit: number) {
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const rows = await q.all<ListRow>(`${LISTS} ${where} ORDER BY id DESC LIMIT ?`, [...(status === 'all' ? [] : [status]), limit]);
  return { data: await Promise.all(rows.map((r) => pickListJson(q, r))) };
}

export async function getPickList(q: Queryable, id: number) {
  const row = await q.one<ListRow>(`${LISTS} WHERE id = ?`, [id]);
  if (!row) throw E.notFound('Pick list');
  return pickListJson(q, row);
}

/**
 * Fill a pick list: ship what is there and say what could not be. Every line must be answered (0 up to the quantity asked). The shipment, the stock
 * leaving and the answer are ONE transaction. A line shipped short is "cannot supply": HQ sends the rest to the next stock branch. Idempotent.
 */
export async function fillPickList(
  db: Database,
  actor: Actor,
  id: number,
  body: z.infer<typeof fillBody>,
  idem: { key: string; hash: string },
): Promise<Result> {
  const answers = new Map<number, number>();
  for (const a of body.items) {
    if (answers.has(a.productId)) throw new AppError(422, 'DUPLICATE_PRODUCT', 'Each product may appear once');
    answers.set(a.productId, parseShipped(a.shipped));
  }
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, FILL_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };
    const mine = await me(q);
    if (mine.kind !== 'stock') throw E.conflict('ONLY_A_STOCK_BRANCH_FILLS', 'Only a stock branch fills a pick list');
    const list = await q.one<ListRow>(`${LISTS} WHERE id = ?`, [id]);
    if (!list) throw E.notFound('Pick list');
    if (list.status !== 'open' || (await q.one('SELECT 1 AS x FROM pick_results WHERE pick_list_id = ?', [id])))
      throw E.conflict('ALREADY_ANSWERED', 'This pick list has already been answered');
    const asked = await q.all<{ product_id: number; qty_milli: number }>(
      'SELECT product_id, qty_milli FROM pick_list_items WHERE pick_list_id = ? ORDER BY id',
      [id],
    );
    if (asked.length !== answers.size || asked.some((a) => !answers.has(a.product_id)))
      throw new AppError(422, 'ANSWER_EVERY_LINE', 'Answer every line of the pick list (0 if nothing can be shipped)');
    for (const a of asked)
      if (answers.get(a.product_id)! > a.qty_milli)
        throw new AppError(422, 'SHIPPED_EXCEEDS_ASKED', `More than was asked for product ${a.product_id}`, { productId: a.product_id });

    const shop = await q.one<DirectoryRow>('SELECT id, code, name, kind, active FROM branch_directory WHERE id = ?', [list.for_branch_id]);
    if (!shop || shop.active !== 1) throw new AppError(422, 'UNKNOWN_BRANCH', 'The shop that asked is not an active branch any more');
    const reason = reasonFor(mine.kind, shop.kind);
    const toShip = asked
      .filter((a) => answers.get(a.product_id)! > 0)
      .map((a) => ({ productId: a.product_id, qtyMilli: answers.get(a.product_id)! }));
    const shipmentId = toShip.length > 0 ? await shipInTx(q, actor, shop, reason, `For request ${list.request_id}`, toShip) : null;

    const result = (await q.one<{ id: number }>(
      'INSERT INTO pick_results (pick_list_id, shipment_id, item_count, user_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [id, shipmentId, asked.length, actor.id, nowIso()],
    ))!;
    for (const a of asked)
      await q.run('INSERT INTO pick_result_items (result_id, product_id, qty_asked_milli, qty_shipped_milli) VALUES (?, ?, ?, ?)', [
        result.id,
        a.product_id,
        a.qty_milli,
        answers.get(a.product_id)!,
      ]);
    await writeAuditQ(q, {
      userId: actor.id,
      action: 'pick-list.fill',
      entity: 'pick-list',
      entityId: id,
      after: {
        forBranch: shop.name,
        lines: asked.length,
        shortLines: asked.filter((a) => answers.get(a.product_id)! < a.qty_milli).length,
        shipmentId,
      },
    });
    const response = { id: result.id, shipmentId, pickList: await getPickList(q, id) };
    await rememberResponseQ(q, FILL_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
