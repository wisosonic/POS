import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param } from '../../db/adapter';
import { E } from '../../errors';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { writeAuditQ } from '../audit/service';
import { refuseIfHqBuys } from './hqBuys';
import {
  createPurchase,
  getPurchase,
  paySupplier,
  purchaseBody,
  purchaseJson,
  purchasePatchBody,
  receiveBody,
  receivePurchase,
  supplierPaymentBody,
  updatePurchase,
  type PurchaseRow,
} from './service';

const listQuery = z.object({
  status: z.enum(['draft', 'ordered', 'received']).optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export default async function purchaseRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.post('/purchases', manager, async (req, reply) => {
    await refuseIfHqBuys(db);
    const id = await createPurchase(db, req.auth, parse(purchaseBody, req.body));
    return reply.status(201).send(await purchaseJson(db, (await getPurchase(db, id))!));
  });

  app.get('/purchases', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: Param[] = [];
    const add = (sql: string, v: Param | undefined) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('status = ?', q.status);
    add('supplier_id = ?', q.supplierId);
    add('id < ?', q.cursor);
    const rows = await db.all<PurchaseRow>(
      `SELECT * FROM purchases ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const data = [];
    for (const p of page) data.push(await purchaseJson(db, p));
    return { data, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  app.get('/purchases/:id', manager, async (req) => {
    const p = await getPurchase(db, idOf(req));
    if (!p) throw E.notFound('Purchase');
    return purchaseJson(db, p);
  });

  app.patch('/purchases/:id', manager, async (req) => {
    await refuseIfHqBuys(db);
    const id = idOf(req);
    await updatePurchase(db, req.auth, id, parse(purchasePatchBody, req.body));
    return purchaseJson(db, (await getPurchase(db, id))!);
  });

  // Only a draft can be thrown away.
  app.delete('/purchases/:id', manager, async (req, reply) => {
    await refuseIfHqBuys(db);
    const id = idOf(req);
    await db.tx(async (tx) => {
      const p = await getPurchase(tx, id);
      if (!p) throw E.notFound('Purchase');
      if (p.status !== 'draft') throw E.conflict('PURCHASE_NOT_DRAFT', 'Only a draft purchase can be deleted');
      await tx.run('DELETE FROM purchase_items WHERE purchase_id = ?', [id]);
      await tx.run('DELETE FROM purchases WHERE id = ?', [id]);
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'purchase.delete',
        entity: 'purchase',
        entityId: id,
        before: { ref: p.ref, totalMinor: p.total_minor },
      });
    });
    return reply.status(204).send();
  });

  app.post('/purchases/:id/receive', manager, async (req, reply) => {
    await refuseIfHqBuys(db);
    const key = requireIdempotencyKey(req);
    const body = parse(receiveBody, req.body ?? {});
    const id = idOf(req);
    const result = await receivePurchase(db, req.auth, id, body, { key, hash: hashRequest({ id, body: req.body ?? {} }) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });

  app.post('/purchases/:id/payments', manager, async (req, reply) => {
    await refuseIfHqBuys(db);
    const key = requireIdempotencyKey(req);
    const body = parse(supplierPaymentBody, req.body);
    const id = idOf(req);
    const result = await paySupplier(db, req.auth, id, body, { key, hash: hashRequest({ id, body: req.body }) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.replay ? 200 : result.statusCode).send(result.body);
  });

  // What the shop owes its suppliers (US-23): every ordered or received purchase that is not fully paid.
  app.get('/reports/payables', manager, async () => {
    const rows = await db.all<{
      id: number;
      ref: number;
      supplier_id: number | null;
      supplier_name: string | null;
      currency: 'USD' | 'LBP';
      total_minor: number;
      paid_minor: number;
      status: string;
      created_at: string;
    }>(
      `SELECT p.id, p.ref, p.supplier_id, s.name AS supplier_name, p.currency, p.total_minor, p.paid_minor, p.status, p.created_at
         FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.status <> 'draft' AND p.paid_minor < p.total_minor ORDER BY p.created_at, p.id`,
    );
    const totals: Record<'USD' | 'LBP', number> = { USD: 0, LBP: 0 };
    for (const r of rows) totals[r.currency] += r.total_minor - r.paid_minor;
    return {
      data: rows.map((r) => ({
        purchaseId: r.id,
        ref: r.ref,
        supplierId: r.supplier_id,
        supplierName: r.supplier_name,
        currency: r.currency,
        totalMinor: r.total_minor,
        paidMinor: r.paid_minor,
        owedMinor: r.total_minor - r.paid_minor,
        status: r.status,
        createdAt: r.created_at,
      })),
      totalOwed: totals,
    };
  });
}
