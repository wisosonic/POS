import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Buying from suppliers (US-16, US-23, decision R2): stock goes up through the ledger, the order tracks what has arrived,
// and quantity on hand (zero or negative included) never stands in the way.
let c: TestCtx;
let manager: string;
let cashier: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Line = { productId: number; qty: string; costMinor: number };

const order = (items: Line[], over: Record<string, unknown> = {}) =>
  c.http
    .post(`${api}/purchases`)
    .set(auth(manager))
    .send({ supplierId: c.seed.suppliers.main.id, currency: 'LBP', items, ...over });
const receive = (id: number, body: Record<string, unknown> = {}, key: string = randomUUID()) =>
  c.http.post(`${api}/purchases/${id}/receive`).set(auth(manager)).set('Idempotency-Key', key).send(body);
const payFor = (id: number, body: Record<string, unknown>, key: string = randomUUID()) =>
  c.http.post(`${api}/purchases/${id}/payments`).set(auth(manager)).set('Idempotency-Key', key).send(body);
const stock = async (productId: number) =>
  Number((await c.http.get(`${api}/stock?productId=${productId}`).set(auth(manager))).body.data[0].qty);
const get = async (id: number) => (await c.http.get(`${api}/purchases/${id}`).set(auth(manager))).body;
const choc = (qty: string, costMinor = 38000): Line => ({ productId: c.seed.products.choc.id, qty, costMinor });
const towel = (qty: string, costMinor = 67000): Line => ({ productId: c.seed.products.towel.id, qty, costMinor });

beforeAll(async () => {
  c = await startCtx();
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('placing an order', () => {
  it('prices each line and totals the order', async () => {
    const res = await order([choc('10'), towel('2.5')]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'draft',
      currency: 'LBP',
      totalMinor: 380000 + 167500,
      paidMinor: 0,
      owedMinor: 547500,
      supplierName: 'Test Supplier',
    });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[1]).toMatchObject({ qty: '2.5', lineTotalMinor: 167500, received: '0', outstanding: '2.5' });
  });

  it('numbers purchases 1, 2, 3 ...', async () => {
    const a = await order([choc('1')]);
    const b = await order([choc('1')]);
    expect(b.body.ref).toBe(a.body.ref + 1);
  });

  it('can be placed straight as ordered, in dollars, with no supplier', async () => {
    const res = await order([choc('4', 250)], { currency: 'USD', status: 'ordered', supplierId: null });
    expect(res.body).toMatchObject({ status: 'ordered', currency: 'USD', totalMinor: 1000, supplierId: null, supplierName: null });
  });

  it('stock on hand does not matter: you can order a product that is at zero, negative, or has never had stock', async () => {
    await c.http
      .post(`${api}/stock/adjustments`)
      .set(auth(manager))
      .send({ productId: c.seed.products.rare.id, qtyDelta: '-4', reason: 'oversold' });
    expect(await stock(c.seed.products.rare.id)).toBe(-3);
    expect((await order([{ productId: c.seed.products.rare.id, qty: '20', costMinor: 6000 }])).status).toBe(201);
    const fresh = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'Brand new', priceMinor: 20000, unitId: c.seed.units.piece.id });
    expect((await order([{ productId: fresh.body.id, qty: '12', costMinor: 12000 }])).status).toBe(201);
  });

  it.each<[string, () => Record<string, unknown>, number]>([
    ['no items', () => ({ items: [] }), 400],
    ['a zero quantity', () => ({ items: [choc('0')] }), 400],
    ['a four-decimal quantity', () => ({ items: [choc('1.2345')] }), 400],
    ['a negative cost', () => ({ items: [{ ...choc('1'), costMinor: -1 }] }), 400],
    ['a fractional cost', () => ({ items: [{ ...choc('1'), costMinor: 1.5 }] }), 400],
    ['an unknown currency', () => ({ currency: 'EUR' }), 400],
    ['an unknown status', () => ({ status: 'received' }), 400],
    ['more than 200 lines', () => ({ items: Array.from({ length: 201 }, () => choc('1')) }), 400],
    ['a product that does not exist', () => ({ items: [{ productId: 999999, qty: '1', costMinor: 1 }] }), 422],
    ['a supplier that does not exist', () => ({ supplierId: 999999 }), 422],
  ])('refuses %s', async (_n, over, status) => {
    const res = await order([choc('1')], over());
    expect(res.status).toBe(status);
  });

  it('is for managers only', async () => {
    expect(
      (
        await c.http
          .post(`${api}/purchases`)
          .set(auth(cashier))
          .send({ items: [choc('1')] })
      ).status,
    ).toBe(403);
    expect((await c.http.get(`${api}/purchases`).set(auth(cashier))).status).toBe(403);
    expect((await c.http.post(`${api}/purchases`).send({ items: [choc('1')] })).status).toBe(401);
  });
});

