import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCtx, type TestCtx } from '../helpers/app';

// Held carts (US-07) and stock adjustments (US-18).
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Item = { productId: number; qty: string; priceLbp: number };

const towel = (qty = '1'): Item => ({ productId: c.seed.products.towel.id, qty, priceLbp: 75000 });
const choc = (qty = '1'): Item => ({ productId: c.seed.products.choc.id, qty, priceLbp: 50000 });
const hold = (items: Item[], over: Record<string, unknown> = {}, token = cashier) =>
  c.http
    .post(`${api}/holds`)
    .set(auth(token))
    .send({ items, ...over });
const qtyOf = async (productId: number) =>
  Number((await c.http.get(`${api}/stock?productId=${productId}`).set(auth(manager))).body.data[0].qty);
const adjust = (body: Record<string, unknown>, token = manager) => c.http.post(`${api}/stock/adjustments`).set(auth(token)).send(body);

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('holding a cart', () => {
  it('parks a cart and lists it with who held it and what it is worth', async () => {
    const res = await hold([towel(), choc('2')], { customerId: c.seed.customers.registered.id, note: 'gone to get her purse' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userName: 'Test cashier',
      customerName: 'Test Customer',
      note: 'gone to get her purse',
      itemCount: 2,
      totalLbp: 75000 + 100000,
    });
    expect(res.body.items).toEqual([
      { productId: c.seed.products.towel.id, name: 'Cedars silver towel', qty: '1', priceLbp: 75000 },
      { productId: c.seed.products.choc.id, name: 'Crispy chocolate', qty: '2', priceLbp: 50000 },
    ]);
  });

  it('every signed-in user sees every held cart: there is one till', async () => {
    const mine = await hold([towel()]);
    const asManager = await c.http.get(`${api}/holds`).set(auth(manager));
    expect(asManager.body.data.map((h: { id: number }) => h.id)).toContain(mine.body.id);
  });

  it('lists newest first', async () => {
    const a = await hold([towel()]);
    const b = await hold([towel()]);
    const ids = (await c.http.get(`${api}/holds`).set(auth(cashier))).body.data.map((h: { id: number }) => h.id);
    expect(ids.indexOf(b.body.id)).toBeLessThan(ids.indexOf(a.body.id));
  });

  it('keeps weighed quantities exactly', async () => {
    const res = await hold([{ productId: c.seed.products.kg.id, qty: '0.350', priceLbp: 400000 }]);
    expect(res.body.items[0].qty).toBe('0.35');
    expect(res.body.totalLbp).toBe(140000);
  });

  it.each<[string, () => Record<string, unknown>, number]>([
    ['no items', () => ({ items: [] }), 400],
    ['a zero quantity', () => ({ items: [towel('0')] }), 400],
    ['a four-decimal quantity', () => ({ items: [towel('1.2345')] }), 400],
    ['a negative price', () => ({ items: [{ ...towel(), priceLbp: -1 }] }), 400],
    ['more than 200 lines', () => ({ items: Array.from({ length: 201 }, () => towel()) }), 400],
    ['a note over 200 characters', () => ({ note: 'x'.repeat(201) }), 400],
    ['a product that does not exist', () => ({ items: [{ productId: 999999, qty: '1', priceLbp: 1 }] }), 422],
    ['a customer that does not exist', () => ({ customerId: 999999 }), 422],
  ])('refuses %s', async (_n, over, status) => {
    expect((await hold([towel()], over())).status).toBe(status);
  });

  it('needs a token', async () => {
    expect((await c.http.post(`${api}/holds`).send({ items: [towel()] })).status).toBe(401);
    expect((await c.http.get(`${api}/holds`)).status).toBe(401);
  });
});

