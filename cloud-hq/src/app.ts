import rateLimit from '@fastify/rate-limit';
import type { Database } from '@pos/core/adapter';
import { safeEqual } from '@pos/core/credentials';
import { AppError, errorHandler, notFoundHandler, problem } from '@pos/core/errors';
import { openDatabase } from '@pos/core/open';
import { createSqliteDatabase } from '@pos/core/sqlite';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import branchRoutes from './modules/branches/routes';
import { resolveBranch, type Branch } from './modules/branches/service';
import syncRoutes from './modules/sync/routes';
import rateRoutes from './modules/rates/routes';
import catalogListRoutes from './modules/catalog/routes';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route that was registered. The security test uses it to prove that each one asks for a sign-in. */
    registeredRoutes: { method: string; url: string }[];
    /** HQ's database through the portable adapter (@pos/core). */
    database: Database;
    /** preHandler: HQ staff only (interim: the HQ admin token). */
    adminOnly: (req: FastifyRequest) => Promise<void>;
    /** preHandler: a connected branch (`X-Branch-Token`). Sets `request.branch`. */
    branchOnly: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    branch: Branch;
  }
}

export const BRANCH_HEADER = 'x-branch-token';

export type CentralOptions = {
  databasePath: string;
  adminToken: string;
  /** Extra host names HQ answers to. */
  allowedHosts?: string[];
  logger?: boolean;
  logStream?: { write(line: string): void };
  /** Per-IP limits on the open door (/sync/enrol). On in production, off by default elsewhere. */
  rateLimit?: boolean;
  production?: boolean;
};

/**
 * The HQ server. The database must already be migrated (db/migrate.ts). It owns its connection and closes it on `close()`.
 * Every route asks for a sign-in: the admin token for staff, a branch token for a branch. The only open doors are `/healthz` and
 * `/sync/enrol` (the one-time code is its credential); `tests/central/security.test.ts` proves it.
 */
export async function buildCentral(options: CentralOptions): Promise<FastifyInstance> {
  if (options.adminToken.length < 24) throw new Error('The HQ admin token must be at least 24 characters');
  const db = openDatabase(options.databasePath);
  const app = Fastify({
    logger: options.logger ? (options.logStream ? { stream: options.logStream } : true) : false,
    trustProxy: false,
  }) as unknown as FastifyInstance;
  const registeredRoutes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });
  app.decorate('registeredRoutes', registeredRoutes);
  app.decorate('database', createSqliteDatabase(db));
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Only answer to this server's own names (and the configured public ones): a web page on the internet can point its own name at
  // this address and then talk to it from someone's browser. Its requests carry that foreign name in Host and Origin.
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(options.allowedHosts ?? [])]);
  const hostOf = (value: string) => {
    try {
      return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  app.addHook('onRequest', async (req, reply) => {
    const host = hostOf(req.headers.host ?? '');
    if (!host || !allowedHosts.has(host))
      return reply
        .status(403)
        .type('application/problem+json')
        .send(problem(403, 'HOST_NOT_ALLOWED', 'This server does not answer to that address'));
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const from = hostOf(origin);
      if (!from || !allowedHosts.has(from))
        return reply
          .status(403)
          .type('application/problem+json')
          .send(problem(403, 'ORIGIN_NOT_ALLOWED', 'Requests from other websites are not accepted'));
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    void reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  });

  if (options.rateLimit ?? options.production) await app.register(rateLimit, { global: false });

  app.decorateRequest('branch', undefined as unknown as Branch);
  app.decorate('adminOnly', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !safeEqual(token, options.adminToken)) throw new AppError(401, 'UNAUTHENTICATED', 'HQ staff sign-in is required');
  });
  app.decorate('branchOnly', async (req: FastifyRequest) => {
    const raw = req.headers[BRANCH_HEADER];
    req.branch = await resolveBranch(app.database, typeof raw === 'string' && raw ? raw : undefined);
  });

  await app.register(
    async (api) => {
      api.get('/healthz', async () => ({ status: 'ok' }));
      await api.register(branchRoutes);
      await api.register(syncRoutes);
      await api.register(rateRoutes);
      await api.register(catalogListRoutes);
    },
    { prefix: '/api/v1' },
  );
  return app;
}