describe('editing and deleting before anything arrives', () => {
  it('a draft can be changed: lines, supplier and status', async () => {
    const p = await order([choc('1')]);
    const res = await c.http
      .patch(`${api}/purchases/${p.body.id}`)
      .set(auth(manager))
      .send({ items: [towel('3')], status: 'ordered' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ordered', totalMinor: 201000 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Cedars silver towel');
  });

  it('an empty patch changes nothing', async () => {
    const p = await order([choc('2')]);
    expect((await c.http.patch(`${api}/purchases/${p.body.id}`).set(auth(manager)).send({})).body.totalMinor).toBe(p.body.totalMinor);
  });

  it('a draft can be deleted, an ordered purchase cannot', async () => {
    const draft = await order([choc('1')]);
    expect((await c.http.delete(`${api}/purchases/${draft.body.id}`).set(auth(manager))).status).toBe(204);
    expect((await c.http.get(`${api}/purchases/${draft.body.id}`).set(auth(manager))).status).toBe(404);

    const ordered = await order([choc('1')], { status: 'ordered' });
    const res = await c.http.delete(`${api}/purchases/${ordered.body.id}`).set(auth(manager));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PURCHASE_NOT_DRAFT');
  });

  it('cannot be edited once goods have arrived, even partly', async () => {
    const p = await order([choc('10')]);
    await receive(p.body.id, { items: [{ purchaseItemId: p.body.items[0].id, qty: '4' }] });
    const res = await c.http
      .patch(`${api}/purchases/${p.body.id}`)
      .set(auth(manager))
      .send({ items: [choc('1')] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PURCHASE_PARTLY_RECEIVED');
  });

  it('404 for an unknown purchase', async () => {
    expect((await c.http.patch(`${api}/purchases/999999`).set(auth(manager)).send({ status: 'ordered' })).status).toBe(404);
    expect((await c.http.delete(`${api}/purchases/999999`).set(auth(manager))).status).toBe(404);
  });
});

describe('receiving goods', () => {
  it('adds the whole order to stock, through the ledger', async () => {
    const before = await stock(c.seed.products.choc.id);
    const p = await order([choc('10')]);
    const res = await receive(p.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'received', receivedNow: [{ productId: c.seed.products.choc.id, qty: '10' }] });
    expect(res.body.receivedAt).toBeTruthy();
    expect(await stock(c.seed.products.choc.id)).toBe(before + 10);
    const ledger = await c.http.get(`${api}/stock/${c.seed.products.choc.id}/movements?limit=1`).set(auth(manager));
    expect(ledger.body.data[0]).toMatchObject({ qtyDelta: '10', reason: 'purchase', refType: 'purchase', refId: p.body.id });
  });

  it('works while the product is at zero or below', async () => {
    const id = c.seed.products.rare.id;
    const before = await stock(id); // negative from the earlier test
    expect(before).toBeLessThan(0);
    const p = await order([{ productId: id, qty: '20', costMinor: 6000 }]);
    expect((await receive(p.body.id)).status).toBe(200);
    expect(await stock(id)).toBe(before + 20);
  });

  it('can arrive in parts: the order stays open until everything has come', async () => {
    const before = await stock(c.seed.products.towel.id);
    const p = await order([towel('10'), choc('6')]);
    const [t, ch] = p.body.items as { id: number }[];

    const first = await receive(p.body.id, { items: [{ purchaseItemId: t!.id, qty: '4' }] });
    expect(first.body.status).toBe('ordered');
    expect(first.body.items[0]).toMatchObject({ received: '4', outstanding: '6' });
    expect(await stock(c.seed.products.towel.id)).toBe(before + 4);

    const second = await receive(p.body.id, { items: [{ purchaseItemId: t!.id, qty: '6' }] });
    expect(second.body.status).toBe('ordered'); // the chocolate has not arrived
    const rest = await receive(p.body.id); // no body: everything still outstanding
    expect(rest.body).toMatchObject({ status: 'received', receivedNow: [{ purchaseItemId: ch!.id, qty: '6' }] });
    expect(await stock(c.seed.products.towel.id)).toBe(before + 10);
  });

  it('cannot receive more than was ordered, and nothing is applied when it is refused', async () => {
    const p = await order([choc('5')]);
    const item = p.body.items[0].id;
    const before = await stock(c.seed.products.choc.id);
    const res = await receive(p.body.id, { items: [{ purchaseItemId: item, qty: '6' }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'RECEIVE_EXCEEDS_ORDERED', outstanding: '5' });
    expect(await stock(c.seed.products.choc.id)).toBe(before);
  });

  it('a multi-line receipt is all or nothing', async () => {
    const p = await order([choc('5'), towel('5')]);
    const [a, b] = p.body.items as { id: number }[];
    const before = [await stock(c.seed.products.choc.id), await stock(c.seed.products.towel.id)];
    const res = await receive(p.body.id, {
      items: [
        { purchaseItemId: a!.id, qty: '5' },
        { purchaseItemId: b!.id, qty: '9' }, // too many
      ],
    });
    expect(res.status).toBe(422);
    expect([await stock(c.seed.products.choc.id), await stock(c.seed.products.towel.id)]).toEqual(before);
    expect((await get(p.body.id)).items[0].received).toBe('0');
  });

  it('refuses a line from another purchase, a repeated line, or a bad quantity', async () => {
    const a = await order([choc('5')]);
    const b = await order([choc('5')]);
    expect((await receive(a.body.id, { items: [{ purchaseItemId: b.body.items[0].id, qty: '1' }] })).status).toBe(422);
    const item = a.body.items[0].id;
    expect(
      (
        await receive(a.body.id, {
          items: [
            { purchaseItemId: item, qty: '1' },
            { purchaseItemId: item, qty: '1' },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await receive(a.body.id, { items: [{ purchaseItemId: item, qty: '0' }] })).status).toBe(400);
    expect((await receive(a.body.id, { items: [] })).status).toBe(400);
  });

  it('a fully received purchase cannot be received again, even with a new key', async () => {
    const p = await order([choc('3')]);
    await receive(p.body.id);
    const stockAfter = await stock(c.seed.products.choc.id);
    const again = await receive(p.body.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PURCHASE_RECEIVED');
    expect(await stock(c.seed.products.choc.id)).toBe(stockAfter);
  });

  it('a purchase that does not exist is 404', async () => {
    expect((await receive(999999)).status).toBe(404);
  });

  it('is idempotent: the same key twice adds the stock once and returns the same answer', async () => {
    const p = await order([choc('7')]);
    const key = randomUUID();
    const before = await stock(c.seed.products.choc.id);
    const first = await receive(p.body.id, {}, key);
    const again = await receive(p.body.id, {}, key);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await stock(c.seed.products.choc.id)).toBe(before + 7);
  });

  it('the same key on a different purchase is refused, not mistaken for a repeat', async () => {
    const a = await order([choc('1')]);
    const b = await order([choc('1')]);
    const key = randomUUID();
    await receive(a.body.id, {}, key);
    const res = await receive(b.body.id, {}, key);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('parallel duplicates add the stock exactly once', async () => {
    const p = await order([choc('9')]);
    const key = randomUUID();
    const before = await stock(c.seed.products.choc.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => receive(p.body.id, {}, key)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await stock(c.seed.products.choc.id)).toBe(before + 9);
  });

  it('needs the key, a manager and a token', async () => {
    const p = await order([choc('1')]);
    expect((await c.http.post(`${api}/purchases/${p.body.id}/receive`).set(auth(manager)).send({})).status).toBe(400);
    expect(
      (await c.http.post(`${api}/purchases/${p.body.id}/receive`).set(auth(cashier)).set('Idempotency-Key', randomUUID()).send({})).status,
    ).toBe(403);
    expect((await c.http.post(`${api}/purchases/${p.body.id}/receive`).set('Idempotency-Key', randomUUID()).send({})).status).toBe(401);
  });

  it('is audited', async () => {
    const p = await order([choc('2')]);
    await receive(p.body.id);
    const log = await c.http.get(`${api}/audit?action=purchase.receive&entityId=${p.body.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ userId: c.seed.users.manager.id, after: { complete: true } });
  });
});

describe('cost follows what was paid (US-16)', () => {
  it('updates the product cost when it differs, and audits it like a price change', async () => {
    const id = c.seed.products.towel.id;
    const p = await order([towel('1', 70000)]); // was 67,000
    const res = await receive(p.body.id);
    expect(res.body.costUpdates).toEqual([{ productId: id, before: 67000, after: 70000, currency: 'LBP' }]);
    expect((await c.http.get(`${api}/products/${id}`).set(auth(manager))).body.costMinor).toBe(70000);
    const log = await c.http.get(`${api}/audit?action=product.price.update&entityId=${id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ before: { costMinor: 67000 }, after: { costMinor: 70000 } });
    expect(log.body.data[0].after.priceMinor).toBe(75000); // the selling price is untouched
  });

  it('leaves the cost alone when it is the same or when asked not to', async () => {
    const id = c.seed.products.choc.id;
    // earlier tests in this file received chocolate at other costs, so read what it costs now
    const current = (await c.http.get(`${api}/products/${id}`).set(auth(manager))).body.costMinor as number;
    const same = await order([choc('1', current)]);
    expect((await receive(same.body.id)).body.costUpdates).toEqual([]);
    const skip = await order([choc('1', current + 5000)]);
    const res = await receive(skip.body.id, { updateCost: false });
    expect(res.body.costUpdates).toEqual([]);
    expect((await c.http.get(`${api}/products/${id}`).set(auth(manager))).body.costMinor).toBe(current);
  });

  it('converts between currencies for a product priced in the other one', async () => {
    // the USD product costs $2.13; buying it for 200,000 LBP (rate 90,000 = $2.22) sets the cost to 222 cents
    const id = c.seed.products.usd.id;
    const p = await order([{ productId: id, qty: '1', costMinor: 200000 }]);
    const res = await receive(p.body.id);
    expect(res.body.costUpdates).toEqual([{ productId: id, before: 213, after: 222, currency: 'USD' }]);
  });

  it('a profit already recorded on an old sale does not change when the cost does', async () => {
    await c.openRegister(cashier);
    const sold = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: [{ productId: c.seed.products.choc.id, qty: '1', unitPriceLbp: 50000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 50000 }],
        }),
      );
    const profit = sold.body.profitLbp;
    const p = await order([choc('1', 45000)]);
    await receive(p.body.id);
    expect((await c.http.get(`${api}/sales/${sold.body.id}`).set(auth(cashier))).body.profitLbp).toBe(profit);
  });
});

describe('paying suppliers (US-23)', () => {
  it('records part payments and what is still owed', async () => {
    const p = await order([choc('10')], { status: 'ordered' }); // 380,000
    const first = await payFor(p.body.id, { amountMinor: 100000, note: 'deposit' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ paidMinor: 100000, owedMinor: 280000 });
    const rest = await payFor(p.body.id, { amountMinor: 280000 });
    expect(rest.body).toMatchObject({ paidMinor: 380000, owedMinor: 0 });
  });

  it('cannot pay more than is owed', async () => {
    const p = await order([choc('1')], { status: 'ordered' });
    const res = await payFor(p.body.id, { amountMinor: p.body.totalMinor + 1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_EXCEEDS_TOTAL');
    expect((await get(p.body.id)).paidMinor).toBe(0);
  });

  it('a draft is not owed yet', async () => {
    const p = await order([choc('1')]);
    const res = await payFor(p.body.id, { amountMinor: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PURCHASE_NOT_ORDERED');
  });

  it('can be paid after the goods arrive', async () => {
    const p = await order([choc('2')]);
    await receive(p.body.id);
    expect((await payFor(p.body.id, { amountMinor: 76000 })).status).toBe(201);
  });

  it('is idempotent, and parallel duplicates pay once', async () => {
    const p = await order([choc('10')], { status: 'ordered' });
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 5 }, () => payFor(p.body.id, { amountMinor: 50000 }, key)));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect((await get(p.body.id)).paidMinor).toBe(50000);
  });

  it.each([
    ['zero', { amountMinor: 0 }],
    ['negative', { amountMinor: -5 }],
    ['fractional', { amountMinor: 10.5 }],
    ['missing', {}],
  ])('refuses an amount that is %s', async (_n, body) => {
    const p = await order([choc('1')], { status: 'ordered' });
    expect((await payFor(p.body.id, body)).status).toBe(400);
  });

  it('the payables report lists what is unpaid, oldest first, with totals per currency', async () => {
    const lbp = await order([choc('10')], { status: 'ordered' }); // 380,000 owed in LBP
    const usd = await order([choc('4', 250)], { currency: 'USD', status: 'ordered' }); // $10.00
    await payFor(lbp.body.id, { amountMinor: 80000 });
    const res = await c.http.get(`${api}/reports/payables`).set(auth(manager));
    const mine = (res.body.data as { purchaseId: number; owedMinor: number }[]).filter((r) =>
      [lbp.body.id, usd.body.id].includes(r.purchaseId),
    );
    expect(mine.map((r) => [r.purchaseId, r.owedMinor])).toEqual([
      [lbp.body.id, 300000],
      [usd.body.id, 1000],
    ]);
    expect(res.body.totalOwed.USD).toBeGreaterThanOrEqual(1000);
    const lbpSum = (res.body.data as { currency: string; owedMinor: number }[])
      .filter((r) => r.currency === 'LBP')
      .reduce((a, r) => a + r.owedMinor, 0);
    expect(res.body.totalOwed.LBP).toBe(lbpSum);
  });

  it('drafts and fully paid purchases are not payables', async () => {
    const draft = await order([choc('1')]);
    const paid = await order([choc('1')], { status: 'ordered' });
    await payFor(paid.body.id, { amountMinor: paid.body.totalMinor });
    const ids = ((await c.http.get(`${api}/reports/payables`).set(auth(manager))).body.data as { purchaseId: number }[]).map(
      (r) => r.purchaseId,
    );
    expect(ids).not.toContain(draft.body.id);
    expect(ids).not.toContain(paid.body.id);
  });

  it('is for managers only', async () => {
    expect((await c.http.get(`${api}/reports/payables`).set(auth(cashier))).status).toBe(403);
  });
});

describe('listing', () => {
  it('filters by status and supplier, newest first', async () => {
    const res = await c.http.get(`${api}/purchases?status=received&limit=200`).set(auth(manager));
    expect(res.body.data.length).toBeGreaterThan(3);
    expect(res.body.data.every((p: { status: string }) => p.status === 'received')).toBe(true);
    const ids = res.body.data.map((p: { id: number }) => p.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    const none = await c.http.get(`${api}/purchases?supplierId=999999`).set(auth(manager));
    expect(none.body.data).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const first = await c.http.get(`${api}/purchases?limit=2`).set(auth(manager));
    const next = await c.http.get(`${api}/purchases?limit=2&cursor=${first.body.nextCursor}`).set(auth(manager));
    expect(next.body.data[0].id).toBeLessThan(first.body.data[1].id);
  });
});

describe('the ledger stays whole', () => {
  it('every product: cached quantity equals the sum of its ledger after all that buying', async () => {
    for (const p of Object.values(c.seed.products)) {
      const cache = await stock(p.id);
      const ledger = await c.http.get(`${api}/stock/${p.id}/movements?limit=500`).set(auth(manager));
      const sum = (ledger.body.data as { qtyDelta: string }[]).reduce((a, m) => a + Number(m.qtyDelta), 0);
      expect(sum, `product ${p.id}`).toBeCloseTo(cache, 6);
    }
  });
});
