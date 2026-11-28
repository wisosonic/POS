import type { Queryable } from '@pos/core/adapter';
import { localDay } from '../../util/time';
import { onOrder } from './restock';

// The chain's reports (docs/12 §23, P4b): read-only figures over what the branches have sent (the mirror tables) and HQ's own catalog. The rules
// are the branch's own (branch-server/src/modules/reports): a sale counts on the day it was made, a return on the day it was taken back, voided
// sales never count, and everything is in lira at the rate each sale was made at, so nothing depends on today's rate. Ids are per branch, so every
// join between mirror tables also joins on branch_id. Figures are SQL aggregates: the shop-day is a time-zone matter, so the database groups by
// (branch, UTC hour) and the code folds those few rows into shop days (an offset of a whole hour makes this exact).

export type Range = { from: string; to: string };
type Param = string | number;

const branchClause = (alias: string, branchId?: number): { sql: string; params: Param[] } =>
  branchId === undefined ? { sql: '', params: [] } : { sql: ` AND ${alias}.branch_id = ?`, params: [branchId] };

export type Totals = { count: number; grossLbp: number; returnsCount: number; returnedLbp: number; netLbp: number; profitLbp: number };
export const emptyTotals = (): Totals => ({ count: 0, grossLbp: 0, returnsCount: 0, returnedLbp: 0, netLbp: 0, profitLbp: 0 });
export type Row = Totals & { key: string; label: string };

type SaleHour = { branch_id: number; h: string; n: number; gross: number; profit: number };
type ReturnHour = { branch_id: number; h: string; n: number; value_lbp: number; profit_lost: number };

const COST_OF_RETURN = `COALESCE((SELECT SUM(CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER))
    FROM return_items ri JOIN sale_items si ON si.branch_id = ri.branch_id AND si.id = ri.sale_item_id
    WHERE ri.branch_id = r.branch_id AND ri.return_id = r.id), 0)`;

export function salesByHour(q: Queryable, range: Range, branchId?: number): Promise<SaleHour[]> {
  const b = branchClause('s', branchId);
  return q.all<SaleHour>(
    `SELECT s.branch_id, substr(s.created_at, 1, 13) AS h, COUNT(*) AS n, SUM(s.total_lbp) AS gross, SUM(s.profit_lbp) AS profit
     FROM sales s WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void'${b.sql}
     GROUP BY s.branch_id, h`,
    [range.from, range.to, ...b.params],
  );
}

export function returnsByHour(q: Queryable, range: Range, branchId?: number): Promise<ReturnHour[]> {
  const b = branchClause('r', branchId);
  return q.all<ReturnHour>(
    `SELECT r.branch_id, substr(r.created_at, 1, 13) AS h, COUNT(*) AS n, SUM(r.refund_lbp + r.balance_reduced_lbp) AS value_lbp,
            SUM((r.refund_lbp + r.balance_reduced_lbp) - ${COST_OF_RETURN}) AS profit_lost
     FROM returns r WHERE r.created_at >= ? AND r.created_at <= ?${b.sql}
     GROUP BY r.branch_id, h`,
    [range.from, range.to, ...b.params],
  );
}

/** The shop-local day of an hour bucket such as `2026-11-27T21` (UTC). */
const dayOfHour = (h: string): string => localDay(`${h}:00:00.000Z`);

export type Folded = Map<string, Totals>;

function add(map: Folded, key: string, s?: SaleHour, r?: ReturnHour): void {
  const t = map.get(key) ?? emptyTotals();
  if (s) {
    t.count += s.n;
    t.grossLbp += s.gross;
    t.profitLbp += s.profit;
  }
  if (r) {
    t.returnsCount += r.n;
    t.returnedLbp += r.value_lbp;
    t.profitLbp -= r.profit_lost;
  }
  t.netLbp = t.grossLbp - t.returnedLbp;
  map.set(key, t);
}

