import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_BATCH_ROWS, MAX_CHANGES_PAGE, type Fact } from '@pos/core/sync';
import { enrolBranch } from '../branches/service';
import { applyFacts, changesAfter, tableDigest } from '../facts/service';

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

  // A batch of what the branch recorded (docs/12-sync-and-hq.md §3). Stored with upserts in ONE transaction, so sending it again after a lost
  // answer changes nothing. `branch_id` comes from the token. The answer says how many rows were applied; the branch then clears them.
  const factRow = z.object({
    tbl: z.string().max(40),
    pk: z.number(),
    op: z.enum(['u', 'd']),
    row: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  });
  app.post('/sync/facts', { ...branch, bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const b = parse(z.object({ rows: z.array(factRow).max(MAX_BATCH_ROWS) }), req.body);
    const applied = await db.tx((tx) => applyFacts(tx, req.branch.id, b.rows as Fact[]));
    return { applied };
  });

  // What HQ owns, after a number: the branch applies the page in order and asks again (docs/12 §15).
  app.get('/sync/changes', branch, async (req) => {
    const q = parse(
      z.object({
        cursor: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(MAX_CHANGES_PAGE).default(MAX_CHANGES_PAGE),
      }),
      req.query,
    );
    return changesAfter(db, q.cursor, q.limit);
  });

  // What HQ holds of one table for the calling branch, as a fingerprint (count, highest id, checksum): the branch compares it with its own.
  app.get('/sync/digest', branch, async (req) => {
    const { tbl } = parse(z.object({ tbl: z.string().max(40) }), req.query);
    return { tbl, ...(await tableDigest(db, req.branch.id, tbl)) };
  });

  // "Are you there?" The branch asks every few seconds; the first answer after an outage is the signal to catch up.
  app.get('/sync/ping', branch, async (req) => ({ ok: true, serverTime: new Date().toISOString(), branch: req.branch }));
}
