import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from './helpers';

// The central stock view's suggestions (docs/15 §8, P5f) over rows made by hand, so every figure can be worked out on paper: reorder for a stock branch
// (stock + on the way + on order against the alert) and rebalancing between shops (slow ones send back, fast ones ask), which only ever suggests.
let hq: Hq;
let w = 0; // the stock branch
let s1 = 0; // a slow shop
let s2 = 0; // a fast shop
let rice = 0;
let soap = 0;
let milk = 0;
const api = '/api/v1';
const get = async (path: string) => (await hq.http.get(`${api}${path}`).set(adminAuth)).body;
const run = (sql: string, params: (string | number | null)[] = []) => hq.app.database.run(sql, params);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

let movementId = 0;
const stock = (branch: number, product: number, qtyMilli: number) =>
  run(
    `INSERT INTO stock_movements (branch_id, id, product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note, created_at, hq_received_at) VALUES (?, ?, ?, 1, ?, 'adjustment', NULL, NULL, NULL, NULL, ?, 'x')`,
    [branch, ++movementId, product, qtyMilli, daysAgo(40)],
  );
let saleId = 0;
const sold = async (branch: number, product: number, qtyMilli: number, status = 'completed') => {
  const id = ++saleId;
  await run(
    `INSERT INTO sales (branch_id, id, ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, discount_lbp, shipping_lbp, rounding_lbp, total_lbp, paid_lbp, change_lbp, rest_lbp, profit_lbp, status, notes, created_at, hq_received_at) VALUES (?, ?, ?, NULL, NULL, 1, 1, 90000, 1, 0, 0, 0, 1, 1, 0, 0, 0, ?, '', ?, 'x')`,
    [branch, id, id, status, daysAgo(5)],
  );
  await run(
    `INSERT INTO sale_items (branch_id, id, sale_id, product_id, name_snap, receipt_name_snap, barcode_snap, brand_snap, unit_snap, qty_milli, unit_price_lbp, unit_cost_lbp, line_total_lbp, legacy_id, hq_received_at)
     VALUES (?, ?, ?, ?, 'x', NULL, '', '', '', ?, 0, 0, 0, NULL, 'x')`,
    [branch, id, id, product, qtyMilli],
  );
};
const order = async (qty: string) => {
  const made = await hq.http
    .post(`${api}/purchase-orders`)
    .set(adminAuth)
    .send({ currency: 'LBP', lines: [{ stockBranchId: w, productId: rice, qty, unitCostMinor: 1000 }] });
  expect(made.status).toBe(201);
  expect((await hq.http.post(`${api}/purchase-orders/${made.body.id}/order`).set(adminAuth).send({})).status).toBe(200);
  return made.body.id as number;
};

beforeAll(async () => {
  hq = await startHq();
  for (const [code, kind] of [
    ['W', 'stock'],
    ['S1', 'sale'],
    ['S2', 'sale'],
  ])
    expect(
      (
        await hq.http
          .post(`${api}/branches`)
          .set(adminAuth)
          .send({ code, name: `Branch ${code}`, kind })
      ).status,
    ).toBe(201);
  const idOf = async (code: string) => (await hq.app.database.one<{ id: number }>('SELECT id FROM branches WHERE code = ?', [code]))!.id;
  [w, s1, s2] = [await idOf('W'), await idOf('S1'), await idOf('S2')];
  const make = async (name: string, stockAlert?: number) =>
    (await hq.http.post(`${api}/products`).set(adminAuth).send({ name, priceMinor: 1000, stockAlert })).body.id as number;
  rice = await make('Rice', 10);
  soap = await make('Soap', 5);
  milk = await make('Milk'); // no alert: never suggested for buying

  // the warehouse: 4 rice (low), 20 soap (fine), 1 milk
  await stock(w, rice, 4000);
  await stock(w, soap, 20000);
  await stock(w, milk, 1000);
  // shop 1: 90 rice, sells 3 in the window (a voided sale of 50 must not count)
  await stock(s1, rice, 90000);
  await sold(s1, rice, 3000);
  await sold(s1, rice, 50000, 'void');
  // shop 2: 1 rice, sells 30 in the window; it already asked for 5 and is still waiting
  await stock(s2, rice, 1000);
  await sold(s2, rice, 30000);
  await run(
    `INSERT INTO request_status (for_branch_id, request_id, product_id, wanted_milli, shipped_milli, unavailable_milli, status, created_at, updated_at) VALUES (?, 1, ?, 5000, 0, 0, 'waiting', 'x', 'x')`,
    [s2, rice],
  );
  // something nobody could supply, 3 rice for shop 1, asked recently
  await run(
    `INSERT INTO stock_requests (branch_id, id, note, item_count, user_id, created_at, hq_received_at) VALUES (?, 9, NULL, 1, NULL, ?, 'x')`,
    [s1, daysAgo(2)],
  );
  await run(
    `INSERT INTO request_status (for_branch_id, request_id, product_id, wanted_milli, shipped_milli, unavailable_milli, status, created_at, updated_at) VALUES (?, 9, ?, 3000, 0, 3000, 'done', 'x', 'x')`,
    [s1, rice],
  );
});
afterAll(async () => {
  await hq.close();
});

