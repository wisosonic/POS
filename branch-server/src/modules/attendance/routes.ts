import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { shopDayStart } from '../../util/time';
import { parse } from '../../util/validate';
import { punch, today } from './service';

/** Clock in and out at this branch (docs/16, P6a-1). Guarded like every route: the person at the till or browser is signed in and the employee clocks beside them. */
export default async function attendanceRoutes(app: FastifyInstance) {
  const db = app.database;

  app.post('/attendance/punch', { preHandler: app.authenticate }, async (req, reply) => {
    const b = parse(z.object({ code: z.string().trim().min(1).max(20), pin: z.string().regex(/^\d{4,8}$/) }), req.body);
    return reply.status(201).send(await punch(db, req.auth.id, b));
  });

  // Who is in now (a manager's view): each assigned employee's last punch since the start of the shop's day.
  app.get('/attendance/today', { preHandler: app.requireRole('manager') }, async () => ({
    data: await today(db, shopDayStart().toISOString()),
  }));
}
