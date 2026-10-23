import type { Db } from '../../db/open';
import { milliToQty } from '../../util/qty';
import { localHour } from '../../util/time';

// Read-only figures for the owner. Sales count on the day they were made and returns on the day they were taken back, so a
// day's net figure is what the till actually gained that day. Voided sales never count. Lira throughout (every sale is
// stored in lira at its own rate), so nothing here depends on today's exchange rate.

export type Range = { from: string; to: string };

type SaleRow = { created_at: string; total_lbp: number; profit_lbp: number; user_id: number | null; user_name: string | null };
type ReturnRow = { created_at: string; value_lbp: number; profit_lost_lbp: number; user_id: number | null; user_name: string | null };

const RETURN_SELECT = `
  SELECT r.created_at, r.refund_lbp + r.balance_reduced_lbp AS value_lbp,
         (r.refund_lbp + r.balance_reduced_lbp) - COALESCE((SELECT SUM(CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER))
            FROM return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = r.id), 0) AS profit_lost_lbp,
         s.user_id AS user_id, u.name AS user_name
  FROM returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = s.user_id`;

export const salesIn = (db: Db, range: Range) =>
  db
    .prepare(
      `SELECT s.created_at, s.total_lbp, s.profit_lbp, s.user_id, u.name AS user_name
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void' ORDER BY s.created_at`,
    )
    .all(range.from, range.to) as SaleRow[];

export const returnsIn = (db: Db, range: Range) =>
  db
    .prepare(`${RETURN_SELECT} WHERE r.created_at >= ? AND r.created_at <= ? ORDER BY r.created_at`)
    .all(range.from, range.to) as ReturnRow[];

export type Totals = { count: number; grossLbp: number; returnedLbp: number; netLbp: number; profitLbp: number };
export const emptyTotals = (): Totals => ({ count: 0, grossLbp: 0, returnedLbp: 0, netLbp: 0, profitLbp: 0 });

/** Net figures for a set of sales and returns. `profitLbp` is already net of what was taken back. */
export function totalsOf(sales: SaleRow[], returns: ReturnRow[]): Totals {
  const t = emptyTotals();
  for (const s of sales) {
    t.count += 1;
    t.grossLbp += s.total_lbp;
    t.profitLbp += s.profit_lbp;
  }
  for (const r of returns) {
    t.returnedLbp += r.value_lbp;
    t.profitLbp -= r.profit_lost_lbp;
  }
  t.netLbp = t.grossLbp - t.returnedLbp;
  return t;
}

export type GroupRow = Totals & { key: string; label: string };

/** Group sales and returns by a key (a day, a cashier) and total each group. Keys come back in order of first appearance, sorted by key. */
export function groupBy(
  sales: SaleRow[],
  returns: ReturnRow[],
  keyOf: (r: { created_at: string; user_id: number | null; user_name: string | null }) => { key: string; label: string },
): GroupRow[] {
  const groups = new Map<string, { label: string; sales: SaleRow[]; returns: ReturnRow[] }>();
  const slot = (r: Parameters<typeof keyOf>[0]) => {
    const { key, label } = keyOf(r);
    if (!groups.has(key)) groups.set(key, { label, sales: [], returns: [] });
    return groups.get(key)!;
  };
  for (const s of sales) slot(s).sales.push(s);
  for (const r of returns) slot(r).returns.push(r);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, g]) => ({ key, label: g.label, ...totalsOf(g.sales, g.returns) }));
}