export const totalOf = (rows: Iterable<Totals>): Totals => {
  const t = emptyTotals();
  for (const r of rows) {
    t.count += r.count;
    t.grossLbp += r.grossLbp;
    t.returnsCount += r.returnsCount;
    t.returnedLbp += r.returnedLbp;
    t.profitLbp += r.profitLbp;
  }
  t.netLbp = t.grossLbp - t.returnedLbp;
  return t;
};

export type BranchNames = Map<number, { code: string; name: string }>;
export async function branchNames(q: Queryable): Promise<BranchNames> {
  const rows = await q.all<{ id: number; code: string; name: string }>('SELECT id, code, name FROM branches ORDER BY id');
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
}
const nameOf = (names: BranchNames, id: number) => names.get(id)?.name ?? `Branch ${id}`;

/** Takings by shop day, by branch or by product category, net of returns. */
export async function salesReport(q: Queryable, range: Range, groupBy: 'day' | 'branch' | 'category', branchId?: number) {
  let rows: Row[];
  if (groupBy === 'category') {
    rows = await byCategory(q, range, branchId);
  } else {
    const [sales, returns, names] = await Promise.all([salesByHour(q, range, branchId), returnsByHour(q, range, branchId), branchNames(q)]);
    const folded: Folded = new Map();
    const keyOf = (branch: number, h: string) => (groupBy === 'day' ? dayOfHour(h) : String(branch));
    for (const s of sales) add(folded, keyOf(s.branch_id, s.h), s);
    for (const r of returns) add(folded, keyOf(r.branch_id, r.h), undefined, r);
    rows = [...folded.entries()]
      .sort(([a], [b]) => (groupBy === 'day' ? a.localeCompare(b) : Number(a) - Number(b)))
      .map(([key, t]) => ({ key, label: groupBy === 'day' ? key : nameOf(names, Number(key)), ...t }));
  }
  return { from: range.from, to: range.to, groupBy, data: rows, totals: totalOf(await grandRows(q, range, branchId)) };
}

/** The grand total comes from the sales and returns themselves, so it is right even when a sale spans categories. */
async function grandRows(q: Queryable, range: Range, branchId?: number): Promise<Totals[]> {
  const [sales, returns] = await Promise.all([salesByHour(q, range, branchId), returnsByHour(q, range, branchId)]);
  const folded: Folded = new Map();
  for (const s of sales) add(folded, 'all', s);
  for (const r of returns) add(folded, 'all', undefined, r);
  return [...folded.values()];
}

async function byCategory(q: Queryable, range: Range, branchId?: number): Promise<Row[]> {
  const bs = branchClause('s', branchId);
  const br = branchClause('r', branchId);
  const sold = await q.all<{ cat: number; cat_name: string; n: number; gross: number; profit: number }>(
    `SELECT COALESCE(p.category_id, 0) AS cat, COALESCE(MAX(c.name), 'No category') AS cat_name, COUNT(DISTINCT (s.branch_id || ':' || s.id)) AS n,
            SUM(si.line_total_lbp) AS gross, SUM(si.line_total_lbp - CAST(ROUND(si.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS profit
     FROM sale_items si JOIN sales s ON s.branch_id = si.branch_id AND s.id = si.sale_id
          LEFT JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void'${bs.sql} GROUP BY cat`,
    [range.from, range.to, ...bs.params],
  );
  const back = await q.all<{ cat: number; cat_name: string; value: number; profit_lost: number }>(
    `SELECT COALESCE(p.category_id, 0) AS cat, COALESCE(MAX(c.name), 'No category') AS cat_name, SUM(ri.amount_lbp) AS value,
            SUM(ri.amount_lbp - CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS profit_lost
     FROM return_items ri JOIN returns r ON r.branch_id = ri.branch_id AND r.id = ri.return_id
          JOIN sale_items si ON si.branch_id = ri.branch_id AND si.id = ri.sale_item_id
          LEFT JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE r.created_at >= ? AND r.created_at <= ?${br.sql} GROUP BY cat`,
    [range.from, range.to, ...br.params],
  );
  const rows = new Map<number, Row>();
  const row = (cat: number, name: string) => {
    if (!rows.has(cat)) rows.set(cat, { key: String(cat), label: name, ...emptyTotals() });
    return rows.get(cat)!;
  };
  for (const s of sold) {
    const r = row(s.cat, s.cat_name);
    r.count += s.n;
    r.grossLbp += s.gross;
    r.profitLbp += s.profit;
  }
  for (const b of back) {
    const r = row(b.cat, b.cat_name);
    r.returnedLbp += b.value;
    r.profitLbp -= b.profit_lost;
  }
  for (const r of rows.values()) r.netLbp = r.grossLbp - r.returnedLbp;
  return [...rows.values()].sort((a, b) => b.netLbp - a.netLbp);
}

