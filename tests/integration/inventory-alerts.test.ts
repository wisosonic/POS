import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// R2: stock exists to notify the owner when quantity is low. Each product has its own threshold (stockAlert).
// Stock never blocks selling, and a quantity of 0 or below never blocks buying from suppliers either. (US-17)
let c: TestCtx;
let cashier: string;
let manager: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const stockOf = async (id: number) => Number((await c.http.get(`/api/v1/stock?productId=${id}`).set(auth(manager))).body.data[0].qty);
const setAlert = (id: number, stockAlert: number | null) => c.http.patch(`/api/v1/products/${id}`).set(auth(manager)).send({ stockAlert });
const sell = (key: string, productId: number, qty: string, price: number) =>
  c.http
    .post('/api/v1/sales')
    .set(auth(cashier))
    .set('Idempotency-Key', key)
    .send(
      c.newSaleBody({
        items: [{ productId, qty, unitPriceLbp: price }],
        payments: [{ method: 'cash', currency: 'LBP', amount: price * Number(qty) }],
      }),
    );
const alerts = async () =>
  (await c.http.get('/api/v1/stock/alerts').set(auth(manager))).body.data as Array<{ productId: number; qty: string; threshold: number }>;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('per-product low-stock threshold', () => {
  it('a product with no threshold never appears in alerts, even at 0', async () => {
    await setAlert(c.seed.products.towel.id, null);
    await sell('al-1', c.seed.products.towel.id, '10', 75000); // 10 → 0
    expect((await alerts()).some((a) => a.productId === c.seed.products.towel.id)).toBe(false);
  });

  it('each product uses its own threshold', async () => {
    await setAlert(c.seed.products.choc.id, 90); // stock 100
    await setAlert(c.seed.products.usd.id, 2); // stock 10
    expect((await alerts()).map((a) => a.productId)).not.toContain(c.seed.products.choc.id);

    await sell('al-2', c.seed.products.choc.id, '10', 50000); // 100 → 90 = at threshold
    await sell('al-3', c.seed.products.usd.id, '3', 225000); // 10 → 7, above its threshold of 2
    const ids = (await alerts()).map((a) => a.productId);
    expect(ids).toContain(c.seed.products.choc.id);
    expect(ids).not.toContain(c.seed.products.usd.id);
  });

  it('alert condition is quantity <= threshold (inclusive)', async () => {
    const a = (await alerts()).find((x) => x.productId === c.seed.products.choc.id)!;
    expect(Number(a.qty)).toBe(90);
    expect(a.threshold).toBe(90);
  });

  it('raising the threshold immediately raises the alert; lowering it clears it', async () => {
    await setAlert(c.seed.products.usd.id, 7);
    expect((await alerts()).map((a) => a.productId)).toContain(c.seed.products.usd.id);
    await setAlert(c.seed.products.usd.id, 1);
    expect((await alerts()).map((a) => a.productId)).not.toContain(c.seed.products.usd.id);
  });

  it('rejects a negative or non-numeric threshold', async () => {
    expect((await setAlert(c.seed.products.choc.id, -1)).status).toBe(400);
    const res = await c.http.patch(`/api/v1/products/${c.seed.products.choc.id}`).set(auth(manager)).send({ stockAlert: 'many' });
    expect(res.status).toBe(400);
  });

  it('alerts list is ordered most urgent first (lowest qty relative to threshold)', async () => {
    const list = await alerts();
    const ratios = list.map((a) => Number(a.qty) / Math.max(a.threshold, 1));
    expect([...ratios].sort((x, y) => x - y)).toEqual(ratios);
  });

  it('a cashier can read the alert count but not change thresholds', async () => {
    const read = await c.http.get('/api/v1/stock/alerts').set(auth(cashier));
    expect(read.status).toBe(200);
    const write = await c.http.patch(`/api/v1/products/${c.seed.products.choc.id}`).set(auth(cashier)).send({ stockAlert: 5 });
    expect(write.status).toBe(403);
  });

  it('the dashboard reports the number of low-stock products', async () => {
    const d = await c.http.get('/api/v1/reports/dashboard').set(auth(manager));
    expect(d.body.lowStockCount).toBe((await alerts()).length);
  });
});

