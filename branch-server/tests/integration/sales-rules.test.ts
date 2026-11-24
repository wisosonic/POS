import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Business rules of the sale, tested the hard way: awkward amounts, hostile input, and cross-checks that every
// cached figure can be rebuilt from the underlying rows. (US-03 to US-06, decision table rows 5 to 21)
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

type Item = { productId: number; qty: string; unitPriceLbp: number };
type Pay = { method: string; currency: string; amount: number };
const cash = (amount: number): Pay => ({ method: 'cash', currency: 'LBP', amount });

const sell = (token: string, over: Record<string, unknown> = {}, key: string = randomUUID()) =>
  c.http.post(`${api}/sales`).set(auth(token)).set('Idempotency-Key', key).send(c.newSaleBody(over));

const towel = () => ({ productId: c.seed.products.towel.id, qty: '1', unitPriceLbp: 75000 });
const choc = (qty = '1') => ({ productId: c.seed.products.choc.id, qty, unitPriceLbp: 50000 });

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('discounts (decision table #17, #18)', () => {
  it('applies a percentage discount and the total follows it', async () => {
    const res = await sell(cashier, { items: [choc('2')], discount: { type: 'percent', value: 10 }, payments: [cash(90000)] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subtotalLbp: 100000, discountLbp: 10000, totalLbp: 90000, restLbp: 0 });
  });

  it('profit is the total after discount minus the cost', async () => {
    const res = await sell(cashier, { items: [choc('2')], discount: { type: 'percent', value: 10 }, payments: [cash(90000)] });
    expect(res.body.profitLbp).toBe(90000 - 2 * 40000);
  });

  it('applies a fixed discount', async () => {
    const res = await sell(cashier, { items: [choc('2')], discount: { type: 'amount', value: 5000 }, payments: [cash(95000)] });
    expect(res.body).toMatchObject({ discountLbp: 5000, totalLbp: 95000 });
  });

  it('a cashier is held to the discount limit (10% by default); a manager is not', async () => {
    // 100,000 less 11% is 89,000, which the till rounds to 90,000, so that is what is paid
    const over = { items: [choc('2')], discount: { type: 'percent', value: 11 }, payments: [cash(90000)] };
    const denied = await sell(cashier, over);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('DISCOUNT_OVER_LIMIT');
    expect((await sell(manager, over)).status).toBe(201);
  });

  it('the limit also applies to fixed discounts, measured as a share of the subtotal', async () => {
    const over = { items: [choc('2')], discount: { type: 'amount', value: 20000 }, payments: [cash(80000)] }; // 20%
    expect((await sell(cashier, over)).status).toBe(403);
    expect((await sell(cashier, { ...over, discount: { type: 'amount', value: 10000 }, payments: [cash(90000)] })).status).toBe(201); // exactly 10%
  });

  it('the limit is a setting', async () => {
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ cashierDiscountLimitPct: 25 });
    expect((await sell(cashier, { items: [choc('2')], discount: { type: 'percent', value: 20 }, payments: [cash(80000)] })).status).toBe(
      201,
    );
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ cashierDiscountLimitPct: 10 });
  });

  it('a discount larger than the subtotal is refused, even for a manager', async () => {
    const res = await sell(manager, { items: [choc()], discount: { type: 'amount', value: 50001 }, payments: [cash(1)] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
  });

  it('a 100% discount leaves nothing to pay and is refused', async () => {
    const res = await sell(manager, { items: [choc()], discount: { type: 'percent', value: 100 }, payments: [] });
    expect(res.status).toBe(422);
  });

  it.each([
    ['over 100 percent', { type: 'percent', value: 101 }],
    ['a negative percentage', { type: 'percent', value: -5 }],
    ['a fractional fixed amount', { type: 'amount', value: 10.5 }],
    ['an unknown type', { type: 'coupon', value: 5 }],
  ])('rejects %s', async (_n, discount) => {
    expect((await sell(manager, { discount })).status).toBe(400);
  });
});

