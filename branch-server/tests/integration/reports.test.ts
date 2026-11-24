import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Dashboard and reports (US-27, US-28): every figure below is worked out by hand from the test seed.
//   towel  price 75,000  cost 67,000  → margin  8,000        choc  price 50,000  cost 40,000  → margin 10,000
//   sale A: 2 towels = 150,000 (profit 16,000)    sale B: 3 choc = 150,000 (profit 30,000)
//   return: 1 towel from sale A = 75,000 back (profit lost 8,000)
//   so today: gross 300,000, returned 75,000, net 225,000, profit 46,000 − 8,000 = 38,000
let c: TestCtx;
let cashier: string;
let manager: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });

async function sell(items: { productId: number; qty: string; unitPriceLbp: number }[], paid: number, over: Record<string, unknown> = {}) {
  const res = await c.http
    .post(`${api}/sales`)
    .set(auth(cashier))
    .set('Idempotency-Key', randomUUID())
    .send(c.newSaleBody({ items, payments: [{ method: 'cash', currency: 'LBP', amount: paid }], ...over }));
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);

  const towel = c.seed.products.towel.id;
  const choc = c.seed.products.choc.id;
  const a = await sell([{ productId: towel, qty: '2', unitPriceLbp: 75000 }], 150000);
  await sell([{ productId: choc, qty: '3', unitPriceLbp: 50000 }], 150000);

  const detail = await c.http.get(`${api}/sales/${a.id}`).set(auth(manager));
  const back = await c.http
    .post(`${api}/returns`)
    .set(auth(manager))
    .set('Idempotency-Key', randomUUID())
    .send({
      saleId: a.id,
      items: [{ saleItemId: detail.body.items[0].id, qty: '1' }],
      reason: 'faulty',
      refund: { method: 'cash', currency: 'LBP', amount: 75000 },
    });
  expect(back.status).toBe(201);
});
afterAll(() => c.close());

describe('dashboard', () => {
  it('takes today’s returns off the takings and the profit', async () => {
    const d = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    expect(d.today).toMatchObject({
      salesCount: 2,
      grossLbp: 300000,
      returnsCount: 1,
      returnedLbp: 75000,
      netLbp: 225000,
      profitLbp: 38000,
      averageBasketLbp: 150000,
    });
    // the older gross figures are unchanged
    expect(d.salesToday).toMatchObject({ count: 2, totalLbp: 300000, profitLbp: 46000 });
  });

  it('spreads the day over 24 hours that add up to the takings', async () => {
    const d = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    expect(d.hourly).toHaveLength(24);
    expect(d.hourly.reduce((n: number, h: { totalLbp: number }) => n + h.totalLbp, 0)).toBe(300000);
    expect(d.hourly.reduce((n: number, h: { count: number }) => n + h.count, 0)).toBe(2);
  });

  it('lists the best sellers by takings', async () => {
    const d = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    expect(d.topItems.map((i: { name: string; qty: string; totalLbp: number }) => [i.name, i.qty, i.totalLbp])).toEqual([
      ['Cedars silver towel', '2', 150000],
      ['Crispy chocolate', '3', 150000],
    ]);
  });
});

