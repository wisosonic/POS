import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open';
import type { Role } from './permissions';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 7;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export type UserRow = {
  id: number;
  username: string;
  name: string;
  role: Role;
  password_hash: string;
  pin_hash: string | null;
  active: number;
  must_reset_password: number;
};

export const publicUser = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  mustResetPassword: u.must_reset_password === 1,
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- refresh tokens (rotating, stored hashed)

export function issueRefreshToken(db: Db, userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    userId,
    sha256(token),
    expiresAt.toISOString(),
  );
  return { token, expiresAt };
}

export type RotateResult = { userId: number } | 'invalid' | 'reused';

/**
 * Exchange a refresh token for a new one. A token can be used once: presenting an already-used token means it
 * may have been stolen, so every session of that user is revoked ("reused").
 */
export function consumeRefreshToken(db: Db, token: string): RotateResult {
  const row = db.prepare('SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?').get(sha256(token)) as
    { id: number; user_id: number; expires_at: string; revoked_at: string | null } | undefined;
  if (!row) return 'invalid';
  if (row.revoked_at) {
    revokeAllRefreshTokens(db, row.user_id);
    return 'reused';
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'invalid';
  db.prepare(`UPDATE refresh_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(row.id);
  return { userId: row.user_id };
}

export function revokeRefreshToken(db: Db, token: string): void {
  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ? AND revoked_at IS NULL`,
  ).run(sha256(token));
}

export function revokeAllRefreshTokens(db: Db, userId: number): void {
  db.prepare(`UPDATE refresh_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND revoked_at IS NULL`).run(
    userId,
  );
}

// ---------------------------------------------------------------- lockout

/**
 * Lockout key is a username for password logins, or "pin:<userId>" for PIN logins.
 * Locked = MAX_FAILED_ATTEMPTS failures since the last success, the latest one less than LOCKOUT_MINUTES ago.
 * Attempts made while locked are not recorded, so the lock does not extend itself.
 * Returns the seconds to wait, or 0 when not locked.
 */
export function lockoutRemainingSeconds(db: Db, key: string, now = Date.now()): number {
  const lastOk = db.prepare('SELECT max(at) at FROM login_attempts WHERE username = ? AND success = 1').get(key) as { at: string | null };
  // Only failures inside the lockout window and after the last success count, so a lock expires cleanly.
  const windowStart = new Date(now - LOCKOUT_MINUTES * 60_000).toISOString();
  const since = lastOk.at && lastOk.at > windowStart ? lastOk.at : windowStart;
  const failures = db
    .prepare('SELECT count(*) n, max(at) last FROM login_attempts WHERE username = ? AND success = 0 AND at > ?')
    .get(key, since) as { n: number; last: string | null };
  if (failures.n < MAX_FAILED_ATTEMPTS || !failures.last) return 0;
  const until = new Date(failures.last).getTime() + LOCKOUT_MINUTES * 60_000;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function recordAttempt(db: Db, key: string, success: boolean): void {
  db.prepare('INSERT INTO login_attempts (username, success) VALUES (?, ?)').run(key, success ? 1 : 0);
}
