import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shopDayStart } from '../../util/time';
import { rebalanceSuggestions, reorderSuggestions } from './restock';
import {
  branchNames,
  expensesReport,
  overview,
  paymentsReport,
  reconciliationReport,
  productsReport,
  registersReport,
  salesReport,
  stockReport,
  requestsReport,
  transfersReport,
  unmetDemand,
} from './queries';

const iso = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use a date and time such as 2026-10-01T00:00:00Z');
// `from` and `to` are both inclusive. Without them the report covers today, from the start of the shop's day until now.
const range = z.object({ from: iso.optional(), to: iso.optional(), branchId: z.coerce.number().int().positive().optional() });
const MAX_DAYS = 400;
const STALE_MINUTES = 10;

const resolve = (q: z.infer<typeof range>) => {
  const from = q.from ?? shopDayStart().toISOString();
  const to = q.to ?? new Date().toISOString();
  if (Date.parse(from) > Date.parse(to)) throw new AppError(400, 'VALIDATION', 'The start of the range is after its end');
  // HQ answers these on its own connection, next to the branches' uploads: a range of years is for a report built for it (a later step).
  if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86_400_000)
    throw new AppError(400, 'VALIDATION', `A report covers at most ${MAX_DAYS} days`);
  return { from, to };
};

/**
 * The chain's reports (docs/12 §23, P4b), over what the branches have sent. HQ staff, any role: a viewer reads everything. `branchId` narrows
 * a report to one branch. Figures are what the branches have SENT: `GET /reports/overview` says when each was last heard from.
 */
export default async function reportRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };

  app.get('/reports/overview', view, async (req) => overview(db, resolve(parse(range, req.query)), STALE_MINUTES));

  app.get('/reports/sales', view, async (req) => {
    const q = parse(range.extend({ groupBy: z.enum(['day', 'branch', 'category']).default('day') }), req.query);
    return salesReport(db, resolve(q), q.groupBy, q.branchId);
  });

  app.get('/reports/products', view, async (req) => {
    const q = parse(
      range.extend({
        sort: z.enum(['qty', 'revenue', 'profit']).default('revenue'),
        order: z.enum(['desc', 'asc']).default('desc'),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }),
      req.query,
    );
    const r = resolve(q);
    return { ...r, data: await productsReport(db, r, { branchId: q.branchId, sort: q.sort, order: q.order, limit: q.limit }) };
  });

  app.get('/reports/payments', view, async (req) => {
    const q = parse(range, req.query);
    const r = resolve(q);
    const names = await branchNames(db);
    const rows = await paymentsReport(db, r, q.branchId);
    return {
      ...r,
      data: rows.map((x) => ({
        branchId: x.branch_id,
        branch: names.get(x.branch_id)?.name ?? `Branch ${x.branch_id}`,
        method: x.method,
        currency: x.currency,
        amount: x.amount,
        count: x.n,
      })),
    };
  });

  app.get('/reports/expenses', view, async (req) => {
    const q = parse(range, req.query);
    const r = resolve(q);
    const names = await branchNames(db);
    const rows = await expensesReport(db, r, q.branchId);
    return {
      ...r,
      data: rows.map((x) => ({
        branchId: x.branch_id,
        branch: names.get(x.branch_id)?.name ?? `Branch ${x.branch_id}`,
        categoryId: x.category_id,
        category: x.category ?? 'No category',
        currency: x.currency,
        amount: x.amount,
        count: x.n,
      })),
    };
  });

  // Till shifts and their counts: who is over, who is short. `onlyVariance=true` keeps the shifts where something is off.
  app.get('/reports/registers', view, async (req) => {
    const q = parse(range.extend({ onlyVariance: z.enum(['true', 'false']).default('false') }), req.query);
    const r = resolve(q);
    return { ...r, ...(await registersReport(db, r, { branchId: q.branchId, onlyVariance: q.onlyVariance === 'true' })) };
  });

  // Requests made by shops, and where each line stands: routing, open or closed (docs/15 §5).
  app.get('/reports/requests', view, async (req) => {
    const q = parse(range.extend({ status: z.enum(['all', 'routing', 'open', 'closed']).default('all') }), req.query);
    const r = resolve(q);
    return { ...r, data: await requestsReport(db, { ...r, branchId: q.branchId, status: q.status }) };
  });

  // What shops asked for that no stock branch could supply: the demand central buying can see (docs/15 §5).
  app.get('/reports/unmet-demand', view, async (req) => {
    const q = parse(range, req.query);
    const r = resolve(q);
    return { ...r, data: await unmetDemand(db, { ...r, branchId: q.branchId }) };
  });

  // Shipments between branches: in transit, received (with the difference) or undeliverable (docs/15 §4). `branchId` = sent or received by it.
  app.get('/reports/transfers', view, async (req) => {
    const q = parse(range.extend({ status: z.enum(['all', 'in_transit', 'received', 'undeliverable']).default('all') }), req.query);
    const r = resolve(q);
    return { ...r, data: await transfersReport(db, { ...r, branchId: q.branchId, status: q.status }) };
  });

  // Where HQ and a branch disagree about what the branch holds, day by day (docs/12 §24). `from` and `to` are days (default: the last 30).
  app.get('/reports/reconciliation', view, async (req) => {
    const q = parse(
      z.object({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        branchId: z.coerce.number().int().positive().optional(),
        onlyMismatch: z.enum(['true', 'false']).default('false'),
      }),
      req.query,
    );
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    return { from, to, data: await reconciliationReport(db, { from, to, branchId: q.branchId, onlyMismatch: q.onlyMismatch === 'true' }) };
  });

  // What to buy: stock branches whose stock, with what is on the way and on order, is at or under the product's alert (docs/15 §8).
  app.get('/reports/reorder', view, async (req) => {
    const q = parse(
      z.object({ branchId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
      req.query,
    );
    return { data: await reorderSuggestions(db, q) };
  });

  // Slow at one shop, fast at another: what a shop could send back to a stock branch and what a fast shop could ask for. HQ only suggests (docs/15 §8).
  app.get('/reports/rebalance', view, async (req) => {
    const days = z.coerce.number().int().min(1).max(365);
    const q = parse(
      z.object({
        branchId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        windowDays: days.optional(),
        slowDays: days.optional(),
        fastDays: days.optional(),
        targetDays: days.optional(),
      }),
      req.query,
    );
    const { branchId, limit, ...cover } = q;
    return rebalanceSuggestions(db, { branchId, limit, cover });
  });

  // Stock per product at every branch, derived from the movements the branches sent. `lowOnly=true`: at or under the product's alert somewhere.
  app.get('/reports/stock', view, async (req) => {
    const q = parse(
      z.object({
        branchId: z.coerce.number().int().positive().optional(),
        productId: z.coerce.number().int().positive().optional(),
        lowOnly: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    return { data: await stockReport(db, { branchId: q.branchId, productId: q.productId, lowOnly: q.lowOnly === 'true', limit: q.limit }) };
  });
}
