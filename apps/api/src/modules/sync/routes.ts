import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../util/validate';
import { enrolAtHq, normaliseHqUrl } from './hqClient';
import { clearLink, getLink, saveLink } from './service';

const connectBody = z.object({ url: z.string().trim().min(1).max(300), code: z.string().trim().min(6).max(24) });

/**
 * Connecting this branch to HQ (Settings > HQ, admin only). The branch token HQ hands back is stored but NEVER returned, logged or
 * audited: the status answer only says whether the link works.
 */
export default async function syncRoutes(app: FastifyInstance) {
  const db = app.database;
  const admin = { preHandler: app.requireRole('admin') };

  const statusJson = async () => {
    const link = await getLink(db);
    const s = app.sync.status();
    return {
      linked: link !== null,
      hqUrl: link?.hqUrl ?? null,
      branch: link ? { code: link.branch.code, name: link.branch.name } : null,
      connectedAt: link?.connectedAt ?? null,
      state: s.state,
      since: s.since,
      lastOkAt: link?.lastOkAt ?? null,
      lastError: s.lastError ?? link?.lastError ?? null,
    };
  };

  app.get('/sync/status', admin, statusJson);

  // The admin types HQ's address and the one-time code HQ showed. The branch trades the code for its token, and the loop starts at once.
  app.post('/sync/connect', admin, async (req) => {
    const b = parse(connectBody, req.body);
    const hqUrl = normaliseHqUrl(b.url);
    const done = await enrolAtHq(hqUrl, b.code); // the network call is made BEFORE the transaction
    await db.tx((tx) => saveLink(tx, req.auth.id, hqUrl, done.token, done.branch));
    app.sync.nudge();
    return statusJson();
  });

  // Back to working on its own. HQ keeps what it already has; this branch just stops talking to it.
  app.post('/sync/disconnect', admin, async (req) => {
    await db.tx((tx) => clearLink(tx, req.auth.id));
    app.sync.nudge();
    return statusJson();
  });
}
