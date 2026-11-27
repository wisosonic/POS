import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from './helpers';

// The chain's reports (docs/12 §23, P4b) over a small set of rows made by hand, so every figure can be worked out on paper. Two branches use the SAME
// ids for different things (sale 1, session 1, expense category 1): the reports must never mix them. Beirut is UTC+2 in November, so a sale at 22:30Z
// belongs to the NEXT shop day.
let hq: Hq;
let b1 = 0;
let b2 = 0;
const api = '/api/v1';
const RANGE = 'from=2026-11-10T00:00:00Z&to=2026-11-12T00:00:00Z';
const get = async (path: string) => (await hq.http.get(`${api}${path}`).set(adminAuth)).body;
const run = (sql: string, params: (string | number | null)[] = []) => hq.app.database.run(sql, params);

const SALE =
  "INSERT INTO sales (branch_id, id, ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, discount_lbp, shipping_lbp, rounding_lbp, total_lbp, paid_lbp, change_lbp, rest_lbp, profit_lbp, status, notes, created_at, hq_received_at) VALUES (?, ?, ?, NULL, NULL, 1, 1, 90000, ?, 0, 0, 0, ?, ?, 0, 0, ?, ?, '', ?, 'x')";
const sale = (branch: number, id: number, at: string, total: number, profit: number, status = 'completed') =>
  run(SALE, [branch, id, id, total, total, total, profit, status, at]);
const item = (branch: number, id: number, saleId: number, product: number, qtyMilli: number, line: number, unitCost: number) =>
  run(
    `INSERT INTO sale_items (branch_id, id, sale_id, product_id, name_snap, receipt_name_snap, barcode_snap, brand_snap, unit_snap, qty_milli, unit_price_lbp, unit_cost_lbp, line_total_lbp, legacy_id, hq_received_at)
     VALUES (?, ?, ?, ?, ?, NULL, '', '', '', ?, 0, ?, ?, NULL, 'x')`,
    [branch, id, saleId, product, product === 1 ? 'Towel' : 'Chair', qtyMilli, unitCost, line],
  );
const payment = (branch: number, id: number, saleId: number, method: string, currency: string, amount: number) =>
  run(
    `INSERT INTO payments (branch_id, id, sale_id, customer_payment_id, method, currency, amount, rate_snap, created_at, hq_received_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 90000, '2026-11-10T10:00:00Z', 'x')`,
    [branch, id, saleId, method, currency, amount],
  );

