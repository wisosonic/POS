import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';
import { SYNC_TABLES } from '../../../branch-server/core/src/sync';

// Everything a branch records goes up to HQ (docs/12 §22, P4a): returns, customer payments, registers, expenses, purchases, wallets and
// services, as well as the sales. A branch does every kind of business, half of it BEFORE it connects (history, sent by the snapshot) and half
// after (sent as it happens); HQ then holds exactly what the branch holds, table by table, and keeps two branches apart.
let hq: Hq;
let c: TestCtx;
let admin: string;
let manager: string;
let cashier: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = () => crypto.randomUUID();
const verify = async () => (await c.http.get(`${api}/sync/verify`).set(auth(admin))).body;
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

const sell = (over: Record<string, unknown> = {}) =>
  c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key()).send(c.newSaleBody(over));
const giveBack = async (saleId: number) => {
  const sale = (await c.http.get(`${api}/sales/${saleId}`).set(auth(cashier))).body;
  return c.http
    .post(`${api}/returns`)
    .set(auth(manager))
    .set('Idempotency-Key', key())
    .send({
      saleId,
      items: [{ saleItemId: sale.items[0].id, qty: '1' }],
      reason: 'changed mind',
      refund: { method: 'cash', currency: 'LBP', amount: 75000 },
    });
};
const expense = (title: string) => c.http.post(`${api}/expenses`).set(auth(manager)).send({ title, amountMinor: 200_000, currency: 'LBP' });
const receivePurchase = async () => {
  const made = await c.http
    .post(`${api}/purchases`)
    .set(auth(manager))
    .send({
      supplierId: c.seed.suppliers.main.id,
      currency: 'LBP',
      items: [{ productId: c.seed.products.choc.id, qty: '5', costMinor: 38000 }],
    });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const got = await c.http.post(`${api}/purchases/${made.body.id}/receive`).set(auth(manager)).set('Idempotency-Key', key()).send({});
  expect(got.status, JSON.stringify(got.body)).toBeLessThan(300);
  const paid = await c.http
    .post(`${api}/purchases/${made.body.id}/payments`)
    .set(auth(manager))
    .set('Idempotency-Key', key())
    .send({ amountMinor: 100000, note: 'deposit' });
  expect(paid.status, JSON.stringify(paid.body)).toBeLessThan(300);
};
const service = () =>
  c.http.post(`${api}/services`).set(auth(manager)).set('Idempotency-Key', key()).send({ costMinor: 0, feeMinor: 50000, currency: 'LBP' });
const wallets = (amount = 0) =>
  c.http
    .post(`${api}/wallets/counts`)
    .set(auth(manager))
    .send({
      balances: ['whish', 'omt'].flatMap((method) => ['LBP', 'USD'].map((currency) => ({ method, currency, amount }))),
    });

/** A day's business of every kind. */
async function aDay(tag: string) {
  const a = await sell();
  expect(a.status).toBe(201);
  expect((await giveBack(a.body.id)).status).toBe(201);
  expect((await expense(`Electricity ${tag}`)).status).toBe(201);
  await receivePurchase();
  expect((await service()).status).toBe(201);
  expect((await sell({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] })).status).toBe(201); // a wallet payment
  expect((await wallets()).status).toBeLessThan(300);
  const who = (
    await c.http
      .post(`${api}/customers`)
      .set(auth(cashier))
      .send({ name: `Credit ${tag}` })
  ).body as { id: number };
  expect((await sell({ customerId: who.id, payments: [] })).status).toBe(201); // on account
  expect(
    (
      await c.http
        .post(`${api}/customers/${who.id}/payments`)
        .set(auth(cashier))
        .set('Idempotency-Key', key())
        .send({ method: 'cash', currency: 'LBP', amount: 30000 })
    ).status,
  ).toBe(201);
}

beforeAll(async () => {
  hq = await startHq();
  c = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
  admin = await c.login('admin');
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  await c.openRegister(cashier);
});
afterAll(async () => {
  await c.close();
  await hq.close();
});

