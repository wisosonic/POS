import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { E } from '../../errors';
import { parse } from '../../util/validate';
import { enrolAgent, markAgentSeen } from '../terminals/service';
import { cancelJob, claimJobs, finishJob, getJob, waitForWake } from './jobs';

const LIMIT = { max: 10, timeWindow: '1 minute' };
/** The longest the server holds a request open waiting for work. Shorter than any proxy's idle timeout. */
const MAX_WAIT_SECONDS = 25;

/**
 * The print agent's three calls, and the till's two calls about a job (docs/06-api-spec.md, "Print agent").
 * The agent signs in with its own token (`X-Agent-Token`), not a user's: it can only fetch and report its own terminal's jobs.
 */
export default async function agentRoutes(app: FastifyInstance) {
  const db = app.database;
  const agent = { preHandler: app.agentOnly };
  const atTerminal = { preHandler: [app.authenticate, app.withTerminal] };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  // The ONE open door of the agent: its one-time code is the credential (about 49 bits, single use, 30 minutes, rate limited), like a
  // sign-in. It answers with the agent's token, once.
  app.post('/agent/enrol', { config: { rateLimit: LIMIT } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(24) }), req.body);
    const done = await db.tx((tx) => enrolAgent(tx, code));
    return { token: done.token, terminal: { code: done.terminal.code, name: done.terminal.name } };
  });

  // Long poll: answers at once if there are jobs, otherwise waits (up to `wait` seconds) for one to be queued.
  app.get('/agent/jobs', agent, async (req) => {
    const { wait } = parse(z.object({ wait: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0) }), req.query);
    const terminalId = req.terminal.id;
    const deadline = Date.now() + wait * 1000;
    // If the agent hangs up while waiting, stop at once. A wait that outlives its client would wake on the next receipt, take the job
    // and send it to nobody, and the receipt would be lost until the job's lease runs out.
    const hungUp = new AbortController();
    const onClose = () => hungUp.abort();
    req.socket.once('close', onClose);
    try {
      await db.tx((tx) => markAgentSeen(tx, terminalId));
      for (;;) {
        if (hungUp.signal.aborted) return { jobs: [] };
        const jobs = await db.tx((tx) => claimJobs(tx, terminalId));
        const left = deadline - Date.now();
        if (jobs.length > 0 || left <= 0) {
          return {
            jobs: jobs.map((j) => ({
              id: j.id,
              kind: j.kind,
              saleId: j.sale_id,
              duplicate: j.duplicate === 1,
              drawer: j.drawer === 1,
              bytes: Buffer.from(j.bytes).toString('base64'),
            })),
          };
        }
        // Woken by a new job, or look again in a few seconds (stale leases, expiry).
        await waitForWake(terminalId, Math.min(left, 5000), hungUp.signal);
      }
    } finally {
      req.socket.off('close', onClose);
    }
  });

  // The agent says whether a job reached the printer. Saying it twice changes nothing.
  app.post('/agent/jobs/:id/result', agent, async (req) => {
    const b = parse(z.object({ ok: z.boolean(), error: z.string().max(300).optional() }), req.body);
    const status = await db.tx((tx) => finishJob(tx, req.terminal.id, idOf(req), b.ok, b.error));
    if (status === null) throw E.notFound('Print job');
    return { status };
  });

  // The till watches a job it queued, so it can say "printed" or offer browser print.
  app.get('/print-jobs/:id', atTerminal, async (req) => {
    const job = await getJob(db, req.terminal.id, idOf(req));
    if (!job) throw E.notFound('Print job');
    return job;
  });

  // The till gives up waiting: a job still queued is cancelled so it cannot print later on top of a browser print.
  app.post('/print-jobs/:id/cancel', atTerminal, async (req) => {
    const job = await db.tx((tx) => cancelJob(tx, req.terminal.id, idOf(req)));
    if (!job) throw E.notFound('Print job');
    return job;
  });
}
