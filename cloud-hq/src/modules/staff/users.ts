import type { Queryable } from '@pos/core/adapter';
import { newToken, sha256 } from '@pos/core/credentials';
import { AppError } from '@pos/core/errors';
import { hashPassword, verifyPassword } from '../../auth/password';
import { writeAudit, type Staff, type StaffRole } from './context';

// HQ staff accounts and their sessions (docs/12 §21, P3d). HQ is reachable from the internet, so: Argon2id hashes only; a password of at least 12
// characters; five wrong passwords lock the account for 15 minutes; a wrong name and a wrong password look the same and cost the same time; a
// session is an opaque token shown once and stored only as a hash, so it can be revoked; the last active admin can never be removed. Hashing is
// slow, so it happens BEFORE a transaction is opened (the adapter rolls back a transaction that waits on anything but the database).

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;
export const SESSION_HOURS = 8;
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
const ROLES: StaffRole[] = ['viewer', 'catalog', 'hr', 'payroll', 'admin', 'employee'];
export const isRole = (v: unknown): v is StaffRole => typeof v === 'string' && (ROLES as string[]).includes(v);

const nowIso = () => new Date().toISOString();
const plusMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export type UserRow = {
  id: number;
  username: string;
  name: string;
  role: StaffRole;
  active: number;
  must_reset_password: number;
  last_login_at: string | null;
  created_at: string;
};
export const userJson = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  active: u.active === 1,
  mustResetPassword: u.must_reset_password === 1,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});
const COLUMNS = 'id, username, name, role, active, must_reset_password, last_login_at, created_at';

export const normaliseUsername = (raw: string): string => raw.trim().toLowerCase();
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD)
    throw new AppError(422, 'WEAK_PASSWORD', `The password must have at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) throw new AppError(422, 'WEAK_PASSWORD', `The password can have at most ${MAX_PASSWORD} characters`);
}

// A hash to check against when the name is unknown, so "no such user" takes as long as "wrong password".
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-for-timing'));

export const listUsers = (q: Queryable): Promise<UserRow[]> => q.all<UserRow>(`SELECT ${COLUMNS} FROM hq_users ORDER BY username`);
export const getUser = (q: Queryable, id: number) => q.one<UserRow>(`SELECT ${COLUMNS} FROM hq_users WHERE id = ?`, [id]);

/** Add an account. `passwordHash` is made by the caller BEFORE the transaction. */
export async function createUser(
  q: Queryable,
  b: { username: string; name: string; role: StaffRole; passwordHash: string; mustReset: boolean },
): Promise<UserRow> {
  if (await q.one('SELECT 1 AS x FROM hq_users WHERE username = ?', [b.username]))
    throw new AppError(409, 'DUPLICATE_NAME', `There is already a user called "${b.username}"`);
  const row = (await q.one<{ id: number }>(
    `INSERT INTO hq_users (username, name, role, password_hash, must_reset_password, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [b.username, b.name, b.role, b.passwordHash, b.mustReset ? 1 : 0, nowIso()],
  ))!;
  await writeAudit(q, 'user.create', 'hq-user', row.id, { username: b.username, role: b.role });
  return (await getUser(q, row.id))!;
}

