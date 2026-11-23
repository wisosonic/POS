import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enrolBranch } from '../branches/service';

const LIMIT = { max: 10, timeWindow: '1 minute' };

/**
 * What a branch server calls (docs/12-sync-and-hq.md §6-7). The branch signs in with its own token (`X-Branch-Token`), never a person's.
 * P2a: connecting and "are you there?". The data both ways comes next (P2b, P2c).
 */
export default async function syncRoutes(app: FastifyInstance) {
  const db = app.database;
  const branch = { preHandler: app.branchOnly };

  // The ONE open door of the sync side: the one-time code (about 49 bits, single use, 30 minutes, rate limited) is the credential,
  // like a sign-in. It answers with the branch's token, once.
  app.post('/sync/enrol', { config: { rateLimit: LIMIT } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(24) }), req.body);
    const done = await db.tx((tx) => enrolBranch(tx, code));
    return { token: done.token, branch: done.branch };
  });

  // "Are you there?" The branch asks every few seconds; the first answer after an outage is the signal to catch up.
  app.get('/sync/ping', branch, async (req) => ({ ok: true, serverTime: new Date().toISOString(), branch: req.branch }));
}
