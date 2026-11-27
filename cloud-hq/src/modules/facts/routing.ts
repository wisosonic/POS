import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { writeAudit } from '../staff/context';

// Routing a shop's request down its list of stock branches (docs/15 §5, P5c). HQ is the only party that does this, and only while it can talk to the
// branches; a request waits in the shop's outbox until then (neither selling nor the branch's own stock depends on it).
//
//   1. A request arrives as a fact (stock_requests + stock_request_items; the header says how many lines there are). When ALL its lines are here, HQ
//      writes one `request_status` row per line ("waiting") and `advance`s the request.
//   2. `advance`: every waiting line goes to the FIRST stock branch in the shop's list that has not been asked about that product yet. The lines
//      for one stock branch become ONE pick list, sent down to that branch only (header first, then its lines).
//   3. The stock branch fills the pick list with one command that ships what it has and records what it asked and what it shipped (pick_results).
//      When all of the answer is here, `processResults` adds what was shipped to each line, marks the pick list answered, and the shortfall ("cannot
//      supply") goes back to "waiting": `advance` sends it to the NEXT stock branch.
//   4. When no stock branch is left, the line is closed as not available (no backorders) and counts in the unmet-demand report.
// Every change of a line writes a line for the SHOP in the change log (it sees where each line stands). One writer per row: HQ writes pick lists and
// statuses, branches write requests and answers.

const nowIso = () => new Date().toISOString();

type Line = {
  id: number;
  for_branch_id: number;
  request_id: number;
  product_id: number;
  wanted_milli: number;
  shipped_milli: number;
  unavailable_milli: number;
  status: 'waiting' | 'picking' | 'done';
};
const LINE = 'id, for_branch_id, request_id, product_id, wanted_milli, shipped_milli, unavailable_milli, status';
const pending = (l: Pick<Line, 'wanted_milli' | 'shipped_milli' | 'unavailable_milli'>) =>
  l.wanted_milli - l.shipped_milli - l.unavailable_milli;

const log = (q: Queryable, tbl: string, pk: number, branchId: number) =>
  q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [tbl, pk, 'u', nowIso(), branchId]);

/** Change a line and tell the shop. */
async function setLine(
  q: Queryable,
  line: Line,
  patch: Partial<Pick<Line, 'shipped_milli' | 'unavailable_milli' | 'status'>>,
): Promise<Line> {
  const next = { ...line, ...patch };
  await q.run('UPDATE request_status SET shipped_milli = ?, unavailable_milli = ?, status = ?, updated_at = ? WHERE id = ?', [
    next.shipped_milli,
    next.unavailable_milli,
    next.status,
    nowIso(),
    line.id,
  ]);
  await log(q, 'request_status', line.id, line.for_branch_id);
  return next;
}

/** The stock branches a shop may ask, in order (an active stock branch only), and the ones already asked about this product in this request. */
async function candidates(
  q: Queryable,
  shopId: number,
  requestId: number,
  productId: number,
): Promise<{ routes: number[]; next: number | null }> {
  const routes = (
    await q.all<{ stock_branch_id: number }>(
      `SELECT r.stock_branch_id FROM supply_routes r JOIN branch_directory d ON d.id = r.stock_branch_id AND d.active = 1 AND d.kind = 'stock'
       WHERE r.sale_branch_id = ? ORDER BY r.rank`,
      [shopId],
    )
  ).map((r) => r.stock_branch_id);
  const tried = new Set(
    (
      await q.all<{ stock_branch_id: number }>(
        `SELECT DISTINCT l.stock_branch_id FROM pick_lists l JOIN pick_list_items i ON i.pick_list_id = l.id
         WHERE l.for_branch_id = ? AND l.request_id = ? AND i.product_id = ?`,
        [shopId, requestId, productId],
      )
    ).map((r) => r.stock_branch_id),
  );
  return { routes, next: routes.find((id) => !tried.has(id)) ?? null };
}