describe('recalling and discarding', () => {
  it('recall returns the cart and removes the hold', async () => {
    const h = await hold([towel('2'), choc()], { note: 'back soon' });
    const res = await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: h.body.id, note: 'back soon' });
    expect(res.body.items.map((i: { qty: string }) => i.qty)).toEqual(['2', '1']);
    expect((await c.http.get(`${api}/holds`).set(auth(cashier))).body.data.map((x: { id: number }) => x.id)).not.toContain(h.body.id);
  });

  it('a hold can be recalled by someone other than who parked it', async () => {
    const h = await hold([towel()], {}, cashier);
    expect((await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(manager))).status).toBe(200);
  });

  it('recall warns when a price changed or the product has been withdrawn', async () => {
    const p = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'Shifting', priceMinor: 10000, unitId: c.seed.units.piece.id });
    const h = await hold([{ productId: p.body.id, qty: '1', priceLbp: 10000 }, towel()]);
    await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ priceMinor: 12000 });
    await c.http.delete(`${api}/products/${c.seed.products.towel.id}`).set(auth(manager));
    const res = await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier));
    const [shifting, withdrawn] = res.body.items;
    expect(shifting).toMatchObject({ priceLbp: 10000, currentPriceLbp: 12000, priceChanged: true, active: true });
    expect(withdrawn).toMatchObject({ priceChanged: false, active: false });
    await c.http.patch(`${api}/products/${c.seed.products.towel.id}`).set(auth(manager)).send({ active: true });
  });

  it('a dollar-priced product is re-priced at the current rate on recall', async () => {
    const h = await hold([{ productId: c.seed.products.usd.id, qty: '1', priceLbp: 225000 }]);
    await c.http.post(`${api}/exchange-rates`).set(auth(admin)).send({ rateLbpPerUsd: 100000 });
    const res = await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier));
    expect(res.body.items[0]).toMatchObject({ priceLbp: 225000, currentPriceLbp: 250000, priceChanged: true });
  });

  it('a hold can be recalled only once, even by two requests at the same moment', async () => {
    const h = await hold([towel()]);
    const [a, b] = await Promise.all([
      c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier)),
      c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(manager)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
  });

  it('discarding removes it; discarding twice is 404', async () => {
    const h = await hold([towel()]);
    expect((await c.http.delete(`${api}/holds/${h.body.id}`).set(auth(cashier))).status).toBe(204);
    expect((await c.http.delete(`${api}/holds/${h.body.id}`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier))).status).toBe(404);
  });

  it('a held cart reserves nothing: holding does not touch stock, and recalling does not either', async () => {
    const before = await qtyOf(c.seed.products.choc.id);
    const h = await hold([choc('50')]);
    expect(await qtyOf(c.seed.products.choc.id)).toBe(before);
    await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier));
    expect(await qtyOf(c.seed.products.choc.id)).toBe(before);
  });

  it('removes the held lines with the hold: nothing is left behind', async () => {
    const h = await hold([towel(), choc()]);
    await c.http.delete(`${api}/holds/${h.body.id}`).set(auth(cashier));
    expect((await c.http.get(`${api}/holds`).set(auth(cashier))).body.data.every((x: { id: number }) => x.id !== h.body.id)).toBe(true);
  });

  it('a recalled cart can be sold: the till re-prices through POST /sales', async () => {
    await c.openRegister(cashier);
    const h = await hold([towel('2')]);
    const cart = (await c.http.post(`${api}/holds/${h.body.id}/recall`).set(auth(cashier))).body;
    const sale = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: cart.items.map((i: { productId: number; qty: string; currentPriceLbp: number }) => ({
            productId: i.productId,
            qty: i.qty,
            unitPriceLbp: i.currentPriceLbp,
          })),
          payments: [{ method: 'cash', currency: 'LBP', amount: 150000 }],
        }),
      );
    expect(sale.status).toBe(201);
    expect(sale.body.totalLbp).toBe(150000);
  });
});

