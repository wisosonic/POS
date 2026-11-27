import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { createProduct } from '../../src/modules/catalog/products';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// The products come down from HQ with HQ's ids (docs/12 §17, P3b). HQ is where a product or a price changes; the branch only receives.
let hq: Hq;
let b: FreshBranch;
type P = {
  id: number;
  name: string;
  priceMinor: number;
  costMinor: number;
  barcode: string;
  active: boolean;
  updatedAt: string;
  receiptName: string;
};

const atHq = (path: string, body: unknown) =>
  hq.http
    .post(`${api}/${path}`)
    .set(adminAuth)
    .send(body as object);
const hqProduct = async (body: Record<string, unknown>) => (await atHq('products', body)).body as P;
const branchProducts = async () => (await b.http.get(`${api}/products?active=all&limit=200`).set(auth(b.admin))).body.data as P[];
const branchProduct = async (id: number) => (await b.http.get(`${api}/products/${id}`).set(auth(b.admin))).body as P;
const syncFeed = async () => (await b.http.get(`${api}/products/sync`).set(auth(b.admin))).body.data as P[];

beforeAll(async () => {
  hq = await startHq();
  b = await startFreshBranch();
});
afterAll(async () => {
  await b.close();
  await hq.close();
});

describe('products at HQ', () => {
  it('HQ staff add products; the receipt name is made from an Arabic name; a retired product is kept (US-HQ-products)', async () => {
    const cat = (await atHq('categories', { name: 'Grocery' })).body;
    const made = await atHq('products', {
      name: 'حليب',
      barcode: '5281000000011',
      priceMinor: 120000,
      costMinor: 90000,
      categoryId: cat.id,
      unitId: 1,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'حليب', priceMinor: 120000, costMinor: 90000, currency: 'LBP', active: true });
    expect(made.body.receiptName).toMatch(/^[\x20-\x7e]+$/); // printable ASCII: receipts are English only
    expect((await hq.http.get(`${api}/products`)).status).toBe(401);
    expect((await hq.http.post(`${api}/products`).send({ name: 'x' })).status).toBe(401);
  });

  it('one ACTIVE product per barcode; a retired product frees its code; links must exist', async () => {
    const first = await hqProduct({ name: 'Cola', barcode: '5281000000028', priceMinor: 50000 });
    const dup = await atHq('products', { name: 'Cola 2', barcode: '5281000000028' });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_BARCODE']);
    expect((await hq.http.delete(`${api}/products/${first.id}`).set(adminAuth)).status).toBe(204);
    expect((await atHq('products', { name: 'Cola 2', barcode: '5281000000028' })).status).toBe(201);
    const noCat = await atHq('products', { name: 'Ghost', categoryId: 9999 });
    expect([noCat.status, noCat.body.code]).toEqual([422, 'VALIDATION']);
  });

  it('a patch changes only what it names (it must not reset cost, barcode or currency), and a patch that changes nothing writes nothing', async () => {
    const p = await hqProduct({ name: 'Rice', barcode: '5281000000035', priceMinor: 100, costMinor: 60, currency: 'USD' });
    const patched = await hq.http.patch(`${api}/products/${p.id}`).set(adminAuth).send({ priceMinor: 150 });
    expect(patched.body).toMatchObject({ priceMinor: 150, costMinor: 60, barcode: '5281000000035', currency: 'USD' });
    const log = async () => (await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM change_log'))!.n;
    const before = await log();
    const same = await hq.http.patch(`${api}/products/${p.id}`).set(adminAuth).send({ priceMinor: 150, name: 'Rice' });
    expect(same.body.updatedAt).toBe(patched.body.updatedAt);
    expect(await log()).toBe(before);
  });
});

describe('products reach a fresh branch with HQ’s ids', () => {
  it('connecting takes every product; a change at HQ follows; the screens are told', async () => {
    const heard: string[] = [];
    const stop = b.app.events.tap((e) => heard.push(e.type));
    const flag = async () => (await b.http.get(`${api}/settings/public`).set(auth(b.cashier))).body.hqOwnsCatalog;
    expect(await flag()).toBe(false); // the screens offer their edit buttons until the branch is connected
    expect((await b.connect(hq, 'P1')).status).toBe(200);
    expect(await flag()).toBe(true); // and say "managed at HQ" after
    const hqAll = (await hq.http.get(`${api}/products?active=all&limit=200`).set(adminAuth)).body.data as P[];
    expect(await until(async () => (await branchProducts()).length === hqAll.length)).toBe(true);
    const there = await branchProducts();
    for (const p of hqAll)
      expect(
        there.find((x) => x.id === p.id),
        `product ${p.id}`,
      ).toMatchObject({ name: p.name, priceMinor: p.priceMinor, barcode: p.barcode, active: p.active });
    expect(heard).toContain('catalog.changed');

    const milk = hqAll.find((p) => p.name === 'حليب')!;
    await hq.http.patch(`${api}/products/${milk.id}`).set(adminAuth).send({ priceMinor: 130000 });
    expect(await until(async () => (await branchProduct(milk.id)).priceMinor === 130000)).toBe(true);
    stop();
  });

  it('a product made at HQ after connecting is sellable at the branch under HQ’s id', async () => {
    const p = await hqProduct({ name: 'Sellable', barcode: '5281000000042', priceMinor: 75000, costMinor: 50000 });
    expect(await until(async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).status === 200)).toBe(true);
    const open = await b.http
      .post(`${api}/registers/open`)
      .set(auth(b.cashier))
      .send({
        terminalId: 'T1',
        openingBalances: [
          { method: 'cash', currency: 'USD', amount: 0 },
          { method: 'cash', currency: 'LBP', amount: 0 },
        ],
      });
    expect(open.status, JSON.stringify(open.body)).toBeLessThan(300);
    const sale = await b.http
      .post(`${api}/sales`)
      .set(auth(b.cashier))
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        clientSaleId: crypto.randomUUID(),
        customerId: 1,
        items: [{ productId: p.id, qty: '1', unitPriceLbp: 75000 }],
        payments: [{ method: 'cash', currency: 'LBP', amount: 75000 }],
      });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const line = await b.app.database.one<{ product_id: number }>('SELECT product_id FROM sale_items WHERE sale_id = ?', [sale.body.id]);
    expect(line?.product_id).toBe(p.id);
  });

  it('the branch keeps its own cost: HQ’s cost is the starting one, and a later change at HQ does not overwrite it', async () => {
    const p = await hqProduct({ name: 'Costed', barcode: '5281000000059', priceMinor: 1000, costMinor: 400 });
    expect(await until(async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).status === 200)).toBe(true);
    expect((await branchProduct(p.id)).costMinor).toBe(400); // HQ's starting cost
    await b.app.database.run('UPDATE products SET cost_minor = 777 WHERE id = ?', [p.id]); // a purchase received here sets its own
    await hq.http.patch(`${api}/products/${p.id}`).set(adminAuth).send({ priceMinor: 1100, costMinor: 450 });
    expect(await until(async () => (await branchProduct(p.id)).priceMinor === 1100)).toBe(true);
    expect((await branchProduct(p.id)).costMinor).toBe(777);
  });

  it('the till’s catalog feed sees a change, and a repeat of the same changes does not make everything look new', async () => {
    const p = await hqProduct({ name: 'Feed', barcode: '5281000000066', priceMinor: 500 });
    expect(await until(async () => (await b.http.get(`${api}/products/${p.id}`).set(auth(b.admin))).status === 200)).toBe(true);
    const stamps = async () => new Map((await branchProducts()).map((x) => [x.id, x.updatedAt]));
    const before = await stamps();
    await b.app.database.run('UPDATE sync_control SET down_cursor = 0 WHERE id = 1'); // everything comes again
    expect(
      await until(
        async () =>
          (await b.app.database.one<{ down_cursor: number }>('SELECT down_cursor FROM sync_control WHERE id = 1'))!.down_cursor > 0,
      ),
    ).toBe(true);
    expect(await stamps()).toEqual(before);
    const since = new Date(Date.now() - 1).toISOString();
    await hq.http.patch(`${api}/products/${p.id}`).set(adminAuth).send({ priceMinor: 600 });
    expect(await until(async () => (await branchProduct(p.id)).priceMinor === 600)).toBe(true);
    const feed = (await b.http.get(`${api}/products/sync?since=${encodeURIComponent(since)}`).set(auth(b.admin))).body.data as P[];
    expect(feed.map((x) => x.id)).toEqual([p.id]);
    expect((await syncFeed()).length).toBeGreaterThan(5);
  });

  it('while connected the branch cannot add, change, retire or import products, or touch the barcode rule', async () => {
    const some = (await branchProducts())[0]!;
    const tries = [
      b.http.post(`${api}/products`).set(auth(b.admin)).send({ name: 'Local' }),
      b.http.patch(`${api}/products/${some.id}`).set(auth(b.admin)).send({ priceMinor: 1 }),
      b.http.delete(`${api}/products/${some.id}`).set(auth(b.admin)),
      b.http.post(`${api}/products/import`).set(auth(b.admin)).send({ csv: 'name\nx', dryRun: false }),
      b.http.post(`${api}/barcodes/enforce`).set(auth(b.admin)).send({ enabled: true }),
      b.http
        .post(`${api}/products/merge`)
        .set(auth(b.admin))
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ keepId: some.id, retireIds: [some.id + 1] }),
    ];
    for (const r of await Promise.all(tries)) expect([r.status, r.body.code]).toEqual([409, 'HQ_OWNS_CATALOG']);
    expect((await branchProduct(some.id)).priceMinor).toBe(some.priceMinor);
  });
});

describe('a large first sync', () => {
  it('a second fresh branch takes 1,200 products page by page and ends with exactly what HQ holds', async () => {
    await hq.app.database.tx(async (tx) => {
      for (let i = 0; i < 1200; i++)
        await createProduct(tx, { name: `Bulk ${i}`, barcode: `9${String(i).padStart(12, '0')}`, priceMinor: 1000 + i });
    });
    const b2 = await startFreshBranch();
    try {
      expect((await b2.connect(hq, 'P2')).status).toBe(200);
      const hqCount = (await hq.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM products'))!.n;
      const count = async () => (await b2.app.database.one<{ n: number }>('SELECT COUNT(*) AS n FROM products'))!.n;
      expect(await until(async () => (await count()) === hqCount, 60_000)).toBe(true);
      const sum = 'SELECT COUNT(*) AS n, SUM(price_minor) AS price, SUM(id) AS ids, SUM(length(name)) AS names FROM products';
      expect(await b2.app.database.one(sum)).toEqual(await hq.app.database.one(sum));
    } finally {
      await b2.close();
    }
  }, 120_000);
});
