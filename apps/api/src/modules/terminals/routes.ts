import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../util/validate';
import { getOpenSession } from '../registers/service';
import { createTerminal, enrolTerminal, listTerminals, newEnrolCodeFor, revokeTerminal, updateTerminal } from './service';

const LIMIT = { max: 10, timeWindow: '1 minute' };

const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use letters, digits, dash or underscore')
    .optional(),
  warehouseId: z.number().int().positive().nullish(),
});
const patchBody = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() });
const enrolBody = z.object({ code: z.string().trim().min(6).max(24) });

export default async function terminalRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };
  const admin = { preHandler: app.requireRole('admin') };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/terminals', manager, async () => ({ data: await listTerminals(db) }));

  // Which till is this device? The screen asks once at start-up (and shows its name in the header).
  app.get('/terminals/me', { preHandler: [app.authenticate, app.withTerminal] }, async (req) => {
    const t = req.terminal;
    const session = await getOpenSession(db, t.code);
    return { id: t.id, code: t.code, name: t.name, branchId: t.branchId, warehouseId: t.warehouseId, openSessionId: session?.id ?? null };
  });

  app.post('/terminals', admin, async (req, reply) => {
    const b = parse(createBody, req.body);
    const created = await db.tx((tx) => createTerminal(tx, req.auth.id, b));
    return reply.status(201).send({ terminal: created.terminal, enrolCode: created.enrolCode, expiresAt: created.expiresAt });
  });

  app.patch('/terminals/:id', admin, async (req) => {
    const b = parse(patchBody, req.body);
    await db.tx((tx) => updateTerminal(tx, req.auth.id, idOf(req), b));
    return { data: (await listTerminals(db)).find((t) => t.id === idOf(req)) };
  });

  // A fresh one-time code, for enrolling this till again or on another device.
  app.post('/terminals/:id/enrol-code', admin, async (req) => {
    const issued = await db.tx((tx) => newEnrolCodeFor(tx, req.auth.id, idOf(req)));
    return { enrolCode: issued.code, expiresAt: issued.expiresAt };
  });

  // The admin, signed in on the till itself, types the code the screen showed. The answer carries the device token, once.
  app.post('/terminals/enrol', { ...admin, config: { rateLimit: LIMIT } }, async (req) => {
    const b = parse(enrolBody, req.body);
    const done = await db.tx((tx) => enrolTerminal(tx, req.auth.id, b.code));
    return { token: done.token, terminal: done.terminal };
  });

  // Lost or replaced device: its token stops working at once and the till must enrol again.
  app.post('/terminals/:id/revoke', admin, async (req, reply) => {
    await db.tx((tx) => revokeTerminal(tx, req.auth.id, idOf(req)));
    return reply.status(204).send();
  });
}
