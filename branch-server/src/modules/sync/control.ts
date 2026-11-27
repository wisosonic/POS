import { CONTROLS, controlDays, controlSql, type DayControls } from '@pos/core/sync';
import type { Database } from '../../db/adapter';
import type { Link } from './service';

// The daily control (docs/12 §24, P4c). Once the branch has sent everything it has, it tells HQ what it holds, per table and per day, and HQ
// compares that with its own copy. A difference is a row missing, doubled or changed on one side, which nothing else would show.
//
// It must never be a false alarm, so it is only sent when it is trustworthy: nothing waiting to go up, the first send of history finished, and no change
// captured while the numbers were being worked out (the outbox sequence is the same before and after). It covers only days that are over (a UTC date
// before today): today is still changing. It never blocks a sale (plain reads, no transaction) and never throws: a problem here is a note, not a failure.

export type ControlOutcome =
  { sent: number; mismatched: number; days: string[] } | { skipped: string } | { error: string; refused?: boolean };

export type ControlOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal; today?: string; days?: number };

const outboxSeq = async (db: Database): Promise<number> =>
  (await db.one<{ seq: number }>(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_outbox'), 0) AS seq`))?.seq ?? 0;

async function caughtUp(db: Database): Promise<boolean> {
  const control = await db.one<{ capture: number }>('SELECT capture FROM sync_control WHERE id = 1');
  if (control?.capture !== 1) return false;
  const waiting = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))!.n;
  const unsent = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_snapshot WHERE done = 0'))!.n;
  return waiting === 0 && unsent === 0;
}

/** What this branch holds for each of the last `days` finished days, or why it is not the moment to say. */
export async function computeControls(
  db: Database,
  opts: { today?: string; days?: number } = {},
): Promise<{ days: DayControls[] } | { skipped: string }> {
  if (!(await caughtUp(db))) return { skipped: 'the branch still has records to send' };
  const before = await outboxSeq(db);
  const { from, to, days } = controlDays(opts.today ?? new Date().toISOString().slice(0, 10), opts.days ?? 7);
  const byDay = new Map<string, DayControls>(
    days.map((d) => [d, { day: d, tables: Object.fromEntries(CONTROLS.map((c) => [c.name, { n: 0, s: 0 }])) }]),
  );
  for (const spec of CONTROLS) {
    for (const r of await db.all<{ d: string; n: number; s: number }>(controlSql(spec, 'branch'), [from, to])) {
      const day = byDay.get(r.d);
      if (day) day.tables[spec.name] = { n: r.n, s: r.s };
    }
  }
  // Something was captured while counting: the numbers may not match what HQ has been sent. Not a result: try again later.
  if ((await outboxSeq(db)) !== before || !(await caughtUp(db))) return { skipped: 'the branch recorded something while it was counting' };
  return { days: [...byDay.values()] };
}

/** Compute the controls and send them to HQ. Never throws. */
export async function runControl(db: Database, link: Link, opts: ControlOptions = {}): Promise<ControlOutcome> {
  try {
    const computed = await computeControls(db, opts);
    if ('skipped' in computed) return computed;
    const res = await (opts.fetchImpl ?? fetch)(`${link.hqUrl}/api/v1/sync/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Branch-Token': link.token, Accept: 'application/json' },
      body: JSON.stringify({ days: computed.days }),
      signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(30_000)]),
    });
    if (res.status === 401) return { refused: true, error: 'HQ no longer accepts this branch' };
    if (!res.ok) return { error: `HQ did not take the control (${res.status})` };
    const body = (await res.json()) as { checked?: number; mismatched?: number };
    return { sent: body.checked ?? computed.days.length, mismatched: body.mismatched ?? 0, days: computed.days.map((d) => d.day) };
  } catch (e) {
    return { error: e instanceof Error && e.name === 'TimeoutError' ? 'HQ did not answer in time' : 'Cannot reach HQ' };
  }
}