/** Send every waiting line of a request to the next stock branch that can be asked, or close it as not available. */
export async function advance(q: Queryable, shopId: number, requestId: number): Promise<void> {
  const waiting = await q.all<Line>(
    `SELECT ${LINE} FROM request_status WHERE for_branch_id = ? AND request_id = ? AND status = 'waiting' ORDER BY id`,
    [shopId, requestId],
  );
  const groups = new Map<number, Line[]>();
  for (const line of waiting) {
    if (pending(line) <= 0) {
      await setLine(q, line, { status: 'done' });
      continue;
    }
    const { routes, next } = await candidates(q, shopId, requestId, line.product_id);
    if (routes.length === 0) continue; // no stock branch is set for this shop yet: it waits until an admin sets one
    if (next === null) {
      await setLine(q, line, { unavailable_milli: line.unavailable_milli + pending(line), status: 'done' }); // every stock branch said it cannot
      continue;
    }
    groups.set(next, [...(groups.get(next) ?? []), line]);
  }
  if (groups.size === 0) return;
  const note =
    (await q.one<{ note: string | null }>('SELECT note FROM stock_requests WHERE branch_id = ? AND id = ?', [shopId, requestId]))?.note ??
    null;
  for (const [stockBranchId, lines] of groups) {
    const now = nowIso();
    const list = (await q.one<{ id: number }>(
      `INSERT INTO pick_lists (for_branch_id, stock_branch_id, request_id, status, note, opened_at, created_at) VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
      [shopId, stockBranchId, requestId, note, now, now],
    ))!;
    const itemIds: number[] = [];
    for (const l of lines) {
      const item = (await q.one<{ id: number }>(
        'INSERT INTO pick_list_items (pick_list_id, product_id, qty_milli) VALUES (?, ?, ?) RETURNING id',
        [list.id, l.product_id, pending(l)],
      ))!;
      itemIds.push(item.id);
      await setLine(q, l, { status: 'picking' });
    }
    await log(q, 'pick_lists', list.id, stockBranchId); // the header first, then its lines: a branch applies a page in order
    for (const id of itemIds) await log(q, 'pick_list_items', id, stockBranchId);
  }
}

/** Route the requests of one shop that are complete and not yet routed. Call inside the transaction that stored its facts. */
export async function routeNewRequests(q: Queryable, shopId: number): Promise<number> {
  const ready = await q.all<{ id: number }>(
    `SELECT r.id FROM stock_requests r
     WHERE r.branch_id = ?
       AND NOT EXISTS (SELECT 1 FROM request_status s WHERE s.for_branch_id = r.branch_id AND s.request_id = r.id)
       AND (SELECT COUNT(*) FROM stock_request_items x WHERE x.branch_id = r.branch_id AND x.request_id = r.id) >= r.item_count
     ORDER BY r.id`,
    [shopId],
  );
  for (const r of ready) {
    const now = nowIso();
    for (const item of await q.all<{ product_id: number; qty_milli: number }>(
      'SELECT product_id, qty_milli FROM stock_request_items WHERE branch_id = ? AND request_id = ? ORDER BY id',
      [shopId, r.id],
    )) {
      const line = (await q.one<{ id: number }>(
        `INSERT INTO request_status (for_branch_id, request_id, product_id, wanted_milli, shipped_milli, unavailable_milli, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, 'waiting', ?, ?) RETURNING id`,
        [shopId, r.id, item.product_id, item.qty_milli, now, now],
      ))!;
      await log(q, 'request_status', line.id, shopId);
    }
    await advance(q, shopId, r.id);
  }
  return ready.length;
}

/** The stock branch's answers that are complete and not yet taken in: add what was shipped, and send the shortfall on. */
export async function processResults(q: Queryable, stockBranchId: number): Promise<number> {
  const answers = await q.all<{ id: number; pick_list_id: number }>(
    `SELECT r.id, r.pick_list_id FROM pick_results r
     WHERE r.branch_id = ?
       AND EXISTS (SELECT 1 FROM pick_lists l WHERE l.id = r.pick_list_id AND l.stock_branch_id = r.branch_id AND l.status = 'open')
       AND (SELECT COUNT(*) FROM pick_result_items x WHERE x.branch_id = r.branch_id AND x.result_id = r.id) >= r.item_count
     ORDER BY r.id`,
    [stockBranchId],
  );
  for (const a of answers) {
    const list = (await q.one<{ for_branch_id: number; request_id: number }>(
      'SELECT for_branch_id, request_id FROM pick_lists WHERE id = ?',
      [a.pick_list_id],
    ))!;
    const answered = new Map(
      (
        await q.all<{ product_id: number; qty_shipped_milli: number }>(
          'SELECT product_id, qty_shipped_milli FROM pick_result_items WHERE branch_id = ? AND result_id = ?',
          [stockBranchId, a.id],
        )
      ).map((x) => [x.product_id, x.qty_shipped_milli]),
    );
    for (const asked of await q.all<{ product_id: number; qty_milli: number }>(
      'SELECT product_id, qty_milli FROM pick_list_items WHERE pick_list_id = ?',
      [a.pick_list_id],
    )) {
      const line = await q.one<Line>(`SELECT ${LINE} FROM request_status WHERE for_branch_id = ? AND request_id = ? AND product_id = ?`, [
        list.for_branch_id,
        list.request_id,
        asked.product_id,
      ]);
      if (!line) continue;
      const shipped = Math.min(Math.max(answered.get(asked.product_id) ?? 0, 0), asked.qty_milli); // never more than was asked
      const next = { ...line, shipped_milli: line.shipped_milli + shipped };
      // What it could not supply goes back to waiting: `advance` asks the next stock branch (or closes the line).
      await setLine(q, line, {
        shipped_milli: next.shipped_milli,
        status: shipped < asked.qty_milli ? 'waiting' : pending(next) <= 0 ? 'done' : 'waiting',
      });
    }
    await q.run(`UPDATE pick_lists SET status = 'answered' WHERE id = ?`, [a.pick_list_id]);
    await log(q, 'pick_lists', a.pick_list_id, stockBranchId); // the stock branch stops showing it
    await advance(q, list.for_branch_id, list.request_id);
  }
  return answers.length;
}

// ------------------------------------------------------------------ the list of stock branches per shop (set by an admin)

export type SupplyRoute = { rank: number; stockBranchId: number; code: string; name: string; active: boolean };

export async function getRoutes(q: Queryable, shopId: number): Promise<SupplyRoute[]> {
  const rows = await q.all<{ rank: number; id: number; code: string; name: string; active: number }>(
    `SELECT r.rank, d.id, d.code, d.name, d.active FROM supply_routes r JOIN branch_directory d ON d.id = r.stock_branch_id WHERE r.sale_branch_id = ? ORDER BY r.rank`,
    [shopId],
  );
  return rows.map((r) => ({ rank: r.rank, stockBranchId: r.id, code: r.code, name: r.name, active: r.active === 1 }));
}

/**
 * Replace the ordered list of stock branches a shop asks ("nearest first"). The shop must be a sale branch and every entry an existing stock branch, each
 * once. Requests that were waiting for a list are routed now.
 */
export async function setRoutes(q: Queryable, shopId: number, stockBranchIds: number[]): Promise<void> {
  const shop = await q.one<{ kind: string }>('SELECT kind FROM branch_directory WHERE id = ?', [shopId]);
  if (!shop) throw new AppError(404, 'NOT_FOUND', 'No such branch');
  if (shop.kind !== 'sale') throw new AppError(422, 'NOT_A_SALE_BRANCH', 'Only a sale branch asks for stock');
  if (new Set(stockBranchIds).size !== stockBranchIds.length)
    throw new AppError(422, 'DUPLICATE_BRANCH', 'Each stock branch may appear once');
  for (const id of stockBranchIds) {
    const d = await q.one<{ kind: string }>('SELECT kind FROM branch_directory WHERE id = ?', [id]);
    if (!d) throw new AppError(404, 'NOT_FOUND', `No such branch ${id}`);
    if (d.kind !== 'stock') throw new AppError(422, 'NOT_A_STOCK_BRANCH', `Branch ${id} is not a stock branch`);
  }
  await q.run('DELETE FROM supply_routes WHERE sale_branch_id = ?', [shopId]);
  for (const [i, id] of stockBranchIds.entries())
    await q.run('INSERT INTO supply_routes (sale_branch_id, stock_branch_id, rank) VALUES (?, ?, ?)', [shopId, id, i + 1]);
  await writeAudit(q, 'supply-routes.set', 'branch', shopId, { stockBranchIds });
  // A request that had no list to follow, or whose lines ran out, may now be routed.
  for (const r of await q.all<{ request_id: number }>(
    `SELECT DISTINCT request_id FROM request_status WHERE for_branch_id = ? AND status = 'waiting' ORDER BY request_id`,
    [shopId],
  ))
    await advance(q, shopId, r.request_id);
}
