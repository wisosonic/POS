import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listOverrides, overrideJson, overridesOfProduct, removeOverride, setOverride } from './prices';

const ids = z.object({ id: z.coerce.number().int().min(1), productId: z.coerce.number().int().min(1) });
const branchOnly = z.object({ id: z.coerce.number().int().min(1) });
const body = z.object({ priceMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

/**
 * A branch's own price for a product (docs/12 §20): set and removed here, and the branch receives the product at the price it should sell at.
 * HQ staff only. The price is in the product's own currency.
 */
export default async function priceRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.adminOnly };

  app.get('/branches/:id/prices', admin, async (req) => {
    const { id } = parse(branchOnly, req.params);
    return { data: (await listOverrides(db, id)).map(overrideJson) };
  });

  // Every branch that has its own price for this product.
  app.get('/products/:id/prices', admin, async (req) => {
    const { id } = parse(branchOnly, req.params);
    return { data: (await overridesOfProduct(db, id)).map((r) => ({ branchId: r.branch_id, priceMinor: r.price_minor })) };
  });

  app.put('/branches/:id/prices/:productId', admin, async (req) => {
    const { id, productId } = parse(ids, req.params);
    const b = parse(body, req.body);
    const changed = await db.tx((tx) => setOverride(tx, id, productId, b.priceMinor));
    return { branchId: id, productId, priceMinor: b.priceMinor, changed };
  });

  app.delete('/branches/:id/prices/:productId', admin, async (req, reply) => {
    const { id, productId } = parse(ids, req.params);
    await db.tx((tx) => removeOverride(tx, id, productId));
    return reply.status(204).send();
  });
}
