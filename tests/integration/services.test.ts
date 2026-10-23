import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-36: service income (IT support, a repair): what it cost, what the customer paid, and the money going into the register.
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const service = (over: Record<string, unknown> = {}, key = randomUUID(), token = manager) =>
  c.http
    .post(`${api}/services`)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send({ costMinor: 0, feeMinor: 50000, currency: 'LBP', ...over });
const bucket = async (method: string, currency: string) =>
  (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body.balances.find(
    (b: { method: string; currency: string }) => b.method === method && b.currency === currency,
  ).expected as number;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('service types', () => {
  it('are a list like the others: add, no duplicate names, rename', async () => {
    const made = await c.http.post(`${api}/service-categories`).set(auth(manager)).send({ name: 'CCTV' });
    expect(made.status).toBe(201);
    expect((await c.http.post(`${api}/service-categories`).set(auth(manager)).send({ name: 'cctv' })).status).toBe(409);
    expect(
      (await c.http.patch(`${api}/service-categories/${made.body.id}`).set(auth(manager)).send({ name: 'CCTV installs' })).body.name,
    ).toBe('CCTV installs');
    expect((await c.http.get(`${api}/service-categories`).set(auth(cashier))).body.data.map((x: { name: string }) => x.name)).toContain(
      'CCTV installs',
    );
    expect((await c.http.post(`${api}/service-categories`).set(auth(cashier)).send({ name: 'Nope' })).status).toBe(403);
  });
});

describe('recording a service', () => {
  it('works out the profit, takes the next reference, and puts the money into the register balance it was paid into', async () => {
    const cat = (await c.http.post(`${api}/service-categories`).set(auth(manager)).send({ name: 'IT support' })).body.id as number;
    const before = await bucket('cash', 'LBP');
    const a = await service({ categoryId: cat, costMinor: 20000, feeMinor: 50000, note: 'router', receivedInto: { method: 'cash' } });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      categoryName: 'IT support',
      costMinor: 20000,
      feeMinor: 50000,
      profitMinor: 30000,
      currency: 'LBP',
      receivedAtTill: true,
      note: 'router',
    });
    expect(await bucket('cash', 'LBP')).toBe(before + 50000);
    const b = await service({ receivedInto: { method: 'cash' } });
    expect(Number(b.body.reference)).toBe(Number(a.body.reference) + 1);
    expect(Number(a.body.reference)).toBeGreaterThanOrEqual(5003); // the old app's last reference was 5002
  });

  it('a dollar service goes into the dollar balance of the wallet it was paid into', async () => {
    const before = await bucket('whish', 'USD');
    const res = await service({ currency: 'USD', costMinor: 1000, feeMinor: 2500, receivedInto: { method: 'whish' } });
    expect(res.body.profitMinor).toBe(1500);
    expect(await bucket('whish', 'USD')).toBe(before + 2500);
  });

  it('paid some other way: recorded, and the register is not touched', async () => {
    const before = await bucket('cash', 'LBP');
    const res = await service({ feeMinor: 75000 });
    expect(res.status).toBe(201);
    expect(res.body.receivedAtTill).toBe(false);
    expect(await bucket('cash', 'LBP')).toBe(before);
  });

  it('a service that cost more than it earned has a negative profit, and a customer can be named', async () => {
    const res = await service({ costMinor: 90000, feeMinor: 50000, customerId: 2 });
    expect(res.body).toMatchObject({ profitMinor: -40000, customerId: 2, customerName: expect.any(String) });
  });

  it('the register closes with the rebuilt figures and no difference', async () => {
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = (cur.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    const closed = await c.http.post(`${api}/registers/${cur.id}/close`).set(auth(cashier)).send({ countedBalances: counted });
    expect(closed.status).toBe(200);
    for (const b of closed.body.balances as { variance: number }[]) expect(b.variance).toBe(0);
    // reopen for the tests that follow
    await c.openRegister(cashier);
  });

  it('a replay answers with the first result and records nothing more; the key is required', async () => {
    const key = randomUUID();
    const first = await service({ feeMinor: 12345, receivedInto: { method: 'cash' } }, key);
    const before = await bucket('cash', 'LBP');
    const replay = await service({ feeMinor: 12345, receivedInto: { method: 'cash' } }, key);
    expect(replay.status).toBe(200);
    expect(replay.header['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(await bucket('cash', 'LBP')).toBe(before);
    expect((await service({ feeMinor: 99 }, key)).status).toBe(422); // same key, different request
    expect((await c.http.post(`${api}/services`).set(auth(manager)).send({ costMinor: 0, feeMinor: 5, currency: 'LBP' })).status).toBe(400);
  });

  it('is refused when it makes no sense', async () => {
    expect((await service({ feeMinor: 0 })).status).toBe(400);
    expect((await service({ feeMinor: 1.5 })).status).toBe(400);
    expect((await service({ costMinor: -1 })).status).toBe(400);
    expect((await service({ currency: 'EUR' })).status).toBe(400);
    expect((await service({ categoryId: 999999 })).status).toBe(422);
    expect((await service({ customerId: 999999 })).status).toBe(422);
    expect((await service({ receivedInto: { method: 'cheque' } })).status).toBe(400);
  });

  it('money into the register needs an open register; recording without it does not', async () => {
    const cur = (await c.http.get(`${api}/registers/current`).set(auth(cashier))).body;
    const counted = (cur.balances as { method: string; currency: string; expected: number }[]).map((b) => ({
      method: b.method,
      currency: b.currency,
      amount: b.expected,
    }));
    await c.http.post(`${api}/registers/${cur.id}/close`).set(auth(cashier)).send({ countedBalances: counted });
    const refused = await service({ receivedInto: { method: 'cash' } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('REGISTER_CLOSED');
    expect((await service({})).status).toBe(201);
    await c.openRegister(cashier);
  });
});

describe('the list', () => {
  it('shows the newest first with totals per currency over everything the filter matches, and pages', async () => {
    const all = await c.http.get(`${api}/services?limit=2`).set(auth(manager));
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].id).toBeGreaterThan(all.body.data[1].id);
    expect(all.body.nextCursor).not.toBeNull();
    expect(all.body.totals.LBP.fee).toBeGreaterThan(0);
    expect(all.body.totals.USD.fee).toBe(2500);
    expect(all.body.totals.LBP.profit).toBe(all.body.totals.LBP.fee - all.body.totals.LBP.cost);
    const next = await c.http.get(`${api}/services?limit=2&cursor=${all.body.nextCursor}`).set(auth(manager));
    expect(next.body.data[0].id).toBeLessThan(all.body.data[1].id);
    const types = (await c.http.get(`${api}/service-categories`).set(auth(manager))).body.data as { id: number; name: string }[];
    const it = types.find((t) => t.name === 'IT support')!;
    const byType = await c.http.get(`${api}/services?categoryId=${it.id}`).set(auth(manager));
    expect(byType.body.data).toHaveLength(1);
    expect(byType.body.totals.LBP.fee).toBe(50000);
  });
});

describe('records are history, and who may record', () => {
  it('the database refuses to change or delete a service', async () => {
    const id = (await service({ feeMinor: 777 })).body.id as number;
    const db = new Database(c.databasePath);
    try {
      expect(() => db.prepare('UPDATE service_sales SET fee_minor = 1 WHERE id = ?').run(id)).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM service_sales WHERE id = ?').run(id)).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it('managers and admins only', async () => {
    expect((await service({}, randomUUID(), cashier)).status).toBe(403);
    expect((await c.http.get(`${api}/services`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.get(`${api}/services`)).status).toBe(401);
  });
});