export type ProductReportRow = {
  productId: number | null;
  name: string;
  qtyMilli: number;
  revenueLbp: number;
  costLbp: number;
  profitLbp: number;
};

/** What sold, per product (the same product under the same id at every branch), net of returns. */
export async function productsReport(
  q: Queryable,
  range: Range,
  opts: { branchId?: number; sort: 'qty' | 'revenue' | 'profit'; order: 'desc' | 'asc'; limit: number },
): Promise<ProductReportRow[]> {
  const bs = branchClause('s', opts.branchId);
  const br = branchClause('r', opts.branchId);
  const sold = await q.all<{ pid: number; item_name: string; sold_milli: number; revenue: number; cost: number }>(
    `SELECT COALESCE(si.product_id, 0) AS pid, MAX(si.name_snap) AS item_name, SUM(si.qty_milli) AS sold_milli, SUM(si.line_total_lbp) AS revenue,
            SUM(CAST(ROUND(si.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS cost
     FROM sale_items si JOIN sales s ON s.branch_id = si.branch_id AND s.id = si.sale_id
     WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void'${bs.sql} GROUP BY pid`,
    [range.from, range.to, ...bs.params],
  );
  const back = await q.all<{ pid: number; back_milli: number; value: number; cost: number }>(
    `SELECT COALESCE(si.product_id, 0) AS pid, SUM(ri.qty_milli) AS back_milli, SUM(ri.amount_lbp) AS value,
            SUM(CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS cost
     FROM return_items ri JOIN returns r ON r.branch_id = ri.branch_id AND r.id = ri.return_id
          JOIN sale_items si ON si.branch_id = ri.branch_id AND si.id = ri.sale_item_id
     WHERE r.created_at >= ? AND r.created_at <= ?${br.sql} GROUP BY pid`,
    [range.from, range.to, ...br.params],
  );
  const returned = new Map(back.map((b) => [b.pid, b]));
  const rows = sold.map((s) => {
    const b = returned.get(s.pid);
    const revenue = s.revenue - (b?.value ?? 0);
    const cost = s.cost - (b?.cost ?? 0);
    return {
      productId: s.pid === 0 ? null : s.pid,
      name: s.pid === 0 ? 'Unmatched items' : s.item_name.trim(),
      qtyMilli: s.sold_milli - (b?.back_milli ?? 0),
      revenueLbp: revenue,
      costLbp: cost,
      profitLbp: revenue - cost,
    };
  });
  const value = (r: ProductReportRow) => (opts.sort === 'qty' ? r.qtyMilli : opts.sort === 'revenue' ? r.revenueLbp : r.profitLbp);
  rows.sort((a, b) => (opts.order === 'desc' ? value(b) - value(a) : value(a) - value(b)) || a.name.localeCompare(b.name));
  return rows.slice(0, opts.limit);
}

/** What was received, per branch, method and currency, for the sales made in the range (a voided sale's payments do not count). */
export async function paymentsReport(q: Queryable, range: Range, branchId?: number) {
  const b = branchClause('s', branchId);
  return q.all<{ branch_id: number; method: string; currency: string; amount: number; n: number }>(
    `SELECT p.branch_id, p.method, p.currency, SUM(p.amount) AS amount, COUNT(*) AS n
     FROM payments p JOIN sales s ON s.branch_id = p.branch_id AND s.id = p.sale_id
     WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void'${b.sql}
     GROUP BY p.branch_id, p.method, p.currency ORDER BY p.branch_id, p.method, p.currency`,
    [range.from, range.to, ...b.params],
  );
}

