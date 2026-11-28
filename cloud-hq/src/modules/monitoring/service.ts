import type { Queryable } from '@pos/core/adapter';

// Is the chain healthy? (docs/12 §32, P7.) One answer for the owner: each branch is reachable, caught up with HQ's changes, and agrees with HQ about
// what it holds; HQ's own backup is recent. Nothing here is stored: it reads what the branches already tell HQ (their pings, their pulls, the daily
// control) and says what needs a look.

export type BranchHealth = {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'stock';
  connected: boolean;
  lastSeenAt: string | null;
  silentMinutes: number | null;
  /** HQ's changes this branch can see that it has not applied yet. */
  pendingChanges: number;
  lastPulledAt: string | null;
  control: { day: string; status: 'ok' | 'mismatch'; checkedAt: string } | null;
  /** Days in the last 14 where the branch and HQ disagreed. */
  mismatchDays: number;
  /** `NEVER_CONNECTED`, `SILENT`, `NOT_PULLING`, `MISMATCH`: what to look at. Empty = fine. */
  problems: string[];
};

type Row = {
  id: number;
  code: string;
  name: string;
  kind: 'sale' | 'stock';
  enrolled_at: string | null;
  last_seen_at: string | null;
  down_cursor: number;
  down_cursor_at: string | null;
};

/** A branch that has not pulled for this long, while changes wait for it, is not pulling. */
const NOT_PULLING_MINUTES = 10;

export async function branchHealth(q: Queryable, opts: { staleMinutes: number; now?: Date }): Promise<BranchHealth[]> {
  const now = opts.now ?? new Date();
  const rows = await q.all<Row>(
    'SELECT id, code, name, kind, enrolled_at, last_seen_at, down_cursor, down_cursor_at FROM branches WHERE active = 1 ORDER BY id',
  );
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const out: BranchHealth[] = [];
  for (const b of rows) {
    const connected = b.enrolled_at !== null;
    const silent = b.last_seen_at ? Math.floor((now.getTime() - Date.parse(b.last_seen_at)) / 60_000) : null;
    const top = await q.one<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM change_log WHERE branch_id IS NULL OR branch_id = ?', [
      b.id,
    ]);
    const pending = Math.max(0, (top?.seq ?? 0) - b.down_cursor);
    const control = await q.one<{ day: string; status: 'ok' | 'mismatch'; checked_at: string }>(
      'SELECT day, status, checked_at FROM reconciliations WHERE branch_id = ? ORDER BY day DESC LIMIT 1',
      [b.id],
    );
    const bad = await q.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM reconciliations WHERE branch_id = ? AND day >= ? AND status = 'mismatch'",
      [b.id, since],
    );
    const problems: string[] = [];
    if (!connected) problems.push('NEVER_CONNECTED');
    else {
      if (silent === null || silent > opts.staleMinutes) problems.push('SILENT');
      const pulled = b.down_cursor_at ? Math.floor((now.getTime() - Date.parse(b.down_cursor_at)) / 60_000) : null;
      if (pending > 0 && (pulled === null || pulled > NOT_PULLING_MINUTES) && !problems.includes('SILENT')) problems.push('NOT_PULLING');
      if ((bad?.n ?? 0) > 0) problems.push('MISMATCH');
    }
    out.push({
      id: b.id,
      code: b.code,
      name: b.name,
      kind: b.kind,
      connected,
      lastSeenAt: b.last_seen_at,
      silentMinutes: silent,
      pendingChanges: connected ? pending : 0,
      lastPulledAt: b.down_cursor_at,
      control: control ? { day: control.day, status: control.status, checkedAt: control.checked_at } : null,
      mismatchDays: bad?.n ?? 0,
      problems,
    });
  }
  return out;
}
