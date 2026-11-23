import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../../db/adapter';
import { AppError, E } from '../../errors';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';
import { defaultWarehouseIdQ } from '../settings/context';

// Terminals (docs/11-multi-branch.md §3.4). A till (browser on a PC or tablet) is a terminal. Each has its own register session
// and may have its own warehouse. A device proves which terminal it is with a token that an admin hands it once, through a short
// one-time enrolment code. Only hashes are stored, and neither the token nor the code is ever logged or audited.

/** The header a till sends with every request. */
export const TERMINAL_HEADER = 'x-terminal-token';
export const ENROL_CODE_MINUTES = 30;

// No 0/O/1/I/L: the code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normaliseCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

function newEnrolCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`; // 10 characters, about 49 bits, good for one use within half an hour
}

type TerminalRow = {
  id: number;
  branch_id: number;
  warehouse_id: number | null;
  code: string;
  name: string;
  token_hash: string | null;
  enrol_hash: string | null;
  enrol_expires_at: string | null;
  enrolled_at: string | null;
  active: number;
  created_at: string;
};

/** What a request handler needs to know about the till it came from. */
export type Terminal = { id: number; code: string; name: string; branchId: number; warehouseId: number | null };

const toTerminal = (r: TerminalRow): Terminal => ({
  id: r.id,
  code: r.code,
  name: r.name,
  branchId: r.branch_id,
  warehouseId: r.warehouse_id,
});

/**
 * Which terminal sent this request.
 * - With a device token: that terminal, if the token belongs to an active one (else 401).
 * - Without one: only in legacy single-till mode, meaning no terminal has been enrolled and exactly one is active (today's shop).
 *   As soon as a till is enrolled, or a second terminal exists, every till must carry its token.
 */
export async function resolveTerminal(q: Queryable, token: string | undefined): Promise<Terminal> {
  if (token) {
    const row = await q.one<TerminalRow>('SELECT * FROM terminals WHERE token_hash = ? AND active = 1', [sha256(token)]);
    if (!row)
      throw new AppError(
        401,
        'TERMINAL_UNKNOWN',
        'This device is not a registered till (or its till was switched off). Ask the admin to set it up again.',
      );
    return toTerminal(row);
  }
  const active = await q.all<TerminalRow>('SELECT * FROM terminals WHERE active = 1 ORDER BY id');
  const anyEnrolled = (await q.one('SELECT 1 FROM terminals WHERE token_hash IS NOT NULL LIMIT 1')) !== undefined;
  if (active.length === 1 && !anyEnrolled) return toTerminal(active[0]!);
  throw new AppError(
    400,
    'TERMINAL_REQUIRED',
    'This device is not set up as a till. Ask the admin for an enrolment code (Menu → Terminals).',
  );
}

/** The warehouse this terminal sells from: its own, or the shop's first one. */
export async function warehouseOf(q: Queryable, t: Terminal): Promise<number> {
  return t.warehouseId ?? (await defaultWarehouseIdQ(q));
}

// ------------------------------------------------------------------ administration

export type TerminalListItem = {
  id: number;
  code: string;
  name: string;
  branch: { id: number; code: string; name: string };
  warehouseId: number | null;
  active: boolean;
  enrolled: boolean;
  enrolledAt: string | null;
  enrolPending: boolean;
  openSessionId: number | null;
};

export async function listTerminals(q: Queryable): Promise<TerminalListItem[]> {
  const rows = await q.all<TerminalRow & { branch_code: string; branch_name: string; open_session: number | null }>(
    `SELECT t.*, b.code AS branch_code, b.name AS branch_name,
            (SELECT s.id FROM register_sessions s WHERE s.terminal_id = t.code AND s.status = 'open') AS open_session
     FROM terminals t JOIN branches b ON b.id = t.branch_id ORDER BY t.id`,
  );
  const now = nowIso();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    branch: { id: r.branch_id, code: r.branch_code, name: r.branch_name },
    warehouseId: r.warehouse_id,
    active: r.active === 1,
    enrolled: r.token_hash !== null,
    enrolledAt: r.enrolled_at,
    enrolPending: r.enrol_hash !== null && r.enrol_expires_at !== null && r.enrol_expires_at > now,
    openSessionId: r.open_session,
  }));
}

/** Give a terminal a new one-time code (replacing any pending one). Returns the code, shown once. */
async function issueCode(q: Queryable, id: number): Promise<{ code: string; expiresAt: string }> {
  const code = newEnrolCode();
  const expiresAt = new Date(Date.now() + ENROL_CODE_MINUTES * 60_000).toISOString();
  await q.run('UPDATE terminals SET enrol_hash = ?, enrol_expires_at = ? WHERE id = ?', [sha256(normaliseCode(code)), expiresAt, id]);
  return { code, expiresAt };
}

export async function createTerminal(
  q: Queryable,
  actorId: number,
  input: { name: string; code?: string; warehouseId?: number | null },
): Promise<{ terminal: Terminal; enrolCode: string; expiresAt: string }> {
  const branch = await q.one<{ id: number }>('SELECT id FROM branches WHERE active = 1 ORDER BY id LIMIT 1');
  if (!branch) throw new Error('No branch exists. Was the migration applied?');
  if (input.warehouseId && !(await q.one('SELECT 1 FROM warehouses WHERE id = ?', [input.warehouseId])))
    throw E.unprocessable('INVALID_REFERENCE', 'That warehouse does not exist');
  const code = (input.code ?? `T${(await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM terminals'))!.n + 1}`).trim();
  if (await q.one('SELECT 1 FROM terminals WHERE code = ?', [code]))
    throw E.conflict('TERMINAL_CODE_TAKEN', `A terminal called "${code}" already exists`);
  const created = await q.one<{ id: number }>(
    'INSERT INTO terminals (branch_id, warehouse_id, code, name, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [branch.id, input.warehouseId ?? null, code, input.name, nowIso()],
  );
  const { code: enrolCode, expiresAt } = await issueCode(q, created!.id);
  await writeAuditQ(q, {
    userId: actorId,
    action: 'terminal.create',
    entity: 'terminal',
    entityId: created!.id,
    after: { code, name: input.name },
  });
  return {
    terminal: { id: created!.id, code, name: input.name, branchId: branch.id, warehouseId: input.warehouseId ?? null },
    enrolCode,
    expiresAt,
  };
}

export async function newEnrolCodeFor(q: Queryable, actorId: number, id: number) {
  const t = await q.one<TerminalRow>('SELECT * FROM terminals WHERE id = ?', [id]);
  if (!t) throw E.notFound('Terminal');
  if (!t.active) throw E.unprocessable('TERMINAL_INACTIVE', 'This terminal is switched off');
  const issued = await issueCode(q, id);
  await writeAuditQ(q, { userId: actorId, action: 'terminal.enrol-code', entity: 'terminal', entityId: id });
  return issued;
}

/** Turn a one-time code into a device token (shown once). Replaces any token the terminal had, so a swapped device starts clean. */
export async function enrolTerminal(q: Queryable, actorId: number, code: string): Promise<{ token: string; terminal: Terminal }> {
  const row = await q.one<TerminalRow>('SELECT * FROM terminals WHERE enrol_hash = ? AND active = 1', [sha256(normaliseCode(code))]);
  if (!row || !row.enrol_expires_at || row.enrol_expires_at <= nowIso())
    throw new AppError(422, 'ENROL_CODE_INVALID', 'That code is wrong, already used or has expired. Ask for a new one.');
  const token = randomBytes(32).toString('base64url');
  await q.run('UPDATE terminals SET token_hash = ?, enrolled_at = ?, enrol_hash = NULL, enrol_expires_at = NULL WHERE id = ?', [
    sha256(token),
    nowIso(),
    row.id,
  ]);
  await writeAuditQ(q, { userId: actorId, action: 'terminal.enrol', entity: 'terminal', entityId: row.id, after: { code: row.code } });
  return { token, terminal: toTerminal(row) };
}

/** The device must enrol again. Used when a till is lost or replaced. */
export async function revokeTerminal(q: Queryable, actorId: number, id: number): Promise<void> {
  const r = await q.run(
    'UPDATE terminals SET token_hash = NULL, enrolled_at = NULL, enrol_hash = NULL, enrol_expires_at = NULL WHERE id = ?',
    [id],
  );
  if (r.changes === 0) throw E.notFound('Terminal');
  await writeAuditQ(q, { userId: actorId, action: 'terminal.revoke', entity: 'terminal', entityId: id });
}

export async function updateTerminal(q: Queryable, actorId: number, id: number, patch: { name?: string; active?: boolean }): Promise<void> {
  const t = await q.one<TerminalRow>('SELECT * FROM terminals WHERE id = ?', [id]);
  if (!t) throw E.notFound('Terminal');
  if (patch.active === false && t.active === 1) {
    if (await q.one(`SELECT 1 FROM register_sessions WHERE terminal_id = ? AND status = 'open'`, [t.code]))
      throw E.conflict('TERMINAL_HAS_OPEN_REGISTER', "Close this till's register before switching it off");
    const others = (await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM terminals WHERE active = 1 AND id <> ?', [id]))!.n;
    if (others === 0) throw E.unprocessable('LAST_TERMINAL', 'The shop needs at least one active till');
  }
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.active !== undefined) {
    sets.push('active = ?');
    vals.push(patch.active ? 1 : 0);
  }
  if (sets.length) await q.run(`UPDATE terminals SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  await writeAuditQ(q, {
    userId: actorId,
    action: 'terminal.update',
    entity: 'terminal',
    entityId: id,
    before: { name: t.name, active: t.active === 1 },
    after: patch,
  });
}