/** Spending by branch, category and currency. */
export async function expensesReport(q: Queryable, range: Range, branchId?: number) {
  const b = branchClause('e', branchId);
  return q.all<{ branch_id: number; category_id: number | null; category: string | null; currency: string; amount: number; n: number }>(
    `SELECT e.branch_id, e.category_id, MAX(c.name) AS category, e.currency, SUM(e.amount_minor) AS amount, COUNT(*) AS n
     FROM expenses e LEFT JOIN expense_categories c ON c.branch_id = e.branch_id AND c.id = e.category_id
     WHERE e.created_at >= ? AND e.created_at <= ?${b.sql}
     GROUP BY e.branch_id, e.category_id, e.currency ORDER BY e.branch_id, category, e.currency`,
    [range.from, range.to, ...b.params],
  );
}

export type SessionRow = {
  branch_id: number;
  id: number;
  terminal_id: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
};
export type BalanceRow = {
  branch_id: number;
  session_id: number;
  method: string;
  currency: string;
  opening: number;
  expected: number;
  counted: number | null;
  variance: number | null;
};

/** Till shifts opened in the range, with each bucket's figures. `onlyVariance` keeps the shifts where any counted bucket is off. */
export async function registersReport(q: Queryable, range: Range, opts: { branchId?: number; onlyVariance: boolean }) {
  const b = branchClause('r', opts.branchId);
  const sessions = await q.all<SessionRow>(
    `SELECT r.branch_id, r.id, r.terminal_id, r.opened_at, r.closed_at, r.status FROM register_sessions r
     WHERE r.opened_at >= ? AND r.opened_at <= ?${b.sql} ORDER BY r.opened_at, r.branch_id, r.id`,
    [range.from, range.to, ...b.params],
  );
  const balances = await q.all<BalanceRow>(
    `SELECT b.branch_id, b.session_id, b.method, b.currency, b.opening, b.expected, b.counted, b.variance
     FROM register_balances b JOIN register_sessions r ON r.branch_id = b.branch_id AND r.id = b.session_id
     WHERE r.opened_at >= ? AND r.opened_at <= ?${b.sql} ORDER BY b.branch_id, b.session_id, b.method, b.currency`,
    [range.from, range.to, ...b.params],
  );
  const by = new Map<string, BalanceRow[]>();
  for (const x of balances) by.set(`${x.branch_id}:${x.session_id}`, [...(by.get(`${x.branch_id}:${x.session_id}`) ?? []), x]);
  const shifts = sessions
    .map((s) => ({
      branchId: s.branch_id,
      id: s.id,
      terminalId: s.terminal_id,
      openedAt: s.opened_at,
      closedAt: s.closed_at,
      status: s.status,
      balances: (by.get(`${s.branch_id}:${s.id}`) ?? []).map((x) => ({
        method: x.method,
        currency: x.currency,
        opening: x.opening,
        expected: x.expected,
        counted: x.counted,
        variance: x.variance,
      })),
    }))
    .filter((s) => !opts.onlyVariance || s.balances.some((x) => x.variance !== null && x.variance !== 0));
  // Over and short, per branch and bucket, over the counted shifts in the range.
  const totals = new Map<string, { branchId: number; method: string; currency: string; variance: number; shifts: number }>();
  for (const s of shifts)
    for (const x of s.balances) {
      if (x.variance === null) continue;
      const k = `${s.branchId}:${x.method}:${x.currency}`;
      const t = totals.get(k) ?? { branchId: s.branchId, method: x.method, currency: x.currency, variance: 0, shifts: 0 };
      t.variance += x.variance;
      t.shifts += 1;
      totals.set(k, t);
    }
  return {
    shifts,
    totals: [...totals.values()].sort(
      (a, c) => a.branchId - c.branchId || a.method.localeCompare(c.method) || a.currency.localeCompare(c.currency),
    ),
  };
}

