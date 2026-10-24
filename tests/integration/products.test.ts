import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

let c: TestCtx;
let manager: string;
let cashier: string;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = '/api/v1';
const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((p) => p.name);

const create = (over: Record<string, unknown> = {}) =>
  c.http
    .post(`${api}/products`)
    .set(auth(manager))
    .send({
      name: 'Test item',
      barcode: '7000000000001',
      priceMinor: 20000,
      costMinor: 12000,
      currency: 'LBP',
      unitId: c.seed.units.piece.id,
      ...over,
    });

beforeAll(async () => {
  c = await startCtx();
  manager = await c.login('manager');
  cashier = await c.login('cashier');
});
afterAll(() => c.close());

describe('create (US-15)', () => {
  it('creates a product with its own currency and returns it', async () => {
    const res = await create({ name: 'Imported coffee', barcode: '7000000000002', currency: 'USD', priceMinor: 450, costMinor: 300 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Imported coffee',
      currency: 'USD',
      priceMinor: 450,
      costMinor: 300,
      active: true,
      qty: '0',
      stockAlert: null,
    });
    expect(res.body.warnings).toEqual([]);
  });

  it('gives an Arabic-named product an ASCII receipt name automatically (R5)', async () => {
    const res = await create({ name: 'خبز كبير', barcode: '7000000000003' });
    expect(res.body.receiptName).toMatch(/^[\x20-\x7e]+$/);
    expect(res.body.receiptNameManual).toBe(false);
  });

  it('keeps a hand-typed receipt name and marks it manual', async () => {
    const res = await create({ name: 'خبز كبير', barcode: '7000000000004', receiptName: 'Big bread' });
    expect(res.body).toMatchObject({ receiptName: 'Big bread', receiptNameManual: true });
  });

  it('defaults: LBP currency, no cost, empty barcode', async () => {
    const res = await c.http.post(`${api}/products`).set(auth(manager)).send({ name: 'Bare minimum', priceMinor: 5000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ currency: 'LBP', costMinor: 0, barcode: '' });
  });

  it('warns about a duplicate barcode but still creates (clean-up is last, Q7)', async () => {
    await create({ name: 'Twin A', barcode: '7000000000010' });
    const res = await create({ name: 'Twin B', barcode: '7000000000010' });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(['DUPLICATE_BARCODE']);
  });

  it.each([
    ['a negative price', { priceMinor: -1 }],
    ['a fractional price', { priceMinor: 10.5 }],
    ['an unknown currency', { currency: 'EUR' }],
    ['an empty name', { name: '   ' }],
    ['a negative low-stock threshold', { stockAlert: -1 }],
    ['a threshold with 4 decimals', { stockAlert: 1.2345 }],
    ['a non-numeric threshold', { stockAlert: 'many' }],
  ])('rejects %s', async (_n, over) => {
    const res = await create({ barcode: '7000000000099', ...over });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('rejects a reference to something that does not exist, without leaking SQL', async () => {
    const res = await create({ barcode: '7000000000098', categoryId: 9999 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_REFERENCE');
    expect(JSON.stringify(res.body)).not.toMatch(/FOREIGN KEY|SQLITE|products/i);
  });

  it('is manager only', async () => {
    expect((await c.http.post(`${api}/products`).set(auth(cashier)).send({ name: 'x', priceMinor: 1 })).status).toBe(403);
  });

  it('writes an audit row', async () => {
    const res = await create({ name: 'Audited item', barcode: '7000000000020' });
    const log = await c.http.get(`${api}/audit?entity=product&entityId=${res.body.id}`).set(auth(await c.login('admin')));
    expect(log.body.data[0]).toMatchObject({ action: 'product.create', userId: c.seed.users.manager.id });
  });
});

describe('weighed products (the till needs to know)', () => {
  it('says whether a product is sold by weight, and its unit', async () => {
    const towel = await c.http.get(`${api}/products/${c.seed.products.towel.id}`).set(auth(cashier));
    const kg = await c.http.get(`${api}/products/${c.seed.products.kg.id}`).set(auth(cashier));
    expect(towel.body).toMatchObject({ fractional: false, unitName: 'Piece' });
    expect(kg.body).toMatchObject({ fractional: true, unitName: 'KG' });
  });

  it('a product with no unit is not fractional', async () => {
    const p = await c.http.post(`${api}/products`).set(auth(manager)).send({ name: 'No unit', barcode: '7300000000001', priceMinor: 100 });
    expect(p.body).toMatchObject({ fractional: false, unitName: null });
  });

  it('the catalog feed carries it too', async () => {
    const feed = await c.http.get(`${api}/products/sync`).set(auth(cashier));
    const kg = (feed.body.data as { id: number; fractional: boolean }[]).find((x) => x.id === c.seed.products.kg.id);
    expect(kg?.fractional).toBe(true);
  });
});

describe('barcode lookup (US-01)', () => {
  it('finds a product by barcode; the answer is always a list', async () => {
    const res = await c.http.get(`${api}/products/by-barcode/5287000107945`).set(auth(cashier));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: 'Cedars silver towel', priceMinor: 75000, currency: 'LBP' });
  });

  it('ignores the CR/LF a scanner appends', async () => {
    const res = await c.http.get(`${api}/products/by-barcode/${encodeURIComponent('5287000107945\r\n')}`).set(auth(cashier));
    expect(res.status).toBe(200);
  });

  it('returns every product sharing a barcode so the till can show a picker', async () => {
    const res = await c.http.get(`${api}/products/by-barcode/7000000000010`).set(auth(cashier));
    expect(names(res).sort()).toEqual(['Twin A', 'Twin B']);
  });

  it('answers 404 for an unknown code and for a blank one', async () => {
    expect((await c.http.get(`${api}/products/by-barcode/0000000000000`).set(auth(cashier))).status).toBe(404);
    expect((await c.http.get(`${api}/products/by-barcode/%20`).set(auth(cashier))).status).toBe(404);
  });

  it('does not return inactive products', async () => {
    const p = await create({ name: 'Gone soon', barcode: '7000000000030' });
    await c.http.delete(`${api}/products/${p.body.id}`).set(auth(manager));
    expect((await c.http.get(`${api}/products/by-barcode/7000000000030`).set(auth(cashier))).status).toBe(404);
  });

  it('accepts any string as a code (legacy EAN-8 and odd codes)', async () => {
    await create({ name: 'Short code item', barcode: '84191069' });
    expect((await c.http.get(`${api}/products/by-barcode/84191069`).set(auth(cashier))).status).toBe(200);
  });
});

describe('search (US-02)', () => {
  const search = (q: string) => c.http.get(`${api}/products?q=${encodeURIComponent(q)}`).set(auth(cashier));

  it('matches a part of a Latin name', async () => {
    expect(names(await search('ilver tow'))).toEqual(['Cedars silver towel']);
  });

  it('is case-insensitive', async () => {
    expect(names(await search('CEDARS'))).toEqual(['Cedars silver towel']);
  });

  it('matches Arabic names', async () => {
    expect(names(await search('خبز'))).toEqual(expect.arrayContaining(['خبز كبير']));
  });

  it('matches the transliterated receipt name', async () => {
    expect(names(await search('Big bread'))).toContain('خبز كبير');
  });

  it('matches a barcode, whole or partial', async () => {
    expect(names(await search('5287000107945'))).toEqual(['Cedars silver towel']);
    expect(names(await search('9342390'))).toEqual(['Crispy chocolate']);
  });

  it('handles one- and two-character queries (shorter than the index needs)', async () => {
    const res = await search('Cr');
    expect(res.status).toBe(200);
    expect(names(res)).toContain('Crispy chocolate');
  });

  it('treats % and _ as plain characters, not wildcards', async () => {
    expect(names(await search('%%'))).toEqual([]);
    expect(names(await search('_'))).toEqual([]);
  });

  it('survives quotes and FTS operators in the query', async () => {
    for (const q of ['"', 'a" OR "b', 'NEAR(a b)', "O'Brien", '* ', 'name:towel', "' OR 1=1; DROP TABLE products;--"]) {
      expect((await search(q)).status).toBe(200);
    }
    expect((await c.http.get(`${api}/products`).set(auth(cashier))).body.data.length).toBeGreaterThan(5);
  });

  it('pages with a cursor and a limit', async () => {
    const first = await c.http.get(`${api}/products?limit=3`).set(auth(cashier));
    expect(first.body.data).toHaveLength(3);
    expect(first.body.nextCursor).toBe(first.body.data[2].id);
    const next = await c.http.get(`${api}/products?limit=3&cursor=${first.body.nextCursor}`).set(auth(cashier));
    expect(next.body.data[0].id).toBeGreaterThan(first.body.data[2].id);
  });

  it('rejects a silly limit', async () => {
    expect((await c.http.get(`${api}/products?limit=0`).set(auth(cashier))).status).toBe(400);
    expect((await c.http.get(`${api}/products?limit=1000`).set(auth(cashier))).status).toBe(400);
  });
});

describe('edit', () => {
  it('REGRESSION: a price-only edit leaves cost, barcode, currency and name untouched', async () => {
    // Zod applies .default() inside .partial(), which once reset cost to 0 and the barcode to "" on every edit.
    const p = await create({ name: 'Keep me', barcode: '7000000000040', costMinor: 777, currency: 'USD', priceMinor: 900 });
    const res = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ priceMinor: 950 });
    expect(res.body).toMatchObject({ name: 'Keep me', barcode: '7000000000040', costMinor: 777, currency: 'USD', priceMinor: 950 });
  });

  it('an empty patch changes nothing and writes no audit row', async () => {
    const p = await create({ name: 'Untouched', barcode: '7000000000041' });
    const admin = await c.login('admin');
    const before = (await c.http.get(`${api}/audit?entity=product&entityId=${p.body.id}`).set(auth(admin))).body.data.length;
    const res = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({});
    expect(res.status).toBe(200);
    expect((await c.http.get(`${api}/audit?entity=product&entityId=${p.body.id}`).set(auth(admin))).body.data.length).toBe(before);
  });

  it('price edits are audited as price updates, other edits as updates, never both for one kind of change', async () => {
    const p = await create({ name: 'Audit me', barcode: '7000000000042' });
    const admin = await c.login('admin');
    await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ priceMinor: 25000 });
    await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ stockAlert: 5 });
    const log = (await c.http.get(`${api}/audit?entity=product&entityId=${p.body.id}`).set(auth(admin))).body.data.map(
      (r: { action: string }) => r.action,
    );
    expect(log).toEqual(['product.update', 'product.price.update', 'product.create']);
  });

  it('sets, changes and clears the low-stock threshold (R2)', async () => {
    const p = await create({ name: 'Threshold', barcode: '7000000000043' });
    const set = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ stockAlert: 2.5 });
    expect(set.body.stockAlert).toBe(2.5);
    const zero = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ stockAlert: 0 });
    expect(zero.body.stockAlert).toBe(0);
    const cleared = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ stockAlert: null });
    expect(cleared.body.stockAlert).toBeNull();
  });

  it('a manual receipt name survives later name edits; clearing it returns to automatic (R5)', async () => {
    const p = await create({ name: 'لبنة', barcode: '7000000000044' });
    const manual = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ receiptName: 'Labneh' });
    expect(manual.body).toMatchObject({ receiptName: 'Labneh', receiptNameManual: true });
    const renamed = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ name: 'لبنة بلدية' });
    expect(renamed.body.receiptName).toBe('Labneh');
    const auto = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ receiptName: null });
    expect(auto.body.receiptNameManual).toBe(false);
    expect(auto.body.receiptName).toMatch(/^[\x20-\x7e]+$/);
    expect(auto.body.receiptName).not.toBe('Labneh');
  });

  it('search follows renames', async () => {
    const p = await create({ name: 'Old Name Item', barcode: '7000000000045' });
    await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ name: 'Fresh Name Item' });
    expect(names(await c.http.get(`${api}/products?q=Fresh Name`).set(auth(cashier)))).toContain('Fresh Name Item');
    expect(names(await c.http.get(`${api}/products?q=Old Name`).set(auth(cashier)))).not.toContain('Old Name Item');
  });

  it('cashiers cannot edit or delete', async () => {
    const id = c.seed.products.towel.id;
    expect((await c.http.patch(`${api}/products/${id}`).set(auth(cashier)).send({ priceMinor: 1 })).status).toBe(403);
    expect((await c.http.delete(`${api}/products/${id}`).set(auth(cashier))).status).toBe(403);
  });

  it('404 for an unknown product', async () => {
    expect((await c.http.patch(`${api}/products/99999`).set(auth(manager)).send({ priceMinor: 1 })).status).toBe(404);
    expect((await c.http.get(`${api}/products/99999`).set(auth(cashier))).status).toBe(404);
  });

  it('deleting deactivates: hidden from the list, still readable, restorable', async () => {
    const p = await create({ name: 'Retire me', barcode: '7000000000046' });
    expect((await c.http.delete(`${api}/products/${p.body.id}`).set(auth(manager))).status).toBe(204);
    expect(names(await c.http.get(`${api}/products?q=Retire me`).set(auth(cashier)))).toEqual([]);
    expect(names(await c.http.get(`${api}/products?q=Retire me&active=all`).set(auth(cashier)))).toEqual(['Retire me']);
    expect((await c.http.get(`${api}/products/${p.body.id}`).set(auth(cashier))).body.active).toBe(false);
    const back = await c.http.patch(`${api}/products/${p.body.id}`).set(auth(manager)).send({ active: true });
    expect(back.body.active).toBe(true);
  });
});

