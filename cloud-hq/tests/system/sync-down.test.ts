import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { pullOnce } from '../../../branch-server/src/modules/sync/down';
import { getLink } from '../../../branch-server/src/modules/sync/service';

// What HQ owns reaches the branch by itself (docs/12-sync-and-hq.md P2c): the exchange rate set at HQ becomes the rate the till sells at.
let hq: Hq;
let c: TestCtx;
let admin: string;
let cashier: string;
let failNext = 0;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const status = async () => (await c.http.get(`${api}/sync/status`).set(auth(admin))).body;
const rate = async () => (await c.http.get(`${api}/exchange-rates/current`).set(auth(cashier))).body.rateLbpPerUsd as number;
const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
};
const setAtHq = (rateLbpPerUsd: number, extra: Record<string, unknown> = {}) =>
  hq.http
    .post(`${api}/exchange-rates`)
    .set(adminAuth)
    .send({ rateLbpPerUsd, ...extra });
const connect = async (code: string) => {
  const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
  expect((await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol })).status).toBe(200);
};
const fetchImpl: typeof fetch = async (input, init) => {
  if (failNext > 0) {
    failNext--;
    throw new TypeError('network down');
  }
  return fetch(input, init);
};

beforeAll(async () => {
  hq = await startHq();
  c = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], refusedRetryMs: 150, idleMs: 40, fetchImpl } });
  admin = await c.login('admin');
  cashier = await c.login('cashier');
});
afterEach(async () => {
  failNext = 0;
  await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
  expect(await until(async () => (await status()).state === 'unlinked')).toBe(true);
});
afterAll(async () => {
  await c.close();
  await hq.close();
});

describe('the exchange rate comes down from HQ', () => {
  it('a rate set at HQ becomes the branch’s rate by itself, and the screens are told (US-HQ-rate)', async () => {
    const heard: string[] = [];
    const stop = c.app.events.tap((e) => heard.push(e.type));
    const before = await rate();
    await connect('R1');
    await setAtHq(before + 1234);
    expect(await until(async () => (await rate()) === before + 1234)).toBe(true);
    expect(heard).toContain('rate.changed');
    stop();
  });

  it('a sale after that is made at the new rate, and an older sale keeps its own', async () => {
    await connect('R2');
    await c.openRegister(cashier);
    const old = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', crypto.randomUUID()).send(c.newSaleBody());
    expect(old.status).toBe(201);
    await setAtHq(95500);
    expect(await until(async () => (await rate()) === 95500)).toBe(true);
    const fresh = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', crypto.randomUUID()).send(c.newSaleBody());
    expect(fresh.body.rateLbpPerUsd ?? fresh.body.rate).toBe(95500);
    const again = await c.http.get(`${api}/sales/${old.body.id}`).set(auth(cashier));
    expect(again.body.rateLbpPerUsd ?? again.body.rate).not.toBe(95500);
  });

  it('a rate that starts in the future does not apply yet', async () => {
    await connect('R3');
    const before = await rate();
    await setAtHq(before + 777, { effectiveFrom: '2099-01-01T00:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 500));
    expect(await rate()).toBe(before);
  });

  it('while connected the branch cannot set its own rate (it would fight HQ); not connected, it can', async () => {
    await connect('R4');
    const refused = await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 91234 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('HQ_OWNS_RATES');
    await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
    expect((await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 91234 })).status).toBe(201);
  });
});

