import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors';
import { resolveTerminal, TERMINAL_HEADER } from '../terminals/service';

/**
 * `GET /ping` (docs/14-connection-and-till-backend.md §3): the till's heartbeat and its change detector in one small call. The answer
 * has no business data: whether the server is up, its clock, its `epoch`, and one version number per topic. A till that cannot get an
 * answer stops selling; one that sees a different number fetches that topic.
 *
 * It is not an open door (rule 19): it needs a **device token** (`X-Terminal-Token`) that belongs to an active till, because the till
 * pings before anyone has signed in. There is no legacy "no token" shortcut here: a till that is to be watched must be enrolled.
 */
export default async function pingRoutes(app: FastifyInstance) {
  app.get(
    '/ping',
    {
      preHandler: async (req) => {
        const raw = req.headers[TERMINAL_HEADER];
        if (typeof raw !== 'string' || !raw) throw new AppError(401, 'TERMINAL_REQUIRED', 'A till must send its device token to ping');
        req.terminal = await resolveTerminal(app.database, raw);
      },
    },
    async () => ({ ok: true, serverTime: new Date().toISOString(), epoch: app.versions.epoch, versions: app.versions.snapshot() }),
  );
}
