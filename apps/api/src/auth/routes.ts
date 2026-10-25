import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError, E } from '../errors';
import { parse } from '../util/validate';
import { writeAudit } from '../modules/audit/service';
import { issueApproval } from './approvals';
import { capabilitiesFor, hasRole } from './permissions';
import { hashPassword, verifyPassword } from './password';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
  consumeRefreshToken,
  issueRefreshToken,
  lockoutRemainingSeconds,
  publicUser,
  recordAttempt,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  type UserRow,
} from './sessions';

// Per-IP limit on credential endpoints (active in production; account lockout applies everywhere).
const LIMIT = { max: 10, timeWindow: '1 minute' };
const COOKIE = 'pos_refresh';
const COOKIE_PATH = '/api/v1/auth';

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) });
const pinBody = z.object({ userId: z.number().int().positive(), pin: z.string().regex(/^\d{4,8}$/) });
const approver = { username: z.string().min(1).max(64), password: z.string().min(1).max(256) };
const approveBody = z.discriminatedUnion('scope', [
  z.object({
    ...approver,
    scope: z.literal('discount'),
    /** The discount the manager is being shown, as a percent of the sale. The approval covers up to this much and no more. */
    pct: z.number().min(0).max(100),
  }),
  z.object({
    ...approver,
    scope: z.literal('return'),
    /** The sale the goods come back from, and the value the manager is being shown. The approval covers that sale and up to that value. */
    saleId: z.number().int().positive(),
    maxLbp: z.number().int().positive(),
  }),
  z.object({
    ...approver,
    scope: z.literal('void'),
    /** The sale the manager is being shown and agrees to cancel. */
    saleId: z.number().int().positive(),
  }),
  z.object({
    ...approver,
    scope: z.literal('delete'),
    /** The sale the manager is being shown and agrees to delete for good. */
    saleId: z.number().int().positive(),
  }),
  z.object({
    ...approver,
    scope: z.literal('price'),
    /** The product and the unit price (whole LBP) the manager is being shown. The approval covers that price for that product and no other. */
    productId: z.number().int().positive(),
    priceLbp: z.number().int().min(0),
  }),
]);
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(8).max(256) });

const SELECT_USER = 'SELECT id, username, name, role, password_hash, pin_hash, active, must_reset_password FROM users';