describe('sales report', () => {
  it('by day: one row for today with gross, returned, net and net profit', async () => {
    const r = await c.http.get(`${api}/reports/sales?groupBy=day`).set(auth(manager));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([
      { key: today(), label: today(), count: 2, grossLbp: 300000, returnedLbp: 75000, netLbp: 225000, profitLbp: 38000 },
    ]);
    expect(r.body.totals).toEqual({ count: 2, grossLbp: 300000, returnedLbp: 75000, netLbp: 225000, profitLbp: 38000 });
  });

  it('by cashier: the return is charged to the cashier who made the sale', async () => {
    const r = await c.http.get(`${api}/reports/sales?groupBy=cashier`).set(auth(manager));
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ count: 2, grossLbp: 300000, returnedLbp: 75000, netLbp: 225000, profitLbp: 38000 });
  });

  it('by category: each line falls under its product’s category, and the rows add up to the totals', async () => {
    const r = await c.http.get(`${api}/reports/sales?groupBy=category`).set(auth(manager));
    const row = (label: string) => r.body.data.find((x: { label: string }) => x.label === label);
    expect(r.body.data).toHaveLength(2);
    expect(row('Household')).toMatchObject({ count: 1, grossLbp: 150000, returnedLbp: 75000, netLbp: 75000, profitLbp: 8000 }); // the towels
    expect(row('Snacks')).toMatchObject({ count: 1, grossLbp: 150000, returnedLbp: 0, netLbp: 150000, profitLbp: 30000 }); // the chocolate
    expect(r.body.totals).toMatchObject({ grossLbp: 300000, returnedLbp: 75000, netLbp: 225000, profitLbp: 38000 });
  });

  it('a range with no sales gives no rows and zero totals', async () => {
    const r = await c.http.get(`${api}/reports/sales?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`).set(auth(manager));
    expect(r.body.data).toEqual([]);
    expect(r.body.totals).toEqual({ count: 0, grossLbp: 0, returnedLbp: 0, netLbp: 0, profitLbp: 0 });
  });

  it('refuses a date it cannot read', async () => {
    expect((await c.http.get(`${api}/reports/sales?from=yesterday`).set(auth(manager))).status).toBe(400);
    expect((await c.http.get(`${api}/reports/sales?groupBy=planet`).set(auth(manager))).status).toBe(400);
  });
});

describe('product report', () => {
  it('shows quantity, takings, cost and profit per product, net of returns', async () => {
    const r = await c.http.get(`${api}/reports/products?sort=revenue`).set(auth(manager));
    expect(r.body.data).toEqual([
      { productId: c.seed.products.choc.id, name: 'Crispy chocolate', qty: '3', revenueLbp: 150000, costLbp: 120000, profitLbp: 30000 },
      { productId: c.seed.products.towel.id, name: 'Cedars silver towel', qty: '1', revenueLbp: 75000, costLbp: 67000, profitLbp: 8000 },
    ]);
  });

  it('can show the slowest first, and cut the list short', async () => {
    const r = await c.http.get(`${api}/reports/products?sort=qty&order=asc&limit=1`).set(auth(manager));
    expect(r.body.data.map((p: { name: string }) => p.name)).toEqual(['Cedars silver towel']);
  });
});

describe('what is owed', () => {
  it('receivables: a part-paid sale shows who owes, how much, and since when', async () => {
    await sell([{ productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 50000 }], 20000, { customerId: 2 });
    const r = await c.http.get(`${api}/reports/receivables`).set(auth(manager));
    expect(r.body.totalOwedLbp).toBe(30000);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ customerId: 2, name: 'Test Customer', balanceLbp: 30000, openSales: 1 });
    expect(typeof r.body.data[0].oldestUnpaidAt).toBe('string');
  });

  it('the dashboard shows what customers owe and what the shop owes its suppliers', async () => {
    const order = await c.http
      .post(`${api}/purchases`)
      .set(auth(manager))
      .send({
        supplierId: c.seed.suppliers.main.id,
        currency: 'LBP',
        status: 'ordered',
        items: [{ productId: c.seed.products.choc.id, qty: '10', costMinor: 6000 }],
      });
    expect(order.status).toBe(201);
    const d = (await c.http.get(`${api}/reports/dashboard`).set(auth(manager))).body;
    expect(d.owedByCustomersLbp).toBe(30000);
    expect(d.owedToSuppliers).toEqual({ USD: 0, LBP: 60000 });
  });
});

describe('who can read them', () => {
  it.each(['/reports/dashboard', '/reports/sales', '/reports/products', '/reports/receivables'])(
    'a cashier cannot read %s',
    async (path) => {
      expect((await c.http.get(`${api}${path}`).set(auth(cashier))).status).toBe(403);
    },
  );
});
