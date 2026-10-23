import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-34: duplicate barcodes. A report of every shared barcode, re-coding, merging products into one (history is not rewritten),
// and finally switching the rule on so the database refuses new duplicates among active products.
let c: TestCtx;
let cashier: string;
let manager: string;
let admin: string;
const api = '/api/v1';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const make = async (name: string, barcode: string, priceMinor = 10000) => {
  const res = await c.http.post(`${api}/products`).set(auth(manager)).send({ name, barcode, priceMinor });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
};
const adjust = (productId: number, qtyDelta: string) =>
  c.http.post(`${api}/stock/adjustments`).set(auth(manager)).send({ productId, qtyDelta, reason: 'test' });
const qtyOf = async (id: number) => Number((await c.http.get(`${api}/products/${id}`).set(auth(manager))).body.qty);
const merge = (keepId: number, retireIds: number[], key = randomUUID(), token = manager) =>
  c.http.post(`${api}/products/merge`).set(auth(token)).set('Idempotency-Key', key).send({ keepId, retireIds });
const enforce = (enabled: boolean, token = manager) => c.http.post(`${api}/barcodes/enforce`).set(auth(token)).send({ enabled });
const dups = async () => (await c.http.get(`${api}/barcodes/duplicates`).set(auth(manager))).body;

beforeAll(async () => {
  c = await startCtx();
  cashier = await c.login('cashier');
  manager = await c.login('manager');
  admin = await c.login('admin');
  await c.openRegister(cashier);
});
afterAll(() => c.close());

describe('the report', () => {
  it('lists every barcode shared by active products, with what helps to choose: stock, sales, price', async () => {
    const a = await make('Twin A', '8800000000011', 15000);
    const b = await make('Twin B', '8800000000011', 16000);
    await adjust(a, '7');
    const sold = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: [{ productId: a, qty: '1', unitPriceLbp: 15000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 15000 }],
        }),
      );
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);

    const r = await dups();
    expect(r.duplicateGroups).toBe(1);
    expect(r.duplicateProducts).toBe(2);
    expect(r.enforced).toBe(false);
    const group = r.data[0];
    expect(group.barcode).toBe('8800000000011');
    const ga = group.products.find((p: { id: number }) => p.id === a);
    expect(ga).toMatchObject({ name: 'Twin A', priceMinor: 15000, qty: '6', soldLines: 1 });
    expect(ga.lastSoldAt).not.toBeNull();
    expect(group.products.find((p: { id: number }) => p.id === b)).toMatchObject({ soldLines: 0, lastSoldAt: null, qty: '0' });
    expect((await c.http.get(`${api}/barcodes/status`).set(auth(manager))).body).toMatchObject({ duplicateGroups: 1 });
  });

  it('a hidden product that keeps a code is not a duplicate', async () => {
    const x = await make('Old X', '8800000000028');
    const y = await make('New X', '8800000000035');
    await c.http.patch(`${api}/products/${x}`).set(auth(manager)).send({ barcode: '8800000000035', active: false });
    expect((await dups()).data.map((g: { barcode: string }) => g.barcode)).not.toContain('8800000000035');
    expect(y).toBeGreaterThan(0);
  });
});

