import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';

// Paying across branches (docs/15 §7.2, P5e step 2): a customer who owes at two branches pays at one. That branch's own sales take what they can; HQ
// places the rest on the person's oldest sales at the other branch, which applies it itself. The money is counted once, where it was taken.
let hq: Hq;
let a: TestCtx;
let b: TestCtx;
let aCashier: string;
let bCashier: string;
let atA = 0;
let atB = 0;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = () => crypto.randomUUID();
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const opts = { sync: { intervalMs: 60, backoffMs: [60, 200], idleMs: 40 } };
const person = async () =>
  (await hq.http.get(`${api}/customers/by-phone/${encodeURIComponent('03 456 789')}`).set(adminAuth)).body as {
    totalBalanceLbp: number;
    unplacedLbp: number;
    branches: { branch: string; balanceLbp: number }[];
  };
const credit = (c: TestCtx, token: string, customerId: number) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(token))
    .set('Idempotency-Key', key())
    .send(c.newSaleBody({ customerId, payments: [] }));
const pay = (c: TestCtx, token: string, customerId: number, amount: number, acrossChain = true) =>
  c.http
    .post(`${api}/customers/${customerId}/payments`)
    .set(auth(token))
    .set('Idempotency-Key', key())
    .send({ method: 'cash', currency: 'LBP', amount, acrossChain });
const balance = async (c: TestCtx, id: number) =>
  (await c.app.database.one<{ b: number }>('SELECT balance_lbp AS b FROM customers WHERE id = ?', [id]))!.b;
const othersAt = async (c: TestCtx, id: number) =>
  (await c.app.database.one<{ o: number }>('SELECT others_lbp AS o FROM customer_chain WHERE customer_id = ?', [id]))?.o;
const cashExpected = async (c: TestCtx, token: string) => {
  const cur = (await c.http.get(`${api}/registers/current`).set(auth(token))).body;
  return (cur.balances as { method: string; currency: string; expected: number }[]).find(
    (x) => x.method === 'cash' && x.currency === 'LBP',
  )!.expected;
};
const openSales = async (c: TestCtx, id: number) =>
  (await c.app.database.all<{ id: number }>('SELECT id FROM sales WHERE customer_id = ? AND rest_lbp > 0', [id])).length;

beforeAll(async () => {
  hq = await startHq();
  a = await startCtx(opts);
  b = await startCtx(opts);
  aCashier = await a.login('cashier');
  bCashier = await b.login('cashier');
  await a.openRegister(aCashier);
  await b.openRegister(bCashier);
  for (const [c, code] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    const enrol = (
      await hq.http
        .post(`${api}/branches`)
        .set(adminAuth)
        .send({ code, name: `Branch ${code}` })
    ).body.enrolCode as string;
    expect(
      (
        await c.http
          .post(`${api}/sync/connect`)
          .set(auth(await c.login('admin')))
          .send({ url: hq.url, code: enrol })
      ).status,
    ).toBe(200);
  }
  atA = (await a.http.post(`${api}/customers`).set(auth(aCashier)).send({ name: 'Nada Saad', phone: '03 456 789' })).body.id;
  atB = (await b.http.post(`${api}/customers`).set(auth(bCashier)).send({ name: 'Nada S.', phone: '+961 3 456789' })).body.id;
});
afterAll(async () => {
  await a.close();
  await b.close();
  await hq.close();
});

describe('a debt at two branches is paid at one (US-cust-chain-pay)', () => {
  it('the branch applies its own sales first and HQ places the rest at the other branch, once, counting the cash where it was taken', async () => {
    // owes 2 sales (150,000) at A, 1 sale (75,000) at B
    expect((await credit(a, aCashier, atA)).status).toBe(201);
    expect((await credit(a, aCashier, atA)).status).toBe(201);
    expect((await credit(b, bCashier, atB)).status).toBe(201);
    expect(await until(async () => (await person()).totalBalanceLbp === 225000)).toBe(true);
    // B learns what the person owes elsewhere (a hint at the till)
    expect(await until(async () => (await othersAt(b, atB)) === 150000)).toBe(true);

    const aCash = await cashExpected(a, aCashier);
    const bCash = await cashExpected(b, bCashier);
    const paid = await pay(b, bCashier, atB, 150000);
    expect(paid.status).toBe(201);
    expect(paid.body.chainLbp).toBe(75000); // 75,000 paid B's own sale, 75,000 is for A
    expect(paid.body.balanceLbp).toBe(0);
    expect(await cashExpected(b, bCashier)).toBe(bCash + 150000);

    // A applies HQ's order to its OLDEST sale, with no cash in its register
    expect(await until(async () => (await balance(a, atA)) === 75000)).toBe(true);
    expect(await openSales(a, atA)).toBe(1);
    expect(await cashExpected(a, aCashier)).toBe(aCash);
    const order = await a.app.database.one<{ n: number; s: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(amount_lbp), 0) AS s FROM customer_payments WHERE customer_id = ? AND session_id IS NULL',
      [atA],
    );
    expect(order).toEqual({ n: 1, s: 75000 });
    expect((await a.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM payments WHERE customer_payment_id IS NOT NULL'))!.n).toBe(
      0,
    );

    // HQ agrees: 75,000 still owed, all at A, nothing waiting
    expect(await until(async () => (await person()).totalBalanceLbp === 75000 && (await person()).unplacedLbp === 0)).toBe(true);
    expect((await person()).branches.find((x) => x.branch === 'Branch A')?.balanceLbp).toBe(75000);
    // and B's hint follows
    expect(await until(async () => (await othersAt(b, atB)) === 75000)).toBe(true);
  });

  it('refuses more than the person owes across the chain', async () => {
    const r = await pay(b, bCashier, atB, 100000);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    // not across the chain: the old rule still holds (B itself is owed nothing)
    expect((await pay(b, bCashier, atB, 5000, false)).body.code).toBe('PAYMENT_EXCEEDS_BALANCE');
  });

  it('what cannot be placed waits, and is placed when the person owes again', async () => {
    // A is paid locally while B still thinks 75,000 is owed there (a stale hint, set by hand)
    expect((await pay(a, aCashier, atA, 75000, false)).status).toBe(201);
    expect(await until(async () => (await person()).totalBalanceLbp === 0)).toBe(true);
    await b.app.database.run('UPDATE customer_chain SET others_lbp = 75000 WHERE customer_id = ?', [atB]);
    const stale = await pay(b, bCashier, atB, 75000);
    expect(stale.status).toBe(201);
    expect(stale.body.chainLbp).toBe(75000);
    expect(await until(async () => (await person()).unplacedLbp === 75000)).toBe(true); // nothing to place it on: visible, not lost

    // the person buys on account at A again: HQ places the waiting payment on that sale
    expect((await credit(a, aCashier, atA)).status).toBe(201);
    expect(await until(async () => (await person()).unplacedLbp === 0)).toBe(true);
    expect(await until(async () => (await balance(a, atA)) === 0)).toBe(true);
    expect(await openSales(a, atA)).toBe(0);
    expect((await person()).totalBalanceLbp).toBe(0);
  });

  it('a payment across the chain needs a customer with a phone', async () => {
    const lone = (await b.http.post(`${api}/customers`).set(auth(bCashier)).send({ name: 'No Phone' })).body.id as number;
    expect((await pay(b, bCashier, lone, 1000)).body.code).toBe('CUSTOMER_NEEDS_PHONE');
  });
});
