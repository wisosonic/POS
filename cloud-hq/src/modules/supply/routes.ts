import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getRoutes, setRoutes } from '../facts/routing';

/**
 * Who supplies whom (docs/15 §5): for each SALE branch, the STOCK branches it asks, in order ("nearest first"). Set by an HQ admin; read by anyone
 * on HQ's staff. Changing the list routes the requests that were waiting for one.
 */
export default async function supplyRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };
  const admin = { preHandler: app.requireStaff('admin') };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/branches/:id/supply-routes', view, async (req) => ({ data: await getRoutes(db, idOf(req)) }));

  app.put('/branches/:id/supply-routes', admin, async (req) => {
    const b = parse(z.object({ stockBranchIds: z.array(z.number().int().positive()).max(20) }), req.body);
    await app.staffTx(req, (tx) => setRoutes(tx, idOf(req), b.stockBranchIds));
    return { data: await getRoutes(db, idOf(req)) };
  });
}