describe('everything a branch records reaches HQ (US-HQ-records)', () => {
  it('history from before connecting and business done afterwards, of every kind, ends identical at HQ', async () => {
    await aDay('before');
    const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'REC', name: 'Records' })).body.enrolCode as string;
    expect((await c.http.post(`${api}/sync/connect`).set(auth(admin)).send({ url: hq.url, code })).status).toBe(200);
    await aDay('after');
    // close the register with exactly what is expected, so the Z-report (the balances) is final too
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(manager))).body;
    const counted = (cur.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    const closed = await c.http.post(`${api}/registers/${cur.id}/close`).set(auth(manager)).send({ countedBalances: counted });
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);

    expect(await until(async () => (await verify()).inSync === true)).toBe(true);
    const v = await verify();
    expect(v.tables.map((t: { table: string }) => t.table)).toEqual(SYNC_TABLES.map((t) => t.name));
    for (const t of v.tables as { table: string; match: boolean; branch: { count: number }; hq: { count: number } }[]) {
      expect(t.match, t.table).toBe(true);
      expect(t.hq.count, t.table).toBe(t.branch.count);
    }
    // every kind of business really happened (the test cannot pass by comparing two empty tables)
    const n = (name: string) => (v.tables as { table: string; hq: { count: number } }[]).find((t) => t.table === name)!.hq.count;
    for (const name of [
      'sales',
      'returns',
      'return_items',
      'customer_payments',
      'register_sessions',
      'register_balances',
      'expenses',
      'purchases',
      'purchase_items',
      'purchase_payments',
      'wallet_entries',
      'wallet_counts',
      'service_sales',
      'stock_movements',
    ])
      expect(n(name), name).toBeGreaterThan(0);
  });

  it('a register session arrives with its final figures: counted, variance and the closed state', async () => {
    const rows = hq.app.database;
    const s = await rows.one<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM register_sessions GROUP BY status`);
    expect(s).toMatchObject({ status: 'closed', n: 1 });
    const bal = await rows.all<{ method: string; currency: string; counted: number | null; variance: number | null }>(
      'SELECT method, currency, counted, variance FROM register_balances ORDER BY method, currency',
    );
    expect(bal.length).toBeGreaterThanOrEqual(2);
    for (const b of bal) expect([b.counted !== null, b.variance]).toEqual([true, 0]);
  });

  it('a later change to a row (a balance, a purchase) reaches HQ again, and a second branch is kept apart', async () => {
    const before = (await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM purchases'))!.n;
    await c.http
      .post(`${api}/registers/open`)
      .set(auth(cashier))
      .send({
        terminalId: 'T1',
        openingBalances: [
          { method: 'cash', currency: 'USD', amount: 0 },
          { method: 'cash', currency: 'LBP', amount: 0 },
        ],
      });
    await receivePurchase();
    expect(await until(async () => (await verify()).inSync === true)).toBe(true);
    expect((await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM purchases'))!.n).toBe(before + 1);
    // a second branch with the very same ids: HQ keeps both, each under its own branch
    const c2 = await startCtx({ sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } });
    try {
      const admin2 = await c2.login('admin');
      const manager2 = await c2.login('manager');
      const cashier2 = await c2.login('cashier');
      await c2.openRegister(cashier2);
      const code = (await hq.http.post(`${api}/branches`).set(adminAuth).send({ code: 'RE2', name: 'Second' })).body.enrolCode as string;
      expect((await c2.http.post(`${api}/sync/connect`).set(auth(admin2)).send({ url: hq.url, code })).status).toBe(200);
      expect(
        (await c2.http.post(`${api}/expenses`).set(auth(manager2)).send({ title: 'Other branch', amountMinor: 5000, currency: 'LBP' }))
          .status,
      ).toBe(201);
      const sessions = () =>
        hq.app.database.all<{ branch_id: number; id: number }>(
          'SELECT branch_id, id FROM register_sessions WHERE id = 1 ORDER BY branch_id',
        );
      expect(await until(async () => (await sessions()).length === 2)).toBe(true); // both branches have a session number 1
      const expenses = await hq.app.database.all<{ branch_id: number; title: string }>(
        "SELECT branch_id, title FROM expenses WHERE title = 'Other branch'",
      );
      expect(expenses).toHaveLength(1);
      const first = (await hq.app.database.one<{ id: number }>("SELECT id FROM branches WHERE code = 'REC'"))!.id;
      expect(expenses[0]!.branch_id).not.toBe(first); // it is the second branch's, not the first's
    } finally {
      await c2.close();
    }
  });
});