export type StockRow = {
  productId: number;
  name: string;
  barcode: string;
  alertMilli: number | null;
  /** On the shelves of every branch (what the branches' movements add up to). */
  totalMilli: number;
  /** Shipped and not yet confirmed by the receiving branch (docs/15 §4): out of the sender's stock, not yet in the receiver's. */
  inTransitMilli: number;
  /** Ordered by HQ for a stock branch and not yet received (docs/15 §6). */
  onOrderMilli: number;
  byBranch: { branchId: number; qtyMilli: number; inTransitMilli: number; onOrderMilli: number }[];
};

/** Stock per product at every branch, derived from the movements the branches sent (a branch's stock is the sum of its movements), and what is on the way. */
export async function stockReport(q: Queryable, opts: { productId?: number; branchId?: number; lowOnly: boolean; limit: number }) {
  const where: string[] = ['p.active = 1'];
  const params: Param[] = [];
  if (opts.productId) {
    where.push('p.id = ?');
    params.push(opts.productId);
  }
  if (opts.lowOnly) where.push('p.stock_alert_milli IS NOT NULL');
  const products = await q.all<{ id: number; name: string; barcode: string; stock_alert_milli: number | null }>(
    `SELECT p.id, p.name, p.barcode, p.stock_alert_milli FROM products p WHERE ${where.join(' AND ')} ORDER BY p.name, p.id`,
    params,
  );
  const mv = opts.branchId === undefined ? { sql: '', params: [] as Param[] } : { sql: ' WHERE branch_id = ?', params: [opts.branchId] };
  const sums = await q.all<{ product_id: number; branch_id: number; qty: number }>(
    `SELECT product_id, branch_id, SUM(qty_milli_delta) AS qty FROM stock_movements${mv.sql} GROUP BY product_id, branch_id`,
    mv.params,
  );
  // Shipped and not yet received, by receiving branch and product (a shipment HQ cannot deliver is not counted: nobody is waiting for it).
  const wait = await q.all<{ branch_id: number; product_id: number; qty: number }>(
    `SELECT i.to_branch_id AS branch_id, x.product_id, SUM(x.qty_milli) AS qty
     FROM incoming_shipment_items x JOIN incoming_shipments i ON i.id = x.incoming_id
          JOIN branch_directory d ON d.id = i.to_branch_id AND d.active = 1 AND d.id <> i.from_branch_id
     WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.branch_id = i.to_branch_id AND r.incoming_id = i.id)${opts.branchId === undefined ? '' : ' AND i.to_branch_id = ?'}
     GROUP BY i.to_branch_id, x.product_id`,
    opts.branchId === undefined ? [] : [opts.branchId],
  );
  const transit = new Map<string, number>(wait.map((w) => [`${w.product_id}:${w.branch_id}`, w.qty]));
  const ordered = await onOrder(q); // placed orders not yet received at a stock branch (docs/15 §6, §8)
  const branches = (
    await q.all<{ id: number }>(
      'SELECT id FROM branches WHERE active = 1' + (opts.branchId === undefined ? '' : ' AND id = ?'),
      opts.branchId === undefined ? [] : [opts.branchId],
    )
  ).map((b) => b.id);
  const per = new Map<number, Map<number, number>>();
  for (const s of sums) per.set(s.product_id, (per.get(s.product_id) ?? new Map()).set(s.branch_id, s.qty));
  const rows: StockRow[] = [];
  for (const p of products) {
    const m = per.get(p.id) ?? new Map<number, number>();
    const byBranch = branches.map((branchId) => ({
      branchId,
      qtyMilli: m.get(branchId) ?? 0,
      inTransitMilli: transit.get(`${p.id}:${branchId}`) ?? 0,
      onOrderMilli: ordered.get(`${p.id}:${branchId}`) ?? 0,
    }));
    // Low = at or under the product's alert at THAT branch (as at a branch: its own stock against its own alert).
    if (opts.lowOnly && !byBranch.some((x) => p.stock_alert_milli !== null && x.qtyMilli <= p.stock_alert_milli)) continue;
    rows.push({
      productId: p.id,
      name: p.name,
      barcode: p.barcode,
      alertMilli: p.stock_alert_milli,
      totalMilli: byBranch.reduce((sum, x) => sum + x.qtyMilli, 0),
      inTransitMilli: byBranch.reduce((sum, x) => sum + x.inTransitMilli, 0),
      onOrderMilli: byBranch.reduce((sum, x) => sum + x.onOrderMilli, 0),
      byBranch,
    });
    if (rows.length >= opts.limit) break;
  }
  return rows;
}

