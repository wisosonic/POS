import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../../branch-server/src/app';
import { openDatabase } from '../../../branch-server/src/db/open';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';

// P2d (docs/12-sync-and-hq.md §16): HQ and TWO real branches, real HTTP, throwaway files. Both branches are seeded the same way, so they
// have the same ids and the same receipt numbers: HQ must keep them apart. Then the connections are made to fail in random ways while both
// branches sell, and in the end HQ must hold exactly what each branch holds, once.
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const FAST = { intervalMs: 50, backoffMs: [40, 150] as [number, number], refusedRetryMs: 150, idleMs: 40, batchSize: 4 };

// A small seeded random generator, so a failing run can be repeated.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

type Branch = { ctx: TestCtx; admin: string; cashier: string; code: string };
let hq: Hq;
let a: Branch;
let b: Branch;
let chaos = { failRate: 0, dropRate: 0, next: rng(1) };

// Every call a branch makes to HQ passes through here, so the network can be made to misbehave: refuse a call, or let HQ store a batch and
// then lose the answer.
const flaky: typeof fetch = async (input, init) => {
  if (chaos.next() < chaos.failRate) throw new TypeError('network down');
  const res = await fetch(input, init);
  if (String(input).includes('/sync/facts') && chaos.next() < chaos.dropRate) throw new TypeError('the answer was lost');
  return res;
};

const until = async (check: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return check();
};
const start = async (code: string): Promise<Branch> => {
  const ctx = await startCtx({ sync: { ...FAST, fetchImpl: flaky } });
  const admin = await ctx.login('admin');
  const cashier = await ctx.login('cashier');
  await ctx.openRegister(cashier);
  const enrol = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name: code })).body.enrolCode as string;
  expect((await ctx.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code: enrol })).status).toBe(200);
  return { ctx, admin, cashier, code };
};
const sell = async (br: Branch, n: number) => {
  for (let i = 0; i < n; i++) {
    const res = await br.ctx.http
      .post(`${api}/sales`)
      .set(auth(br.cashier))
      .set('Idempotency-Key', crypto.randomUUID())
      .send(br.ctx.newSaleBody());
    expect(res.status).toBe(201);
  }
};
const inSync = async (br: Branch) => (await br.ctx.http.get(`${api}/sync/verify`).set(auth(br.admin))).body.inSync === true;
const bothInSync = async () => (await inSync(a)) && (await inSync(b));

/** What a database holds of the sale cluster: row counts and sums that must agree between a branch and HQ's copy of it. */
const figures = (path: string, branchId?: number) => {
  const db = openDatabase(path, { readonly: true });
  const where = branchId === undefined ? '' : `WHERE branch_id = ${branchId}`;
  const one = (sql: string) => db.prepare(sql).get() as Record<string, number>;
  const out = {
    sales: one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_lbp), 0) AS total FROM sales ${where}`),
    items: one(`SELECT COUNT(*) AS n, COALESCE(SUM(line_total_lbp), 0) AS total FROM sale_items ${where}`),
    payments: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments ${where}`),
    moves: one(`SELECT COUNT(*) AS n, COALESCE(SUM(qty_milli_delta), 0) AS total FROM stock_movements ${where}`),
  };
  db.close();
  return out;
};
const hqBranchId = (code: string) => {
  const db = openDatabase(hq.databasePath, { readonly: true });
  const row = db.prepare('SELECT id FROM branches WHERE code = ?').get(code) as { id: number };
  db.close();
  return row.id;
};

beforeAll(async () => {
  hq = await startHq();
  chaos = { failRate: 0, dropRate: 0, next: rng(1) };
  a = await start('CA');
  b = await start('CB');
});
afterAll(async () => {
  await a.ctx.close();
  await b.ctx.close();
  await hq.close();
});

