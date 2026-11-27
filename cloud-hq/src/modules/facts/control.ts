import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { CONTROLS, controlSql, diffControls, type Control, type ControlDiff, type DayControls } from '@pos/core/sync';
import { writeAudit } from '../staff/context';

// The daily reconciliation at HQ (docs/12 §24, P4c). The branch says what it holds per table and day; HQ works out the same figures from its mirror
// (the SAME definition, `CONTROLS`, so the two cannot drift) and keeps the result for each (branch, day). A difference is recorded, audited the first
// time it appears (and again when it is gone), and shown in the reports. HQ never "fixes" anything: the branch re-sends (`POST /sync/resync`).

export const MAX_CONTROL_DAYS = 31;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** What HQ holds for one branch over a range of days, by day and table. */
async function hqControls(q: Queryable, branchId: number, from: string, to: string): Promise<Map<string, Record<string, Control>>> {
  const out = new Map<string, Record<string, Control>>();
  for (const spec of CONTROLS) {
    for (const r of await q.all<{ d: string; n: number; s: number }>(controlSql(spec, 'hq'), [from, to, branchId])) {
      const day = out.get(r.d) ?? {};
      day[spec.name] = { n: r.n, s: r.s };
      out.set(r.d, day);
    }
  }
  return out;
}

export type ReconcileResult = { day: string; status: 'ok' | 'mismatch'; differences: ControlDiff[] };

/** Compare a branch's controls with HQ's copy and keep the results. Call inside a transaction. */
export async function reconcile(
  q: Queryable,
  branchId: number,
  days: DayControls[],
): Promise<{ checked: number; mismatched: number; results: ReconcileResult[] }> {
  if (days.length === 0 || days.length > MAX_CONTROL_DAYS)
    throw new AppError(422, 'CONTROL_INVALID', `A control covers 1 to ${MAX_CONTROL_DAYS} days`);
  const today = new Date().toISOString().slice(0, 10);
  for (const d of days) {
    if (!DAY.test(d.day) || Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)))
      throw new AppError(422, 'CONTROL_INVALID', `"${d.day}" is not a day`);
    if (d.day > today) throw new AppError(422, 'CONTROL_INVALID', 'A day that has not begun cannot be compared');
  }
  const sorted = days.map((d) => d.day).sort();
  const hq = await hqControls(q, branchId, sorted[0]!, nextDay(sorted[sorted.length - 1]!));
  const now = new Date().toISOString();
  const results: ReconcileResult[] = [];
  for (const d of days) {
    const differences = diffControls(d.tables, hq.get(d.day) ?? {});
    const status = differences.length === 0 ? 'ok' : 'mismatch';
    const before = await q.one<{ status: string }>('SELECT status FROM reconciliations WHERE branch_id = ? AND day = ?', [branchId, d.day]);
    await q.run(
      `INSERT INTO reconciliations (branch_id, day, status, checked_at, diff_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (branch_id, day) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at, diff_json = excluded.diff_json`,
      [branchId, d.day, status, now, differences.length ? JSON.stringify(differences) : null],
    );
    // Said once when a difference appears and once when it is gone, not at every check.
    if (status === 'mismatch' && before?.status !== 'mismatch')
      await writeAudit(q, 'reconcile.mismatch', 'branch', branchId, { day: d.day, tables: differences.map((x) => x.table) });
    if (status === 'ok' && before?.status === 'mismatch') await writeAudit(q, 'reconcile.resolved', 'branch', branchId, { day: d.day });
    results.push({ day: d.day, status, differences });
  }
  return { checked: results.length, mismatched: results.filter((r) => r.status === 'mismatch').length, results };
}
