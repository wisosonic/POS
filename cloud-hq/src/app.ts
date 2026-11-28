import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { Database } from '@pos/core/adapter';
import { safeEqual } from '@pos/core/credentials';
import type { Queryable } from '@pos/core/adapter';
import { AppError, errorHandler, notFoundHandler, problem } from '@pos/core/errors';
import { openDatabase } from '@pos/core/open';
import { createSqliteDatabase } from '@pos/core/sqlite';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import branchRoutes from './modules/branches/routes';
import { resolveBranch, type Branch } from './modules/branches/service';
import syncRoutes from './modules/sync/routes';
import rateRoutes from './modules/rates/routes';
import catalogListRoutes from './modules/catalog/routes';
import productRoutes from './modules/catalog/productRoutes';
import priceRoutes from './modules/catalog/priceRoutes';
import reportRoutes from './modules/reports/routes';
import purchasingRoutes from './modules/purchasing/routes';
import customerRoutes from './modules/customers/routes';
import { BackupService, type BackupSettings } from './backup/service';
import backupRoutes from './modules/backup/routes';
import monitoringRoutes from './modules/monitoring/routes';
import hrRoutes from './modules/hr/routes';
import payrollRoutes from './modules/payroll/routes';
import scheduleRoutes from './modules/hr/scheduleRoutes';
import payslipRoutes from './modules/payslips/routes';
import supplyRoutes from './modules/supply/routes';
import { asStaff, hasRole, type Capability, type Staff } from './modules/staff/context';
import staffRoutes from './modules/staff/routes';
import { staffOfToken } from './modules/staff/users';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route that was registered. The security test uses it to prove that each one asks for a sign-in. */
    registeredRoutes: { method: string; url: string }[];
    /** HQ's database through the portable adapter (@pos/core). */
    database: Database;
    /**
     * preHandler: a signed-in member of HQ staff with at least this role (viewer < catalog < admin). Sets `request.staff`. A person who still has to
     * choose their own password is stopped (`PASSWORD_RESET_REQUIRED`) unless the route says `allowReset`.
     */
    requireStaff: (min: Capability, opts?: { allowReset?: boolean }) => (req: FastifyRequest) => Promise<void>;
    /** One transaction in which every audit row written says who made the change (staff/context.ts). */
    staffTx: <T>(req: FastifyRequest, fn: (tx: Queryable) => Promise<T>) => Promise<T>;
    /** preHandler: a connected branch (`X-Branch-Token`). Sets `request.branch`. */
    branchOnly: (req: FastifyRequest) => Promise<void>;
    /** The folder product pictures are kept in (named by their content, docs/12 §19). */
    uploadsDir: string;
    /** Backups of HQ's database: scheduled, on demand, and reported (docs/07 §3). */
    backups: BackupService;
  }
  interface FastifyRequest {
    branch: Branch;
    staff: Staff;
  }
}

export const BRANCH_HEADER = 'x-branch-token';

export type CentralOptions = {
  databasePath: string;
  /**
   * A break-glass credential: a long random value that works as an admin, for a first start or an emergency. It is not a person and is audited as
   * `token`. Leave it unset once the admins have accounts (`npm run create-admin`).
   */
  adminToken?: string;
  /** Extra host names HQ answers to. */
  allowedHosts?: string[];
  logger?: boolean;
  logStream?: { write(line: string): void };
  /** Per-IP limits on the open door (/sync/enrol). On in production, off by default elsewhere. */
  rateLimit?: boolean;
  production?: boolean;
  /** Where product pictures are kept (default: `uploads` next to the database). */
  uploadsDir?: string;
  /** The built HQ screen (cloud-hq/web/dist). Without it HQ answers the API only. */
  webDist?: string;
  /** Backups (docs/07 §3). Without a folder there are none. `schedule: false` keeps the timer off (tests). */
  backup?: Omit<BackupSettings, 'uploadsDir'> & { schedule?: boolean };
};

