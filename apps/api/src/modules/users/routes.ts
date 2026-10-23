import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { E } from '../../errors';
import { hashPassword } from '../../auth/password';
import { revokeAllRefreshTokens } from '../../auth/sessions';
import { inWriteTransaction } from '../../db/open';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';

const role = z.enum(['cashier', 'manager', 'admin']);
const username = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore');
const password = z.string().min(8).max(256);
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');

const createBody = z.object({
  username,
  name: z.string().min(1).max(100),
  role,
  password,
  pin: pin.optional(),
  phone: z.string().max(50).optional(),
  email: z.string().max(100).optional(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(100),
    role,
    active: z.boolean(),
    password,
    pin: pin.nullable(),
    phone: z.string().max(50).nullable(),
    email: z.string().max(100).nullable(),
    mustResetPassword: z.boolean(),
  })
  .partial();

type Row = {
  id: number;
  username: string;
  name: string;
  role: string;
  active: number;
  must_reset_password: number;
  phone: string | null;
  email: string | null;
  pin_hash: string | null;
  created_at: string;
};

// Never include password_hash or pin_hash. Only whether a PIN exists.
const toJson = (u: Row) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  active: u.active === 1,
  mustResetPassword: u.must_reset_password === 1,
  phone: u.phone,
  email: u.email,
  hasPin: u.pin_hash !== null,
  createdAt: u.created_at,
});

const pinCashierOnly = () =>
  E.unprocessable('PIN_CASHIER_ONLY', 'Only cashiers can have a PIN. Managers and admins sign in with their password.');

const COLUMNS = 'id, username, name, role, active, must_reset_password, phone, email, pin_hash, created_at';

export default async function userRoutes(app: FastifyInstance) {
  const db = app.db;
  const admin = { preHandler: app.requireRole('admin') };

  app.get('/users', admin, async () => ({
    data: (db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY username`).all() as Row[]).map(toJson),
  }));

  // Cashiers pick their name on the PIN screen. Names only, no secrets.
  app.get('/users/pin-list', { preHandler: app.authenticate }, async () => ({
    data: db.prepare(`SELECT id, name FROM users WHERE active = 1 AND role = 'cashier' AND pin_hash IS NOT NULL ORDER BY name`).all(),
  }));

  app.post('/users', admin, async (req, reply) => {
    const b = parse(createBody, req.body);
    if (b.pin && b.role !== 'cashier') throw pinCashierOnly();
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username))
      throw E.conflict('USERNAME_TAKEN', 'That username is already in use');
    const passwordHash = await hashPassword(b.password);
    const pinHash = b.pin ? await hashPassword(b.pin) : null;

    const id = inWriteTransaction(db, () => {
      const newId = Number(
        db
          .prepare('INSERT INTO users (username, name, role, password_hash, pin_hash, phone, email) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(b.username, b.name, b.role, passwordHash, pinHash, b.phone ?? null, b.email ?? null).lastInsertRowid,
      );
      writeAudit(db, {
        userId: req.auth.id,
        action: 'user.create',
        entity: 'user',
        entityId: newId,
        after: { username: b.username, name: b.name, role: b.role, hasPin: pinHash !== null },
      });
      return newId;
    });
    return reply.status(201).send(toJson(db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row));
  });

  app.patch('/users/:id', admin, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(patchBody, req.body);
    const before = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row | undefined;
    if (!before) throw E.notFound('User');

    // Safety rail: an admin cannot deactivate or demote their own account. Only admins can edit users, so this also
    // guarantees the shop always keeps at least one active admin.
    const losesAdmin =
      before.role === 'admin' && before.active === 1 && (b.active === false || (b.role !== undefined && b.role !== 'admin'));
    if (losesAdmin && id === req.auth.id) {
      throw E.unprocessable('CANNOT_DEMOTE_SELF', 'You cannot deactivate or demote your own account');
    }

    const roleAfter = b.role ?? before.role;
    if (b.pin && roleAfter !== 'cashier') throw pinCashierOnly();
    // Promoting a cashier takes their PIN away: it must not linger on an account that now has more power.
    const dropPin = b.pin === null || (roleAfter !== 'cashier' && before.pin_hash !== null);

    const passwordHash = b.password ? await hashPassword(b.password) : undefined;
    const pinHash = b.pin ? await hashPassword(b.pin) : undefined;

    inWriteTransaction(db, () => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), vals.push(v));
      if (b.name !== undefined) set('name', b.name);
      if (b.role !== undefined) set('role', b.role);
      if (b.active !== undefined) set('active', b.active ? 1 : 0);
      if (b.phone !== undefined) set('phone', b.phone);
      if (b.email !== undefined) set('email', b.email);
      if (b.mustResetPassword !== undefined) set('must_reset_password', b.mustResetPassword ? 1 : 0);
      if (passwordHash) set('password_hash', passwordHash);
      if (dropPin) set('pin_hash', null);
      else if (pinHash) set('pin_hash', pinHash);
      if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

      // A changed password or a deactivation ends every existing session of that user.
      if (passwordHash || b.active === false) revokeAllRefreshTokens(db, id);

      writeAudit(db, {
        userId: req.auth.id,
        action: 'user.update',
        entity: 'user',
        entityId: id,
        before: { name: before.name, role: before.role, active: before.active === 1 },
        after: {
          ...(b.name !== undefined && { name: b.name }),
          ...(b.role !== undefined && { role: b.role }),
          ...(b.active !== undefined && { active: b.active }),
          ...(passwordHash && { passwordChanged: true }),
          ...(b.pin !== undefined && { pinChanged: true }),
        },
      });
    });
    return toJson(db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row);
  });
}
