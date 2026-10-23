import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDay, shopDayStart } from '../../util/time';
import { parse } from '../../util/validate';
import { lowStock } from '../inventory/routes';
import { byCategory, groupBy, hourly, productSales, returnsIn, salesIn, topItems, totalsOf } from './queries';

const iso = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time such as 2026-10-01T00:00:00Z');

// `from` and `to` are both inclusive. Without them the report covers today, from the start of the shop's day until now.
const range = z.object({ from: iso.optional(), to: iso.optional() });

const salesQuery = range.extend({ groupBy: z.enum(['day', 'cashier', 'category']).default('day') });
const productsQuery = range.extend({
  sort: z.enum(['qty', 'revenue', 'profit']).default('revenue'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const resolve = (q: z.infer<typeof range>) => ({ from: q.from ?? shopDayStart().toISOString(), to: q.to ?? new Date().toISOString() });

export default async function reportRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  // Live dashboard: today so far, with returns taken off, the hours of the day, the best sellers, and what is owed either way.
  app.get('/reports/dashboard', manager, async () => {
    const since = shopDayStart().toISOString();
    const now = new Date().toISOString();
    const sales = salesIn(db, { from: since, to: now });
    const returns = returnsIn(db, { from: since, to: now });
    const t = totalsOf(sales, returns);
    const open = db.prepare(`SELECT count(*) AS n FROM register_sessions WHERE status = 'open'`).get() as { n: number };
    const owedToSuppliers = { USD: 0, LBP: 0 };
    for (const r of db
      .prepare(
        `SELECT currency, SUM(total_minor - paid_minor) AS owed FROM purchases WHERE status <> 'draft' AND paid_minor < total_minor GROUP BY currency`,
      )
      .all() as { currency: 'USD' | 'LBP'; owed: number }[])
      owedToSuppliers[r.currency] = r.owed;

    return {
      // Gross figures, as before: every sale made today, returns not taken off.
      salesToday: {
        count: t.count,
        totalLbp: t.grossLbp,
        profitLbp: sales.reduce((sum, s) => sum + s.profit_lbp, 0),
        averageBasketLbp: t.count ? Math.round(t.grossLbp / t.count) : 0,
      },
      // The figures to look at: what was taken back today is already off.
      today: {
        salesCount: t.count,
        grossLbp: t.grossLbp,
        returnsCount: returns.length,
        returnedLbp: t.returnedLbp,
        netLbp: t.netLbp,
        profitLbp: t.profitLbp,
        averageBasketLbp: t.count ? Math.round(t.grossLbp / t.count) : 0,
      },
      hourly: hourly(sales),
      topItems: topItems(db, since),
      owedByCustomersLbp: (db.prepare('SELECT COALESCE(SUM(balance_lbp), 0) AS owed FROM customers').get() as { owed: number }).owed,
      owedToSuppliers,
      lowStockCount: lowStock(db).length,
      openRegisters: open.n,
    };
  });

  // Takings between two moments, by shop day, by cashier or by product category. Returns count on the day they were taken back.
  app.get('/reports/sales', manager, async (req) => {
    const q = parse(salesQuery, req.query);
    const r = resolve(q);
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
  });

  // Best and slowest sellers, with margin.
  app.get('/reports/products', manager, async (req) => {
    const q = parse(productsQuery, req.query);
    const r = resolve(q);
    return { from: r.from, to: r.to, data: productSales(db, r, q.sort, q.order, q.limit) };
  });
}