export type TransferRow = {
  id: number;
  fromBranchId: number;
  from: string;
  toBranchId: number;
  to: string;
  shipmentId: number;
  reason: string;
  note: string | null;
  shippedAt: string;
  lines: number;
  qtyMilli: number;
  /** `in_transit`: shipped, not yet confirmed. `received`: confirmed (with the net difference). `undeliverable`: no branch HQ can deliver it to. */
  status: 'in_transit' | 'received' | 'undeliverable';
  receivedAt: string | null;
  /** counted minus expected over the whole shipment: negative is short */
  differenceMilli: number | null;
};

/** Shipments between branches in the range, with where each stands (docs/15 §4). `branchId` keeps those sent or received by that branch. */
export async function transfersReport(
  q: Queryable,
  opts: { from: string; to: string; branchId?: number; status: 'all' | TransferRow['status'] },
): Promise<TransferRow[]> {
  const where = ['i.shipped_at >= ?', 'i.shipped_at <= ?'];
  const params: Param[] = [opts.from, opts.to];
  if (opts.branchId !== undefined) {
    where.push('(i.from_branch_id = ? OR i.to_branch_id = ?)');
    params.push(opts.branchId, opts.branchId);
  }
  const rows = await q.all<{
    id: number;
    from_branch_id: number;
    to_branch_id: number;
    shipment_id: number;
    reason: string;
    note: string | null;
    shipped_at: string;
    lines: number;
    qty: number;
    receipt_id: number | null;
    received_at: string | null;
    difference: number | null;
    deliverable: number | null;
  }>(
    `SELECT i.id, i.from_branch_id, i.to_branch_id, i.shipment_id, i.reason, i.note, i.shipped_at,
            (SELECT COUNT(*) FROM incoming_shipment_items x WHERE x.incoming_id = i.id) AS lines,
            (SELECT COALESCE(SUM(x.qty_milli), 0) FROM incoming_shipment_items x WHERE x.incoming_id = i.id) AS qty,
            r.id AS receipt_id, r.created_at AS received_at,
            (SELECT COALESCE(SUM(ri.qty_counted_milli - ri.qty_expected_milli), 0) FROM receipt_items ri WHERE ri.branch_id = r.branch_id AND ri.receipt_id = r.id) AS difference,
            d.id AS deliverable
     FROM incoming_shipments i
          LEFT JOIN receipts r ON r.branch_id = i.to_branch_id AND r.incoming_id = i.id
          LEFT JOIN branch_directory d ON d.id = i.to_branch_id AND d.active = 1 AND d.id <> i.from_branch_id
     WHERE ${where.join(' AND ')} ORDER BY i.shipped_at DESC, i.id DESC LIMIT 500`,
    params,
  );
  const names = await branchNames(q);
  const out = rows.map((r): TransferRow => ({
    id: r.id,
    fromBranchId: r.from_branch_id,
    from: nameOf(names, r.from_branch_id),
    toBranchId: r.to_branch_id,
    to: nameOf(names, r.to_branch_id),
    shipmentId: r.shipment_id,
    reason: r.reason,
    note: r.note,
    shippedAt: r.shipped_at,
    lines: r.lines,
    qtyMilli: r.qty,
    status: r.receipt_id !== null ? 'received' : r.deliverable === null ? 'undeliverable' : 'in_transit',
    receivedAt: r.received_at,
    differenceMilli: r.receipt_id !== null ? r.difference : null,
  }));
  return opts.status === 'all' ? out : out.filter((t) => t.status === opts.status);
}

export type ReconciliationRow = {
  branchId: number;
  branch: string;
  day: string;
  status: 'ok' | 'mismatch';
  checkedAt: string;
  differences: { table: string; branch: { n: number; s: number }; hq: { n: number; s: number } }[];
};

