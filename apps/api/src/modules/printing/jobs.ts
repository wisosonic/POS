import type { Queryable } from '../../db/adapter';
import { nowIso } from '../../util/time';
import { writeAuditQ } from '../audit/service';

// The print queue for tills whose receipts are printed by the print agent on the till PC (migration 0016). The server builds every
// receipt and decides what is a duplicate and whether the drawer opens, then queues the bytes here. The agent asks for its terminal's
// jobs, prints them, and says whether they reached the printer. Only a print that reached the printer is audited as `sale.print`,
// so "the first print of a sale is the original" keeps meaning the first that really printed (CLAUDE.md: a reprint is not a sale).

/** A job nobody picked up in this long is no use any more (nobody wants a receipt that comes out an hour later). */
export const JOB_MAX_QUEUED_MINUTES = 10;
/** A job handed to the agent that gets no answer in this long is offered again, up to ATTEMPTS times. */
export const JOB_LEASE_SECONDS = 60;
export const JOB_ATTEMPTS = 3;
/** Finished jobs hold a receipt (a customer's name among it): they are cleared after this. */
const KEEP_FINISHED_HOURS = 48;

export type JobStatus = 'queued' | 'sent' | 'printed' | 'failed' | 'cancelled' | 'expired';
type JobRow = {
  id: number;
  terminal_id: number;
  sale_id: number | null;
  user_id: number | null;
  kind: 'receipt';
  bytes: Uint8Array;
  duplicate: number;
  drawer: number;
  status: JobStatus;
  attempts: number;
  error: string | null;
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ------------------------------------------------------------------ waking a waiting agent
// The agent holds a request open ("long poll") until there is work. A job queued in this process wakes it at once; the timeout makes
// it ask again so a dropped connection is noticed. (One server process owns the database, so an in-memory signal is enough.)
const waiters = new Map<number, Set<() => void>>();

export function wakeAgent(terminalId: number): void {
  for (const wake of waiters.get(terminalId) ?? []) wake();
}

/** Resolves when a job is queued for this terminal, after `ms`, or as soon as `signal` aborts (the agent hung up). */
export function waitForWake(terminalId: number, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(terminalId) ?? waiters.set(terminalId, new Set()).get(terminalId)!;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      set.delete(done);
      if (set.size === 0) waiters.delete(terminalId);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    if (signal?.aborted) return done();
    signal?.addEventListener('abort', done);
  });
}

// ------------------------------------------------------------------ the queue

export type NewJob = { bytes: Uint8Array; duplicate: boolean; drawer: boolean };

/** Queue one job per copy, in order. The first is the one that may open the drawer. Returns their ids. */
export async function enqueueReceipt(
  q: Queryable,
  input: { terminalId: number; userId: number; saleId: number; jobs: NewJob[] },
): Promise<number[]> {
  const ids: number[] = [];
  for (const j of input.jobs) {
    const row = await q.one<{ id: number }>(
      `INSERT INTO print_jobs (terminal_id, sale_id, user_id, kind, bytes, duplicate, drawer, created_at)
       VALUES (?, ?, ?, 'receipt', ?, ?, ?, ?) RETURNING id`,
      [input.terminalId, input.saleId, input.userId, j.bytes, j.duplicate ? 1 : 0, j.drawer ? 1 : 0, nowIso()],
    );
    ids.push(row!.id);
  }
  // Housekeeping: finished jobs hold receipts, so they do not stay.
  await q.run(`DELETE FROM print_jobs WHERE status NOT IN ('queued', 'sent') AND COALESCE(finished_at, created_at) < ?`, [
    ago(KEEP_FINISHED_HOURS * 3_600_000),
  ]);
  return ids;
}

/** Jobs of this sale that are still on their way to the printer. A new print request for the sale is then a duplicate, not a second original. */
export async function pendingForSale(q: Queryable, saleId: number): Promise<number> {
  return (await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM print_jobs WHERE sale_id = ? AND status IN ('queued', 'sent')`, [saleId]))!
    .n;
}

/**
 * Hand the agent its next jobs (oldest first) and mark them as sent. First tidies up: jobs that waited too long expire, and a job the
 * agent took but never answered for is offered again (or fails after the last attempt).
 */
export async function claimJobs(q: Queryable, terminalId: number, limit = 3): Promise<JobRow[]> {
  const now = nowIso();
  await q.run(`UPDATE print_jobs SET status = 'expired', finished_at = ? WHERE terminal_id = ? AND status = 'queued' AND created_at < ?`, [
    now,
    terminalId,
    ago(JOB_MAX_QUEUED_MINUTES * 60_000),
  ]);
  await q.run(
    `UPDATE print_jobs SET status = 'failed', finished_at = ?, error = 'The print agent did not answer' WHERE terminal_id = ? AND status = 'sent' AND sent_at < ? AND attempts >= ?`,
    [now, terminalId, ago(JOB_LEASE_SECONDS * 1000), JOB_ATTEMPTS],
  );
  await q.run(`UPDATE print_jobs SET status = 'queued' WHERE terminal_id = ? AND status = 'sent' AND sent_at < ? AND attempts < ?`, [
    terminalId,
    ago(JOB_LEASE_SECONDS * 1000),
    JOB_ATTEMPTS,
  ]);
  const jobs = await q.all<JobRow>(`SELECT * FROM print_jobs WHERE terminal_id = ? AND status = 'queued' ORDER BY id LIMIT ?`, [
    terminalId,
    limit,
  ]);
  for (const j of jobs)
    await q.run(`UPDATE print_jobs SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?`, [now, j.id]);
  return jobs;
}

/**
 * The agent says how a job went. Only this terminal's own job, and only once: saying it again changes nothing. A print that reached
 * the printer is audited as `sale.print`, like a print made on the server's own printer.
 */
export async function finishJob(q: Queryable, terminalId: number, id: number, ok: boolean, error?: string): Promise<JobStatus | null> {
  const job = await q.one<JobRow>('SELECT * FROM print_jobs WHERE id = ? AND terminal_id = ?', [id, terminalId]);
  if (!job) return null;
  if (job.status !== 'queued' && job.status !== 'sent') return job.status; // already settled
  const status: JobStatus = ok ? 'printed' : 'failed';
  await q.run('UPDATE print_jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?', [
    status,
    nowIso(),
    ok ? null : (error ?? 'The printer did not print').slice(0, 300),
    id,
  ]);
  if (ok && job.sale_id !== null)
    await writeAuditQ(q, {
      userId: job.user_id,
      action: 'sale.print',
      entity: 'sale',
      entityId: job.sale_id,
      after: { copies: 1, duplicate: job.duplicate === 1, drawer: job.drawer === 1, via: 'agent' },
    });
  return status;
}

/** The till gives up waiting. A job still in the queue is cancelled, so it cannot come out later when the cashier has already used browser print. */
export async function cancelJob(q: Queryable, terminalId: number, id: number): Promise<{ status: JobStatus; error: string | null } | null> {
  await q.run(`UPDATE print_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND terminal_id = ? AND status = 'queued'`, [
    nowIso(),
    id,
    terminalId,
  ]);
  return getJob(q, terminalId, id);
}

export async function getJob(q: Queryable, terminalId: number, id: number): Promise<{ status: JobStatus; error: string | null } | null> {
  const row = await q.one<{ status: JobStatus; error: string | null }>(
    'SELECT status, error FROM print_jobs WHERE id = ? AND terminal_id = ?',
    [id, terminalId],
  );
  return row ?? null;
}
