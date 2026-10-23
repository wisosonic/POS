import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nextRef } from '../../db/counters';
import { inWriteTransaction } from '../../db/open';
import { E } from '../../errors';
import { findReplay, hashRequest, rememberResponse, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { activeMethods, recordCashIn, requireOpenSession } from '../registers/service';

// Service income (US-36): what the shop earns that is not a product (IT support, a repair, an installation). It records what the
// service cost the shop and what the customer paid; profit is the difference. When the customer paid at the till the money goes
// into a register balance in the same transaction, so tonight's count still agrees. Never edited or deleted (migration 0009).

const SCOPE = 'POST /services';

const createBody = z.object({
  categoryId: z.number().int().positive().nullish(),
  customerId: z.number().int().positive().nullish(),
  note: z.string().trim().max(500).nullish(),
  /** What the service cost the shop. */
  costMinor: z.number().int().min(0),
  /** What the customer paid. */
  feeMinor: z.number().int().positive(),
  currency: z.enum(['USD', 'LBP']),
  /** Received into this register balance, in the service's own currency. Leave out when it was paid some other way. */
  receivedInto: z.object({ method: z.string().min(1).max(20) }).optional(),
});

const listQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

type Row = {
  id: number;
  category_id: number | null;
  category_name: string | null;
  customer_id: number | null;
  customer_name: string | null;
  session_id: number | null;
  reference: string;
  note: string | null;
  cost_minor: number;
  fee_minor: number;
  profit_minor: number;
  currency: 'USD' | 'LBP';
  created_at: string;
};

const SELECT = `SELECT s.*, c.name AS category_name, cu.name AS customer_name FROM service_sales s
  LEFT JOIN service_categories c ON c.id = s.category_id LEFT JOIN customers cu ON cu.id = s.customer_id`;

const serviceJson = (r: Row) => ({
  id: r.id,
  reference: r.reference,
  categoryId: r.category_id,
  categoryName: r.category_name,
  customerId: r.customer_id,
  customerName: r.customer_name,
  note: r.note,
  costMinor: r.cost_minor,
  feeMinor: r.fee_minor,
  profitMinor: r.profit_minor,
  currency: r.currency,
  receivedAtTill: r.session_id !== null,
  createdAt: r.created_at,
});

export default async function serviceRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  app.post('/services', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const b = parse(createBody, req.body);
    if (b.categoryId && !db.prepare('SELECT 1 FROM service_categories WHERE id = ?').get(b.categoryId))
      throw E.unprocessable('INVALID_REFERENCE', 'That service type does not exist');
    if (b.customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customerId))
      throw E.unprocessable('INVALID_REFERENCE', 'That customer does not exist');
    if (b.receivedInto && !activeMethods(db).includes(b.receivedInto.method)) throw E.validation('Unknown payment method');

    const hash = hashRequest(req.body);
    const result = inWriteTransaction(db, () => {
      const replay = findReplay(db, SCOPE, key, hash);
      if (replay) return { ...replay, replay: true };
      // Money received at the till needs an open register; it goes in, in the same transaction as the service is recorded.
      const session = b.receivedInto ? requireOpenSession(db) : null;
      const reference = String(nextRef(db, 'service_ref'));
      const id = Number(
        db
          .prepare(
            `INSERT INTO service_sales (category_id, customer_id, user_id, session_id, reference, note, cost_minor, fee_minor, profit_minor, currency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            b.categoryId ?? null,
            b.customerId ?? null,
            req.auth.id,
            session?.id ?? null,
            reference,
            b.note ?? null,
            b.costMinor,
            b.feeMinor,
            b.feeMinor - b.costMinor,
            b.currency,
          ).lastInsertRowid,
      );
      if (session && b.receivedInto) {
        recordCashIn(
          db,
          session.id,
          { method: b.receivedInto.method, currency: b.currency },
          b.feeMinor,
          `Service ${reference}`,
          req.auth.id,
        );
      }
      writeAudit(db, {
        userId: req.auth.id,
        action: 'service.create',
        entity: 'service',
        entityId: id,
        after: {
          reference,
          feeMinor: b.feeMinor,
          costMinor: b.costMinor,
          currency: b.currency,
          receivedInto: b.receivedInto?.method ?? null,
        },
      });
      const body = serviceJson(db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row);
      rememberResponse(db, SCOPE, key, hash, 201, body);
      return { statusCode: 201, body: body as unknown, replay: false };
    });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  app.get('/services', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('s.created_at >= ?', q.from);
    add('s.created_at <= ?', q.to);
    add('s.category_id = ?', q.categoryId);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The totals cover everything the filters match, not only this page.
    const sums = db
      .prepare(
        `SELECT s.currency AS currency, SUM(s.fee_minor) AS fee, SUM(s.cost_minor) AS cost, SUM(s.profit_minor) AS profit FROM service_sales s ${filter} GROUP BY s.currency`,
      )
      .all(...params) as { currency: 'USD' | 'LBP'; fee: number; cost: number; profit: number }[];
    const totals = { USD: { fee: 0, cost: 0, profit: 0 }, LBP: { fee: 0, cost: 0, profit: 0 } };
    for (const s of sums) totals[s.currency] = { fee: s.fee, cost: s.cost, profit: s.profit };

    add('s.id < ?', q.cursor);
    const rows = db
      .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`)
      .all(...params, q.limit + 1) as Row[];
    const page = rows.slice(0, q.limit);
    return { data: page.map(serviceJson), totals, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });
}
