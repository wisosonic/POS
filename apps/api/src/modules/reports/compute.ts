import type { Db } from '../../db/open';
import { localDay } from '../../util/time';
import { byCategory, groupBy, productSales, returnsIn, salesIn, totalsOf } from './queries';

// The two reports that can read a lot of history (every sale and return in a range): a whole-history sales report on a five-year
// branch takes over half a second. They are plain functions of a database handle and a few values, so the same code runs on the server's
// own connection (small shops, tests) or inside a worker thread with its own read-only connection (modules/reports/runner.ts), where
// a long report cannot hold up a sale.

export type RangeParams = { from: string; to: string };
export type SalesReportParams = RangeParams & { groupBy: 'day' | 'cashier' | 'category' };
export type ProductsReportParams = RangeParams & { sort: 'qty' | 'revenue' | 'profit'; order: 'desc' | 'asc'; limit: number };

/** Takings between two moments, by shop day, by cashier or by product category. Returns count on the day they were taken back. */
export function salesReport(db: Db, q: SalesReportParams) {
  const r = { from: q.from, to: q.to };
  const sales = salesIn(db, r);
  const returns = returnsIn(db, r);
  const rows =
    q.groupBy === 'day'
      ? groupBy(sales, returns, (x) => ({ key: localDay(x.created_at), label: localDay(x.created_at) }))
      : q.groupBy === 'cashier'
        ? groupBy(sales, returns, (x) => ({ key: String(x.user_id ?? 0), label: x.user_name ?? 'Imported or unknown' }))
        : byCategory(db, r);
  // The grand total comes from the sales and returns themselves, so it is right even when a sale spans categories.
  return { from: r.from, to: r.to, groupBy: q.groupBy, data: rows, totals: totalsOf(sales, returns) };
}

/** Best and slowest sellers, with margin. */
export function productsReport(db: Db, q: ProductsReportParams) {
  return { from: q.from, to: q.to, data: productSales(db, { from: q.from, to: q.to }, q.sort, q.order, q.limit) };
}

export type ReportJob = { kind: 'sales'; params: SalesReportParams } | { kind: 'products'; params: ProductsReportParams };

/** Run one report on the given connection. The worker and the inline runner both go through here. */
export function runReport(db: Db, job: ReportJob): unknown {
  return job.kind === 'sales' ? salesReport(db, job.params) : productsReport(db, job.params);
}
