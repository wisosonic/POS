import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import { phoneKey } from '@pos/shared/phone';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customersWithoutPhone, listSharedCustomers } from './service';

/** The chain's customers, one person across branches (docs/15 §7, P5e). Read-only for HQ's staff. */
export default async function customerRoutes(app: FastifyInstance) {
  const db = app.database;
  const view = { preHandler: app.requireStaff('viewer') };

  app.get('/customers', view, async (req) => {
    const q = parse(
      z.object({
        q: z.string().trim().max(60).optional(),
        owing: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    return {
      data: await listSharedCustomers(db, { q: q.q || undefined, owing: q.owing === 'true', limit: q.limit }),
      withoutPhone: await customersWithoutPhone(db),
    };
  });

  // One person, by their phone (any way of writing it).
  app.get('/customers/by-phone/:phone', view, async (req) => {
    const key = phoneKey(parse(z.object({ phone: z.string().max(40) }), req.params).phone);
    if (!key) throw new AppError(400, 'VALIDATION', 'That is not a phone number');
    const found = await listSharedCustomers(db, { key, limit: 1 });
    if (found.length === 0) throw new AppError(404, 'NOT_FOUND', 'No customer has that phone number');
    return found[0];
  });
}
