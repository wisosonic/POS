import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../apps/api/src/db/adapter';
import { createSqliteDatabase } from '../../apps/api/src/db/drivers/sqlite';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { seedTestData, type Seed } from '../../apps/api/src/db/seed-test';
import {
  JOB_ATTEMPTS,
  cancelJob,
  claimJobs,
  enqueueReceipt,
  finishJob,
  getJob,
  pendingForSale,
  waitForWake,
  wakeAgent,
} from '../../apps/api/src/modules/printing/jobs';

// The print queue (migration 0016): leases, expiry, isolation between terminals and the rules that keep one receipt from printing twice.
let dir: string;
let raw: Db;
let db: Database;
let seed: Seed;
const bytes = (s: string) => new TextEncoder().encode(s);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pos-jobs-'));
  const file = join(dir, 'pos.db');
  migrate(file);
  seed = await seedTestData(file);
  raw = openDatabase(file);
  db = createSqliteDatabase(raw);
  raw.prepare(`INSERT INTO terminals (branch_id, code, name, created_at) VALUES (1, 'T2', 'Till 2', '2026-11-23T00:00:00.000Z')`).run(); // id 2
});
afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const queue = (terminalId: number, saleId = 1, texts = ['one']) =>
  enqueueReceipt(db, {
    terminalId,
    userId: seed.users.cashier.id,
    saleId,
    jobs: texts.map((t, i) => ({ bytes: bytes(t), duplicate: false, drawer: i === 0 })),
  });
const row = (id: number) => raw.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id) as Record<string, unknown>;

describe('the print queue', () => {
  it('hands out the oldest jobs first and marks them as sent', async () => {
    const ids = await queue(1, 1, ['a', 'b', 'c', 'd']);
    const got = await claimJobs(db, 1, 3);
    expect(got.map((j) => j.id)).toEqual(ids.slice(0, 3));
    expect(got.map((j) => Buffer.from(j.bytes).toString())).toEqual(['a', 'b', 'c']);
    expect(row(ids[0]!)).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await claimJobs(db, 1, 3)).map((j) => j.id)).toEqual([ids[3]]); // the rest
    expect(await claimJobs(db, 1)).toEqual([]);
  });

  it('a terminal never sees, finishes or cancels another terminal’s jobs', async () => {
    const [mine] = await queue(1);
    const [theirs] = await queue(2);
    expect((await claimJobs(db, 2)).map((j) => j.id)).toEqual([theirs]);
    expect(await finishJob(db, 2, mine!, true)).toBeNull(); // not theirs
    expect(await getJob(db, 2, mine!)).toBeNull();
    expect(await cancelJob(db, 2, mine!)).toBeNull();
    expect(row(mine!)).toMatchObject({ status: 'queued' });
  });

  it('a job nobody picked up in ten minutes expires and is never printed late', async () => {
    const [id] = await queue(1);
    raw.prepare('UPDATE print_jobs SET created_at = ? WHERE id = ?').run(minutesAgo(11), id);
    expect(await claimJobs(db, 1)).toEqual([]);
    expect(row(id!)).toMatchObject({ status: 'expired' });
  });

  it('a job handed out but never answered is offered again, and fails after the last attempt', async () => {
    const [id] = await queue(1);
    for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
      const got = await claimJobs(db, 1);
      expect(got.map((j) => j.id)).toEqual([id]);
      expect(row(id!)).toMatchObject({ status: 'sent', attempts: attempt });
      raw.prepare('UPDATE print_jobs SET sent_at = ? WHERE id = ?').run(minutesAgo(5), id); // the lease runs out
    }
    expect(await claimJobs(db, 1)).toEqual([]);
    expect(row(id!)).toMatchObject({ status: 'failed', error: 'The print agent did not answer' });
  });

  it('a job whose lease has not run out is not offered to a second request', async () => {
    await queue(1);
    expect(await claimJobs(db, 1)).toHaveLength(1);
    expect(await claimJobs(db, 1)).toHaveLength(0); // still "sent", still within its lease
  });

  it('an answer settles a job once: saying it again changes nothing, and a late "failed" cannot undo "printed"', async () => {
    const [id] = await queue(1);
    await claimJobs(db, 1);
    expect(await finishJob(db, 1, id!, true)).toBe('printed');
    expect(await finishJob(db, 1, id!, false, 'late')).toBe('printed');
    expect(row(id!)).toMatchObject({ status: 'printed', error: null });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.print'`).get()).toEqual({ n: 1 }); // audited once
  });

  it('a failed job keeps the reason (cut to a sensible length) and is not audited as a print', async () => {
    const [id] = await queue(1);
    await claimJobs(db, 1);
    expect(await finishJob(db, 1, id!, false, 'x'.repeat(500))).toBe('failed');
    expect((row(id!).error as string).length).toBe(300);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.print'`).get()).toEqual({ n: 0 });
  });

  it('only a job still in the queue can be cancelled', async () => {
    const [taken, waiting] = await queue(1, 1, ['a', 'b']);
    await claimJobs(db, 1, 1); // the agent takes the first one
    expect((await cancelJob(db, 1, waiting!))?.status).toBe('cancelled'); // still in the queue
    expect((await cancelJob(db, 1, taken!))?.status).toBe('sent'); // already with the agent: too late
  });

  it('knows which jobs of a sale are still on their way (so a second click is a duplicate)', async () => {
    const [id] = await queue(1, 7);
    expect(await pendingForSale(db, 7)).toBe(1);
    expect(await pendingForSale(db, 8)).toBe(0);
    await claimJobs(db, 1);
    expect(await pendingForSale(db, 7)).toBe(1); // sent, not yet printed
    await finishJob(db, 1, id!, true);
    expect(await pendingForSale(db, 7)).toBe(0);
  });

  it('clears old finished jobs (they hold a receipt) but never one still waiting', async () => {
    const [old, waiting] = await queue(1, 1, ['old', 'waiting']);
    await claimJobs(db, 1, 1);
    await finishJob(db, 1, old!, true);
    raw.prepare('UPDATE print_jobs SET finished_at = ? WHERE id = ?').run(minutesAgo(60 * 49), old);
    await queue(1, 2); // housekeeping runs when a job is queued
    expect(raw.prepare('SELECT id FROM print_jobs WHERE id = ?').get(old)).toBeUndefined();
    expect(raw.prepare('SELECT id FROM print_jobs WHERE id = ?').get(waiting)).toBeDefined();
  });
});

describe('waking a waiting agent', () => {
  it('a queued job wakes the waiter at once; with no job it ends after its time', async () => {
    const started = Date.now();
    const woken = waitForWake(1, 5000);
    setTimeout(() => wakeAgent(1), 50);
    await woken;
    expect(Date.now() - started).toBeLessThan(1000);

    const t0 = Date.now();
    await waitForWake(1, 80);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it('only wakes the terminal the job is for, and stops waiting when the agent hangs up', async () => {
    let otherWoke = false;
    void waitForWake(2, 300).then(() => (otherWoke = true));
    wakeAgent(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(otherWoke).toBe(false);

    const hangUp = new AbortController();
    const waiting = waitForWake(1, 5000, hangUp.signal);
    setTimeout(() => hangUp.abort(), 30);
    const t0 = Date.now();
    await waiting;
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
