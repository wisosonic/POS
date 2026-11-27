import type { Queryable } from '@pos/core/adapter';
import { newOneTimeCode, newToken, normaliseCode, sha256 } from '@pos/core/credentials';
import { AppError, E } from '@pos/core/errors';
import { writeAudit } from '../staff/context';

// Branches at HQ (docs/12-sync-and-hq.md §6). An HQ admin adds a branch and gets a one-time code (valid 30 minutes, works once); the
// branch's server trades it for a long-lived token, which HQ stores only as a hash. Every later call from the branch carries the
// token. Neither the code nor the token is ever written to the audit log, a list or a log line.

export const ENROL_CODE_MINUTES = 30;
/** `last_seen_at` is refreshed at most this often, so a branch that pings every few seconds does not write on every ping. */
const SEEN_EVERY_SECONDS = 10;

const nowIso = () => new Date().toISOString();

type BranchRow = {
  id: number;
  code: string;
  name: string;
  kind: BranchKind;
  active: number;
  token_hash: string | null;
  enrol_hash: string | null;
  enrol_expires_at: string | null;
  enrolled_at: string | null;
  last_seen_at: string | null;
  created_at: string;
};

/** A sale branch has tills and sells; a stock branch is a warehouse with no tills (docs/15 §3). */
export type BranchKind = 'sale' | 'stock';

/** What HQ's code needs to know about the branch a request came from. */
export type Branch = { id: number; code: string; name: string; kind: BranchKind };
const toBranch = (r: BranchRow): Branch => ({ id: r.id, code: r.code, name: r.name, kind: r.kind });

/** The audit log (staff/context.ts): the actor of the transaction is recorded with each row. */
export const hqAudit = writeAudit;

export type BranchListItem = {
  id: number;
  code: string;
  name: string;
  kind: BranchKind;
  active: boolean;
  connected: boolean;
  enrolPending: boolean;
  enrolledAt: string | null;
  lastSeenAt: string | null;
};

export async function listBranches(q: Queryable): Promise<BranchListItem[]> {
  const rows = await q.all<BranchRow>('SELECT * FROM branches ORDER BY id');
  const now = nowIso();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    active: r.active === 1,
    connected: r.token_hash !== null,
    enrolPending: r.enrol_hash !== null && r.enrol_expires_at !== null && r.enrol_expires_at > now,
    enrolledAt: r.enrolled_at,
    lastSeenAt: r.last_seen_at,
  }));
}

async function issueCode(q: Queryable, id: number): Promise<{ code: string; expiresAt: string }> {
  const code = newOneTimeCode();
  const expiresAt = new Date(Date.now() + ENROL_CODE_MINUTES * 60_000).toISOString();
  await q.run('UPDATE branches SET enrol_hash = ?, enrol_expires_at = ? WHERE id = ?', [sha256(normaliseCode(code)), expiresAt, id]);
  return { code, expiresAt };
}

export async function createBranch(
  q: Queryable,
  input: { code: string; name: string; kind?: BranchKind },
): Promise<{ branch: Branch; enrolCode: string; expiresAt: string }> {
  const kind = input.kind ?? 'sale';
  const code = input.code.trim().toUpperCase();
  if (await q.one('SELECT 1 FROM branches WHERE code = ?', [code]))
    throw E.conflict('BRANCH_CODE_TAKEN', `A branch with the code "${code}" already exists`);
  const created = await q.one<{ id: number }>('INSERT INTO branches (code, name, kind, created_at) VALUES (?, ?, ?, ?) RETURNING id', [
    code,
    input.name,
    kind,
    nowIso(),
  ]);
  const issued = await issueCode(q, created!.id);
  await hqAudit(q, 'branch.create', 'branch', created!.id, { code, name: input.name, kind });
  return { branch: { id: created!.id, code, name: input.name, kind }, enrolCode: issued.code, expiresAt: issued.expiresAt };
}

export async function newEnrolCodeFor(q: Queryable, id: number): Promise<{ code: string; expiresAt: string }> {
  const b = await q.one<BranchRow>('SELECT * FROM branches WHERE id = ?', [id]);
  if (!b) throw E.notFound('Branch');
  if (!b.active) throw E.unprocessable('BRANCH_INACTIVE', 'This branch is switched off');
  const issued = await issueCode(q, id);
  await hqAudit(q, 'branch.enrol-code', 'branch', id);
  return issued;
}

/** A branch trades its one-time code for its token (shown once). Replaces any token it had, so a rebuilt branch server starts clean. */
export async function enrolBranch(q: Queryable, code: string): Promise<{ token: string; branch: Branch }> {
  const row = await q.one<BranchRow>('SELECT * FROM branches WHERE enrol_hash = ? AND active = 1', [sha256(normaliseCode(code))]);
  if (!row || !row.enrol_expires_at || row.enrol_expires_at <= nowIso())
    throw new AppError(422, 'ENROL_CODE_INVALID', 'That code is wrong, already used or has expired. Ask for a new one.');
  const token = newToken();
  await q.run(
    'UPDATE branches SET token_hash = ?, enrolled_at = ?, last_seen_at = ?, enrol_hash = NULL, enrol_expires_at = NULL WHERE id = ?',
    [sha256(token), nowIso(), nowIso(), row.id],
  );
  await hqAudit(q, 'branch.enrol', 'branch', row.id, { code: row.code });
  return { token, branch: toBranch(row) };
}

export async function revokeBranch(q: Queryable, id: number): Promise<void> {
  const r = await q.run('UPDATE branches SET token_hash = NULL, enrol_hash = NULL, enrol_expires_at = NULL WHERE id = ?', [id]);
  if (r.changes === 0) throw E.notFound('Branch');
  await hqAudit(q, 'branch.revoke', 'branch', id);
}

export async function updateBranch(q: Queryable, id: number, patch: { name?: string; active?: boolean; kind?: BranchKind }): Promise<void> {
  const b = await q.one<BranchRow>('SELECT * FROM branches WHERE id = ?', [id]);
  if (!b) throw E.notFound('Branch');
  // A branch that has connected may have sold (or received stock): it cannot become the other kind. Add a new branch instead.
  if (patch.kind !== undefined && patch.kind !== b.kind) {
    if (b.enrolled_at !== null)
      throw E.conflict(
        'BRANCH_KIND_LOCKED',
        'This branch has already connected, so its kind cannot change. Add a new branch of the other kind.',
      );
    await q.run('UPDATE branches SET kind = ? WHERE id = ?', [patch.kind, id]);
  }
  if (patch.name !== undefined) await q.run('UPDATE branches SET name = ? WHERE id = ?', [patch.name, id]);
  if (patch.active !== undefined) await q.run('UPDATE branches SET active = ? WHERE id = ?', [patch.active ? 1 : 0, id]);
  await hqAudit(q, 'branch.update', 'branch', id, { before: { name: b.name, active: b.active === 1, kind: b.kind }, after: patch });
}

/** Which branch does this token belong to? An unknown token, or one of a switched-off branch, is refused. */
export async function resolveBranch(q: Queryable, token: string | undefined): Promise<Branch> {
  const row = token ? await q.one<BranchRow>('SELECT * FROM branches WHERE token_hash = ? AND active = 1', [sha256(token)]) : undefined;
  if (!row) throw new AppError(401, 'BRANCH_UNKNOWN', 'This branch is not connected to HQ (or was switched off). Ask HQ for a new code.');
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (Date.now() - seen > SEEN_EVERY_SECONDS * 1000) await q.run('UPDATE branches SET last_seen_at = ? WHERE id = ?', [nowIso(), row.id]);
  return toBranch(row);
}
