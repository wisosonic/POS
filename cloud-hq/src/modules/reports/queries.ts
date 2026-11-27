import type { Queryable } from '@pos/core/adapter';
import { localDay } from '../../util/time';

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
  totalMilli: number;
  byBranch: { branchId: number; qtyMilli: number }[];
};

/** Stock per product at every branch, derived from the movements the branches sent (a branch's stock is the sum of its movements). */
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
    const byBranch = branches.map((branchId) => ({ branchId, qtyMilli: m.get(branchId) ?? 0 }));
    // Low = at or under the product's alert at THAT branch (as at a branch: its own stock against its own alert).
    if (opts.lowOnly && !byBranch.some((x) => p.stock_alert_milli !== null && x.qtyMilli <= p.stock_alert_milli)) continue;
    rows.push({
      productId: p.id,
      name: p.name,
      barcode: p.barcode,
      alertMilli: p.stock_alert_milli,
      totalMilli: byBranch.reduce((sum, x) => sum + x.qtyMilli, 0),
      byBranch,
    });
    if (rows.length >= opts.limit) break;
  }
  return rows;
}

/** The chain at a glance: each branch's takings, returns, spending and open tills in the range, and when it was last heard from. */
export async function overview(q: Queryable, range: Range, staleMinutes: number) {
  const [sales, returns, names, open, spent, seen] = await Promise.all([
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
    q.all<{ id: number; active: number; last_seen_at: string | null }>('SELECT id, active, last_seen_at FROM branches ORDER BY id'),
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
      active: b.active === 1,
      ...t,
      openRegisters: open.find((o) => o.branch_id === b.id)?.n ?? 0,
      expenses: spent.filter((e) => e.branch_id === b.id).map((e) => ({ currency: e.currency, amount: e.amount })),
      lastSeenAt: last,
      // A branch that has not been heard from lately: its figures may be behind (they are what it has sent, not what it has done).
      stale: b.active === 1 && (last === null || now - Date.parse(last) > staleMinutes * 60_000),
    };
  });
  return { from: range.from, to: range.to, branches: rows, totals: totalOf(rows) };
}
