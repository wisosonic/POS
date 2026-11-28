import type { Database } from '../../db/adapter';
import { hashPassword, verifyPassword } from '../../auth/password';
import { AppError, E } from '../../errors';
import { writeAuditQ } from '../audit/service';

// Clock in and clock out (docs/16, P6a-1). The employees come from HQ; this branch records when they punch. The attendance PIN can only do this one
// thing, and is checked here with Argon2id before any transaction opens. A wrong code and a wrong PIN look the same, and failures lock a code.

const LOCK_AFTER = 5; // failures for a code ...
const LOCK_WINDOW_MS = 10 * 60_000; // ... within this long lock it for this long
const DOUBLE_PRESS_MS = 60_000; // a second punch this soon is the same punch

let dummy: Promise<string> | null = null;
/** A real hash to verify against when the code is unknown, so an unknown code costs the same time as a wrong PIN. */
const dummyHash = () => (dummy ??= hashPassword('not-a-real-pin'));

const normalise = (code: string) => code.trim().toUpperCase();

export type PunchResult = { employee: { id: number; code: string; name: string }; kind: 'in' | 'out'; at: string };

export async function punch(db: Database, actorId: number, input: { code: string; pin: string }, now = new Date()): Promise<PunchResult> {
  const code = normalise(input.code);
  const since = new Date(now.getTime() - LOCK_WINDOW_MS).toISOString();
  const failures = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM attendance_failures WHERE code = ? AND at >= ?', [code, since]);
  if ((failures?.n ?? 0) >= LOCK_AFTER)
    throw new AppError(429, 'ATTENDANCE_LOCKED', 'Too many wrong tries for this code. Wait ten minutes, or ask a manager.');

  const emp = await db.one<{ id: number; code: string; name: string; active: number; pin_hash: string | null }>(
    'SELECT id, code, name, active, pin_hash FROM employees WHERE UPPER(code) = ?',
    [code],
  );
  const ok = await verifyPassword(emp?.pin_hash ?? (await dummyHash()), input.pin); // slow: before the transaction
  if (!emp || !emp.pin_hash || emp.active !== 1 || !ok) {
    await db.run('INSERT INTO attendance_failures (code, at) VALUES (?, ?)', [code, now.toISOString()]);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'That code or PIN is not right');
  }

  return db.tx(async (q) => {
    const last = await q.one<{ kind: 'in' | 'out'; created_at: string }>(
      'SELECT kind, created_at FROM attendance_punches WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [emp.id],
    );
    if (last && now.getTime() - Date.parse(last.created_at) < DOUBLE_PRESS_MS)
      throw E.conflict('PUNCHED_JUST_NOW', 'Already clocked a moment ago');
    const kind: 'in' | 'out' = !last || last.kind === 'out' ? 'in' : 'out';
    const at = now.toISOString();
    const made = await q.one<{ id: number }>(
      'INSERT INTO attendance_punches (employee_id, kind, user_id, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      [emp.id, kind, actorId, at],
    );
    await writeAuditQ(q, {
      userId: actorId,
      action: 'attendance.punch',
      entity: 'employee',
      entityId: emp.id,
      after: { kind, punchId: made!.id },
    });
    // A good punch forgives the earlier wrong tries.
    await q.run('DELETE FROM attendance_failures WHERE code = ?', [code]);
    return { employee: { id: emp.id, code: emp.code, name: emp.name }, kind, at };
  });
}

export type TodayRow = {
  employeeId: number;
  code: string;
  name: string;
  active: boolean;
  state: 'in' | 'out' | 'none';
  lastAt: string | null;
};

/** Who is in now and who has gone, from this branch's punches. `since` is the start of today (the caller's shop day). */
export async function today(db: Database, since: string): Promise<TodayRow[]> {
  const rows = await db.all<{ id: number; code: string; name: string; active: number; kind: 'in' | 'out' | null; at: string | null }>(
    `SELECT e.id, e.code, e.name, e.active,
            (SELECT p.kind FROM attendance_punches p WHERE p.employee_id = e.id AND p.created_at >= ? ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS kind,
            (SELECT p.created_at FROM attendance_punches p WHERE p.employee_id = e.id AND p.created_at >= ? ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS at
       FROM employees e ORDER BY e.name, e.id`,
    [since, since],
  );
  return rows.map((r) => ({ employeeId: r.id, code: r.code, name: r.name, active: r.active === 1, state: r.kind ?? 'none', lastAt: r.at }));
}
