import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import { parseQtyMilli } from '@pos/shared/money';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  cancelOrder,
  closeOrder,
  createOrder,
  listOrders,
  orderJson,
  payables,
  payOrder,
  placeOrder,
  replaceDraft,
  type OrderInput,
} from './service';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');
const orderBody = z.object({
  supplierId: z.number().int().positive().nullish(),
  currency: z.enum(['USD', 'LBP']),
  note: z.string().trim().max(300).nullish(),
  lines: z
    .array(
      z.object({
        stockBranchId: z.number().int().positive(),
        productId: z.number().int().positive(),
        qty,
        unitCostMinor: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});
const idParam = z.object({ id: z.coerce.number().int().min(1) });

const toInput = (b: z.infer<typeof orderBody>): OrderInput => ({
  supplierId: b.supplierId ?? null,
  currency: b.currency,
  note: b.note ?? null,
  lines: b.lines.map((l) => ({
    stockBranchId: l.stockBranchId,
    productId: l.productId,
    qtyMilli: parseQtyMilli(l.qty),
    unitCostMinor: l.unitCostMinor,
  })),
});

/**
 * Central purchasing (docs/15 §6, P5d): HQ's orders to suppliers, delivered to stock branches. Anyone on HQ's staff reads; the catalog role makes and
 * places orders; paying a supplier is for an admin.
 */
export default async function purchasingRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };
  const edit = { preHandler: app.requireStaff('catalog') };
  const admin = { preHandler: app.requireStaff('admin') };

  app.get('/purchase-orders', view, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['all', 'draft', 'ordered', 'closed', 'cancelled']).default('all'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return { data: await listOrders(db, q) };
  });

  app.get('/purchase-orders/:id', view, async (req) => orderJson(db, parse(idParam, req.params).id));

  app.post('/purchase-orders', edit, async (req, reply) => {
    const input = toInput(parse(orderBody, req.body));
    const id = await app.staffTx(req, (tx) => createOrder(tx, input));
    return reply.status(201).send(await orderJson(db, id));
  });

  app.patch('/purchase-orders/:id', edit, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = toInput(parse(orderBody, req.body));
    await app.staffTx(req, (tx) => replaceDraft(tx, id, input));
    return orderJson(db, id);
  });

  app.post('/purchase-orders/:id/order', edit, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => placeOrder(tx, id));
    return orderJson(db, id);
  });

  app.post('/purchase-orders/:id/cancel', edit, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => cancelOrder(tx, id));
    return orderJson(db, id);
  });

  app.post('/purchase-orders/:id/close', edit, async (req) => {
    const { id } = parse(idParam, req.params);
    await app.staffTx(req, (tx) => closeOrder(tx, id));
    return orderJson(db, id);
  });

  // Pay the supplier on an order, in part or in full. The same `Idempotency-Key` is the same payment.
  app.post('/purchase-orders/:id/payments', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ amountMinor: z.number().int().min(1), note: z.string().trim().max(200).nullish() }), req.body);
    const header = req.headers['idempotency-key'];
    const key = typeof header === 'string' && header.length > 0 && header.length <= 100 ? header : null;
    if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header, so a repeated request is one payment');
    const fresh = await app.staffTx(req, (tx) => payOrder(tx, id, b.amountMinor, b.note ?? null, key));
    if (!fresh) void reply.header('Idempotent-Replay', 'true');
    return reply.status(fresh ? 201 : 200).send(await orderJson(db, id));
  });

  app.get('/reports/payables', view, async () => payables(db));
}