describe('stock adjustments (US-18)', () => {
  it('adds stock and records it in the ledger with the reason', async () => {
    const before = await qtyOf(c.seed.products.towel.id);
    const res = await adjust({ productId: c.seed.products.towel.id, qtyDelta: '5', reason: 'found a box in the back' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      productId: c.seed.products.towel.id,
      qty: String(before + 5),
      qtyDelta: '5',
      reason: 'found a box in the back',
    });
    const ledger = await c.http.get(`${api}/stock/${c.seed.products.towel.id}/movements?limit=1`).set(auth(manager));
    expect(ledger.body.data[0]).toMatchObject({
      qtyDelta: '5',
      reason: 'adjustment',
      note: 'found a box in the back',
      userId: c.seed.users.manager.id,
    });
  });

  it('removes stock, with a negative number or a string', async () => {
    const before = await qtyOf(c.seed.products.choc.id);
    await adjust({ productId: c.seed.products.choc.id, qtyDelta: -3, reason: 'damaged' });
    await adjust({ productId: c.seed.products.choc.id, qtyDelta: '-2', reason: 'expired' });
    expect(await qtyOf(c.seed.products.choc.id)).toBe(before - 5);
  });

  it('works in thousandths for weighed products', async () => {
    const before = await qtyOf(c.seed.products.kg.id);
    const res = await adjust({ productId: c.seed.products.kg.id, qtyDelta: '-0.125', reason: 'sampled' });
    expect(res.body.qtyDelta).toBe('-0.125');
    expect(await qtyOf(c.seed.products.kg.id)).toBeCloseTo(before - 0.125, 6);
  });

  it('may take a product below zero: stock is informational', async () => {
    const res = await adjust({ productId: c.seed.products.rare.id, qtyDelta: '-50', reason: 'write-off' });
    expect(res.status).toBe(201);
    expect(Number(res.body.qty)).toBeLessThan(0);
  });

  it('a product with a threshold shows up in the alerts after an adjustment', async () => {
    await c.http.patch(`${api}/products/${c.seed.products.usd.id}`).set(auth(manager)).send({ stockAlert: 3 });
    await adjust({ productId: c.seed.products.usd.id, qtyDelta: '-8', reason: 'spoiled' }); // 10 - 8 = 2
    const alerts = await c.http.get(`${api}/stock/alerts`).set(auth(cashier));
    expect(alerts.body.data.map((a: { productId: number }) => a.productId)).toContain(c.seed.products.usd.id);
  });

  it.each([
    ['a zero change', { qtyDelta: '0' }],
    ['no change given', { qtyDelta: undefined }],
    ['a four-decimal change', { qtyDelta: '1.2345' }],
    ['text', { qtyDelta: 'a lot' }],
    ['no reason', { reason: '' }],
    ['a blank reason', { reason: '   ' }],
  ])('refuses %s', async (_n, over) => {
    const before = await qtyOf(c.seed.products.towel.id);
    const res = await adjust({ productId: c.seed.products.towel.id, qtyDelta: '1', reason: 'because', ...over });
    expect(res.status).toBe(400);
    expect(await qtyOf(c.seed.products.towel.id)).toBe(before);
  });

  it('404 for an unknown product', async () => {
    expect((await adjust({ productId: 999999, qtyDelta: '1', reason: 'x' })).status).toBe(404);
  });

  it('is for managers only', async () => {
    expect((await adjust({ productId: c.seed.products.towel.id, qtyDelta: '1', reason: 'x' }, cashier)).status).toBe(403);
    expect((await c.http.post(`${api}/stock/adjustments`).send({ productId: 1, qtyDelta: '1', reason: 'x' })).status).toBe(401);
  });

  it('is audited', async () => {
    await adjust({ productId: c.seed.products.towel.id, qtyDelta: '2', reason: 'recount' });
    const log = await c.http.get(`${api}/audit?action=stock.adjust&entityId=${c.seed.products.towel.id}`).set(auth(admin));
    expect(log.body.data[0]).toMatchObject({ userId: c.seed.users.manager.id, after: { qtyDelta: '2', reason: 'recount' } });
  });

  it('the ledger still equals the cache after every adjustment, sale and purchase', async () => {
    for (const p of Object.values(c.seed.products)) {
      const cache = await qtyOf(p.id);
      const ledger = await c.http.get(`${api}/stock/${p.id}/movements?limit=500`).set(auth(manager));
      const sum = (ledger.body.data as { qtyDelta: string }[]).reduce((a, m) => a + Number(m.qtyDelta), 0);
      expect(sum, `product ${p.id}`).toBeCloseTo(cache, 6);
    }
  });
});