describe('two branches and HQ', () => {
  it('two branches with the same ids and the same receipt numbers stay apart at HQ, and add up (US-HQ-two)', async () => {
    await sell(a, 3);
    await sell(b, 2);
    expect(await until(bothInSync)).toBe(true);
    const fa = figures(a.ctx.databasePath);
    const fb = figures(b.ctx.databasePath);
    expect(figures(hq.databasePath, hqBranchId('CA'))).toEqual(fa);
    expect(figures(hq.databasePath, hqBranchId('CB'))).toEqual(fb);
    // and HQ as a whole is the sum of the branches
    const all = figures(hq.databasePath);
    expect(all.sales.n).toBe(fa.sales.n! + fb.sales.n!);
    expect(all.sales.total).toBe(fa.sales.total! + fb.sales.total!);
    expect(all.moves.total).toBe(fa.moves.total! + fb.moves.total!);
  });

  it('a rate set at HQ reaches both branches, and each sells at it', async () => {
    await hq.http.post(`${api}/exchange-rates`).set(adminAuth).send({ rateLbpPerUsd: 93333 });
    for (const br of [a, b])
      expect(
        await until(
          async () => (await br.ctx.http.get(`${api}/exchange-rates/current`).set(auth(br.cashier))).body.rateLbpPerUsd === 93333,
        ),
      ).toBe(true);
  });

  it('both sell while HQ is gone; when it returns both catch up, with nobody doing anything', async () => {
    const { databasePath, port } = hq;
    await hq.stop();
    await sell(a, 6);
    await sell(b, 4);
    expect((await a.ctx.http.get(`${api}/sync/status`).set(auth(a.admin))).body.progress.pending).toBeGreaterThan(0);
    hq = await startHq({ databasePath, port });
    expect(await until(bothInSync)).toBe(true);
    expect(figures(hq.databasePath, hqBranchId('CA'))).toEqual(figures(a.ctx.databasePath));
    expect(figures(hq.databasePath, hqBranchId('CB'))).toEqual(figures(b.ctx.databasePath));
  });

  it('with the network failing and losing answers at random while both sell, HQ still ends up with each row once', async () => {
    chaos = { failRate: 0.3, dropRate: 0.3, next: rng(42) };
    await Promise.all([sell(a, 12), sell(b, 12)]); // at the same time
    chaos.failRate = 0;
    chaos.dropRate = 0;
    expect(await until(bothInSync, 60_000)).toBe(true);
    expect(figures(hq.databasePath, hqBranchId('CA'))).toEqual(figures(a.ctx.databasePath));
    expect(figures(hq.databasePath, hqBranchId('CB'))).toEqual(figures(b.ctx.databasePath));
  }, 90_000);

  it('a branch server that is stopped and started again in the middle of a backlog carries on where it stopped', async () => {
    const { databasePath, port } = hq;
    await hq.stop();
    await sell(b, 7);
    const pending = (await b.ctx.http.get(`${api}/sync/status`).set(auth(b.admin))).body.progress.pending;
    expect(pending).toBeGreaterThan(0);

    // stop branch B (a power cut at the branch) and start it again on the same database
    await b.ctx.app.close();
    const again = await buildApp({
      databasePath: b.ctx.databasePath,
      logger: false,
      reports: { worker: false },
      sync: { ...FAST, fetchImpl: flaky },
    });
    await again.ready();
    await again.listen({ host: '127.0.0.1', port: 0 });
    const addr = again.server.address();
    const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    const login = await fetch(`${url}${api}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: b.ctx.seed.users.admin.username, password: b.ctx.seed.users.admin.password }),
    });
    const token = ((await login.json()) as { accessToken: string }).accessToken;
    expect(((await (await fetch(`${url}${api}/sync/status`, { headers: auth(token) })).json()) as { linked: boolean }).linked).toBe(true); // still connected

    hq = await startHq({ databasePath, port });
    const verified = async () =>
      ((await (await fetch(`${url}${api}/sync/verify`, { headers: auth(token) })).json()) as { inSync: boolean }).inSync === true;
    expect(await until(verified)).toBe(true);
    expect(figures(hq.databasePath, hqBranchId('CB'))).toEqual(figures(b.ctx.databasePath));
    await again.close();
    // (the first app was already closed: give the context a harmless second close)
    b.ctx.close = async () => {};
  });
});
