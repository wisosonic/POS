import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { milliToQty } from '../../util/qty';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { createReturn, returnBody } from './service';

const listQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  saleId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export default async function returnRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  // A cashier may start a return, but the server refuses it without a manager's approval (RETURN_NEEDS_APPROVAL).
  app.post('/returns', { preHandler: app.authenticate }, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(returnBody, req.body);
    const result = createReturn(db, req.auth, body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  app.get('/returns', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('created_at >= ?', q.from);
    add('created_at <= ?', q.to);
    add('sale_id = ?', q.saleId);
    add('id < ?', q.cursor);

    const rows = db
      .prepare(`SELECT * FROM returns ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, q.limit + 1) as {
      id: number;
      ref: number;
      sale_id: number;
      user_id: number | null;
      reason: string;
      refund_lbp: number;
      balance_reduced_lbp: number;
      created_at: string;
    }[];
    const page = rows.slice(0, q.limit);
    const itemsOf = db.prepare('SELECT sale_item_id, qty_milli, amount_lbp FROM return_items WHERE return_id = ? ORDER BY id');
    return {
      data: page.map((r) => ({
        id: r.id,
        ref: r.ref,
        saleId: r.sale_id,
        userId: r.user_id,
        reason: r.reason,
        refundLbp: r.refund_lbp,
        balanceReducedLbp: r.balance_reduced_lbp,
        createdAt: r.created_at,
        items: (itemsOf.all(r.id) as { sale_item_id: number; qty_milli: number; amount_lbp: number }[]).map((i) => ({
          saleItemId: i.sale_item_id,
          qty: milliToQty(i.qty_milli),
          amountLbp: i.amount_lbp,
        })),
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}