describe('selling and buying are independent of quantity on hand', () => {
  it('selling below zero is fine and the product is listed in alerts if it has a threshold', async () => {
    await setAlert(c.seed.products.rare.id, 0); // threshold 0: alert only when quantity is 0 or below
    const res = await sell('al-4', c.seed.products.rare.id, '4', 10000); // 1 → -3
    expect(res.status).toBe(201);
    expect(await stockOf(c.seed.products.rare.id)).toBe(-3);
    expect((await alerts()).some((a) => a.productId === c.seed.products.rare.id)).toBe(true);
  });

  it('a supplier purchase can be created and received while quantity is 0 or negative', async () => {
    const supplierId = c.seed.suppliers.main.id;
    const po = await c.http
      .post('/api/v1/purchases')
      .set(auth(manager))
      .send({ supplierId, currency: 'LBP', items: [{ productId: c.seed.products.rare.id, qty: '20', costMinor: 6000 }] });
    expect(po.status).toBe(201);
    const rec = await c.http.post(`/api/v1/purchases/${po.body.id}/receive`).set(auth(manager)).set('Idempotency-Key', 'rcv-1').send({});
    expect(rec.status).toBe(200);
    expect(await stockOf(c.seed.products.rare.id)).toBe(-3 + 20);
  });

  it('after restocking above the threshold the product leaves the alert list', async () => {
    expect((await alerts()).some((a) => a.productId === c.seed.products.rare.id)).toBe(false);
  });

  it('receiving the same purchase twice does not add stock twice (idempotent)', async () => {
    const po = await c.http
      .post('/api/v1/purchases')
      .set(auth(manager))
      .send({
        supplierId: c.seed.suppliers.main.id,
        currency: 'LBP',
        items: [{ productId: c.seed.products.rare.id, qty: '5', costMinor: 6000 }],
      });
    await c.http.post(`/api/v1/purchases/${po.body.id}/receive`).set(auth(manager)).set('Idempotency-Key', 'rcv-2').send({});
    const before = await stockOf(c.seed.products.rare.id);
    await c.http.post(`/api/v1/purchases/${po.body.id}/receive`).set(auth(manager)).set('Idempotency-Key', 'rcv-2').send({});
    expect(await stockOf(c.seed.products.rare.id)).toBe(before);
  });

  it('a purchase can be created for a product that has never had stock', async () => {
    const fresh = await c.http.post('/api/v1/products').set(auth(manager)).send({
      name: 'New item',
      barcode: '7777777777777',
      priceMinor: 20000,
      costMinor: 12000,
      currency: 'LBP',
      unitId: c.seed.units.piece.id,
    });
    expect(fresh.status).toBe(201);
    const po = await c.http
      .post('/api/v1/purchases')
      .set(auth(manager))
      .send({ supplierId: c.seed.suppliers.main.id, currency: 'LBP', items: [{ productId: fresh.body.id, qty: '12', costMinor: 12000 }] });
    expect(po.status).toBe(201);
  });
});

describe('receipt_name is generated by transliteration on product save (R5)', () => {
  it('an Arabic-named product gets an ASCII receiptName automatically', async () => {
    const res = await c.http.post('/api/v1/products').set(auth(manager)).send({
      name: 'خبز كبير',
      barcode: '7777777777770',
      priceMinor: 20000,
      costMinor: 12000,
      currency: 'LBP',
      unitId: c.seed.units.piece.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.receiptName).toMatch(/^[\x20-\x7e]+$/);
  });

  it('a manually edited receiptName is never overwritten by later name edits', async () => {
    const p = await c.http.post('/api/v1/products').set(auth(manager)).send({
      name: 'لبنة',
      barcode: '7777777777771',
      priceMinor: 20000,
      costMinor: 12000,
      currency: 'LBP',
      unitId: c.seed.units.piece.id,
    });
    await c.http.patch(`/api/v1/products/${p.body.id}`).set(auth(manager)).send({ receiptName: 'Labneh' });
    const after = await c.http.patch(`/api/v1/products/${p.body.id}`).set(auth(manager)).send({ name: 'لبنة بلدية' });
    expect(after.body.receiptName).toBe('Labneh');
  });

  it('an Arabic name edit regenerates receiptName only while it is auto-generated', async () => {
    const p = await c.http.post('/api/v1/products').set(auth(manager)).send({
      name: 'حليب',
      barcode: '7777777777772',
      priceMinor: 20000,
      costMinor: 12000,
      currency: 'LBP',
      unitId: c.seed.units.piece.id,
    });
    const first = p.body.receiptName;
    const edited = await c.http.patch(`/api/v1/products/${p.body.id}`).set(auth(manager)).send({ name: 'حليب كامل الدسم' });
    expect(edited.body.receiptName).not.toBe(first);
    expect(edited.body.receiptName).toMatch(/^[\x20-\x7e]+$/);
  });
});
