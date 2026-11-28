import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';

// Monitoring (docs/12 §32, P7): is the chain healthy? A real branch that is connected and caught up is fine; a branch that never connected, went silent, stopped
// pulling or disagrees with HQ is named with the reason; HQ's own backup is part of the answer.
let hq: Hq;
let live: TestCtx;
let backupDir = '';
const api = '/api/v1';
const get = async (q = '') => (await hq.http.get(`${api}/monitoring/branches${q}`).set(adminAuth)).body;
const row = async (code: string) =>
  (await get()).branches.find((b: { code: string }) => b.code === code) as Record<string, unknown> & { problems: string[] };
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const run = (sql: string, params: (string | number | null)[] = []) => hq.app.database.run(sql, params);
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeAll(async () => {
  backupDir = mkdtempSync(join(tmpdir(), 'hq-mon-'));
  hq = await startHq();
  live = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
  const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'LIVE', name: 'Live branch' })).body.enrolCode as string;
  const admin = await live.login('admin');
  expect(
    (
      await live.http
        .post(`${api}/sync/connect`)
        .set({ Authorization: `Bearer ${admin}` })
        .send({ url: hq.url, code: enrol })
    ).status,
  ).toBe(200);
  expect((await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'NEW', name: 'Not yet connected' })).status).toBe(201);
});
afterAll(async () => {
  await live.close();
  await hq.close();
  rmSync(backupDir, { recursive: true, force: true });
});

describe('the chain at a glance (US-OPS-monitoring)', () => {
  it('a connected branch that is caught up is fine; one that never connected is named', async () => {
    expect(await until(async () => (await row('LIVE')).problems.length === 0 && (await row('LIVE')).pendingChanges === 0)).toBe(true);
    const live1 = await row('LIVE');
    expect(live1).toMatchObject({ connected: true, kind: 'sale', pendingChanges: 0 });
    expect(live1.lastSeenAt).not.toBeNull();
    expect((await row('NEW')).problems).toEqual(['NEVER_CONNECTED']);
    // a change at HQ is pulled and applied: the branch stays caught up
    expect((await hq.http.post(`${api}/categories`).set(adminAuth).send({ name: 'Dairy' })).status).toBe(201);
    expect(await until(async () => (await row('LIVE')).pendingChanges === 0 && (await row('LIVE')).lastPulledAt !== null)).toBe(true);
  });

  it('HQ itself says whether it is backed up, and the answer is "attention" until everything is fine', async () => {
    const r = await get();
    expect(r.backup).toMatchObject({ configured: false, problem: 'BACKUP_NOT_CONFIGURED' });
    expect(r.status).toBe('attention');
    expect(r.summary).toMatchObject({ branches: 2, withProblems: 1 }); // the live one is fine, the one never connected is not
  });

  it('a branch that stops talking is silent, and the time it counts is a choice', async () => {
    // a branch made by hand (no agent running), enrolled long ago and last heard from 45 minutes back
    expect((await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'QUIET', name: 'Quiet branch' })).status).toBe(201);
    await run('UPDATE branches SET enrolled_at = ?, last_seen_at = ? WHERE code = ?', [iso(600), iso(45), 'QUIET']);
    const r = await row('QUIET');
    expect(r.problems).toContain('SILENT');
    expect(r.silentMinutes).toBeGreaterThanOrEqual(45);
    expect((await row('QUIET')).problems).toContain('SILENT');
    expect(
      ((await get('?staleMinutes=120')).branches as { code: string; problems: string[] }[]).find((b) => b.code === 'QUIET')?.problems,
    ).not.toContain('SILENT');
  });

  it('a branch that is there but not pulling, and one that disagrees with HQ, are named', async () => {
    await run('UPDATE branches SET last_seen_at = ?, down_cursor = 0, down_cursor_at = ? WHERE code = ?', [iso(1), iso(60), 'QUIET']);
    const behind = await row('QUIET');
    expect(behind.problems).toEqual(['NOT_PULLING']);
    expect(behind.pendingChanges).toBeGreaterThan(0);
    // a branch and HQ that disagree about a day
    const id = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'QUIET'"))!.id;
    await run(
      "INSERT INTO reconciliations (branch_id, day, status, checked_at, diff_json) VALUES (?, ?, 'mismatch', ?, '[]') ON CONFLICT (branch_id, day) DO UPDATE SET status = 'mismatch'",
      [id, iso(60 * 24).slice(0, 10), iso(5)],
    );
    const both = await row('QUIET');
    expect(both.problems).toEqual(['NOT_PULLING', 'MISMATCH']);
    expect(both).toMatchObject({ mismatchDays: 1, control: { status: 'mismatch' } });
  });

  it('needs a staff sign-in', async () => {
    expect((await hq.http.get(`${api}/monitoring/branches`)).status).toBe(401);
  });
});

describe('with a backup configured', () => {
  it('a recent backup clears the backup problem', async () => {
    const withBackup = await startHq({ backup: { dir: backupDir } });
    try {
      expect((await withBackup.http.get(`${api}/monitoring/branches`).set(adminAuth)).body.backup.problem).toBe('BACKUP_STALE'); // none yet
      expect((await withBackup.http.post(`${api}/backups`).set(adminAuth)).status).toBe(201);
      const r = (await withBackup.http.get(`${api}/monitoring/branches`).set(adminAuth)).body;
      expect(r.backup).toMatchObject({ configured: true, problem: null });
      expect(r.status).toBe('ok'); // no branches, a fresh backup
    } finally {
      await withBackup.close();
    }
  });
});
