import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase } from '../../branch-server/src/db/open';
import { adminAuth, branchAuth, startHq, type Hq } from './helpers';

// What HQ owns and sends down (docs/12-sync-and-hq.md P2c): the exchange rate is set at HQ, written to a change log in the same transaction,
// and a branch reads the log after the number it remembers.
let hq: Hq;
let token = '';
// A new HQ already has three lines in its log: the units every branch starts with (migration 0004). The rate tests start after them.
let base = 0;
const api = '/api/v1';
const setRate = (rateLbpPerUsd: number, extra: Record<string, unknown> = {}) =>
  hq.http
    .post(`${api}/exchange-rates`)
    .set(adminAuth)
    .send({ rateLbpPerUsd, ...extra });
const changes = (cursor = 0, limit?: number) =>
  hq.http.get(`${api}/sync/changes?cursor=${cursor}${limit ? `&limit=${limit}` : ''}`).set(branchAuth(token));

beforeAll(async () => {
  hq = await startHq();
  const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'D1', name: 'Down' })).body.enrolCode as string;
  token = (await hq.http.post(`${api}/sync/enrol`).send({ code })).body.token as string;
  const seeded = (await changes(0)).body;
  expect(seeded.changes.map((c: { tbl: string; pk: number }) => [c.tbl, c.pk])).toEqual([
    ['units', 1],
    ['units', 2],
    ['units', 3],
  ]);
  base = seeded.next;
});
afterAll(() => hq.close());

describe('the exchange rate at HQ', () => {
  it('only HQ staff may read or set it: not anonymous, not a branch', async () => {
    expect((await hq.http.get(`${api}/exchange-rates`)).status).toBe(401);
    expect((await hq.http.post(`${api}/exchange-rates`).send({ rateLbpPerUsd: 90000 })).status).toBe(401);
    expect((await hq.http.post(`${api}/exchange-rates`).set(branchAuth(token)).send({ rateLbpPerUsd: 90000 })).status).toBe(401);
  });

  it('refuses a rate that is not a whole positive number', async () => {
    for (const bad of [0, -5, 1.5, '90000', null])
      expect((await hq.http.post(`${api}/exchange-rates`).set(adminAuth).send({ rateLbpPerUsd: bad })).status, String(bad)).toBe(400);
  });

  it('adds a rate, newest first in the list, and audits it', async () => {
    const res = await setRate(89500);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ rateLbpPerUsd: 89500 });
    const list = (await hq.http.get(`${api}/exchange-rates`).set(adminAuth)).body.data;
    expect(list[0]).toMatchObject({ rateLbpPerUsd: 89500 });
    const db = openDatabase(hq.databasePath, { readonly: true });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM hq_audit WHERE action = 'rate.add'`).get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('the change log a branch reads', () => {
  it('needs a branch token', async () => {
    expect((await hq.http.get(`${api}/sync/changes?cursor=0`)).status).toBe(401);
    expect((await hq.http.get(`${api}/sync/changes?cursor=0`).set(adminAuth)).status).toBe(401);
  });

  it('gives each change with the row as it is, in order, and where to ask next', async () => {
    await setRate(90000);
    await setRate(91000, { effectiveFrom: '2030-01-01T00:00:00.000Z' });
    const res = await changes(base);
    expect(res.status).toBe(200);
    expect(res.body.more).toBe(false);
    expect(res.body.changes.map((c: { tbl: string; op: string }) => [c.tbl, c.op])).toEqual([
      ['exchange_rates', 'u'],
      ['exchange_rates', 'u'],
      ['exchange_rates', 'u'],
    ]);
    const seqs = res.body.changes.map((c: { seq: number }) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(res.body.next).toBe(seqs[seqs.length - 1]);
    expect(res.body.changes[2].row).toMatchObject({ rate_lbp_per_usd: 91000, effective_from: '2030-01-01T00:00:00.000Z' });
  });

  it('pages: a small limit says there is more, and asking again after `next` continues without a gap or a repeat', async () => {
    const first = (await changes(base, 2)).body;
    expect(first.changes).toHaveLength(2);
    expect(first.more).toBe(true);
    const second = (await changes(first.next, 2)).body;
    expect(second.changes).toHaveLength(1);
    expect(second.more).toBe(false);
    const all = [...first.changes, ...second.changes].map((c: { seq: number }) => c.seq);
    expect(new Set(all).size).toBe(3);
  });

  it('nothing after the last number: an empty page that keeps the number', async () => {
    const last = (await changes(0)).body.next;
    const res = await changes(last);
    expect(res.body).toEqual({ changes: [], next: last, more: false });
  });

  it('refuses a cursor or limit that is not a number', async () => {
    expect((await hq.http.get(`${api}/sync/changes?cursor=abc`).set(branchAuth(token))).status).toBe(400);
    expect((await hq.http.get(`${api}/sync/changes?cursor=-1`).set(branchAuth(token))).status).toBe(400);
    expect((await hq.http.get(`${api}/sync/changes?cursor=0&limit=100000`).set(branchAuth(token))).status).toBe(400);
  });

  it('the log is append-only: the database refuses an edit or a delete', () => {
    const db = openDatabase(hq.databasePath);
    expect(() => db.prepare('UPDATE change_log SET pk = 9').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM change_log').run()).toThrow(/append-only/);
    db.close();
  });
});
