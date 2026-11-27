import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addRate, listRates } from './service';

const body = z.object({
  rateLbpPerUsd: z.number().int().min(1).max(100_000_000),
  effectiveFrom: z.iso.datetime().optional(),
});
const json = (r: { id: number; rate_lbp_per_usd: number; effective_from: string; created_at: string }) => ({
  id: r.id,
  rateLbpPerUsd: r.rate_lbp_per_usd,
  effectiveFrom: r.effective_from,
  createdAt: r.created_at,
});

/** The exchange rate for the whole chain: set here, every connected branch receives it (docs/12 §15). HQ staff only. */
export default async function rateRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };
  const edit = { preHandler: app.requireStaff('catalog') };

  app.get('/exchange-rates', view, async () => ({ data: (await listRates(db)).map(json) }));

  app.post('/exchange-rates', edit, async (req, reply) => {
    const b = parse(body, req.body);
    const row = await app.staffTx(req, (tx) =>
      addRate(tx, b.rateLbpPerUsd, b.effectiveFrom ? new Date(b.effectiveFrom).toISOString() : undefined),
    );
    return reply.status(201).send(json(row));
  });
}