describe('outages and repeats lose nothing', () => {
  it('a failed call is tried again until it works', async () => {
    await connect('R5');
    const before = await rate();
    failNext = 4;
    await setAtHq(before + 5);
    expect(await until(async () => (await rate()) === before + 5)).toBe(true);
  });

  it('a rate set while the branch cannot reach HQ arrives when it can, with nobody doing anything', async () => {
    await connect('R6');
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    const { databasePath, port } = hq;
    await hq.stop();
    expect(await until(async () => (await status()).state === 'offline')).toBe(true);
    hq = await startHq({ databasePath, port });
    const target = (await rate()) + 9;
    await setAtHq(target);
    expect(await until(async () => (await rate()) === target, 15_000)).toBe(true);
  });

  it('applying the same page again changes nothing (a lost answer, a repeat)', async () => {
    await connect('R7');
    const target = (await rate()) + 3;
    await setAtHq(target);
    expect(await until(async () => (await rate()) === target)).toBe(true);
    const count = () => c.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM exchange_rates');
    const before = await count();
    await c.app.database.run('UPDATE sync_control SET down_cursor = 0 WHERE id = 1'); // forget how far it got
    const link = (await getLink(c.app.database))!;
    const r = await pullOnce(c.app.database, link);
    expect('applied' in r && r.applied).toBeGreaterThan(0);
    expect(await count()).toEqual(before);
  });

  it('a page that arrives after the branch was disconnected or connected elsewhere is not applied', async () => {
    await connect('R7b');
    const link = (await getLink(c.app.database))!;
    // A page only this test could make (the live loop cannot): a rate with an id HQ never used.
    const page = async () =>
      new Response(
        JSON.stringify({
          changes: [
            {
              seq: 999_999,
              tbl: 'exchange_rates',
              pk: 99_999,
              op: 'u',
              row: {
                id: 99_999,
                rate_lbp_per_usd: 12345,
                effective_from: '2001-01-01T00:00:00.000Z',
                created_at: '2001-01-01T00:00:00.000Z',
              },
            },
          ],
          next: 999_999,
          more: false,
        }),
        { status: 200 },
      );
    const stale = { ...link, connectedAt: '2000-01-01T00:00:00.000Z' }; // the link it was asked under is gone
    const r = await pullOnce(c.app.database, stale, { fetchImpl: page as unknown as typeof fetch });
    expect(r).toMatchObject({ applied: 0, changed: [] });
    expect(await c.app.database.one('SELECT 1 FROM exchange_rates WHERE hq_id = 99999')).toBeUndefined();
    // and under the real link the same page IS applied (so the test above proves the check, not a broken page)
    const ok = await pullOnce(c.app.database, link, { fetchImpl: page as unknown as typeof fetch });
    expect(ok).toMatchObject({ applied: 1 });
    expect(await c.app.database.one('SELECT 1 FROM exchange_rates WHERE hq_id = 99999')).toBeTruthy();
  });

  it('pulls a long log page by page', async () => {
    await connect('R8');
    for (let i = 0; i < 5; i++) await setAtHq(80000 + i);
    expect(await until(async () => (await rate()) === 80004)).toBe(true);
    await c.app.database.run('UPDATE sync_control SET down_cursor = 0 WHERE id = 1');
    const link = (await getLink(c.app.database))!;
    let pages = 0;
    for (;;) {
      const r = await pullOnce(c.app.database, link, { limit: 2 });
      expect('error' in r).toBe(false);
      pages++;
      if (!('more' in r) || !r.more) break;
    }
    expect(pages).toBeGreaterThan(1);
  });

  it('a page HQ sends that this branch cannot read is refused whole and the number does not move', async () => {
    await connect('R9');
    const link = (await getLink(c.app.database))!;
    const cursor = async () =>
      (await c.app.database.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))!.down_cursor;
    const before = await cursor();
    const bad = async () =>
      new Response(
        JSON.stringify({
          changes: [{ seq: before + 1, tbl: 'exchange_rates', pk: 1, op: 'u', row: { id: 1, rate_lbp_per_usd: 1.5 } }],
          next: before + 1,
          more: false,
        }),
        {
          status: 200,
        },
      );
    const r = await pullOnce(c.app.database, link, { fetchImpl: bad as unknown as typeof fetch });
    expect('error' in r).toBe(true);
    expect(await cursor()).toBe(before);
  });

  it('connecting again starts from the beginning of HQ’s log', async () => {
    await connect('R10');
    expect(await until(async () => (await status()).state === 'online')).toBe(true);
    await setAtHq(70001);
    expect(await until(async () => (await rate()) === 70001)).toBe(true);
    await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
    expect(await until(async () => (await status()).state === 'unlinked')).toBe(true);
    expect((await c.app.database.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))!.down_cursor).toBe(0);
  });
});