beforeAll(async () => {
  hq = await startHq();
  for (const [code, name] of [
    ['B1', 'Hamra'],
    ['B2', 'Verdun'],
  ])
    await hq.http.post(`${api}/branches`).set(adminAuth).send({ code, name });
  const idOf = async (code: string) => (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
  b1 = await idOf('B1');
  b2 = await idOf('B2');
  // HQ's own catalog: the same product ids as in every branch's sales
  const home = (await hq.http.post(`${api}/categories`).set(adminAuth).send({ name: 'Home' })).body.id;
  await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Towel', priceMinor: 50000, categoryId: home, stockAlert: 8 });
  await hq.http.post(`${api}/products`).set(adminAuth).send({ name: 'Chair', priceMinor: 200000 });

  // Branch 1: A, B on shop day 10, C just after local midnight (day 11), a voided sale D that must not count. Branch 2: E, sale number 1 again.
  await sale(b1, 1, '2026-11-10T10:00:00.000Z', 100000, 30000);
  await sale(b1, 2, '2026-11-10T21:30:00.000Z', 50000, 10000);
  await sale(b1, 3, '2026-11-10T22:30:00.000Z', 70000, 20000);
  await sale(b1, 4, '2026-11-10T11:00:00.000Z', 999999, 999999, 'void');
  await sale(b2, 1, '2026-11-10T12:00:00.000Z', 200000, 50000);
  await item(b1, 1, 1, 1, 2000, 100000, 35000); // 2 towels, cost 35,000 each
  await item(b1, 2, 2, 1, 1000, 50000, 40000);
  await item(b2, 1, 1, 2, 1000, 200000, 150000);
  await payment(b1, 1, 1, 'cash', 'LBP', 100000);
  await payment(b1, 2, 2, 'whish', 'LBP', 50000);
  await payment(b1, 3, 4, 'cash', 'LBP', 999999); // the voided sale's payment
  await payment(b2, 1, 1, 'cash', 'USD', 2000);
  // A return of half a towel from sale A, taken back on day 11: 25,000 refunded, of which the cost was 17,500, so 7,500 of profit lost.
  await run(
    `INSERT INTO returns (branch_id, id, ref, sale_id, session_id, user_id, reason, refund_lbp, balance_reduced_lbp, refund_method, refund_currency, refund_amount, idempotency_key, legacy_id, created_at, hq_received_at)
     VALUES (?, 1, 1, 1, NULL, NULL, 'x', 25000, 0, 'cash', 'LBP', 25000, NULL, NULL, '2026-11-11T09:00:00.000Z', 'x')`,
    [b1],
  );
  await run(
    `INSERT INTO return_items (branch_id, id, return_id, sale_item_id, qty_milli, amount_lbp, hq_received_at) VALUES (?, 1, 1, 1, 500, 25000, 'x')`,
    [b1],
  );
  // Expenses: both branches have an expense category number 1, with different names.
  await run(
    `INSERT INTO expense_categories (branch_id, id, name, legacy_id, hq_received_at) VALUES (?, 1, 'Rent', NULL, 'x'), (?, 1, 'Fuel', NULL, 'x')`,
    [b1, b2],
  );
  const expense = (branch: number, id: number, amount: number, currency: string) =>
    run(
      `INSERT INTO expenses (branch_id, id, category_id, session_id, title, reference, note, amount_minor, currency, legacy_id, created_at, hq_received_at) VALUES (?, ?, 1, NULL, 'x', '', NULL, ?, ?, NULL, '2026-11-10T08:00:00.000Z', 'x')`,
      [branch, id, amount, currency],
    );
  await expense(b1, 1, 300000, 'LBP');
  await expense(b1, 2, 100000, 'LBP');
  await expense(b2, 1, 500, 'USD');
  // Tills: branch 1 had two closed shifts (the second 5,000 short), branch 2 has one still open.
  const session = (branch: number, id: number, status: string) =>
    run(
      `INSERT INTO register_sessions (branch_id, id, terminal_id, opened_by, opened_at, closed_by, closed_at, status, legacy_id, hq_received_at) VALUES (?, ?, 'T1', NULL, ?, NULL, ?, ?, NULL, 'x')`,
      [branch, id, `2026-11-10T0${id}:00:00.000Z`, status === 'closed' ? '2026-11-10T18:00:00.000Z' : null, status],
    );
  const bucket = (
    n: number,
    branch: number,
    sessionId: number,
    method: string,
    currency: string,
    expected: number,
    counted: number | null,
  ) =>
    run(
      `INSERT INTO register_balances (branch_id, id, session_id, method, currency, opening, expected, counted, variance, hq_received_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'x')`,
      [branch, n, sessionId, method, currency, expected, counted, counted === null ? null : counted - expected],
    );
  await session(b1, 1, 'closed');
  await session(b1, 2, 'closed');
  await session(b2, 1, 'open');
  await bucket(1, b1, 1, 'cash', 'LBP', 175000, 175000);
  await bucket(2, b1, 2, 'cash', 'LBP', 175000, 170000);
  await bucket(3, b2, 1, 'cash', 'LBP', 0, null);
  // Stock: branch 1 bought 10, sold 3, took 0.5 back = 7.5 (at or under the alert of 8); branch 2 holds 3.
  const move = (branch: number, id: number, product: number, delta: number) =>
    run(
      `INSERT INTO stock_movements (branch_id, id, product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note, created_at, hq_received_at) VALUES (?, ?, ?, 1, ?, 'sale', NULL, NULL, NULL, NULL, '2026-11-10T10:00:00.000Z', 'x')`,
      [branch, id, product, delta],
    );
  await move(b1, 1, 1, 10000);
  await move(b1, 2, 1, -2000);
  await move(b1, 3, 1, -1000);
  await move(b1, 4, 1, 500);
  await move(b2, 1, 1, 3000);
  await run('UPDATE branches SET last_seen_at = ? WHERE id = ?', [new Date().toISOString(), b1]);
  await run('UPDATE branches SET last_seen_at = ? WHERE id = ?', ['2026-11-01T00:00:00.000Z', b2]);
});
afterAll(() => hq.close());

describe('sales (US-HQ-reports)', () => {
  it('by shop day: the sale at 22:30Z is on the next Beirut day, a return counts on the day it was taken back, a voided sale never counts', async () => {
    const r = await get(`/reports/sales?${RANGE}&groupBy=day`);
    expect(r.data).toEqual([
      expect.objectContaining({
        key: '2026-11-10',
        count: 3,
        grossLbp: 350000,
        returnsCount: 0,
        returnedLbp: 0,
        netLbp: 350000,
        profitLbp: 90000,
      }),
      expect.objectContaining({
        key: '2026-11-11',
        count: 1,
        grossLbp: 70000,
        returnsCount: 1,
        returnedLbp: 25000,
        netLbp: 45000,
        profitLbp: 12500,
      }),
    ]);
    expect(r.totals).toEqual({ count: 4, grossLbp: 420000, returnsCount: 1, returnedLbp: 25000, netLbp: 395000, profitLbp: 102500 });
  });

  it('by branch, the same sale number at two branches is two sales; a branch filter narrows every figure', async () => {
    const r = await get(`/reports/sales?${RANGE}&groupBy=branch`);
    expect(r.data).toEqual([
      expect.objectContaining({
        key: String(b1),
        label: 'Hamra',
        count: 3,
        grossLbp: 220000,
        returnedLbp: 25000,
        netLbp: 195000,
        profitLbp: 52500,
      }),
      expect.objectContaining({
        key: String(b2),
        label: 'Verdun',
        count: 1,
        grossLbp: 200000,
        returnedLbp: 0,
        netLbp: 200000,
        profitLbp: 50000,
      }),
    ]);
    const one = await get(`/reports/sales?${RANGE}&groupBy=day&branchId=${b1}`);
    expect(one.totals).toEqual({ count: 3, grossLbp: 220000, returnsCount: 1, returnedLbp: 25000, netLbp: 195000, profitLbp: 52500 });
    expect(one.data[0]).toMatchObject({ key: '2026-11-10', count: 2, grossLbp: 150000 });
  });

  it('by category, from HQ’s own catalog; the total still comes from the sales themselves', async () => {
    const r = await get(`/reports/sales?${RANGE}&groupBy=category`);
    expect(r.data).toEqual([
      expect.objectContaining({ label: 'No category', count: 1, grossLbp: 200000, netLbp: 200000, profitLbp: 50000 }),
      expect.objectContaining({ label: 'Home', count: 2, grossLbp: 150000, returnedLbp: 25000, netLbp: 125000, profitLbp: 32500 }),
    ]);
    expect(r.totals.grossLbp).toBe(420000); // includes sale C, which has no lines
  });

  it('a range outside the data is empty, and a bad range is refused', async () => {
    const empty = await get('/reports/sales?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z');
    expect(empty.data).toEqual([]);
    expect(empty.totals.count).toBe(0);
    for (const q of [
      'from=2026-11-12T00:00:00Z&to=2026-11-10T00:00:00Z',
      'from=2024-01-01T00:00:00Z&to=2026-11-12T00:00:00Z',
      'from=nonsense',
    ]) {
      expect((await hq.http.get(`${api}/reports/sales?${q}`).set(adminAuth)).status, q).toBe(400);
    }
  });
});

describe('products, payments, expenses', () => {
  it('products: the same product at every branch adds up, net of what was taken back, best first', async () => {
    const r = await get(`/reports/products?${RANGE}`);
    expect(r.data).toEqual([
      expect.objectContaining({ productId: 2, name: 'Chair', qtyMilli: 1000, revenueLbp: 200000, costLbp: 150000, profitLbp: 50000 }),
      expect.objectContaining({ productId: 1, name: 'Towel', qtyMilli: 2500, revenueLbp: 125000, costLbp: 92500, profitLbp: 32500 }),
    ]);
    const byQty = await get(`/reports/products?${RANGE}&sort=qty&limit=1`);
    expect(byQty.data.map((p: { name: string }) => p.name)).toEqual(['Towel']);
    expect((await get(`/reports/products?${RANGE}&branchId=${b2}`)).data.map((p: { name: string }) => p.name)).toEqual(['Chair']);
  });

  it('payments: per branch, method and currency, without the voided sale’s', async () => {
    const r = await get(`/reports/payments?${RANGE}`);
    expect(
      r.data.map((x: { branchId: number; method: string; currency: string; amount: number }) => [
        x.branchId,
        x.method,
        x.currency,
        x.amount,
      ]),
    ).toEqual([
      [b1, 'cash', 'LBP', 100000],
      [b1, 'whish', 'LBP', 50000],
      [b2, 'cash', 'USD', 2000],
    ]);
  });

  it('expenses: category names are each branch’s own, even when the numbers are the same', async () => {
    const r = await get(`/reports/expenses?${RANGE}`);
    expect(r.data).toEqual([
      expect.objectContaining({ branchId: b1, category: 'Rent', currency: 'LBP', amount: 400000, count: 2 }),
      expect.objectContaining({ branchId: b2, category: 'Fuel', currency: 'USD', amount: 500, count: 1 }),
    ]);
  });
});

describe('tills, stock and the chain at a glance', () => {
  it('registers: every shift with its buckets, over and short per branch, and a filter for the shifts that are off', async () => {
    const r = await get(`/reports/registers?${RANGE}`);
    // in the order they were opened (branch 2's shift opened between branch 1's two)
    expect(r.shifts.map((s: { branchId: number; id: number; status: string }) => [s.branchId, s.id, s.status])).toEqual([
      [b1, 1, 'closed'],
      [b2, 1, 'open'],
      [b1, 2, 'closed'],
    ]);
    expect(r.shifts[2].balances).toEqual([
      { method: 'cash', currency: 'LBP', opening: 0, expected: 175000, counted: 170000, variance: -5000 },
    ]);
    expect(r.totals).toEqual([{ branchId: b1, method: 'cash', currency: 'LBP', variance: -5000, shifts: 2 }]); // the open shift has no count yet
    const off = await get(`/reports/registers?${RANGE}&onlyVariance=true`);
    expect(off.shifts.map((s: { branchId: number; id: number }) => [s.branchId, s.id])).toEqual([[b1, 2]]);
  });

  it('stock: per branch from the movements; low means at or under the product’s alert at that branch', async () => {
    const r = await get('/reports/stock');
    const towel = r.data.find((p: { name: string }) => p.name === 'Towel');
    expect(towel).toMatchObject({ totalMilli: 10500, alertMilli: 8000 });
    expect(towel.byBranch).toEqual([
      { branchId: b1, qtyMilli: 7500 },
      { branchId: b2, qtyMilli: 3000 },
    ]);
    const low = await get('/reports/stock?lowOnly=true');
    expect(low.data.map((p: { name: string }) => p.name)).toEqual(['Towel']); // the chair has no alert
    const justTwo = await get(`/reports/stock?branchId=${b2}&productId=1`);
    expect(justTwo.data[0].byBranch).toEqual([{ branchId: b2, qtyMilli: 3000 }]);
  });

  it('overview: each branch’s figures, its open tills, its spending, and whether it has been heard from lately', async () => {
    const r = await get(`/reports/overview?${RANGE}`);
    const one = r.branches.find((b: { branchId: number }) => b.branchId === b1);
    const two = r.branches.find((b: { branchId: number }) => b.branchId === b2);
    expect(one).toMatchObject({
      name: 'Hamra',
      count: 3,
      netLbp: 195000,
      openRegisters: 0,
      stale: false,
      expenses: [{ currency: 'LBP', amount: 400000 }],
    });
    expect(two).toMatchObject({
      name: 'Verdun',
      count: 1,
      netLbp: 200000,
      openRegisters: 1,
      stale: true,
      expenses: [{ currency: 'USD', amount: 500 }],
    });
    expect(r.totals).toMatchObject({ count: 4, netLbp: 395000 });
  });
});

describe('who may read them', () => {
  it('only signed-in HQ staff, and any role may read: a viewer sees every report', async () => {
    for (const path of ['overview', 'sales', 'products', 'payments', 'expenses', 'registers', 'stock'])
      expect((await hq.http.get(`${api}/reports/${path}`)).status, path).toBe(401);
    const made = await hq.http
      .post(`${api}/users`)
      .set(adminAuth)
      .send({ username: 'viewer.one', name: 'V', role: 'viewer', password: 'a-long-first-password' });
    expect(made.status).toBe(201);
    const first = await hq.http.post(`${api}/auth/login`).send({ username: 'viewer.one', password: 'a-long-first-password' });
    const changed = await hq.http
      .post(`${api}/auth/password`)
      .set({ Authorization: `Bearer ${first.body.token}` })
      .send({ current: 'a-long-first-password', password: 'a-different-long-password' });
    const viewer = { Authorization: `Bearer ${changed.body.token}` };
    for (const path of ['overview', 'sales', 'products', 'payments', 'expenses', 'registers', 'stock'])
      expect((await hq.http.get(`${api}/reports/${path}`).set(viewer)).status, path).toBe(200);
  });
});
