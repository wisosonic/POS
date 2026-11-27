import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashRequest, requireIdempotencyKey } from '../../util/idempotency';
import { parse } from '../../util/validate';
import { createRequest, fillBody, fillPickList, getPickList, listPickLists, listRequests, requestBody, requestJson } from './service';

/**
 * Requests and pick lists (docs/15 §5, P5c). A SHOP's manager asks for items; a STOCK branch's manager fills the pick list HQ sends it. Both need the
 * branch to be connected to HQ (which routes the request and sends the pick list).
 */
export default async function requestRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };

  app.post('/stock-requests', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const body = parse(requestBody, req.body);
    const result = await createRequest(db, req.auth, body, { key, hash: hashRequest(req.body) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });

  app.get('/stock-requests', manager, async (req) => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    return listRequests(db, q);
  });

  app.get('/stock-requests/:id', manager, async (req) => requestJson(db, Number((req.params as { id: string }).id)));

  // What HQ asked this stock branch to pick: open (to fill), answered, or all.
  app.get('/pick-lists', manager, async (req) => {
    const q = parse(
      z.object({ status: z.enum(['open', 'answered', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    return listPickLists(db, q.status, q.limit);
  });

  app.get('/pick-lists/:id', manager, async (req) => getPickList(db, Number((req.params as { id: string }).id)));

  app.post('/pick-lists/:id/fill', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const id = Number((req.params as { id: string }).id);
    const body = parse(fillBody, req.body);
    const result = await fillPickList(db, req.auth, id, body, { key, hash: hashRequest({ id, body: req.body }) });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });
}