describe('rounding and weighed items (decision: totals round to 5,000 LBP)', () => {
  it('rounds the total to the nearest 5,000 and shows the adjustment', async () => {
    // 0.123 kg × 400,000 = 49,200 → rounds up to 50,000 (+800)
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.kg.id, qty: '0.123', unitPriceLbp: 400000 }],
      payments: [cash(50000)],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subtotalLbp: 49200, roundingLbp: 800, totalLbp: 50000 });
  });

  it('rounds down when the total is closer to the lower multiple', async () => {
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.kg.id, qty: '0.118', unitPriceLbp: 400000 }],
      payments: [cash(45000)],
    });
    // 0.118 × 400,000 = 47,200 → nearest 5,000 is 45,000 (-2,200)
    expect(res.body).toMatchObject({ subtotalLbp: 47200, roundingLbp: -2200, totalLbp: 45000 });
  });

  it('the rounding increment is a setting', async () => {
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ lbpRounding: 1000 });
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.kg.id, qty: '0.123', unitPriceLbp: 400000 }],
      payments: [cash(49000)],
    });
    expect(res.body).toMatchObject({ totalLbp: 49000, roundingLbp: -200 });
    await c.http.patch(`${api}/settings`).set(auth(admin)).send({ lbpRounding: 5000 });
  });

  it('a sale that rounds down to nothing is refused rather than recorded for free', async () => {
    // 0.001 kg = 400 LBP, which rounds to 0
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.kg.id, qty: '0.001', unitPriceLbp: 400000 }],
      payments: [cash(1)],
    });
    expect(res.status).toBe(422);
  });

  it('refuses to sell part of an item sold by the piece', async () => {
    const res = await sell(cashier, { items: [{ ...towel(), qty: '0.5' }], payments: [cash(40000)] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FRACTIONAL_NOT_ALLOWED');
  });

  it('keeps the quantity as sold on the line and in the stock ledger', async () => {
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.kg.id, qty: '0.250', unitPriceLbp: 400000 }],
      payments: [cash(100000)],
    });
    expect(res.body.items[0].qty).toBe('0.25');
    const ledger = await c.http.get(`${api}/stock/${c.seed.products.kg.id}/movements?limit=1`).set(auth(manager));
    expect(ledger.body.data[0]).toMatchObject({ qtyDelta: '-0.25', reason: 'sale', refType: 'sale', refId: res.body.id });
  });
});

