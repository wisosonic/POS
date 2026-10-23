import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BackupService } from '../backup/service';
import type { Db } from '../db/open';
import type { ReceiptPrinter } from '../modules/printing/driver';
import { AppError, E } from '../errors';
import { hasRole, type Role } from './permissions';

export type AuthUser = { id: number; username: string; name: string; role: Role };

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Sends receipts to the USB printer. Replaced by a fake in tests. */
    printer: ReceiptPrinter;
    /** Runs, schedules and reports on database backups. */
    backups: BackupService;
    /** Stop the server so the launcher starts it again (after a restore). Does nothing in tests. */
    requestRestart: () => void;
    /** The server speaks HTTPS: the sign-in cookie is then marked Secure. */
    tls: boolean;
    /** The database file this server owns. */
    dbPath: string;
    /** Where product pictures are kept (content-named files, served at /uploads/<name>). */
    uploadsDir: string;
    /** Every route that was registered. The security test uses it to prove that each one asks for a sign-in. */
    registeredRoutes: { method: string; url: string }[];
    /** preHandler: require a valid access token. Sets `request.auth`. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory: require at least this role. */
    requireRole: (minimum: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AuthUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

/**
 * Authentication decorators. The access token only carries the user id: role and "active" are read from the database
 * on every request, so deactivating a user or changing a role takes effect immediately, not when the token expires.
 */
export default fp<{ db: Db; jwtSecret: string }>(async (app, opts) => {
  app.decorate('db', opts.db);
  await app.register(cookie);
  await app.register(jwt, { secret: opts.jwtSecret, sign: { expiresIn: '15m' } });
  app.decorateRequest('auth', undefined as unknown as AuthUser);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    let sub: string;
    try {
      sub = (await req.jwtVerify<{ sub: string }>()).sub;
    } catch {
      throw E.unauthenticated('Missing, invalid or expired access token');
    }
    const row = opts.db
      .prepare('SELECT id, username, name, role, active, must_reset_password AS reset FROM users WHERE id = ?')
      .get(Number(sub)) as (AuthUser & { active: number; reset: number }) | undefined;
    if (!row || row.active !== 1) throw E.unauthenticated('Account is not active');
    // The admin gave this person a first password: until they choose their own, the only things they can do are ask who they
    // are and change it. (The screen already stops them; this makes the server agree.)
    if (row.reset === 1) {
      const url = req.routeOptions?.url ?? '';
      if (!url.endsWith('/auth/change-password') && !url.endsWith('/me'))
        throw new AppError(403, 'PASSWORD_RESET_REQUIRED', 'Choose your own password before anything else');
    }
    req.auth = { id: row.id, username: row.username, name: row.name, role: row.role };
  });

  app.decorate('requireRole', (minimum: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    if (!hasRole(req.auth.role, minimum)) throw E.forbidden();
  });
});