/** The latest daily comparison for each branch and day (docs/12 §24): where HQ and a branch disagree about what the branch holds. */
export async function reconciliationReport(
  q: Queryable,
  opts: { from: string; to: string; branchId?: number; onlyMismatch: boolean },
): Promise<ReconciliationRow[]> {
  const where = ['r.day >= ?', 'r.day <= ?'];
  const params: Param[] = [opts.from, opts.to];
  if (opts.branchId !== undefined) {
    where.push('r.branch_id = ?');
    params.push(opts.branchId);
  }
  if (opts.onlyMismatch) where.push("r.status = 'mismatch'");
  const rows = await q.all<{ branch_id: number; day: string; status: 'ok' | 'mismatch'; checked_at: string; diff_json: string | null }>(
    `SELECT r.branch_id, r.day, r.status, r.checked_at, r.diff_json FROM reconciliations r WHERE ${where.join(' AND ')} ORDER BY r.day DESC, r.branch_id`,
    params,
  );
  const names = await branchNames(q);
  return rows.map((r) => ({
    branchId: r.branch_id,
    branch: nameOf(names, r.branch_id),
    day: r.day,
    status: r.status,
    checkedAt: r.checked_at,
    differences: r.diff_json ? (JSON.parse(r.diff_json) as ReconciliationRow['differences']) : [],
  }));
}

/** The chain at a glance: each branch's takings, returns, spending and open tills in the range, and when it was last heard from. */
export async function overview(q: Queryable, range: Range, staleMinutes: number) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [sales, returns, names, open, spent, seen, recon] = await Promise.all([
    salesByHour(q, range),
    returnsByHour(q, range),
    branchNames(q),
    q.all<{ branch_id: number; n: number }>(
      `SELECT branch_id, COUNT(*) AS n FROM register_sessions WHERE status = 'open' GROUP BY branch_id`,
    ),
    q.all<{ branch_id: number; currency: string; amount: number }>(
      `SELECT branch_id, currency, SUM(amount_minor) AS amount FROM expenses WHERE created_at >= ? AND created_at <= ? GROUP BY branch_id, currency`,
      [range.from, range.to],
    ),
    q.all<{ id: number; active: number; kind: string; last_seen_at: string | null }>(
      'SELECT id, active, kind, last_seen_at FROM branches ORDER BY id',
    ),
    q.all<{ branch_id: number; last: string; bad: number }>(
      `SELECT branch_id, MAX(checked_at) AS last, SUM(CASE WHEN status = 'mismatch' THEN 1 ELSE 0 END) AS bad FROM reconciliations WHERE day >= ? GROUP BY branch_id`,
      [since],
    ),
  ]);
  const folded: Folded = new Map();
  for (const s of sales) add(folded, String(s.branch_id), s);
  for (const r of returns) add(folded, String(r.branch_id), undefined, r);
  const now = Date.now();
  const rows = seen.map((b) => {
    const t = folded.get(String(b.id)) ?? emptyTotals();
    const last = b.last_seen_at;
    return {
      branchId: b.id,
      code: names.get(b.id)?.code ?? '',
      name: nameOf(names, b.id),
      kind: b.kind,
      active: b.active === 1,
      ...t,
      openRegisters: open.find((o) => o.branch_id === b.id)?.n ?? 0,
      expenses: spent.filter((e) => e.branch_id === b.id).map((e) => ({ currency: e.currency, amount: e.amount })),
      lastSeenAt: last,
      // The daily comparison of the last 30 days: when it last ran, and on how many days HQ and the branch disagree (docs/12 §24).
      reconciliation: {
        lastCheckedAt: recon.find((x) => x.branch_id === b.id)?.last ?? null,
        mismatchDays: recon.find((x) => x.branch_id === b.id)?.bad ?? 0,
      },
      // A branch that has not been heard from lately: its figures may be behind (they are what it has sent, not what it has done).
      stale: b.active === 1 && (last === null || now - Date.parse(last) > staleMinutes * 60_000),
    };
  });
  return { from: range.from, to: range.to, branches: rows, totals: totalOf(rows) };
}