async function activeAdmins(q: Queryable, exceptId: number): Promise<number> {
  return (await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM hq_users WHERE role = 'admin' AND active = 1 AND id <> ?`, [exceptId]))!.n;
}

export async function revokeSessions(q: Queryable, userId: number): Promise<void> {
  await q.run('UPDATE hq_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
}

/** Change a person's name, role or whether they can sign in. Never leaves HQ without an active admin. Deactivating signs them out everywhere. */
export async function updateUser(q: Queryable, id: number, patch: { name?: string; role?: StaffRole; active?: boolean }): Promise<UserRow> {
  const before = await getUser(q, id);
  if (!before) throw new AppError(404, 'NOT_FOUND', 'No such user');
  const role = patch.role ?? before.role;
  const active = patch.active === undefined ? before.active === 1 : patch.active;
  if (before.role === 'admin' && before.active === 1 && (role !== 'admin' || !active) && (await activeAdmins(q, id)) === 0)
    throw new AppError(409, 'LAST_ADMIN', 'HQ must keep at least one active admin');
  const sets: [string, string | number][] = [];
  if (patch.name !== undefined && patch.name !== before.name) sets.push(['name', patch.name]);
  if (role !== before.role) sets.push(['role', role]);
  if (active !== (before.active === 1)) sets.push(['active', active ? 1 : 0]);
  if (sets.length === 0) return before;
  await q.run(`UPDATE hq_users SET ${sets.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`, [...sets.map(([, v]) => v), id]);
  if (!active || role !== before.role) await revokeSessions(q, id); // a changed role or a closed account takes effect at once
  await writeAudit(q, 'user.update', 'hq-user', id, { changed: sets.map(([c]) => c), role, active });
  return (await getUser(q, id))!;
}

/** Set a password (an admin for someone else, or the person for themselves). Signs them out everywhere. `passwordHash` is made BEFORE the transaction. */
export async function setPassword(q: Queryable, id: number, passwordHash: string, mustReset: boolean, action: string): Promise<void> {
  const r = await q.run(
    'UPDATE hq_users SET password_hash = ?, must_reset_password = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [passwordHash, mustReset ? 1 : 0, id],
  );
  if (r.changes === 0) throw new AppError(404, 'NOT_FOUND', 'No such user');
  await revokeSessions(q, id);
  await writeAudit(q, action, 'hq-user', id); // never the password
}

export type LoginResult = { token: string; expiresAt: string; user: ReturnType<typeof userJson> };

/**
 * Check a name and password and open a session. Slow hashing is done here, OUTSIDE any transaction; only short writes follow. A wrong name, a
 * wrong password and a closed account all answer the same way (`INVALID_CREDENTIALS`), so the answer does not say which names exist.
 */
export async function login(
  db: { one: Queryable['one']; tx: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> },
  usernameRaw: string,
  password: string,
): Promise<LoginResult> {
  const username = normaliseUsername(usernameRaw);
  const row = await db.one<UserRow & { password_hash: string; failed_attempts: number; locked_until: string | null }>(
    `SELECT ${COLUMNS}, password_hash, failed_attempts, locked_until FROM hq_users WHERE username = ?`,
    [username],
  );
  if (row?.locked_until && row.locked_until > nowIso())
    throw new AppError(429, 'ACCOUNT_LOCKED', `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes, or ask an admin.`);
  const ok = await verifyPassword(row ? row.password_hash : await dummyHash(), password);
  if (!row || row.active !== 1 || !ok) {
    if (row && row.active === 1) {
      await db.tx(async (tx) => {
        const failed = row.failed_attempts + 1;
        const lock = failed >= MAX_FAILED;
        await tx.run('UPDATE hq_users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [
          lock ? 0 : failed,
          lock ? plusMinutes(LOCK_MINUTES) : null,
          row.id,
        ]);
        if (lock) await writeAudit(tx, 'user.locked', 'hq-user', row.id, { minutes: LOCK_MINUTES });
      });
    }
    throw new AppError(401, 'INVALID_CREDENTIALS', 'The name or the password is wrong');
  }
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString();
  await db.tx(async (tx) => {
    await tx.run('UPDATE hq_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [nowIso(), row.id]);
    await tx.run('INSERT INTO hq_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      sha256(token),
      row.id,
      nowIso(),
      expiresAt,
    ]);
  });
  return { token, expiresAt, user: userJson({ ...row, last_login_at: nowIso() }) };
}

/** The person behind a session token, or null (unknown, expired, signed out, or the account is closed). */
export async function staffOfToken(q: Queryable, token: string): Promise<Staff | null> {
  const r = await q.one<UserRow>(
    `SELECT u.id, u.username, u.name, u.role, u.active, u.must_reset_password, u.last_login_at, u.created_at
     FROM hq_sessions s JOIN hq_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`,
    [sha256(token), nowIso()],
  );
  return r
    ? {
        id: r.id,
        username: r.username,
        name: r.name,
        role: r.role,
        mustResetPassword: r.must_reset_password === 1,
        actor: `user:${r.username}`,
      }
    : null;
}

export async function endSession(q: Queryable, token: string): Promise<void> {
  await q.run('UPDATE hq_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [nowIso(), sha256(token)]);
}