describe('reorder suggestions for the stock branches (US-HQ-stock)', () => {
  it('a stock branch at or under the alert is suggested up to twice the alert, with the unmet demand beside it', async () => {
    const r = (await get('/reports/reorder')).data as Record<string, number | string>[];
    expect(r.map((x) => x.name)).toEqual(['Rice']); // soap is fine, milk has no alert, the shops are not stock branches
    expect(r[0]).toMatchObject({
      branchId: w,
      qtyMilli: 4000,
      inTransitMilli: 0,
      onOrderMilli: 0,
      alertMilli: 10000,
      suggestMilli: 16000,
      unmetMilli: 3000,
    });
  });

  it('what is already on order counts, so the same goods are not bought twice; a closed order does not', async () => {
    await order('6');
    let r = (await get('/reports/reorder')).data;
    expect(r[0]).toMatchObject({ qtyMilli: 4000, onOrderMilli: 6000, suggestMilli: 10000 }); // 4 + 6 on order = at the alert: still low
    const second = await order('12');
    r = (await get('/reports/reorder')).data;
    expect(r).toEqual([]); // 4 + 6 + 12 is over the alert
    // the stock report shows what is on order, per branch and in all
    const row = (await get(`/reports/stock?productId=${rice}`)).data[0];
    expect(row.onOrderMilli).toBe(18000);
    expect(row.byBranch.find((b: { branchId: number }) => b.branchId === w).onOrderMilli).toBe(18000);
    // cancelling the big order puts the need back
    expect((await hq.http.post(`${api}/purchase-orders/${second}/cancel`).set(adminAuth).send({})).status).toBe(200);
    expect((await get('/reports/reorder')).data[0]).toMatchObject({ onOrderMilli: 6000, suggestMilli: 10000 });
  });

  it('can be limited to one stock branch, and needs a staff sign-in', async () => {
    expect((await get(`/reports/reorder?branchId=${s1}`)).data).toEqual([]); // a shop is not a stock branch
    expect((await hq.http.get(`${api}/reports/reorder`)).status).toBe(401);
    expect((await hq.http.get(`${api}/reports/rebalance`)).status).toBe(401);
  });
});

describe('rebalancing between shops (US-HQ-stock)', () => {
  it('a slow shop could send back what it will not sell, and a fast shop could ask for more, never shop to shop', async () => {
    const r = await get('/reports/rebalance');
    // shop 1: 90 on hand, 3 sold in 30 days (the voided 50 is out) = 900 days of cover. It keeps the alert (10) and could send back 80.
    expect(r.sendBack).toHaveLength(1);
    expect(r.sendBack[0]).toMatchObject({
      productId: rice,
      branchId: s1,
      qtyMilli: 90000,
      perDayMilli: 100,
      coverDays: 900,
      suggestMilli: 80000,
    });
    // shop 2: 1 on hand, 30 sold in 30 days = about one day of cover. A month's cover is 30, less 1 on hand and 5 already asked for.
    expect(r.requestMore).toHaveLength(1);
    expect(r.requestMore[0]).toMatchObject({
      productId: rice,
      branchId: s2,
      qtyMilli: 1000,
      perDayMilli: 1000,
      coverDays: 1,
      suggestMilli: 24000,
    });
    // the warehouse is never part of it
    expect([...r.sendBack, ...r.requestMore].some((x: { branchId: number }) => x.branchId === w)).toBe(false);
  });

  it('the thresholds can be changed, and a shop can be picked', async () => {
    // 900 days of cover is slow by any mark up to a year; a mark over a year is refused
    expect((await get('/reports/rebalance?slowDays=365')).sendBack).toHaveLength(1); // 900 days is still over 365
    expect((await hq.http.get(`${api}/reports/rebalance?slowDays=1000`).set(adminAuth)).status).toBe(400);
    expect((await get(`/reports/rebalance?branchId=${s2}`)).sendBack).toEqual([]);
    expect((await get(`/reports/rebalance?branchId=${s2}`)).requestMore).toHaveLength(1);
    expect((await hq.http.get(`${api}/reports/rebalance?slowDays=0`).set(adminAuth)).status).toBe(400);
  });
});