describe('catalog sync for the till cache', () => {
  it('returns only what changed after a timestamp, plus the server time to use next', async () => {
    const all = await c.http.get(`${api}/products/sync`).set(auth(cashier));
    expect(all.body.data.length).toBeGreaterThan(5);
    const mark = all.body.serverTime as string;

    await new Promise((r) => setTimeout(r, 5));
    const p = await create({ name: 'After mark', barcode: '7000000000050' });
    const delta = await c.http.get(`${api}/products/sync?since=${encodeURIComponent(mark)}`).set(auth(cashier));
    expect(names(delta)).toEqual(['After mark']);
    expect(delta.body.serverTime > mark).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await c.http.delete(`${api}/products/${p.body.id}`).set(auth(manager));
    const gone = await c.http.get(`${api}/products/sync?since=${encodeURIComponent(delta.body.serverTime)}`).set(auth(cashier));
    expect(gone.body.data[0]).toMatchObject({ name: 'After mark', active: false }); // deactivations are delivered too
  });
});

describe('stock reads (R2)', () => {
  it('reports quantity as a decimal string', async () => {
    const res = await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(cashier));
    expect(res.body.data).toEqual([expect.objectContaining({ productId: c.seed.products.towel.id, qty: '10', threshold: null })]);
    const kg = await c.http.get(`${api}/stock?productId=${c.seed.products.kg.id}`).set(auth(cashier));
    expect(kg.body.data[0].qty).toBe('5');
  });

  it('a product that never had stock reads as 0', async () => {
    const p = await create({ name: 'Never stocked', barcode: '7000000000060' });
    const res = await c.http.get(`${api}/stock?productId=${p.body.id}`).set(auth(cashier));
    expect(res.body.data[0].qty).toBe('0');
  });

  const alertIds = async () =>
    ((await c.http.get(`${api}/stock/alerts`).set(auth(cashier))).body.data as { productId: number }[]).map((a) => a.productId);

  it('alerts need a token, and seeded products (no threshold) never alert', async () => {
    expect((await c.http.get(`${api}/stock/alerts`)).status).toBe(401);
    const res = await c.http.get(`${api}/stock/alerts`).set(auth(cashier));
    expect(res.status).toBe(200);
    const seeded = Object.values(c.seed.products).map((p) => p.id);
    expect((await alertIds()).filter((id) => seeded.includes(id))).toEqual([]);
  });

  it('a product appears in alerts once its quantity is at or below its own threshold', async () => {
    const id = c.seed.products.rare.id;
    await c.http.patch(`${api}/products/${id}`).set(auth(manager)).send({ stockAlert: 1 }); // stock is 1
    const res = await c.http.get(`${api}/stock/alerts`).set(auth(cashier));
    expect(res.body.data).toContainEqual(expect.objectContaining({ productId: id, qty: '1', threshold: 1 }));
    await c.http.patch(`${api}/products/${id}`).set(auth(manager)).send({ stockAlert: 0.5 });
    expect(await alertIds()).not.toContain(id);
  });

  it('inactive products never alert', async () => {
    const p = await create({ name: 'Inactive low', barcode: '7000000000061', stockAlert: 5 }); // qty 0 <= 5
    expect((await c.http.get(`${api}/stock/alerts`).set(auth(cashier))).body.data.map((a: { productId: number }) => a.productId)).toContain(
      p.body.id,
    );
    await c.http.delete(`${api}/products/${p.body.id}`).set(auth(manager));
    expect(
      (await c.http.get(`${api}/stock/alerts`).set(auth(cashier))).body.data.map((a: { productId: number }) => a.productId),
    ).not.toContain(p.body.id);
  });
});