export type RequestLine = {
  productId: number;
  name: string;
  wantedMilli: number;
  shippedMilli: number;
  unavailableMilli: number;
  status: 'waiting' | 'picking' | 'done';
};
export type RequestRow = {
  branchId: number;
  branch: string;
  requestId: number;
  createdAt: string;
  note: string | null;
  /** `routing`: HQ has not sent it anywhere yet. `open`: some line is still waiting or being picked. `closed`: every line is shipped or not available. */
  status: 'routing' | 'open' | 'closed';
  lines: RequestLine[];
};

/** Requests made by shops in the range, with where each line stands (docs/15 §5). */
export async function requestsReport(
  q: Queryable,
  opts: { from: string; to: string; branchId?: number; status: 'all' | RequestRow['status'] },
): Promise<RequestRow[]> {
  const b = branchClause('r', opts.branchId);
  const reqs = await q.all<{ branch_id: number; id: number; created_at: string; note: string | null }>(
    `SELECT r.branch_id, r.id, r.created_at, r.note FROM stock_requests r WHERE r.created_at >= ? AND r.created_at <= ?${b.sql}
     ORDER BY r.created_at DESC, r.branch_id, r.id DESC LIMIT 500`,
    [opts.from, opts.to, ...b.params],
  );
  if (reqs.length === 0) return [];
  const lines = await q.all<{
    for_branch_id: number;
    request_id: number;
    product_id: number;
    name: string | null;
    wanted_milli: number;
    shipped_milli: number;
    unavailable_milli: number;
    status: RequestLine['status'];
  }>(
    `SELECT s.for_branch_id, s.request_id, s.product_id, p.name, s.wanted_milli, s.shipped_milli, s.unavailable_milli, s.status
     FROM request_status s JOIN stock_requests r ON r.branch_id = s.for_branch_id AND r.id = s.request_id LEFT JOIN products p ON p.id = s.product_id
     WHERE r.created_at >= ? AND r.created_at <= ?${b.sql} ORDER BY s.id`,
    [opts.from, opts.to, ...b.params],
  );
  const names = await branchNames(q);
  const out = reqs.map((r): RequestRow => {
    const mine = lines
      .filter((l) => l.for_branch_id === r.branch_id && l.request_id === r.id)
      .map((l): RequestLine => ({
        productId: l.product_id,
        name: l.name ?? `Product ${l.product_id}`,
        wantedMilli: l.wanted_milli,
        shippedMilli: l.shipped_milli,
        unavailableMilli: l.unavailable_milli,
        status: l.status,
      }));
    return {
      branchId: r.branch_id,
      branch: nameOf(names, r.branch_id),
      requestId: r.id,
      createdAt: r.created_at,
      note: r.note,
      status: mine.length === 0 ? 'routing' : mine.every((l) => l.status === 'done') ? 'closed' : 'open',
      lines: mine,
    };
  });
  return opts.status === 'all' ? out : out.filter((r) => r.status === opts.status);
}

/** What shops asked for that no stock branch could supply, by product (docs/15 §5): the demand central buying can see. */
export async function unmetDemand(q: Queryable, opts: { from: string; to: string; branchId?: number }) {
  const b = branchClause('r', opts.branchId);
  const rows = await q.all<{ product_id: number; name: string | null; unavailable: number; wanted: number; lines: number }>(
    `SELECT s.product_id, MAX(p.name) AS name, SUM(s.unavailable_milli) AS unavailable, SUM(s.wanted_milli) AS wanted, COUNT(*) AS lines
     FROM request_status s JOIN stock_requests r ON r.branch_id = s.for_branch_id AND r.id = s.request_id LEFT JOIN products p ON p.id = s.product_id
     WHERE s.unavailable_milli > 0 AND r.created_at >= ? AND r.created_at <= ?${b.sql}
     GROUP BY s.product_id ORDER BY unavailable DESC, name`,
    [opts.from, opts.to, ...b.params],
  );
  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name ?? `Product ${r.product_id}`,
    unavailableMilli: r.unavailable,
    wantedMilli: r.wanted,
    lines: r.lines,
  }));
}
