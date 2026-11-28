import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { startCtx, type TestCtx } from '../../../branch-server/tests/helpers/app';

// Shared customers (docs/15 §7, P5e slice 1): HQ recognises the same person at two branches by their phone (however it is written) and shows one
// total; a customer with no phone stays at their branch; a connected branch sells on account only to a customer with a phone.
let hq: Hq;
let a: TestCtx;
let b: TestCtx;
let aCashier: string;
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
const newCustomer = async (c: TestCtx, token: string, name: string, phone?: string) =>
  (await c.http.post(`${api}/customers`).set(auth(token)).send({ name, phone })).body.id as number;
const shared = async (q = '') => (await hq.http.get(`${api}/customers?q=${encodeURIComponent(q)}`).set(adminAuth)).body;

beforeAll(async () => {
  hq = await startHq();
  a = await startCtx(opts);
  b = await startCtx(opts);
  aCashier = await a.login('cashier');
  await a.openRegister(aCashier);
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
});
afterAll(async () => {
  await a.close();
  await b.close();
  await hq.close();
});

describe('one person at two branches (US-cust-chain)', () => {
  it('is recognised by phone however it is written, and the balances add up', async () => {
    const adminA = await a.login('admin');
    const adminB = await b.login('admin');
    const atA = await newCustomer(a, aCashier, 'Rima Haddad', '03 123 456');
    const atB = await newCustomer(b, await b.login('cashier'), 'Rima H.', '+961 3 123456');
    await newCustomer(b, await b.login('cashier'), 'Karim Nasr', '71 555 000');
    await newCustomer(a, aCashier, 'No Phone'); // stays at branch A
    // they owe 50,000 at A and 30,000 at B
    await a.app.database.run('UPDATE customers SET balance_lbp = 50000 WHERE id = ?', [atA]);
    await b.app.database.run('UPDATE customers SET balance_lbp = 30000 WHERE id = ?', [atB]);
    void adminA;
    void adminB;

    expect(
      await until(async () => {
        const r = (await shared('3123456')).data as { totalBalanceLbp: number; branches: unknown[] }[];
        return r.length === 1 && r[0]!.totalBalanceLbp === 80000 && r[0]!.branches.length === 2;
      }),
    ).toBe(true);
    const one = (await shared('+961 03 123 456')).data[0];
    expect(one.phoneKey).toBe('9613123456');
    expect(one.branches.map((x: { branch: string; balanceLbp: number }) => [x.branch, x.balanceLbp])).toEqual([
      ['Branch A', 50000],
      ['Branch B', 30000],
    ]);

    // the lookup by phone, any spelling; and another person stays apart
    const byPhone = await hq.http.get(`${api}/customers/by-phone/${encodeURIComponent('00961 3 123 456')}`).set(adminAuth);
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.totalBalanceLbp).toBe(80000);
    expect((await hq.http.get(`${api}/customers/by-phone/70999999`).set(adminAuth)).status).toBe(404);
    expect((await hq.http.get(`${api}/customers/by-phone/abc`).set(adminAuth)).status).toBe(400);
    const owing = (await hq.http.get(`${api}/customers?owing=true`).set(adminAuth)).body.data as { name: string }[];
    expect(owing).toHaveLength(1);

    // the one without a phone is counted, not listed
    const all = await shared();
    expect(all.data.map((p: { name: string }) => p.name)).not.toContain('No Phone');
    expect(all.withoutPhone).toBe(1);

    // a phone changed at the branch moves the person
    await a.http.patch(`${api}/customers/${atA}`).set(auth(adminA)).send({ phone: '70 999 999' });
    expect(await until(async () => (await shared('3123456')).data[0]?.branches.length === 1)).toBe(true);
    expect((await hq.http.get(`${api}/customers/by-phone/70999999`).set(adminAuth)).body.totalBalanceLbp).toBe(50000);
  });

  it('needs a staff sign-in, like every HQ route', async () => {
    expect((await hq.http.get(`${api}/customers`)).status).toBe(401);
  });

  it('a connected branch sells on account only to a customer with a phone', async () => {
    const noPhone = await newCustomer(a, aCashier, 'Walks Without');
    const withPhone = await newCustomer(a, aCashier, 'Has Phone', '03 777 888');
    const sale = (customerId: number) =>
      a.http
        .post(`${api}/sales`)
        .set(auth(aCashier))
        .set('Idempotency-Key', key())
        .send(a.newSaleBody({ customerId, payments: [] }));
    const refused = await sale(noPhone);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('CUSTOMER_NEEDS_PHONE');
    expect((await sale(withPhone)).status).toBe(201);
  });
});
