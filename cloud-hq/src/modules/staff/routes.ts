import { AppError } from '@pos/core/errors';
import { parse } from '@pos/core/validate';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../auth/password';
import {
  checkPassword,
  createUser,
  endSession,
  getUser,
  isRole,
  listUsers,
  login,
  MAX_PASSWORD,
  normaliseUsername,
  setPassword,
  updateUser,
  USERNAME,
  userJson,
} from './users';

const role = z.string().refine(isRole, 'The role must be viewer, catalog or admin') as unknown as z.ZodType<'viewer' | 'catalog' | 'admin'>;
const idParam = z.object({ id: z.coerce.number().int().min(1) });
const LOGIN_LIMIT = { max: 10, timeWindow: '1 minute' };

/**
 * HQ staff sign-in and the people who may sign in (docs/12 §21, P3d). `POST /auth/login` is the ONE new open door (its credential is the name
 * and password; rate limited, and five wrong passwords lock the account for 15 minutes). Everything else asks for a session token.
 */
export default async function staffRoutes(app: FastifyInstance) {
  const db = app.database;
  // A person who must still choose their own password may do these three things and nothing else.
  const anyone = { preHandler: app.requireStaff('viewer', { allowReset: true }) };
  const admin = { preHandler: app.requireStaff('admin') };
  const bearer = (header: string | undefined) => (header?.startsWith('Bearer ') ? header.slice(7) : '');

  app.post('/auth/login', { config: { rateLimit: LOGIN_LIMIT } }, async (req) => {
    const b = parse(z.object({ username: z.string().max(80), password: z.string().max(MAX_PASSWORD) }), req.body);
    return login(db, b.username, b.password);
  });

  app.post('/auth/logout', anyone, async (req, reply) => {
    if (req.staff.id !== null) await db.tx((tx) => endSession(tx, bearer(req.headers.authorization)));
    return reply.status(204).send();
  });

  app.get('/auth/me', anyone, async (req) => ({
    id: req.staff.id,
    username: req.staff.username,
    name: req.staff.name,
    role: req.staff.role,
    mustResetPassword: req.staff.mustResetPassword,
  }));

  // Change your own password. Needs the current one; every session is closed, and a fresh one comes back so the person stays signed in.
  app.post('/auth/password', anyone, async (req) => {
    const b = parse(z.object({ current: z.string().max(MAX_PASSWORD), password: z.string().max(MAX_PASSWORD) }), req.body);
    if (req.staff.id === null)
      throw new AppError(403, 'TOKEN_HAS_NO_PASSWORD', 'The HQ token is not a person: it has no password to change');
    checkPassword(b.password);
    if (b.password === b.current) throw new AppError(422, 'WEAK_PASSWORD', 'Choose a different password from the one you have');
    const row = await db.one<{ password_hash: string }>('SELECT password_hash FROM hq_users WHERE id = ?', [req.staff.id]);
    if (!row || !(await verifyPassword(row.password_hash, b.current)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'The current password is wrong');
    const hash = await hashPassword(b.password);
    await app.staffTx(req, (tx) => setPassword(tx, req.staff.id!, hash, false, 'user.password.change'));
    return login(db, req.staff.username, b.password);
  });

  app.get('/users', admin, async () => ({ data: (await listUsers(db)).map(userJson) }));

  // The admin chooses a first password; the person must replace it before doing anything else (the server enforces that: PASSWORD_RESET_REQUIRED).
  app.post('/users', admin, async (req, reply) => {
    const b = parse(
      z.object({ username: z.string().max(80), name: z.string().trim().min(1).max(120), role, password: z.string().max(MAX_PASSWORD) }),
      req.body,
    );
    const username = normaliseUsername(b.username);
    if (!USERNAME.test(username))
      throw new AppError(
        422,
        'VALIDATION',
        'The user name has 3 to 40 characters: letters, digits, dot, dash and underscore, starting with a letter or digit',
      );
    checkPassword(b.password);
    const passwordHash = await hashPassword(b.password); // slow: before the transaction
    const row = await app.staffTx(req, (tx) => createUser(tx, { username, name: b.name, role: b.role, passwordHash, mustReset: true }));
    return reply.status(201).send(userJson(row));
  });

  app.patch('/users/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120), role, active: z.boolean() }).partial(), req.body);
    return userJson(await app.staffTx(req, (tx) => updateUser(tx, id, b)));
  });

  app.post('/users/:id/password', admin, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ password: z.string().max(MAX_PASSWORD) }), req.body);
    checkPassword(b.password);
    if (!(await getUser(db, id))) throw new AppError(404, 'NOT_FOUND', 'No such user');
    const hash = await hashPassword(b.password);
    await app.staffTx(req, (tx) => setPassword(tx, id, hash, true, 'user.password.reset'));
    return reply.status(204).send();
  });
}