/**
 * The HQ server. The database must already be migrated (db/migrate.ts). It owns its connection and closes it on `close()`.
 * Every route asks for a sign-in: the admin token for staff, a branch token for a branch. The only open doors are `/healthz` and
 * `/sync/enrol` (the one-time code is its credential); `tests/central/security.test.ts` proves it.
 */
export async function buildCentral(options: CentralOptions): Promise<FastifyInstance> {
  if (options.adminToken !== undefined && options.adminToken.length < 24)
    throw new Error('The HQ admin token must be at least 24 characters');
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
  app.decorate('uploadsDir', resolve(options.uploadsDir ?? join(dirname(options.databasePath), 'uploads')));
  const backups = new BackupService(
    db,
    { at: '02:00', keep: 30, ...options.backup, uploadsDir: resolve(options.uploadsDir ?? join(dirname(options.databasePath), 'uploads')) },
    { info: (o, m) => app.log.info(o, m), error: (o, m) => app.log.error(o, m) },
  );
  app.decorate('backups', backups);
  if (options.backup?.schedule !== false) backups.start();
  app.addHook('preClose', async () => backups.stop());
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler(errorHandler);
  // The HQ screen is a single-page app: a page address such as /branches belongs to its router, so a browser asking for it gets the app.
  // The API keeps its JSON 404s.
  const webRoot = options.webDist ? resolve(options.webDist) : undefined;
  const serveWeb = !!webRoot && existsSync(resolve(webRoot, 'index.html'));
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && req.method === 'GET' && !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html'))
      return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
    return notFoundHandler(req, reply);
  });

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
  // The API answers with private data: never cached, never framed, and it may load nothing. A route that needs different headers (the payslip page
  // needs its own inline style) sets them itself and is not overridden. The HQ screen's own files may load scripts and styles from this server only.
  app.addHook('onSend', async (req, reply) => {
    void reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) {
      if (!reply.hasHeader('Cache-Control')) void reply.header('Cache-Control', 'no-store');
      if (!reply.hasHeader('Content-Security-Policy'))
        void reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      return;
    }
    void reply
      .header('Cross-Origin-Opener-Policy', 'same-origin')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
  });

  if (options.rateLimit ?? options.production) await app.register(rateLimit, { global: false });

  app.decorateRequest('branch', undefined as unknown as Branch);
  app.decorateRequest('staff', undefined as unknown as Staff);
  app.decorate('requireStaff', (min: Capability, opts: { allowReset?: boolean } = {}) => async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    let staff: Staff | null = null;
    if (token) {
      staff =
        options.adminToken && safeEqual(token, options.adminToken)
          ? { id: null, username: 'hq-token', name: 'HQ token', role: 'admin', mustResetPassword: false, actor: 'token' }
          : await staffOfToken(app.database, token);
    }
    if (!staff) throw new AppError(401, 'UNAUTHENTICATED', 'HQ staff sign-in is required');
    if (staff.mustResetPassword && !opts.allowReset)
      throw new AppError(403, 'PASSWORD_RESET_REQUIRED', 'Choose your own password first (POST /auth/password)');
    if (!hasRole(staff.role, min)) throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this');
    req.staff = staff;
  });
  app.decorate('staffTx', <T>(req: FastifyRequest, fn: (tx: Queryable) => Promise<T>) => asStaff(app.database, req.staff, fn));
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
      await api.register(productRoutes);
      await api.register(priceRoutes);
      await api.register(staffRoutes);
      await api.register(reportRoutes);
      await api.register(supplyRoutes);
      await api.register(purchasingRoutes);
      await api.register(customerRoutes);
      await api.register(backupRoutes);
      await api.register(monitoringRoutes);
      await api.register(hrRoutes);
      await api.register(payrollRoutes);
      await api.register(scheduleRoutes);
      await api.register(payslipRoutes);
    },
    { prefix: '/api/v1' },
  );
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webRoot!,
      wildcard: false,
      setHeaders(res, path) {
        const immutable = /[\\/]assets[\\/]/.test(path);
        void res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  return app;
}
