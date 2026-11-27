import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';

// A real branch server and a real HQ, talking over HTTP (docs/12-sync-and-hq.md P2b): what the branch sells reaches HQ by itself, history
// from before connecting follows in small batches, an outage or a lost answer loses and duplicates nothing, and a check proves the two agree.
let hq: Hq;
let c: TestCtx;
let admin: string;
let cashier: string;
let flaky: { failNext: number; dropAnswerNext: number; calls: number } = { failNext: 0, dropAnswerNext: 0, calls: 0 };
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const status = async () => (await c.http.get(`${api}/sync/status`).set(auth(admin))).body;
const verify = async () => (await c.http.get(`${api}/sync/verify`).set(auth(admin))).body;
const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
};
const sell = async () => {
  const res = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', crypto.randomUUID()).send(c.newSaleBody());
  expect(res.status).toBe(201);
  return res.body;
};
const connect = async (code: string) => {
  const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
  const res = await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol });
  expect(res.status).toBe(200);
};
const inSync = async () => (await verify()).inSync === true;

// The branch's calls to HQ pass through here, so a test can make one fail, or lose the answer after HQ has stored the batch.
const fetchImpl: typeof fetch = async (input, init) => {
  flaky.calls++;
  if (flaky.failNext > 0) {
    flaky.failNext--;
    throw new TypeError('network down');
  }
  const res = await fetch(input, init);
  if (flaky.dropAnswerNext > 0 && String(input).includes('/sync/facts')) {
    flaky.dropAnswerNext--;
    throw new TypeError('the answer was lost');
  }
  return res;
};

beforeAll(async () => {
  hq = await startHq();
  c = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], refusedRetryMs: 150, idleMs: 40, batchSize: 3, fetchImpl } });
  admin = await c.login('admin');
  cashier = await c.login('cashier');
  await c.openRegister(cashier);
});
afterEach(async () => {
  flaky = { failNext: 0, dropAnswerNext: 0, calls: 0 };
  await c.http.post(`${api}/sync/disconnect`).set(auth(admin));
  expect(await until(async () => (await status()).state === 'unlinked')).toBe(true);
});
afterAll(async () => {
  await c.close();
  await hq.close();
});

describe('sales travel to HQ by themselves', () => {
  it('history from before connecting arrives in small batches, then new sales follow within moments (US-HQ-sync)', async () => {
    for (let i = 0; i < 4; i++) await sell(); // before connecting
    await connect('S1');
    expect(await until(inSync)).toBe(true);
    const p = (await status()).progress;
    expect(p).toMatchObject({ capturing: true, pending: 0 });
    expect(p.snapshot.done).toBe(true);

    await sell();
    await sell();
    expect(await until(inSync)).toBe(true);
    const v = await verify();
    const names = v.tables.map((t: { table: string }) => t.table);
    expect(names.slice(0, 4)).toEqual(['sales', 'sale_items', 'payments', 'stock_movements']); // the sale cluster first (P2b), then what P4a added
    for (const t of ['returns', 'register_sessions', 'register_balances', 'expenses', 'purchases', 'wallet_entries'])
      expect(names).toContain(t);
    for (const t of v.tables) expect(t.match, t.table).toBe(true);
    expect(v.tables[0].hq.count).toBeGreaterThanOrEqual(6);
  });

  it('a brand-new, empty connection is in sync at once', async () => {
    await connect('S2');
    expect(await until(inSync)).toBe(true);
  });
});

describe('outages and lost answers lose nothing and duplicate nothing', () => {
  it('sales made while HQ is unreachable arrive, in full, when it comes back, with nobody doing anything', async () => {
    await connect('S3');
    expect(await until(inSync)).toBe(true);
    const { databasePath, port } = hq;
    await hq.stop();
    expect(await until(async () => (await status()).state === 'offline')).toBe(true);
    for (let i = 0; i < 5; i++) await sell(); // the shop carries on
    expect((await status()).progress.pending).toBeGreaterThan(0); // and the backlog is waiting, not lost
    hq = await startHq({ databasePath, port });
    expect(await until(inSync, 15_000)).toBe(true);
    expect((await status()).progress.pending).toBe(0);
  });

  it('a failed call is tried again until it works', async () => {
    await connect('S4');
    expect(await until(inSync)).toBe(true);
    flaky.failNext = 4;
    await sell();
    expect(await until(inSync)).toBe(true);
  });

  it('when HQ stores a batch but the answer is lost, the batch is sent again and HQ ends up with each row once', async () => {
    await connect('S5');
    expect(await until(inSync)).toBe(true);
    flaky.dropAnswerNext = 2;
    await sell();
    await sell();
    expect(await until(inSync)).toBe(true);
    const v = await verify();
    for (const t of v.tables) expect(t.branch.count, t.table).toBe(t.hq.count);
  });
});

describe('changes to a sale that already travelled', () => {
  it('a voided sale arrives as the voided sale', async () => {
    await connect('S6');
    expect(await until(inSync)).toBe(true);
    const sale = await sell();
    expect(await until(inSync)).toBe(true);
    const void_ = await c.http
      .post(`${api}/sales/${sale.id}/void`)
      .set(auth(admin))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ reason: 'test' });
    expect([200, 201]).toContain(void_.status);
    expect(await until(inSync)).toBe(true);
  });

  it('the connection status shows progress, and never a token', async () => {
    await connect('S7');
    expect(await until(inSync)).toBe(true);
    const s = await status();
    expect(s.progress.lastPushAt === null || typeof s.progress.lastPushAt === 'string').toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/token/i);
  });
});

describe('who may check', () => {
  it('only an admin, and only while connected', async () => {
    expect((await c.http.get(`${api}/sync/verify`)).status).toBe(401);
    expect((await c.http.get(`${api}/sync/verify`).set(auth(cashier))).status).toBe(403);
    const res = await c.http.get(`${api}/sync/verify`).set(auth(admin));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CONNECTED');
  });

  it('says plainly when HQ cannot be reached', async () => {
    await connect('S8');
    expect(await until(inSync)).toBe(true);
    const { databasePath, port } = hq;
    await hq.stop();
    const res = await c.http.get(`${api}/sync/verify`).set(auth(admin));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('HQ_UNREACHABLE');
    hq = await startHq({ databasePath, port });
  });
});
