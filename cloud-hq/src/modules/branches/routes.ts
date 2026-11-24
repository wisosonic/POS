import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createBranch, listBranches, newEnrolCodeFor, revokeBranch, updateBranch } from './service';

const createBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,8}$/, 'Use 1 to 8 letters or digits'),
  name: z.string().trim().min(1).max(100),
});
const patchBody = z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() });

/** Managing branches: HQ staff only (interim: the HQ admin token; HQ users come with P3). */
export default async function branchRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.adminOnly };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  app.get('/branches', admin, async () => ({ data: await listBranches(db) }));

  // The one-time code is shown here once; the branch's admin types it at the branch (Settings > HQ).
  app.post('/branches', admin, async (req, reply) => {
    const b = parse(createBody, req.body);
    const created = await db.tx((tx) => createBranch(tx, b));
    return reply.status(201).send({ branch: created.branch, enrolCode: created.enrolCode, expiresAt: created.expiresAt });
  });

  app.patch('/branches/:id', admin, async (req) => {
    const b = parse(patchBody, req.body);
    await db.tx((tx) => updateBranch(tx, idOf(req), b));
    return { data: (await listBranches(db)).find((x) => x.id === idOf(req)) };
  });

  app.post('/branches/:id/enrol-code', admin, async (req) => {
    const issued = await db.tx((tx) => newEnrolCodeFor(tx, idOf(req)));
    return { enrolCode: issued.code, expiresAt: issued.expiresAt };
  });

  // The branch's token stops working at once; it has to connect again with a new code.
  app.post('/branches/:id/revoke', admin, async (req, reply) => {
    await db.tx((tx) => revokeBranch(tx, idOf(req)));
    return reply.status(204).send();
  });
}
