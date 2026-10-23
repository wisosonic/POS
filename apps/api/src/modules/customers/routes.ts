import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inWriteTransaction } from '../../db/open';
import { E } from '../../errors';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { saleSummaryJson } from '../sales/service';
import { customerJson, customerPaymentBody, getCustomer, receiveCustomerPayment, type CustomerRow } from './service';

const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(200).optional(),
  email: z.string().trim().max(100).optional(),
});
const patchBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().max(50).nullable(),
    address: z.string().trim().max(200).nullable(),
    email: z.string().trim().max(100).nullable(),
  })
  .partial();

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  withBalance: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function customerRoutes(app: FastifyInstance) {
  const db = app.db;
  const user = { preHandler: app.authenticate };
  const manager = { preHandler: app.requireRole('manager') };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/customers', user, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) {
      where.push(`(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`);
      params.push(`%${likeEscape(q.q)}%`, `%${likeEscape(q.q)}%`);
    }
    if (q.withBalance === 'true') where.push('balance_lbp > 0');
    if (q.cursor) {
      where.push('id > ?');
      params.push(q.cursor);
    }
    const rows = db
      .prepare(`SELECT * FROM customers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`)
      .all(...params, q.limit + 1) as CustomerRow[];
    const page = rows.slice(0, q.limit);
    return { data: page.map(customerJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  app.post('/customers', user, async (req, reply) => {
    const b = parse(createBody, req.body);
    const id = inWriteTransaction(db, () => {
      const newId = Number(
        db
          .prepare('INSERT INTO customers (name, phone, address, email) VALUES (?, ?, ?, ?)')
          .run(b.name, b.phone ?? null, b.address ?? null, b.email ?? null).lastInsertRowid,
      );
      writeAudit(db, { userId: req.auth.id, action: 'customer.create', entity: 'customer', entityId: newId, after: b });
      return newId;
    });
    return reply.status(201).send(customerJson(getCustomer(db, id)!));
  });

  app.get('/customers/:id', user, async (req) => {
    const c = getCustomer(db, idOf(req));
    if (!c) throw E.notFound('Customer');
    return customerJson(c);
  });

  app.patch('/customers/:id', manager, async (req) => {
    const id = idOf(req);
    const before = getCustomer(db, id);
    if (!before) throw E.notFound('Customer');
    if (before.is_walk_in) throw E.unprocessable('WALK_IN_PROTECTED', 'Walk-In cannot be edited');
    const b = parse(patchBody, req.body);
    const entries = Object.entries(b);
    if (entries.length) {
      inWriteTransaction(db, () => {
        db.prepare(`UPDATE customers SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
          ...entries.map(([, v]) => v),
          id,
        );
        writeAudit(db, {
          userId: req.auth.id,
          action: 'customer.update',
          entity: 'customer',
          entityId: id,
          before: customerJson(before),
          after: b,
        });
      });
    }
    return customerJson(getCustomer(db, id)!);
  });

  app.get('/customers/:id/sales', user, async (req) => {
    const id = idOf(req);
    if (!getCustomer(db, id)) throw E.notFound('Customer');
    const q = parse(pageQuery, req.query);
    const rows = db
      .prepare(`SELECT * FROM sales WHERE customer_id = ? ${q.cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...[id, ...(q.cursor ? [q.cursor] : []), q.limit + 1]) as Parameters<typeof saleSummaryJson>[0][];
    const page = rows.slice(0, q.limit);
    return { data: page.map(saleSummaryJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  // Sales the customer still owes on, oldest first (the order payments are applied in).
  app.get('/customers/:id/open-sales', user, async (req) => {
    const id = idOf(req);
    if (!getCustomer(db, id)) throw E.notFound('Customer');
    const rows = db.prepare('SELECT * FROM sales WHERE customer_id = ? AND rest_lbp > 0 ORDER BY created_at, id').all(id) as Parameters<
      typeof saleSummaryJson
    >[0][];
    return { data: rows.map(saleSummaryJson) };
  });

  app.post('/customers/:id/payments', user, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(customerPaymentBody, req.body);
    const result = receiveCustomerPayment(db, req.auth, idOf(req), body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  // Who owes money (US-33).
  app.get('/reports/receivables', manager, async () => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.phone, c.balance_lbp,
                (SELECT min(created_at) FROM sales s WHERE s.customer_id = c.id AND s.rest_lbp > 0) AS oldest_unpaid_at,
                (SELECT count(*) FROM sales s WHERE s.customer_id = c.id AND s.rest_lbp > 0) AS open_sales
         FROM customers c WHERE c.balance_lbp > 0 ORDER BY c.balance_lbp DESC, c.id`,
      )
      .all() as {
      id: number;
      name: string;
      phone: string | null;
      balance_lbp: number;
      oldest_unpaid_at: string | null;
      open_sales: number;
    }[];
    return {
      data: rows.map((r) => ({
        customerId: r.id,
        name: r.name,
        phone: r.phone,
        balanceLbp: r.balance_lbp,
        oldestUnpaidAt: r.oldest_unpaid_at,
        openSales: r.open_sales,
      })),
      totalOwedLbp: rows.reduce((sum, r) => sum + r.balance_lbp, 0),
    };
  });
}
