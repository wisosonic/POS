import { digestRows, SYNC_TABLES, type Digest, type Fact, type FactRow, type SyncTable } from '@pos/core/sync';
import type { Database } from '../../db/adapter';
import { nowIso } from '../../util/time';
import type { Link } from './service';

// Sending a branch's records to HQ (docs/12-sync-and-hq.md §3). One call to `pushOnce` sends ONE batch and says whether there is more.
//   1. First the OUTBOX (what changed since the branch connected, oldest first): the freshest sales matter most.
//   2. Then the SNAPSHOT (the rows that already existed when it connected), table by table, a batch at a time, remembering how far it got.
// The outbox says only WHICH rows changed: the row is read now, as it is, so ten changes to a sale are one message and a row that has been
// deleted since goes out as a deletion. A batch is cleared from the outbox ONLY after HQ confirms it, so a lost answer, a crash, or an outage
// just sends it again, and HQ's upserts make that harmless.

export type PushOutcome =
  | { sent: number; more: boolean }
  /** `refused`: HQ does not accept this branch any more (retrying will not help). Otherwise the batch will simply be tried again. */
  | { error: string; refused?: boolean };

export type PushOptions = { fetchImpl?: typeof fetch; batchSize?: number; signal?: AbortSignal };
const DEFAULT_BATCH = 200;

const cols = (t: SyncTable) => t.columns.map((c) => c.name).join(', ');
const tableOf = (name: string) => SYNC_TABLES.find((t) => t.name === name);

async function post(link: Link, rows: Fact[], opts: PushOptions): Promise<{ ok: true } | { ok: false; error: string; refused?: boolean }> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${link.hqUrl}/api/v1/sync/facts`, {
      method: 'POST',
      headers: { 'X-Branch-Token': link.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(30_000)]),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401)
      return { ok: false, refused: true, error: 'HQ no longer accepts this branch. Ask HQ for a new code and connect again.' };
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    return { ok: false, error: `HQ did not take a batch (${res.status})${body.detail ? `: ${body.detail}` : ''}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'TimeoutError' ? 'HQ did not answer in time' : 'Cannot reach HQ' };
  }
}

/** The current state of these rows. */
async function readRows(db: Database, t: SyncTable, ids: number[]): Promise<Map<number, FactRow>> {
  const found = new Map<number, FactRow>();
  if (ids.length === 0) return found;
  for (const r of await db.all<FactRow>(`SELECT ${cols(t)} FROM ${t.name} WHERE id IN (${ids.map(() => '?').join(',')})`, ids))
    found.set(Number(r.id), r);
  return found;
}