describe('pricing from the catalog (rule 2: the server decides totals)', () => {
  it('ignores totals the client tries to dictate', async () => {
    const res = await sell(cashier, {
      totalLbp: 1,
      subtotalLbp: 1,
      profitLbp: 999999,
      status: 'paid',
      paidLbp: 1,
      payments: [cash(75000)],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ totalLbp: 75000, subtotalLbp: 75000 });
  });

  it('refuses a stale price and says what the price should be', async () => {
    const res = await sell(cashier, { items: [{ ...towel(), unitPriceLbp: 70000 }], payments: [cash(70000)] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'PRICE_MISMATCH',
      expectedUnitPriceLbp: 75000,
      sentUnitPriceLbp: 70000,
      productId: c.seed.products.towel.id,
    });
  });

  it('a manager may sell at their own price, and that is audited', async () => {
    const res = await sell(manager, { items: [{ ...towel(), unitPriceLbp: 60000 }], payments: [cash(60000)] });
    expect(res.status).toBe(201);
    expect(res.body.totalLbp).toBe(60000);
    const log = await c.http.get(`${api}/audit?action=sale.price.override&entityId=${res.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({
      before: { unitPriceLbp: 75000 },
      after: { unitPriceLbp: 60000 },
      userId: c.seed.users.manager.id,
    });
  });

  it('a USD product costs its dollar price at the current rate; the profit uses its USD cost', async () => {
    const res = await sell(cashier, {
      items: [{ productId: c.seed.products.usd.id, qty: '2', unitPriceLbp: 225000 }],
      payments: [cash(450000)],
    });
    expect(res.body.totalLbp).toBe(450000);
    // cost $2.13 → 191,700 LBP each
    expect(res.body.profitLbp).toBe(450000 - 2 * 191700);
  });

  it('refuses an inactive product', async () => {
    const p = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'Discontinued', barcode: '7100000000001', priceMinor: 10000, currency: 'LBP', unitId: c.seed.units.piece.id });
    await c.http.delete(`${api}/products/${p.body.id}`).set(auth(manager));
    const res = await sell(cashier, { items: [{ productId: p.body.id, qty: '1', unitPriceLbp: 10000 }], payments: [cash(10000)] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PRODUCT_INACTIVE');
  });

  it('refuses an unknown product or customer without leaking details', async () => {
    const noProduct = await sell(cashier, { items: [{ productId: 424242, qty: '1', unitPriceLbp: 1 }], payments: [cash(1)] });
    const noCustomer = await sell(cashier, { customerId: 424242 });
    expect([noProduct.status, noCustomer.status]).toEqual([422, 422]);
    expect(noProduct.body.code).toBe('INVALID_REFERENCE');
    expect(noCustomer.body.code).toBe('INVALID_REFERENCE');
    expect(JSON.stringify([noProduct.body, noCustomer.body])).not.toMatch(/SQLITE|FOREIGN/);
  });

  it('the same product on two lines is two lines and two stock movements', async () => {
    const before = await c.http.get(`${api}/stock?productId=${c.seed.products.choc.id}`).set(auth(manager));
    const res = await sell(cashier, { items: [choc(), choc('2')], payments: [cash(150000)] });
    expect(res.body.items).toHaveLength(2);
    const after = await c.http.get(`${api}/stock?productId=${c.seed.products.choc.id}`).set(auth(manager));
    expect(Number(before.body.data[0].qty) - Number(after.body.data[0].qty)).toBe(3);
  });
});

describe('payment (decision table #7 to #13)', () => {
  it('a wallet payment may not exceed the total, because change can only be given in cash', async () => {
    const res = await sell(cashier, { payments: [{ method: 'whish', currency: 'LBP', amount: 100000 }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WALLET_EXCEEDS_TOTAL');
  });

  it('a wallet and cash together can leave change, taken from the cash', async () => {
    const res = await sell(cashier, { payments: [{ method: 'whish', currency: 'LBP', amount: 50000 }, cash(30000)] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', changeLbp: 5000, receivedLbp: 80000, paidLbp: 75000 });
  });

  it('dollars for a lira price: the change is in lira', async () => {
    const res = await sell(cashier, { payments: [{ method: 'cash', currency: 'USD', amount: 100 }] }); // $1 = 90,000
    expect(res.body).toMatchObject({ changeLbp: 15000, receivedLbp: 90000 });
  });

  it('one payment method used twice in different currencies is two payment rows', async () => {
    const res = await sell(cashier, { payments: [{ method: 'cash', currency: 'USD', amount: 50 }, cash(30000)] }); // 45,000 + 30,000
    expect(res.body.payments).toEqual([
      { method: 'cash', currency: 'USD', amount: 50 },
      { method: 'cash', currency: 'LBP', amount: 30000 },
    ]);
    expect(res.body.changeLbp).toBe(0);
  });

  it('merges repeated tenders of the same method and currency', async () => {
    const res = await sell(cashier, { payments: [cash(40000), cash(35000)] });
    expect(res.body.payments).toEqual([{ method: 'cash', currency: 'LBP', amount: 75000 }]);
  });

  it.each([
    ['a zero amount', [{ method: 'cash', currency: 'LBP', amount: 0 }]],
    ['a negative amount', [{ method: 'cash', currency: 'LBP', amount: -75000 }]],
    ['a fractional amount', [{ method: 'cash', currency: 'LBP', amount: 75000.5 }]],
    ['an unknown currency', [{ method: 'cash', currency: 'EUR', amount: 75000 }]],
    ['a missing method', [{ currency: 'LBP', amount: 75000 }]],
    ['more than 12 payment lines', Array.from({ length: 13 }, () => cash(1000))],
  ])('rejects %s', async (_n, payments) => {
    expect((await sell(cashier, { payments })).status).toBe(400);
  });
});

describe('input validation', () => {
  // Thunks: the table is built before beforeAll runs, so the seeded product ids must be read lazily.
  it.each<[string, () => Record<string, unknown>]>([
    ['no items', () => ({ items: [] })],
    ['a missing items list', () => ({ items: undefined })],
    ['a zero quantity', () => ({ items: [{ ...towel(), qty: '0' }] })],
    ['a four-decimal quantity', () => ({ items: [{ ...towel(), qty: '1.2345' }] })],
    ['a quantity given as a number', () => ({ items: [{ ...towel(), qty: 1 }] })],
    ['a quantity in scientific notation', () => ({ items: [{ ...towel(), qty: '1e3' }] })],
    ['a negative price', () => ({ items: [{ ...towel(), unitPriceLbp: -1 }] })],
    ['a non-integer product id', () => ({ items: [{ ...towel(), productId: 1.5 }] })],
    ['more than 200 lines', () => ({ items: Array.from({ length: 201 }, () => towel()) })],
    ['notes over 500 characters', () => ({ notes: 'x'.repeat(501) })],
  ])('rejects %s', async (_n, over) => {
    const res = await sell(cashier, over());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('rejects an Idempotency-Key that is empty, too long or has odd characters', async () => {
    for (const key of ['', 'k'.repeat(129), 'has space', 'tab\there']) {
      const res = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(c.newSaleBody());
      expect(res.status, JSON.stringify(key)).toBe(400);
    }
  });

  it('keeps a free-text note exactly as given, never interpreting it', async () => {
    const note = `'); DROP TABLE sales;-- <script>alert(1)</script> خبز`;
    const res = await sell(cashier, { notes: note });
    expect(res.status).toBe(201);
    expect(res.body.notes).toBe(note);
    expect((await c.http.get(`${api}/sales/${res.body.id}`).set(auth(cashier))).body.notes).toBe(note);
  });
});

describe('idempotency and numbering', () => {
  it('a rejected request does not use up its key: the corrected request with the same key goes through', async () => {
    const key = randomUUID();
    const bad = await sell(cashier, { items: [{ ...towel(), unitPriceLbp: 1 }], payments: [cash(1)] }, key);
    expect(bad.status).toBe(422);
    const good = await sell(cashier, {}, key);
    expect(good.status).toBe(201);
  });

  it('a replay returns exactly the first answer and does not apply anything twice', async () => {
    const key = randomUUID();
    const body = c.newSaleBody();
    const stock = async () =>
      Number((await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty);
    const before = await stock();
    const first = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    const again = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await stock()).toBe(before - 1);
  });

  it('the same body under a different key is a new sale', async () => {
    const body = c.newSaleBody({ clientSaleId: undefined });
    const a = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(body);
    const b = await c.http.post(`${api}/sales`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send(body);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('a clientSaleId that was already used is a conflict and records nothing', async () => {
    const clientSaleId = randomUUID();
    expect((await sell(cashier, { clientSaleId })).status).toBe(201);
    const stock = async () =>
      Number((await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty);
    const before = await stock();
    const dup = await sell(cashier, { clientSaleId });
    expect(dup.status).toBe(409);
    expect(await stock()).toBe(before);
  });

  it('receipt numbers rise by one, and a failed sale does not burn a number', async () => {
    const a = await sell(cashier);
    await sell(cashier, { items: [{ ...towel(), unitPriceLbp: 1 }] }); // refused
    const b = await sell(cashier);
    expect(b.body.ref).toBe(a.body.ref + 1);
  });

  it('numbers never repeat under parallel load', async () => {
    const rs = await Promise.all(Array.from({ length: 25 }, () => sell(cashier)));
    const refs = rs.map((r) => r.body.ref as number).sort((x, y) => x - y);
    expect(new Set(refs).size).toBe(25);
    expect(refs[24]! - refs[0]!).toBe(24); // no gaps either
  });
});

describe('reading sales', () => {
  it('a cashier lists only their own sales; a manager lists everyone’s', async () => {
    const mine = await sell(cashier);
    const theirs = await sell(manager);
    const asCashier = await c.http.get(`${api}/sales?limit=200`).set(auth(cashier));
    const asManager = await c.http.get(`${api}/sales?limit=200`).set(auth(manager));
    const idsC = asCashier.body.data.map((s: { id: number }) => s.id);
    expect(idsC).toContain(mine.body.id);
    expect(idsC).not.toContain(theirs.body.id);
    expect(asManager.body.data.map((s: { id: number }) => s.id)).toEqual(expect.arrayContaining([mine.body.id, theirs.body.id]));
  });

  it('a cashier cannot widen the list to someone else by passing userId', async () => {
    const res = await c.http.get(`${api}/sales?userId=${c.seed.users.manager.id}&limit=200`).set(auth(cashier));
    expect(res.body.data.every((s: { userId: number }) => s.userId === c.seed.users.cashier.id)).toBe(true);
  });

  it('finds a sale by receipt number', async () => {
    const s = await sell(cashier);
    const byRef = await c.http.get(`${api}/sales/by-ref/${s.body.ref}`).set(auth(cashier));
    expect(byRef.body.id).toBe(s.body.id);
    expect((await c.http.get(`${api}/sales/by-ref/99999999`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.get(`${api}/sales/99999999`).set(auth(cashier))).status).toBe(404);
  });

  it('pages newest first', async () => {
    const first = await c.http.get(`${api}/sales?limit=3`).set(auth(manager));
    expect(first.body.data).toHaveLength(3);
    expect(first.body.data[0].id).toBeGreaterThan(first.body.data[2].id);
    const next = await c.http.get(`${api}/sales?limit=3&cursor=${first.body.nextCursor}`).set(auth(manager));
    expect(next.body.data[0].id).toBeLessThan(first.body.data[2].id);
  });

  it('sales need a token', async () => {
    expect((await c.http.get(`${api}/sales`)).status).toBe(401);
    expect((await c.http.get(`${api}/sales/1`)).status).toBe(401);
  });
});

describe('receipts (US-06)', () => {
  it('returns the receipt model and a text rendering that fits the printer', async () => {
    const sale = await sell(cashier, { items: [towel(), choc('2')], payments: [cash(200000)] });
    const json = await c.http.get(`${api}/sales/${sale.body.id}/receipt`).set(auth(cashier));
    expect(json.body).toMatchObject({ storeName: 'Darwish Market', ref: sale.body.ref, totalLbp: 175000, changeLbp: 25000 });
    expect(json.body.items).toHaveLength(2);

    const text = await c.http.get(`${api}/sales/${sale.body.id}/receipt?format=text`).set(auth(cashier));
    expect(text.headers['content-type']).toMatch(/text\/plain/);
    const lines = (text.text as string).split('\n');
    expect(lines.every((l) => [...l].length <= 42)).toBe(true);
    expect(text.text).toContain(`Receipt #${sale.body.ref}`);
    expect(text.text).toMatch(/TOTAL \(LL\)\s+175,000/);
    expect(text.text).toMatch(/Change\s+25,000/);
  });

  it('a credit sale shows the customer, what remains and the account balance', async () => {
    const sale = await sell(cashier, { customerId: c.seed.customers.registered.id, payments: [cash(25000)] });
    const text = (await c.http.get(`${api}/sales/${sale.body.id}/receipt?format=text`).set(auth(cashier))).text as string;
    expect(text).toContain('Test Customer');
    expect(text).toMatch(/Remaining\s+50,000/);
    expect(text).toMatch(/Account balance\s+50,000/);
  });

  it('an Arabic product name prints as readable Latin, never as question marks', async () => {
    const p = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'خبز كبير', barcode: '7100000000002', priceMinor: 20000, currency: 'LBP', unitId: c.seed.units.piece.id });
    const sale = await sell(cashier, { items: [{ productId: p.body.id, qty: '1', unitPriceLbp: 20000 }], payments: [cash(20000)] });
    const text = (await c.http.get(`${api}/sales/${sale.body.id}/receipt?format=text`).set(auth(cashier))).text as string;
    expect(text).not.toContain('خبز');
    expect(text).not.toContain('?');
    expect(text).toContain(p.body.receiptName);
  });

  it('the receipt keeps the name as sold even if the product is renamed later', async () => {
    const p = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'Old label', barcode: '7100000000003', priceMinor: 10000, currency: 'LBP', unitId: c.seed.units.piece.id });
    const sale = await sell(cashier, { items: [{ productId: p.body.id, qty: '1', unitPriceLbp: 10000 }], payments: [cash(10000)] });
    await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ name: 'New label', priceMinor: 99999 });
    const detail = await c.http.get(`${api}/sales/${sale.body.id}`).set(auth(cashier));
    expect(detail.body.items[0]).toMatchObject({ name: 'Old label', unitPriceLbp: 10000 });
  });

  it('unknown sale is 404 and a token is required', async () => {
    expect((await c.http.get(`${api}/sales/99999999/receipt`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.get(`${api}/sales/1/receipt`)).status).toBe(401);
  });
});

describe('everything stays consistent under a mixed parallel workload', () => {
  it('stock ledger = stock cache, and the register recomputes to the running totals', async () => {
    const methods = ['cash', 'whish', 'omt'] as const;
    const requests = Array.from({ length: 36 }, (_, i) => {
      const method = methods[i % 3]!;
      const useUsd = i % 4 === 0;
      const item: Item = useUsd ? { productId: c.seed.products.usd.id, qty: '1', unitPriceLbp: 225000 } : i % 2 ? choc() : towel();
      const total = useUsd ? 225000 : item.unitPriceLbp;
      const payments: Pay[] = useUsd ? [{ method, currency: 'USD', amount: 250 }] : [{ method, currency: 'LBP', amount: total }];
      return sell(i % 5 === 0 ? manager : cashier, { items: [item], payments });
    });
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 201)).toBe(true);

    // 1. every product: cached quantity equals the sum of its ledger
    for (const p of Object.values(c.seed.products)) {
      const cache = Number((await c.http.get(`${api}/stock?productId=${p.id}`).set(auth(manager))).body.data[0].qty);
      const ledger = await c.http.get(`${api}/stock/${p.id}/movements?limit=500`).set(auth(manager));
      const sum = ledger.body.data.reduce((a: number, m: { qtyDelta: string }) => a + Number(m.qtyDelta), 0);
      expect(sum, `product ${p.id}`).toBeCloseTo(cache, 6);
    }

    // 2. the register's running "expected" equals what the rows add up to (opening + sales - change ...)
    const current = await c.http.get(`${api}/registers/current`).set(auth(cashier));
    const z = await c.http.get(`${api}/reports/register/${current.body.id}`).set(auth(manager));
    for (const live of current.body.balances as { method: string; currency: string; expected: number }[]) {
      const rebuilt = z.body.balances.find(
        (b: { method: string; currency: string }) => b.method === live.method && b.currency === live.currency,
      );
      expect(rebuilt.expected, `${live.method}/${live.currency}`).toBe(live.expected);
    }

    // 3. the Z-report's totals match the sales list
    const all = await c.http.get(`${api}/sales?limit=200`).set(auth(manager));
    const sum = (all.body.data as { totalLbp: number }[]).reduce((a, s) => a + s.totalLbp, 0);
    if (all.body.nextCursor === null) expect(z.body.totals.salesTotalLbp).toBe(sum);
    expect(z.body.totals.salesCount).toBeGreaterThanOrEqual(36);
  });

  it('every credit-sale invariant holds: balance = sum of open sales, paid + rest = total', async () => {
    const id = c.seed.customers.registered.id;
    for (const paid of [0, 10000, 30000]) await sell(cashier, { customerId: id, payments: paid ? [cash(paid)] : [] });
    const customer = await c.http.get(`${api}/customers/${id}`).set(auth(cashier));
    const open = await c.http.get(`${api}/customers/${id}/open-sales`).set(auth(cashier));
    const rest = (open.body.data as { restLbp: number }[]).reduce((a, s) => a + s.restLbp, 0);
    expect(customer.body.balanceLbp).toBe(rest);
    for (const s of open.body.data as { totalLbp: number; paidLbp: number; restLbp: number }[])
      expect(s.paidLbp + s.restLbp).toBe(s.totalLbp);
  });
});
