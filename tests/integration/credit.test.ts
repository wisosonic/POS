import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// Q4: customers may pay part of a bill or pay later, only if registered. (US-31..US-33)
let c: TestCtx;
let cashier: string;
let manager: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const CUSTOMER = 2; // registered; Walk-In is 1

const sale = (key: string, over: Record<string, unknown>) =>
  c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', key).send(c.newSaleBody(over));
const balance = async (id: number) => (await c.http.get(`/api/v1/customers/${id}`).set(auth(manager))).body.balanceLbp as number;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('credit sales', () => {
  it('partial payment: registered customer owes the rest', async () => {
    const res = await sale('cr-1', { customerId: CUSTOMER, payments: [{ method: 'cash', currency: 'LBP', amount: 25000 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'partial', paidLbp: 25000, restLbp: 50000 });
    expect(await balance(CUSTOMER)).toBe(50000);
  });

  it('pay later: no payment at all → unpaid', async () => {
    const before = await balance(CUSTOMER);
    const res = await sale('cr-2', { customerId: CUSTOMER, payments: [] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'unpaid', paidLbp: 0, restLbp: 75000 });
    expect(await balance(CUSTOMER)).toBe(before + 75000);
  });

  it('Walk-In cannot buy on credit (partial or unpaid)', async () => {
    const partial = await sale('cr-3', { customerId: 1, payments: [{ method: 'cash', currency: 'LBP', amount: 1000 }] });
    const unpaid = await sale('cr-4', { customerId: 1, payments: [] });
    expect(partial.status).toBe(422);
    expect(unpaid.status).toBe(422);
    expect(partial.body.code).toBe('CREDIT_REQUIRES_CUSTOMER');
  });

  it('a failed sale does not change the customer balance (atomicity)', async () => {
    const before = await balance(CUSTOMER);
    const res = await sale('cr-5', {
      customerId: CUSTOMER,
      items: [{ productId: 999999, qty: '1', unitPriceLbp: 1 }],
      payments: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await balance(CUSTOMER)).toBe(before);
  });
});

describe('settling a customer account (US-32)', () => {
  it('a payment reduces the balance and is applied to the oldest open sales first', async () => {
    const before = await balance(CUSTOMER);
    const res = await c.http
      .post(`/api/v1/customers/${CUSTOMER}/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', 'pay-1')
      .send({ method: 'omt', currency: 'LBP', amount: 60000 });
    expect(res.status).toBe(201);
    expect(await balance(CUSTOMER)).toBe(before - 60000);
    const open = await c.http.get(`/api/v1/customers/${CUSTOMER}/open-sales`).set(auth(cashier));
    // the first partial sale (50,000 owed) must be fully paid before the second is touched
    expect(open.body.data[0].restLbp).toBeGreaterThan(0);
    expect(open.body.data.every((s: { status: string }) => s.status !== 'paid')).toBe(true);
  });

  it('rejects paying more than the balance', async () => {
    const owed = await balance(CUSTOMER);
    const res = await c.http
      .post(`/api/v1/customers/${CUSTOMER}/payments`)
      .set(auth(cashier))
      .set('Idempotency-Key', 'pay-2')
      .send({ method: 'cash', currency: 'LBP', amount: owed + 5000 });
    expect(res.status).toBe(422);
  });

  it('is idempotent', async () => {
    const body = { method: 'cash', currency: 'LBP', amount: 5000 };
    const a = await c.http.post(`/api/v1/customers/${CUSTOMER}/payments`).set(auth(cashier)).set('Idempotency-Key', 'pay-3').send(body);
    const b = await c.http.post(`/api/v1/customers/${CUSTOMER}/payments`).set(auth(cashier)).set('Idempotency-Key', 'pay-3').send(body);
    expect(b.body.id).toBe(a.body.id);
  });

  it('the payment appears in the register totals for its method', async () => {
    const z = await c.http.get('/api/v1/registers/current').set(auth(cashier));
    const omt = z.body.balances.find((b: { method: string; currency: string }) => b.method === 'omt' && b.currency === 'LBP');
    expect(omt.expected).toBeGreaterThanOrEqual(1_000_000 + 60000);
  });

  it('cannot take a payment for Walk-In', async () => {
    const res = await c.http
      .post('/api/v1/customers/1/payments')
      .set(auth(cashier))
      .set('Idempotency-Key', 'pay-4')
      .send({ method: 'cash', currency: 'LBP', amount: 5000 });
    expect(res.status).toBe(422);
  });
});

describe('receivables (US-33)', () => {
  it('lists customers with a balance and their open sales', async () => {
    const res = await c.http.get('/api/v1/reports/receivables').set(auth(manager));
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { customerId: number }) => r.customerId === CUSTOMER);
    expect(row.balanceLbp).toBe(await balance(CUSTOMER));
  });

  it('customer balance always equals the sum of rest amounts of their open sales', async () => {
    const open = await c.http.get(`/api/v1/customers/${CUSTOMER}/open-sales`).set(auth(cashier));
    const sum = open.body.data.reduce((a: number, s: { restLbp: number }) => a + s.restLbp, 0);
    expect(sum).toBe(await balance(CUSTOMER));
  });
});
