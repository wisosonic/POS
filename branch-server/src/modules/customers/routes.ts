import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param } from '../../db/adapter';
import { E } from '../../errors';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { writeAuditQ } from '../audit/service';
import { saleSummaryJson, type SaleRow } from '../sales/service';
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
  const db = app.database;
  const user = { preHandler: app.authenticate };
  const manager = { preHandler: app.requireRole('manager') };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/customers', user, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = ['deleted_at IS NULL'];
    const params: Param[] = [];
    if (q.q) {
      // LOWER() on both sides keeps the search case-insensitive on every database engine.
      where.push(`(LOWER(name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(phone) LIKE LOWER(?) ESCAPE '\\')`);
      params.push(`%${likeEscape(q.q)}%`, `%${likeEscape(q.q)}%`);
    }
    if (q.withBalance === 'true') where.push('balance_lbp > 0');
    if (q.cursor) {
      where.push('id > ?');
      params.push(q.cursor);
    }
    const rows = await db.all<CustomerRow>(
      `SELECT customers.*, COALESCE((SELECT h.others_lbp FROM customer_chain h WHERE h.customer_id = customers.id), 0) AS others_lbp
         FROM customers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return { data: page.map(customerJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  app.post('/customers', user, async (req, reply) => {
    const b = parse(createBody, req.body);
    const id = await db.tx(async (tx) => {
      const row = await tx.one<{ id: number }>('INSERT INTO customers (name, phone, address, email) VALUES (?, ?, ?, ?) RETURNING id', [
        b.name,
        b.phone ?? null,
        b.address ?? null,
        b.email ?? null,
      ]);
      await writeAuditQ(tx, { userId: req.auth.id, action: 'customer.create', entity: 'customer', entityId: row!.id, after: b });
      return row!.id;
    });
    return reply.status(201).send(customerJson((await getCustomer(db, id))!));
  });

  app.get('/customers/:id', user, async (req) => {
    const c = await getCustomer(db, idOf(req));
    if (!c) throw E.notFound('Customer');
    return customerJson(c);
  });

  app.patch('/customers/:id', manager, async (req) => {
    const id = idOf(req);
    const before = await getCustomer(db, id);
    if (!before) throw E.notFound('Customer');
    if (before.is_walk_in) throw E.unprocessable('WALK_IN_PROTECTED', 'Walk-In cannot be edited');
    const b = parse(patchBody, req.body);
    const entries = Object.entries(b); // keys come from the validated schema above, never from the client's raw body
    if (entries.length) {
      await db.tx(async (tx) => {
        await tx.run(`UPDATE customers SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
          ...entries.map(([, v]) => v as Param),
          id,
        ]);
        await writeAuditQ(tx, {
          userId: req.auth.id,
          action: 'customer.update',
          entity: 'customer',
          entityId: id,
          before: customerJson(before),
          after: b,
        });
      });
    }
    return customerJson((await getCustomer(db, id))!);
  });

  // "Deleting" a customer hides them and keeps the row, because their past sales and payments point at it (history is never
  // rewritten). Not Walk-In, and not someone who still owes money: that debt would vanish from every list.
  app.delete('/customers/:id', manager, async (req, reply) => {
    const id = idOf(req);
    const before = await getCustomer(db, id);
    if (!before) throw E.notFound('Customer');
    if (before.is_walk_in) throw E.unprocessable('WALK_IN_PROTECTED', 'Walk-In cannot be deleted');
    if (before.balance_lbp > 0)
      throw E.unprocessable('CUSTOMER_OWES', 'This customer still owes money. Take their payment (or write it off) before deleting them');
    await db.tx(async (tx) => {
      await tx.run('UPDATE customers SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), id]);
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'customer.delete',
        entity: 'customer',
        entityId: id,
        before: customerJson(before),
      });
    });
    return reply.status(204).send();
  });

  app.get('/customers/:id/sales', user, async (req) => {
    const id = idOf(req);
    if (!(await getCustomer(db, id))) throw E.notFound('Customer');
    const q = parse(pageQuery, req.query);
    const rows = await db.all<SaleRow>(
      `SELECT * FROM sales WHERE customer_id = ? ${q.cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      [id, ...(q.cursor ? [q.cursor] : []), q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return { data: page.map(saleSummaryJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  // Sales the customer still owes on, oldest first (the order payments are applied in).
  app.get('/customers/:id/open-sales', user, async (req) => {
    const id = idOf(req);
    if (!(await getCustomer(db, id))) throw E.notFound('Customer');
    const rows = await db.all<SaleRow>('SELECT * FROM sales WHERE customer_id = ? AND rest_lbp > 0 ORDER BY created_at, id', [id]);
    return { data: rows.map(saleSummaryJson) };
  });

  app.post('/customers/:id/payments', { preHandler: [app.authenticate, app.withTerminal] }, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(customerPaymentBody, req.body);
    const result = await receiveCustomerPayment(db, req.auth, req.terminal, idOf(req), body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  // Who owes money (US-33).
  app.get('/reports/receivables', manager, async () => {
    const rows = await db.all<{
      id: number;
      name: string;
      phone: string | null;
      balance_lbp: number;
      oldest_unpaid_at: string | null;
      open_sales: number;
    }>(
      `SELECT c.id, c.name, c.phone, c.balance_lbp,
                (SELECT min(created_at) FROM sales s WHERE s.customer_id = c.id AND s.rest_lbp > 0) AS oldest_unpaid_at,
                (SELECT count(*) FROM sales s WHERE s.customer_id = c.id AND s.rest_lbp > 0) AS open_sales
         FROM customers c WHERE c.balance_lbp > 0 ORDER BY c.balance_lbp DESC, c.id`,
    );
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