export default async function authRoutes(app: FastifyInstance) {
  const db = app.db;
  const secureCookie = app.tls || process.env.COOKIE_SECURE === 'true';

  // Used so that "unknown user" takes as long as "wrong password": the response never reveals which usernames exist.
  let dummyHash: string | undefined;
  const timingHash = async () => (dummyHash ??= await hashPassword('timing-equalizer-not-a-real-password'));

  const locked = (seconds: number) =>
    new AppError(423, 'LOCKED', `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`, {
      retryAfterSeconds: seconds,
    });
  const invalid = () => E.unauthenticated('Invalid credentials');

  function startSession(reply: FastifyReply, user: UserRow) {
    const accessToken = app.jwt.sign({ sub: String(user.id) });
    const { token, expiresAt } = issueRefreshToken(db, user.id);
    void reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      path: COOKIE_PATH,
      expires: expiresAt,
      maxAge: REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, user: publicUser(user) };
  }

  app.post('/login', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    const { username, password } = parse(loginBody, req.body);
    const key = username.toLowerCase();
    const wait = lockoutRemainingSeconds(db, key);
    if (wait > 0) throw locked(wait);

    const user = db.prepare(`${SELECT_USER} WHERE username = ?`).get(username) as UserRow | undefined;
    const ok = await verifyPassword(user?.password_hash ?? (await timingHash()), password);
    if (!user || user.active !== 1 || !ok) {
      recordAttempt(db, key, false);
      throw invalid();
    }
    recordAttempt(db, key, true);
    return startSession(reply, user);
  });

  // Quick cashier switch at the till (US-25). Same lockout rules, tracked per user.
  app.post('/pin', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    const { userId, pin } = parse(pinBody, req.body);
    const key = `pin:${userId}`;
    const wait = lockoutRemainingSeconds(db, key);
    if (wait > 0) throw locked(wait);

    const user = db.prepare(`${SELECT_USER} WHERE id = ?`).get(userId) as UserRow | undefined;
    const ok = await verifyPassword(user?.pin_hash ?? (await timingHash()), pin);
    // A PIN is a short secret, so it only opens a cashier's session (US-25). A manager or admin signs in with a password,
    // even if a PIN was left on the account.
    if (!user || user.active !== 1 || user.role !== 'cashier' || !user.pin_hash || !ok) {
      recordAttempt(db, key, false);
      throw invalid();
    }
    recordAttempt(db, key, true);
    return startSession(reply, user);
  });

  // A manager types their name and password at the cashier's till to allow one thing the cashier may not do alone (US-09).
  // Not a PIN: a short secret must not carry a manager's authority (docs/08-security-review.md). The cashier stays signed
  // in; the answer is a token that works once, for this cashier only, for a few minutes.
  app.post('/approve', { preHandler: app.authenticate, config: { rateLimit: LIMIT } }, async (req) => {
    const body = parse(approveBody, req.body);
    const { username, password } = body;
    // Counted apart from sign-in, so a cashier guessing here cannot lock the manager out of signing in.
    const key = `approve:${username.toLowerCase()}`;
    const wait = lockoutRemainingSeconds(db, key);
    if (wait > 0) throw locked(wait);

    const manager = db.prepare(`${SELECT_USER} WHERE username = ?`).get(username) as UserRow | undefined;
    const ok = await verifyPassword(manager?.password_hash ?? (await timingHash()), password);
    // The same answer whether the name is wrong, the password is wrong, or the person is not a manager.
    if (!manager || manager.active !== 1 || !ok || !hasRole(manager.role, 'manager')) {
      recordAttempt(db, key, false);
      throw E.unauthenticated('That manager name and password were not accepted');
    }
    recordAttempt(db, key, true);

    if (
      (body.scope === 'return' || body.scope === 'void' || body.scope === 'delete') &&
      !db.prepare('SELECT 1 FROM sales WHERE id = ?').get(body.saleId)
    )
      throw E.notFound('Sale');
    if (body.scope === 'price' && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(body.productId)) throw E.notFound('Product');
    const grant =
      body.scope === 'discount'
        ? ({ scope: 'discount', maxPct: body.pct } as const)
        : body.scope === 'return'
          ? ({ scope: 'return', saleId: body.saleId, maxLbp: body.maxLbp } as const)
          : body.scope === 'void'
            ? ({ scope: 'void', saleId: body.saleId } as const)
            : body.scope === 'delete'
              ? ({ scope: 'delete', saleId: body.saleId } as const)
              : ({ scope: 'price', productId: body.productId, priceLbp: body.priceLbp } as const);
    const { token, expiresAt } = issueApproval(db, { requestedBy: req.auth.id, approvedBy: manager.id, ...grant });
    writeAudit(db, {
      userId: req.auth.id,
      action: 'approval.grant',
      entity: 'user',
      entityId: req.auth.id,
      after: { ...grant, approvedBy: manager.id, approvedByName: manager.name },
    });
    return { approvalToken: token, expiresAt, ...grant, approvedBy: { id: manager.id, name: manager.name } };
  });

  app.post('/refresh', { config: { rateLimit: LIMIT } }, async (req, reply) => {
    const token = req.cookies[COOKIE];
    const fail = () => {
      void reply.clearCookie(COOKIE, { path: COOKIE_PATH });
      return E.unauthenticated('Session expired. Please sign in again.');
    };
    if (!token) throw fail();
    const result = consumeRefreshToken(db, token);
    if (result === 'invalid' || result === 'reused') throw fail();
    const user = db.prepare(`${SELECT_USER} WHERE id = ?`).get(result.userId) as UserRow | undefined;
    if (!user || user.active !== 1) throw fail();
    return startSession(reply, user);
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) revokeRefreshToken(db, token);
    void reply.clearCookie(COOKIE, { path: COOKIE_PATH });
    return reply.status(204).send();
  });

  app.post('/change-password', { preHandler: app.authenticate }, async (req, reply) => {
    const { currentPassword, newPassword } = parse(changePasswordBody, req.body);
    const user = db.prepare(`${SELECT_USER} WHERE id = ?`).get(req.auth.id) as UserRow;
    if (!(await verifyPassword(user.password_hash, currentPassword))) throw E.unauthenticated('Current password is incorrect');
    if (newPassword === currentPassword) throw E.validation('The new password must be different');

    const newHash = await hashPassword(newPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(newHash, user.id);
      revokeAllRefreshTokens(db, user.id); // every other session must sign in again
      writeAudit(db, { userId: user.id, action: 'user.password.change', entity: 'user', entityId: user.id });
    }).immediate();

    // Keep this device signed in with a fresh session.
    return startSession(reply, db.prepare(`${SELECT_USER} WHERE id = ?`).get(user.id) as UserRow);
  });
}

export function meRoute(app: FastifyInstance) {
  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const row = app.db.prepare('SELECT must_reset_password m FROM users WHERE id = ?').get(req.auth.id) as { m: number };
    return { user: { ...req.auth, mustResetPassword: row.m === 1 }, capabilities: capabilitiesFor(req.auth.role) };
  });
}