/** Send the next batch. Never throws for a network problem: it says what happened. */
export async function pushOnce(db: Database, link: Link, opts: PushOptions = {}): Promise<PushOutcome> {
  const size = opts.batchSize ?? DEFAULT_BATCH;
  const control = await db.one<{ capture: number }>('SELECT capture FROM sync_control WHERE id = 1');
  if (control?.capture !== 1) return { sent: 0, more: false };

  // ---- 1. what changed since connecting
  const queued = await db.all<{ seq: number; tbl: string; pk: number; op: 'u' | 'd' }>(
    'SELECT seq, tbl, pk, op FROM sync_outbox ORDER BY seq LIMIT ?',
    [size],
  );
  if (queued.length > 0) {
    const toSeq = queued[queued.length - 1]!.seq;
    // One message per row: the LAST thing that happened to it decides.
    const latest = new Map<string, { tbl: string; pk: number; op: 'u' | 'd' }>();
    for (const q of queued) latest.set(`${q.tbl}:${q.pk}`, q);
    const facts: Fact[] = [];
    for (const t of SYNC_TABLES) {
      const wanted = [...latest.values()].filter((x) => x.tbl === t.name);
      const current = await readRows(
        db,
        t,
        wanted.filter((x) => x.op === 'u').map((x) => x.pk),
      );
      for (const w of wanted) {
        const row = w.op === 'u' ? current.get(w.pk) : undefined;
        facts.push(row ? { tbl: t.name, pk: w.pk, op: 'u', row } : { tbl: t.name, pk: w.pk, op: 'd' }); // gone since it was recorded: a deletion
      }
    }
    const sent = await post(link, facts, opts);
    if (!sent.ok) return { error: sent.error, refused: sent.refused };
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM sync_outbox WHERE seq <= ?', [toSeq]);
      await tx.run('UPDATE sync_control SET last_push_at = ? WHERE id = 1', [nowIso()]);
    });
    const left = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))!.n;
    const snapshotLeft = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_snapshot WHERE done = 0'))!.n;
    return { sent: facts.length, more: left > 0 || snapshotLeft > 0 };
  }

  // ---- 2. the rows that existed when it connected
  const snap = await db.one<{ tbl: string; upto: number; next_pk: number }>(
    'SELECT tbl, upto, next_pk FROM sync_snapshot WHERE done = 0 ORDER BY tbl LIMIT 1',
  );
  if (!snap) return { sent: 0, more: false };
  const t = tableOf(snap.tbl);
  if (!t) {
    await db.run('UPDATE sync_snapshot SET done = 1 WHERE tbl = ?', [snap.tbl]); // a table this version does not know: nothing to send
    return { sent: 0, more: true };
  }
  const rows = await db.all<FactRow>(`SELECT ${cols(t)} FROM ${t.name} WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`, [
    snap.next_pk,
    snap.upto,
    size,
  ]);
  if (rows.length === 0) {
    await db.run('UPDATE sync_snapshot SET done = 1 WHERE tbl = ?', [snap.tbl]);
    return { sent: 0, more: true };
  }
  const sent = await post(
    link,
    rows.map((row) => ({ tbl: t.name, pk: Number(row.id), op: 'u' as const, row })),
    opts,
  );
  if (!sent.ok) return { error: sent.error, refused: sent.refused };
  const last = Number(rows[rows.length - 1]!.id);
  const finished = rows.length < size || last >= snap.upto;
  await db.tx(async (tx) => {
    await tx.run('UPDATE sync_snapshot SET next_pk = ?, done = ? WHERE tbl = ?', [last, finished ? 1 : 0, snap.tbl]);
    await tx.run('UPDATE sync_control SET last_push_at = ? WHERE id = 1', [nowIso()]);
  });
  return { sent: rows.length, more: true };
}

// ------------------------------------------------------------------ checking that HQ holds exactly what this branch holds

export type VerifyResult = {
  /** Changes still waiting to be sent: while there are any, the two sides are expected to differ. */
  pending: number;
  snapshotDone: boolean;
  /** True only when nothing is waiting AND every table matches. */
  inSync: boolean;
  tables: { table: string; branch: Digest; hq: Digest | null; match: boolean }[];
};

export async function localDigest(db: Database, t: SyncTable): Promise<Digest> {
  return digestRows(t, await db.all<FactRow>(`SELECT ${cols(t)} FROM ${t.name} ORDER BY id`));
}

/** Compare this branch's tables with HQ's copies, table by table. Reads whole tables: for a person to ask for, not for every minute. */
export async function verifyWithHq(db: Database, link: Link, opts: PushOptions = {}): Promise<VerifyResult | { error: string }> {
  const pending = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox'))!.n;
  const snapshotDone = (await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sync_snapshot WHERE done = 0'))!.n === 0;
  const tables: VerifyResult['tables'] = [];
  for (const t of SYNC_TABLES) {
    let hq: Digest | null = null;
    try {
      const res = await (opts.fetchImpl ?? fetch)(`${link.hqUrl}/api/v1/sync/digest?tbl=${t.name}`, {
        headers: { 'X-Branch-Token': link.token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { error: `HQ answered ${res.status}` };
      hq = (await res.json()) as Digest;
    } catch {
      return { error: 'Cannot reach HQ' };
    }
    const branch = await localDigest(db, t);
    tables.push({
      table: t.name,
      branch,
      hq,
      match: branch.count === hq.count && branch.maxPk === hq.maxPk && branch.checksum === hq.checksum,
    });
  }
  return { pending, snapshotDone, inSync: pending === 0 && snapshotDone && tables.every((x) => x.match), tables };
}
