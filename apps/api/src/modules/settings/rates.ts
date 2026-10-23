import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inWriteTransaction } from '../../db/open';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { currentRate } from './context';

const createBody = z.object({
  rateLbpPerUsd: z.number().int().min(1).max(100_000_000),
  /** When the rate starts to apply. Defaults to now. Existing sales always keep the rate they were made at. */
  effectiveFrom: z.iso.datetime().optional(),
});

type Row = { id: number; rate_lbp_per_usd: number; effective_from: string; created_by: number | null; created_at: string };

const json = (r: Row) => ({
  id: r.id,
  rateLbpPerUsd: r.rate_lbp_per_usd,
  effectiveFrom: r.effective_from,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export default async function rateRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/exchange-rates/current', { preHandler: app.authenticate }, async () => {
    const rate = currentRate(db);
    const row = db
      .prepare(
        'SELECT effective_from FROM exchange_rates WHERE rate_lbp_per_usd = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1',
      )
      .get(rate, new Date().toISOString()) as { effective_from: string };
    return { rateLbpPerUsd: rate, effectiveFrom: row.effective_from };
  });

  app.get('/exchange-rates', { preHandler: app.requireRole('admin') }, async () => ({
    data: (db.prepare('SELECT * FROM exchange_rates ORDER BY effective_from DESC, id DESC LIMIT 200').all() as Row[]).map(json),
  }));

  app.post('/exchange-rates', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const b = parse(createBody, req.body);
    const before = currentRate(db);
    const effectiveFrom = b.effectiveFrom ? new Date(b.effectiveFrom).toISOString() : new Date().toISOString();
    const id = inWriteTransaction(db, () => {
      const newId = Number(
        db
          .prepare('INSERT INTO exchange_rates (rate_lbp_per_usd, effective_from, created_by) VALUES (?, ?, ?)')
          .run(b.rateLbpPerUsd, effectiveFrom, req.auth.id).lastInsertRowid,
      );
      writeAudit(db, {
        userId: req.auth.id,
        action: 'exchange-rate.create',
        entity: 'exchange-rate',
        entityId: newId,
        before: { rateLbpPerUsd: before },
        after: { rateLbpPerUsd: b.rateLbpPerUsd, effectiveFrom },
      });
      return newId;
    });
    return reply.status(201).send(json(db.prepare('SELECT * FROM exchange_rates WHERE id = ?').get(id) as Row));
  });
}
