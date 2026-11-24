import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// The exchange rate (US-30): changing it affects new sales only, never old ones (CLAUDE.md rule 9).
let c: TestCtx;
let cashier: string;
let admin: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const setRate = (token: string, body: Record<string, unknown>) => c.http.post(`${api}/exchange-rates`).set(auth(token)).send(body);
const usdSale = (unitPriceLbp: number, usdCents = 300) =>
  c.http
    .post(`${api}/sales`)
    .set(auth(cashier))
    .set('Idempotency-Key', randomUUID())
    .send(
      c.newSaleBody({
        items: [{ productId: c.seed.products.usd.id, qty: '1', unitPriceLbp }],
        payments: [{ method: 'cash', currency: 'USD', amount: usdCents }],
      }),
    );

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('reading the rate', () => {
  it('everyone signed in can read the current rate', async () => {
    const res = await c.http.get(`${api}/exchange-rates/current`).set(auth(cashier));
    expect(res.body).toMatchObject({ rateLbpPerUsd: 90000 });
    expect(res.body.effectiveFrom).toBeTruthy();
    expect((await c.http.get(`${api}/exchange-rates/current`)).status).toBe(401);
  });

  it('only an admin sees the history', async () => {
    expect((await c.http.get(`${api}/exchange-rates`).set(auth(manager))).status).toBe(403);
    expect((await c.http.get(`${api}/exchange-rates`).set(auth(admin))).body.data).toHaveLength(1);
  });
});

describe('changing the rate', () => {
  it('only an admin can', async () => {
    expect((await setRate(cashier, { rateLbpPerUsd: 95000 })).status).toBe(403);
    expect((await setRate(manager, { rateLbpPerUsd: 95000 })).status).toBe(403);
  });

  it.each([
    ['zero', { rateLbpPerUsd: 0 }],
    ['negative', { rateLbpPerUsd: -90000 }],
    ['fractional', { rateLbpPerUsd: 90000.5 }],
    ['absurdly large', { rateLbpPerUsd: 1e12 }],
    ['text', { rateLbpPerUsd: 'high' }],
    ['a bad date', { rateLbpPerUsd: 95000, effectiveFrom: 'next tuesday' }],
  ])('refuses a rate that is %s', async (_n, body) => {
    expect((await setRate(admin, body)).status).toBe(400);
  });

  it('a sale made before the change keeps its rate forever', async () => {
    const before = await usdSale(225000); // $2.50 at 90,000
    expect(before.body).toMatchObject({ totalLbp: 225000, rateLbpPerUsd: 90000 });

    const res = await setRate(admin, { rateLbpPerUsd: 100000 });
    expect(res.status).toBe(201);
    expect((await c.http.get(`${api}/exchange-rates/current`).set(auth(cashier))).body.rateLbpPerUsd).toBe(100000);

    const old = await c.http.get(`${api}/sales/${before.body.id}`).set(auth(cashier));
    expect(old.body).toMatchObject({ totalLbp: 225000, rateLbpPerUsd: 90000 });
    const receipt = await c.http.get(`${api}/sales/${before.body.id}/receipt?format=text`).set(auth(cashier));
    expect(receipt.text).toContain('@ 90,000');
  });

  it('a new sale uses the new rate: the USD product costs more lira and the old price is now stale', async () => {
    const stale = await usdSale(225000);
    expect(stale.status).toBe(422);
    expect(stale.body).toMatchObject({ code: 'PRICE_MISMATCH', expectedUnitPriceLbp: 250000 });

    const fresh = await usdSale(250000, 300); // $2.50 × 100,000; paid with $3.00 = 300,000 LBP
    expect(fresh.status).toBe(201);
    expect(fresh.body).toMatchObject({ totalLbp: 250000, rateLbpPerUsd: 100000, changeLbp: 50000 });
  });

  it('a product priced in lira is not affected by the rate', async () => {
    const res = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(c.newSaleBody());
    expect(res.body.totalLbp).toBe(75000);
  });

  it('a payment in dollars is worth more or fewer lira under the new rate', async () => {
    // $1 now buys 100,000 LBP, so $1 pays a 75,000 sale with 25,000 change (it was 15,000 at 90,000)
    const res = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(c.newSaleBody({ payments: [{ method: 'cash', currency: 'USD', amount: 100 }] }));
    expect(res.body).toMatchObject({ changeLbp: 25000, receivedLbp: 100000 });
  });

  it('a rate set for the future does not apply yet', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect((await setRate(admin, { rateLbpPerUsd: 120000, effectiveFrom: future })).status).toBe(201);
    expect((await c.http.get(`${api}/exchange-rates/current`).set(auth(cashier))).body.rateLbpPerUsd).toBe(100000);
  });

  it('the latest rate that has started wins, even if an older one was entered later', async () => {
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await setRate(admin, { rateLbpPerUsd: 85000, effectiveFrom: past });
    expect((await c.http.get(`${api}/exchange-rates/current`).set(auth(cashier))).body.rateLbpPerUsd).toBe(100000);
  });

  it('every change is audited with the old and the new rate', async () => {
    const log = await c.http.get(`${api}/audit?action=exchange-rate.create`).set(auth(admin));
    expect(log.body.data.length).toBeGreaterThanOrEqual(3);
    const first = log.body.data[log.body.data.length - 1];
    expect(first).toMatchObject({ before: { rateLbpPerUsd: 90000 }, after: { rateLbpPerUsd: 100000 }, userId: c.seed.users.admin.id });
  });

  it('keeps the history, newest start date first', async () => {
    const res = await c.http.get(`${api}/exchange-rates`).set(auth(admin));
    const dates = res.body.data.map((r: { effectiveFrom: string }) => r.effectiveFrom);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(res.body.data.length).toBe(4);
  });
});