/** Sales by product category, net of returns. A sale with lines in two categories counts once in each. */
export function byCategory(db: Db, range: Range): GroupRow[] {
  const sold = db
    .prepare(
      `SELECT COALESCE(p.category_id, 0) AS cat, COALESCE(MAX(c.name), 'No category') AS cat_name, COUNT(DISTINCT s.id) AS n,
              SUM(si.line_total_lbp) AS gross,
              SUM(si.line_total_lbp - CAST(ROUND(si.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS profit
       FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void' GROUP BY cat`,
    )
    .all(range.from, range.to) as { cat: number; cat_name: string; n: number; gross: number; profit: number }[];
  const back = db
    .prepare(
      `SELECT COALESCE(p.category_id, 0) AS cat, COALESCE(MAX(c.name), 'No category') AS cat_name,
              SUM(ri.amount_lbp) AS value,
              SUM(ri.amount_lbp - CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS profit_lost
       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
            LEFT JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE r.created_at >= ? AND r.created_at <= ? GROUP BY cat`,
    )
    .all(range.from, range.to) as { cat: number; cat_name: string; value: number; profit_lost: number }[];

  const rows = new Map<number, GroupRow>();
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

export type ProductRow = {
  productId: number | null;
  name: string;
  qty: string;
  revenueLbp: number;
  costLbp: number;
  profitLbp: number;
};

/**
 * What sold, per product, net of returns. Values are the line values before any discount on the whole sale, so
 * the profit here can differ slightly from the sales report for a discounted sale.
 */
export function productSales(db: Db, range: Range, sort: 'qty' | 'revenue' | 'profit', order: 'desc' | 'asc', limit: number): ProductRow[] {
  const sold = db
    .prepare(
      `SELECT COALESCE(si.product_id, 0) AS pid, MAX(si.name_snap) AS item_name, SUM(si.qty_milli) AS sold_milli, SUM(si.line_total_lbp) AS revenue,
              SUM(CAST(ROUND(si.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS cost
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.created_at >= ? AND s.created_at <= ? AND s.status <> 'void' GROUP BY pid`,
    )
    .all(range.from, range.to) as { pid: number; item_name: string; sold_milli: number; revenue: number; cost: number }[];
  const back = db
    .prepare(
      `SELECT COALESCE(si.product_id, 0) AS pid, SUM(ri.qty_milli) AS back_milli, SUM(ri.amount_lbp) AS value,
              SUM(CAST(ROUND(ri.qty_milli * si.unit_cost_lbp / 1000.0) AS INTEGER)) AS cost
       FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
       WHERE r.created_at >= ? AND r.created_at <= ? GROUP BY pid`,
    )
    .all(range.from, range.to) as { pid: number; back_milli: number; value: number; cost: number }[];
  const returned = new Map(back.map((b) => [b.pid, b]));

  const rows = sold.map((s) => {
    const b = returned.get(s.pid);
    const qtyMilli = s.sold_milli - (b?.back_milli ?? 0);
    const revenue = s.revenue - (b?.value ?? 0);
    const cost = s.cost - (b?.cost ?? 0);
    return {
      productId: s.pid === 0 ? null : s.pid,
      name: s.pid === 0 ? 'Unmatched legacy items' : s.item_name.trim(),
      qtyMilli,
      qty: milliToQty(qtyMilli),
      revenueLbp: revenue,
      costLbp: cost,
      profitLbp: revenue - cost,
    };
  });
  const value = (r: (typeof rows)[number]) => (sort === 'qty' ? r.qtyMilli : sort === 'revenue' ? r.revenueLbp : r.profitLbp);
  rows.sort((a, b) => (order === 'desc' ? value(b) - value(a) : value(a) - value(b)) || a.name.localeCompare(b.name));
  return rows.slice(0, limit).map(({ qtyMilli: _q, ...r }) => r);
}

/** Today's best sellers by takings, for the dashboard. */
export function topItems(db: Db, since: string, limit = 5) {
  const rows = db
    .prepare(
      `SELECT COALESCE(si.product_id, 0) AS pid, MAX(si.name_snap) AS item_name, SUM(si.qty_milli) AS sold_milli, SUM(si.line_total_lbp) AS revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.created_at >= ? AND s.status <> 'void'
       GROUP BY pid ORDER BY revenue DESC, item_name LIMIT ?`,
    )
    .all(since, limit) as { pid: number; item_name: string; sold_milli: number; revenue: number }[];
  return rows.map((r) => ({
    productId: r.pid === 0 ? null : r.pid,
    name: r.item_name.trim(),
    qty: milliToQty(r.sold_milli),
    totalLbp: r.revenue,
  }));
}

/** Takings per shop-local hour for a set of sales, as 24 entries (0 to 23). */
export function hourly(sales: SaleRow[]) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, totalLbp: 0 }));
  for (const s of sales) {
    const h = hours[localHour(s.created_at)]!;
    h.count += 1;
    h.totalLbp += s.total_lbp;
  }
  return hours;
}