describe('cleaning up', () => {
  it('turning the rule on is refused while anything is still shared', async () => {
    const res = await enforce(true);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DUPLICATES_REMAIN', duplicateGroups: 1 });
  });

  it('merging folds the others into the one that stays: stock moves across, they are hidden and their code is freed, history is untouched', async () => {
    const keep = await make('Keep me', '8800000000042', 20000);
    const gone1 = await make('Dup one', '8800000000042', 20000);
    const gone2 = await make('Dup two', '8800000000042', 20000);
    await adjust(keep, '3');
    await adjust(gone1, '5');
    await adjust(gone2, '-2'); // stock may be negative; it moves too
    const sold = await c.http
      .post(`${api}/sales`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .send(
        c.newSaleBody({
          items: [{ productId: gone1, qty: '1', unitPriceLbp: 20000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 20000 }],
        }),
      );
    expect(sold.status, JSON.stringify(sold.body)).toBe(201); // gone1 now 4

    const res = await merge(keep, [gone1, gone2]);
    expect(res.status).toBe(200);
    expect(res.body.retired).toEqual([
      { id: gone1, name: 'Dup one', qty: '4' },
      { id: gone2, name: 'Dup two', qty: '-2' },
    ]);
    expect(await qtyOf(keep)).toBe(3 + 4 - 2);
    expect(await qtyOf(gone1)).toBe(0);
    expect(await qtyOf(gone2)).toBe(0);

    const retired = (await c.http.get(`${api}/products/${gone1}`).set(auth(manager))).body;
    expect(retired).toMatchObject({ active: false, barcode: '' });
    const found = await c.http.get(`${api}/products/by-barcode/8800000000042`).set(auth(cashier));
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].id).toBe(keep);

    const sale = await c.http.get(`${api}/sales/${sold.body.id}`).set(auth(manager)); // the old sale still says what it sold
    expect(sale.body.items[0]).toMatchObject({ productId: gone1, name: 'Dup one' });
    const ledger = (await c.http.get(`${api}/stock/${keep}/movements`).set(auth(manager))).body.data as {
      reason: string;
      note: string | null;
    }[];
    expect(ledger.filter((m) => m.reason === 'transfer').map((m) => m.note)).toEqual(
      expect.arrayContaining(['Merged from "Dup one"', 'Merged from "Dup two"']),
    );
    const log = await c.http.get(`${api}/audit?action=product.merge&entityId=${keep}`).set(auth(admin));
    expect(log.body.data[0].after).toMatchObject({ barcode: '8800000000042', kept: 'Keep me' });
  });

  it('only products that share the barcode can be merged; each once; the one that stays must be active', async () => {
    const a = await make('M1', '8800000000059');
    const b = await make('M2', '8800000000066');
    const refused = await merge(a, [b]);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('NOT_DUPLICATES');
    expect((await merge(a, [a])).status).toBe(400);
    expect((await merge(a, [b, b])).status).toBe(400);
    expect((await merge(a, [999999])).status).toBe(404);
    await c.http.patch(`${api}/products/${b}`).set(auth(manager)).send({ active: false });
    expect((await merge(b, [a])).body.code).toBe('PRODUCT_INACTIVE');
    expect(
      (
        await c.http
          .post(`${api}/products/merge`)
          .set(auth(manager))
          .send({ keepId: a, retireIds: [b] })
      ).status,
    ).toBe(400); // key required
  });

  it('a replay of the same merge answers with the first result and moves nothing more', async () => {
    const keep = await make('R keep', '8800000000073');
    const dup = await make('R dup', '8800000000073');
    await adjust(dup, '4');
    const key = randomUUID();
    const first = await merge(keep, [dup], key);
    const replay = await merge(keep, [dup], key);
    expect(replay.status).toBe(200);
    expect(replay.header['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await qtyOf(keep)).toBe(4);
  });

  it('re-coding a product (the product screen) also clears a group', async () => {
    const before = (await dups()).duplicateGroups;
    expect(before).toBe(1); // Twin A and Twin B are still sharing a code
    const r = await c.http.get(`${api}/barcodes/duplicates`).set(auth(manager));
    const twinB = r.body.data[0].products.find((p: { name: string }) => p.name === 'Twin B').id as number;
    expect((await c.http.patch(`${api}/products/${twinB}`).set(auth(manager)).send({ barcode: '8800000000080' })).status).toBe(200);
    expect((await dups()).duplicateGroups).toBe(0);
  });
});

describe('the rule, once it is on', () => {
  it('turns on when nothing is shared, and the database then refuses a second active product with a code', async () => {
    const res = await enforce(true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enforced: true, duplicateGroups: 0 });

    const dupCreate = await c.http
      .post(`${api}/products`)
      .set(auth(manager))
      .send({ name: 'Copycat', barcode: '8800000000080', priceMinor: 1 });
    expect(dupCreate.status).toBe(409);
    expect(dupCreate.body.code).toBe('DUPLICATE_BARCODE');
    const other = await make('Other', '8800000000097');
    const dupPatch = await c.http.patch(`${api}/products/${other}`).set(auth(manager)).send({ barcode: '8800000000080' });
    expect(dupPatch.status).toBe(409);
    expect(dupPatch.body.code).toBe('DUPLICATE_BARCODE');
    expect((await c.http.get(`${api}/products/${other}`).set(auth(manager))).body.barcode).toBe('8800000000097'); // unchanged
  });

  it('products without a barcode are never "the same", and a hidden product may hold a code that an active one uses', async () => {
    await make('No code 1', '');
    await make('No code 2', '');
    const x = await make('Holder', '8800000000103');
    await c.http.patch(`${api}/products/${x}`).set(auth(manager)).send({ active: false });
    const y = await make('Taker', '8800000000103'); // the hidden one does not count
    expect(y).toBeGreaterThan(0);
    // but bringing the hidden one back would make two active products share the code
    const back = await c.http.patch(`${api}/products/${x}`).set(auth(manager)).send({ active: true });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('DUPLICATE_BARCODE');
  });

  it('a product can still be edited without touching its barcode, and the CSV import cannot create a duplicate', async () => {
    const id = await make('Editable', '8800000000110');
    expect((await c.http.patch(`${api}/products/${id}`).set(auth(manager)).send({ priceMinor: 2222 })).status).toBe(200);
    const imp = await c.http
      .post(`${api}/products/import`)
      .set(auth(manager))
      .send({ csv: 'name,barcode,price\nEditable renamed,8800000000110,3000\n', dryRun: false });
    expect(imp.body.summary).toMatchObject({ update: 1, create: 0 }); // the barcode finds the product, it does not add a second
  });

  it('turning it off is for an admin only, and allows duplicates again', async () => {
    expect((await enforce(false, manager)).status).toBe(403);
    expect((await enforce(false, admin)).body.enforced).toBe(false);
    const a = await make('Free 1', '8800000000127');
    const b = await make('Free 2', '8800000000127');
    expect(a).not.toBe(b);
    expect((await dups()).duplicateGroups).toBe(1);
  });
});

describe('who may', () => {
  it('managers and admins only', async () => {
    for (const [method, path] of [
      ['get', '/barcodes/status'],
      ['get', '/barcodes/duplicates'],
    ] as const) {
      expect((await c.http[method](`${api}${path}`).set(auth(cashier))).status).toBe(403);
      expect((await c.http[method](`${api}${path}`)).status).toBe(401);
    }
    expect((await enforce(true, cashier)).status).toBe(403);
    expect((await merge(1, [2], randomUUID(), cashier)).status).toBe(403);
  });
});
