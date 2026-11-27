import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { getDelivery, listDeliveries, receiveBody, receiveDelivery } from './service';

/**
 * Expected deliveries (docs/15 §6, P5d): what HQ bought for this STOCK branch, and receiving it. A manager receives, in whole or in parts.
 */
export default async function deliveryRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };

  app.get('/deliveries', manager, async (req) => {
    const q = parse(
      z.object({ status: z.enum(['open', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    return listDeliveries(db, q.status, q.limit);
  });

  app.get('/deliveries/:id', manager, async (req) => getDelivery(db, Number((req.params as { id: string }).id)));

  app.post('/deliveries/:id/receive', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const id = Number((req.params as { id: string }).id);
    const body = parse(receiveBody, req.body ?? {});
    const result = await receiveDelivery(db, req.auth, id, body, { key, hash: hashRequest({ id, body: req.body ?? {} }) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });
}
