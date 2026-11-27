import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import {
  createReceipt,
  createShipment,
  destinations,
  getIncoming,
  listIncoming,
  listReceipts,
  listShipments,
  receiptBody,
  shipmentBody,
} from './service';

/**
 * Moving stock between branches (docs/15 §4, P5b). A branch MANAGER ships and receives; a cashier does not. Shipping needs the branch to be connected to
 * HQ (HQ relays the shipment and tells the branch who the others are), and a sale branch can only send to a stock branch.
 */
export default async function transferRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };

  // Where this branch may send stock, with whether the direction is allowed (a sale branch cannot send to another sale branch).
  app.get('/transfers/destinations', manager, async () => destinations(db));

  app.post('/shipments', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(shipmentBody, req.body);
    const result = await createShipment(db, req.auth, body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/shipments', manager, async (req) => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    return listShipments(db, q);
  });

  // What HQ has relayed to this branch: on the way (to be confirmed), received, or all.
  app.get('/incoming', manager, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['on_the_way', 'received', 'all']).default('on_the_way'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    return listIncoming(db, q.status, q.limit);
  });

  app.get('/incoming/:id', manager, async (req) => getIncoming(db, Number((req.params as { id: string }).id)));

  app.post('/receipts', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(receiptBody, req.body);
    const result = await createReceipt(db, req.auth, body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/receipts', manager, async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    return listReceipts(db, q.limit);
  });
}
