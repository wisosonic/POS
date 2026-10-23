import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

let c: TestCtx;
let cashier: string;
let manager: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const stockOf = async (productId: number) => {
  const r = await c.http.get(`/api/v1/stock?productId=${productId}`).set(auth(manager));
  return Number(r.body.data[0].qty);
};

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
});
afterAll(() => c.close());

describe('POST /sales · register gate (US-11, decision #1)', () => {
  it('409 REGISTER_CLOSED when the cashier has no open session', async () => {
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-closed').send(c.newSaleBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REGISTER_CLOSED');
  });
});

describe('POST /sales · happy path (US-01, US-05)', () => {
  beforeAll(async () => {
    await c.openRegister(cashier);
  });

  it('creates a paid sale, decrements stock and returns totals', async () => {
    const before = await stockOf(c.seed.products.towel.id);
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-1').send(c.newSaleBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', totalLbp: 75000, paidLbp: 75000, restLbp: 0, rateLbpPerUsd: 90000 });
    expect(await stockOf(c.seed.products.towel.id)).toBe(before - 1);
  });

  it('snapshots cost so profit is fixed at sale time', async () => {
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-2').send(c.newSaleBody());
    expect(res.body.profitLbp).toBe(75000 - c.seed.products.towel.costLbp);
  });

  it('returns change for over-tender', async () => {
    const body = c.newSaleBody({ payments: [{ method: 'cash', currency: 'LBP', amount: 100000 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-3').send(body);
    expect(res.body.changeLbp).toBe(25000);
  });

  it('prices a USD-denominated product at the current rate (Q1: currency per product)', async () => {
    const body = c.newSaleBody({
      items: [{ productId: c.seed.products.usd.id, qty: '1', unitPriceLbp: 225000 }], // $2.50 × 90,000
      payments: [{ method: 'cash', currency: 'USD', amount: 250 }],
    });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-usd').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ totalLbp: 225000, rateLbpPerUsd: 90000 });
  });

  it('records a Whish payment with no third-party call (Q6)', async () => {
    const body = c.newSaleBody({ payments: [{ method: 'whish', currency: 'LBP', amount: 75000 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-whish').send(body);
    expect(res.status).toBe(201);
    expect(res.body.payments[0]).toMatchObject({ method: 'whish', currency: 'LBP', amount: 75000 });
  });

  it('rejects an unknown payment method', async () => {
    const body = c.newSaleBody({ payments: [{ method: 'bitcoin', currency: 'LBP', amount: 75000 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-bad-m').send(body);
    expect(res.status).toBe(400);
  });

  it('supports weighed quantities', async () => {
    const body = c.newSaleBody({
      items: [{ productId: c.seed.products.kg.id, qty: '0.350', unitPriceLbp: 400000 }],
      payments: [{ method: 'cash', currency: 'LBP', amount: 140000 }],
    });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-kg').send(body);
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBe(140000);
  });
});

describe('POST /sales · validation and security', () => {
  it('401 without a token', async () => {
    const res = await c.http.post('/api/v1/sales').set('Idempotency-Key', 'x').send(c.newSaleBody());
    expect(res.status).toBe(401);
  });

  it('400 without an Idempotency-Key', async () => {
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).send(c.newSaleBody());
    expect(res.status).toBe(400);
  });

  it('422 PRICE_MISMATCH when the client price differs from the catalog (cashier cannot override)', async () => {
    const body = c.newSaleBody({ items: [{ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 1 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-pm').send(body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PRICE_MISMATCH');
  });

  it('400 VALIDATION on negative quantity', async () => {
    const body = c.newSaleBody({ items: [{ productId: c.seed.products.towel.id, qty: '-1', unitPriceLbp: 75000 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-neg').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('rejects a short payment for Walk-In (decision #10)', async () => {
    const body = c.newSaleBody({ payments: [{ method: 'cash', currency: 'LBP', amount: 1000 }] });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-short').send(body);
    expect(res.status).toBe(422);
  });

  it('does not write anything when the transaction fails (atomicity)', async () => {
    const before = await stockOf(c.seed.products.choc.id);
    const body = c.newSaleBody({
      items: [
        { productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 50000 },
        { productId: 999999, qty: '1', unitPriceLbp: 1 }, // does not exist
      ],
      payments: [{ method: 'cash', currency: 'LBP', amount: 50001 }],
    });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-atomic').send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stockOf(c.seed.products.choc.id)).toBe(before);
  });
});

describe('POST /sales · idempotency (US-10, decision #14)', () => {
  it('same key + same body returns the original sale and creates only one', async () => {
    const body = c.newSaleBody();
    const a = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-idem').send(body);
    const b = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-idem').send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
  });

  it('same key + different body → 422 IDEMPOTENCY_CONFLICT', async () => {
    await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-idem2').send(c.newSaleBody());
    const other = c.newSaleBody({ notes: 'different' });
    const res = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-idem2').send(other);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('parallel duplicate requests still create exactly one sale', async () => {
    const body = c.newSaleBody();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-par').send(body)),
    );
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
  });
});

describe('POST /sales · stock never blocks a sale (R2: stock is only an alert)', () => {
  const sellRare = (key: string, qty = '1') =>
    c.http
      .post('/api/v1/sales')
      .set(auth(cashier))
      .set('Idempotency-Key', key)
      .send(
        c.newSaleBody({
          items: [{ productId: c.seed.products.rare.id, qty, unitPriceLbp: 10000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 10000 * Number(qty) }],
        }),
      );

  it('selling more than the quantity on hand succeeds and stock goes negative', async () => {
    const before = await stockOf(c.seed.products.rare.id); // seeded at 1
    const res = await sellRare('k-oversell', '5');
    expect(res.status).toBe(201);
    expect(await stockOf(c.seed.products.rare.id)).toBe(before - 5);
  });

  it('selling a product that is at 0 succeeds', async () => {
    const res = await sellRare('k-zero');
    expect(res.status).toBe(201);
  });

  it('two parallel sales of the last unit both succeed, with no deadlock, ending at the exact sum', async () => {
    const before = await stockOf(c.seed.products.towel.id);
    const sell = (k: string) => c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', k).send(c.newSaleBody());
    const [a, b] = await Promise.all([sell('k-par-a'), sell('k-par-b')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await stockOf(c.seed.products.towel.id)).toBe(before - 2);
  });

  it('the sale response lists items now at or below their low-stock threshold (for the UI toast)', async () => {
    await c.http.patch(`/api/v1/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ stockAlert: 1000 });
    const res = await c.http
      .post('/api/v1/sales')
      .set(auth(cashier))
      .set('Idempotency-Key', 'k-lowflag')
      .send(
        c.newSaleBody({
          items: [{ productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 50000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 50000 }],
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.lowStock).toEqual([expect.objectContaining({ productId: c.seed.products.choc.id, threshold: 1000 })]);
    await c.http.patch(`/api/v1/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ stockAlert: null }); // reset
  });
});

describe('POST /sales · concurrency and consistency', () => {
  it('50 parallel sales keep the stock ledger equal to the cached level', async () => {
    const before = await stockOf(c.seed.products.choc.id);
    const rs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        c.http
          .post('/api/v1/sales')
          .set(auth(cashier))
          .set('Idempotency-Key', `k-load-${i}`)
          .send(
            c.newSaleBody({
              items: [{ productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 50000 }],
              payments: [{ method: 'cash', currency: 'LBP', amount: 50000 }],
            }),
          ),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(c.seed.products.choc.id)).toBe(before - 50);
    const led = await c.http.get(`/api/v1/stock/${c.seed.products.choc.id}/movements?limit=200`).set(auth(manager));
    const sum = led.body.data.reduce((a: number, m: { qtyDelta: string }) => a + Number(m.qtyDelta), 0);
    expect(sum).toBe(await stockOf(c.seed.products.choc.id)); // ledger == cache
  });
});

describe('Returns (US-14)', () => {
  it('manager can return items; stock is restored; cannot over-return', async () => {
    const sale = await c.http.post('/api/v1/sales').set(auth(cashier)).set('Idempotency-Key', 'k-ret').send(c.newSaleBody());
    const before = await stockOf(c.seed.products.towel.id);
    const itemId = sale.body.items[0].id;
    const ok = await c.http
      .post('/api/v1/returns')
      .set(auth(manager))
      .set('Idempotency-Key', 'r-1')
      .send({
        saleId: sale.body.id,
        items: [{ saleItemId: itemId, qty: '1' }],
        reason: 'damaged',
        refund: { method: 'cash', currency: 'LBP', amount: 75000 },
      });
    expect(ok.status).toBe(201);
    expect(await stockOf(c.seed.products.towel.id)).toBe(before + 1);
    const again = await c.http
      .post('/api/v1/returns')
      .set(auth(manager))
      .set('Idempotency-Key', 'r-2')
      .send({
        saleId: sale.body.id,
        items: [{ saleItemId: itemId, qty: '1' }],
        reason: 'x',
        refund: { method: 'cash', currency: 'LBP', amount: 75000 },
      });
    expect(again.status).toBe(422);
  });
});

describe('Audit & immutability', () => {
  it('there is no endpoint to edit a completed sale', async () => {
    const res = await c.http.patch('/api/v1/sales/1').set(auth(manager)).send({ totalLbp: 1 });
    expect([404, 405]).toContain(res.status);
  });
});