describe('dashboard', () => {
  it('reports today and the low-stock count to managers only', async () => {
    expect((await c.http.get(`${api}/reports/dashboard`).set(auth(cashier))).status).toBe(403);
    const res = await c.http.get(`${api}/reports/dashboard`).set(auth(manager));
    expect(res.body.salesToday).toEqual({ count: 0, totalLbp: 0, profitLbp: 0, averageBasketLbp: 0 });
    const alerts = await c.http.get(`${api}/stock/alerts`).set(auth(manager));
    expect(res.body.lowStockCount).toBe(alerts.body.data.length);
    expect(res.body.openRegisters).toBe(0);
  });
});

describe('filtering the list by category and brand (US-15)', () => {
  it('returns only the products of the chosen category and/or brand, combined with search and the hidden switch', async () => {
    const cat = (await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'Filter category' })).body.id as number;
    const other = (await c.http.post(`${api}/categories`).set(auth(manager)).send({ name: 'Other category' })).body.id as number;
    const brand = (await c.http.post(`${api}/brands`).set(auth(manager)).send({ name: 'Filter brand' })).body.id as number;
    const a = await create({ name: 'Filter A', barcode: '7100000000001', categoryId: cat, brandId: brand });
    const b = await create({ name: 'Filter B', barcode: '7100000000002', categoryId: cat });
    const d = await create({ name: 'Filter D', barcode: '7100000000003', categoryId: other, brandId: brand });
    const names = async (qs: string) =>
      ((await c.http.get(`${api}/products?${qs}`).set(auth(cashier))).body.data as { name: string }[]).map((p) => p.name).sort();

    expect(await names(`categoryId=${cat}`)).toEqual(['Filter A', 'Filter B']);
    expect(await names(`brandId=${brand}`)).toEqual(['Filter A', 'Filter D']);
    expect(await names(`categoryId=${cat}&brandId=${brand}`)).toEqual(['Filter A']); // both must match
    expect(await names(`categoryId=${cat}&q=Filter B`)).toEqual(['Filter B']); // together with the search
    expect(await names(`categoryId=${other}&brandId=${brand}&q=Filter A`)).toEqual([]);

    await c.http.patch(`${api}/products/${b.body.id}`).set(auth(manager)).send({ active: false });
    expect(await names(`categoryId=${cat}`)).toEqual(['Filter A']); // hidden ones stay out unless asked for
    expect(await names(`categoryId=${cat}&active=all`)).toEqual(['Filter A', 'Filter B']);
    expect(d.status).toBe(201);
  });
});
