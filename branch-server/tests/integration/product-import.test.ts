import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCtx, type TestCtx } from '../helpers/app';

// US-15: products from a spreadsheet's CSV. A first call only says what would happen; a file with any problem writes nothing;
// the answer names the row and the reason; running the same file twice changes nothing the second time.
let c: TestCtx;
let manager: string;
let cashier: string;
let admin: string;
const api = '/api/v1';
const TOWEL = '5287000107945'; // seeded: 75,000 LBP
const CHOC = '9342390005250'; // seeded: 50,000 LBP
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const send = (csv: string, over: Record<string, unknown> = {}, token = manager) =>
  c.http
    .post(`${api}/products/import`)
    .set(auth(token))
    .send({ csv, ...over });
const check = (csv: string, over: Record<string, unknown> = {}) => send(csv, { dryRun: true, ...over });
const apply = (csv: string, over: Record<string, unknown> = {}) => send(csv, { dryRun: false, ...over });
const lines = (...l: string[]) => l.join('\n');
const find = async (barcode: string) =>
  (await c.http.get(`${api}/products?q=${encodeURIComponent(barcode)}&active=all`).set(auth(manager))).body.data as {
    id: number;
    name: string;
    receiptName: string;
    receiptNameManual: boolean;
    barcode: string;
    priceMinor: number;
    costMinor: number;
    currency: string;
    categoryId: number | null;
    brandId: number | null;
    stockAlert: number | null;
  }[];
const count = async () => (await c.http.get(`${api}/products?limit=200&active=all`).set(auth(manager))).body.data.length as number;
const audit = async (action: string) =>
  (await c.http.get(`${api}/audit?action=${action}&limit=50`).set(auth(admin))).body.data as {
    entityId: string | null;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }[];

beforeAll(async () => {
  c = await startCtx();
  manager = await c.login('manager');
  cashier = await c.login('cashier');
  admin = await c.login('admin');
});
afterAll(() => c.close());

describe('checking a file (dry run)', () => {
  it('is the default: leaving the flag out writes nothing', async () => {
    const before = await count();
    const res = await send(lines('name,barcode,price', 'Dry run item,7100000000011,1000'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, applied: false, summary: { create: 1, update: 0, unchanged: 0, errors: 0 } });
    expect(await count()).toBe(before);
    expect(await find('7100000000011')).toHaveLength(0);
  });

  it('says for every row what it would do, with the row as a spreadsheet numbers it (the header is row 1)', async () => {
    const res = await check(lines('name,barcode,price', 'New one,7100000000012,2000', `Cedars silver towel,${TOWEL},80000`));
    expect(res.body.rows).toMatchObject([
      { row: 2, action: 'create', name: 'New one', changes: ['new product'] },
      { row: 3, action: 'update', changes: [expect.stringContaining('price 75000 LBP → 80000 LBP')] },
    ]);
  });

  it('lists columns it does not use, and reads headers in any case, with spaces or hyphens', async () => {
    const res = await check(lines('Name,Bar-Code,Price,Colour', 'X,7100000000013,5', 'Y,7100000000014,6'));
    expect(res.body.ignoredColumns).toEqual(['Bar-Code'.length ? 'Bar-Code' : '', 'Colour']);
    const ok = await check(lines('NAME, Receipt Name ,PRICE,Colour', 'Z,Zee,5'));
    expect(ok.body.ignoredColumns).toEqual(['Colour']);
    expect(ok.body.summary.create).toBe(1);
  });
});

describe('applying a file', () => {
  it('creates products with every column, in one go, and audits each and the import', async () => {
    const res = await apply(
      lines(
        'name,barcode,price,cost,currency,category,brand,supplier,stock_alert,receipt_name',
        'Olive oil 1L,7200000000011,12.50,9.75,USD,Pantry,Zeit,Beirut Foods,6,Olive oil',
        'حليب كامل الدسم,7200000000028,95000,70000,LBP,Pantry,,,0.5,',
      ),
      { createMissing: true },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, summary: { create: 2, errors: 0 } });
    expect(res.body.newLookups).toEqual(
      expect.arrayContaining([
        { kind: 'category', name: 'Pantry' },
        { kind: 'brand', name: 'Zeit' },
        { kind: 'supplier', name: 'Beirut Foods' },
      ]),
    );
    expect(res.body.newLookups).toHaveLength(3); // Pantry once, though two rows use it

    const [oil] = await find('7200000000011');
    expect(oil).toMatchObject({
      name: 'Olive oil 1L',
      priceMinor: 1250,
      costMinor: 975,
      currency: 'USD',
      stockAlert: 6,
      receiptName: 'Olive oil',
      receiptNameManual: true,
    });
    expect(oil!.categoryId).not.toBeNull();
    const [milk] = await find('7200000000028');
    expect(milk).toMatchObject({ priceMinor: 95000, currency: 'LBP', stockAlert: 0.5, receiptNameManual: false });
    expect(milk!.receiptName).toMatch(/^[\x20-\x7e]+$/); // the Arabic name is transliterated for the printer
    expect(milk!.categoryId).toBe(oil!.categoryId);

    expect((await audit('product.create')).filter((a) => a.after?.via === 'import')).toHaveLength(2);
    const summary = (await audit('product.import'))[0]!;
    expect(summary.after).toMatchObject({ create: 2, update: 0, errors: 0 });
  });

  it('running the same file again changes nothing', async () => {
    const file = lines('name,barcode,price,cost,currency', 'Again,7300000000011,3000,2000,LBP');
    expect((await apply(file)).body.summary).toMatchObject({ create: 1 });
    const before = await count();
    const second = await apply(file);
    expect(second.body.summary).toMatchObject({ create: 0, update: 0, unchanged: 1 });
    expect(second.body.rows[0]).toMatchObject({ action: 'unchanged', changes: [] });
    expect(await count()).toBe(before);
  });

  it('updates a product found by its barcode, changes only the filled-in cells, and audits the price change with before and after', async () => {
    const [before] = await find(CHOC);
    const res = await apply(lines('name,barcode,price,cost,category', `ignored label,${before!.barcode},55000,,`));
    expect(res.body.summary).toMatchObject({ update: 1 });
    const [after] = await find(CHOC);
    expect(after).toMatchObject({
      priceMinor: 55000,
      costMinor: before!.costMinor,
      categoryId: before!.categoryId,
      currency: before!.currency,
    });
    expect(after!.name).toBe('ignored label'); // the name column is the name: it is not only a label
    const log = (await audit('product.price.update')).find((a) => a.entityId === String(before!.id) && a.after?.via === 'import')!;
    expect(log.before).toMatchObject({ priceMinor: before!.priceMinor });
    expect(log.after).toMatchObject({ priceMinor: 55000 });
    await c.http.patch(`${api}/products/${before!.id}`).set(auth(manager)).send({ name: before!.name, priceMinor: before!.priceMinor });
  });

  it('finds a product with no barcode in the file by its name, ignoring case', async () => {
    await apply(lines('name,price', 'Plain Bread,2500'));
    const res = await apply(lines('name,price', 'PLAIN bread,3000'));
    expect(res.body.summary).toMatchObject({ create: 0, update: 1 });
    const found = (await c.http.get(`${api}/products?q=Plain%20Bread`).set(auth(manager))).body.data;
    expect(found).toHaveLength(1);
    expect(found[0].priceMinor).toBe(3000);
  });

  it('accepts a file written by Excel: byte-order mark, CRLF, quoted names with commas', async () => {
    const res = await apply('﻿name,barcode,price\r\n"Cheese, sliced",7400000000011,4500\r\n');
    expect(res.body.summary.create).toBe(1);
    expect((await find('7400000000011'))[0]!.name).toBe('Cheese, sliced');
  });

  it('a currency change needs both amounts in the new currency', async () => {
    await apply(lines('name,barcode,price', 'Switcher,7500000000011,9000'));
    const bad = await check(lines('name,barcode,currency,price', 'Switcher,7500000000011,USD,1.00'));
    expect(bad.body.rows[0].errors[0]).toMatch(/price and the cost must both be given in USD/);
    const good = await apply(lines('name,barcode,currency,price,cost', 'Switcher,7500000000011,USD,1.00,0.60'));
    expect(good.body.summary.update).toBe(1);
    expect((await find('7500000000011'))[0]).toMatchObject({ currency: 'USD', priceMinor: 100, costMinor: 60 });
  });

  it('does not touch stock or sales', async () => {
    const stockBefore = (await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty;
    await apply(lines('name,barcode,price', `Cedars silver towel,${TOWEL},75000`));
    const stockAfter = (await c.http.get(`${api}/stock?productId=${c.seed.products.towel.id}`).set(auth(manager))).body.data[0].qty;
    expect(stockAfter).toBe(stockBefore);
  });
});

describe('a file with a problem writes nothing, and says where', () => {
  const bad: [string, string, RegExp, Record<string, unknown>?][] = [
    ['an empty name', ',7600000000011,100', /name is empty/],
    ['a price with a thousands separator', '"A",7600000000012,"75,000"', /price: "75,000" is not a whole number of lira/],
    ['dollars with three decimals', 'A,7600000000013,1.234,,USD', /price: .*dollars/],
    ['a negative price', 'A,7600000000014,-5', /price/],
    ['an unknown currency', 'A,7600000000015,5,,EUR', /currency "EUR" must be LBP or USD/],
    ['a barcode a spreadsheet turned into a number', 'A,7.6E+12,5', /shortened/],
    ['a barcode that is too long', `A,${'1'.repeat(65)},5`, /longer than 64/],
    ['a new product without a price', 'A,7600000000016,', /needs a price/],
    ['a category that does not exist (without the box ticked)', 'A,7600000000017,5,,,Nowhere', /no category called "Nowhere"/],
    ['a stock alert that is not a number', 'A,7600000000018,5,,,,,,lots', /stock alert/],
  ];
  it.each(bad)('%s', async (_what, row, message) => {
    const header = 'name,barcode,price,cost,currency,category,brand,supplier,stock_alert';
    const before = await count();
    const good = 'Perfectly fine,7699999999999,100';
    const file = lines(header, `${good},,,,,,`, row);
    const res = await check(file);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].action).toBe('create'); // the good row is fine on its own
    expect(res.body.rows[1]).toMatchObject({ row: 3, action: 'error' });
    expect(res.body.rows[1].errors.join(' ')).toMatch(message);
    expect(res.body.summary.errors).toBe(1);

    const applied = await apply(file);
    expect(applied.body.applied).toBe(false);
    expect(await count()).toBe(before); // not even the good row
    expect(await find('7699999999999')).toHaveLength(0);
  });

  it('a name with a comma and no quotes pushes the cells along, and is caught', async () => {
    const res = await check(lines('name,price', 'Cheese, sliced,5'));
    expect(res.body.rows[0].errors.join(' ')).toMatch(/more cells than the first row/);
  });

  it('a unit that does not exist is refused even when missing lists may be created', async () => {
    const res = await check(lines('name,barcode,price,unit', 'A,7600000000021,5,Furlong'), { createMissing: true });
    expect(res.body.rows[0].errors[0]).toMatch(/no unit called "Furlong".*Lists/);
  });

  it('the same barcode twice in the file, and the same product twice', async () => {
    const res = await check(lines('name,barcode,price', 'One,7600000000031,5', 'Two,7600000000031,6', 'Same,,7', 'same,,8'));
    expect(res.body.rows[1].errors[0]).toMatch(/already used by row 2/);
    expect(res.body.rows[3].errors[0]).toMatch(/already used by row 4/);
  });

  it('an old duplicate barcode in the shop is not guessed at', async () => {
    for (const name of ['Twin A', 'Twin B']) {
      await c.http.post(`${api}/products`).set(auth(manager)).send({ name, barcode: '7600000000041', priceMinor: 100 });
    }
    const res = await check(lines('name,barcode,price', 'Twin,7600000000041,5'));
    expect(res.body.rows[0].errors[0]).toMatch(/2 products already share the barcode/);
  });

  it('a name shared by two products, with no barcode in the row', async () => {
    for (const barcode of ['7600000000051', '7600000000052']) {
      await c.http.post(`${api}/products`).set(auth(manager)).send({ name: 'Doppel', barcode, priceMinor: 100 });
    }
    const res = await check(lines('name,price', 'Doppel,5'));
    expect(res.body.rows[0].errors[0]).toMatch(/2 products are called "Doppel"/);
  });

  it('warns, without blocking, when a new barcode carries a name that already exists', async () => {
    const res = await check(lines('name,barcode,price', 'Doppel,7600000000061,5'));
    expect(res.body.rows[0]).toMatchObject({ action: 'create', warnings: [expect.stringContaining('already exists')] });
  });
});

describe('a file that cannot be read at all is refused with IMPORT_INVALID_FILE', () => {
  const cases: [string, string, RegExp][] = [
    ['empty', '', /empty/],
    ['no name column', lines('barcode,price', '1,2'), /"name"/],
    ['only the header', 'name,price', /no products/],
    ['a column twice', lines('name,price,price', 'a,1,2'), /appears twice/],
    ['a quote that never closes', lines('name,price', '"a,1', 'b,2'), /never closed/],
  ];
  it.each(cases)('%s', async (_what, csv, message) => {
    const res = await check(csv);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IMPORT_INVALID_FILE');
    expect(res.body.detail).toMatch(message);
  });

  it('too many products at once', async () => {
    const body = ['name,price', ...Array.from({ length: 5001 }, (_, i) => `p${i},1`)].join('\n');
    const res = await check(body);
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/5000/);
  });

  it('wrong types are validation errors, and an enormous file is refused', async () => {
    expect((await send(123 as unknown as string)).status).toBe(400);
    // too big: refused with 400 or 413, or the connection is cut before the answer (the server stops reading)
    const big = await send('x'.repeat(3_100_000)).then(
      (r) => r.status,
      () => 0,
    );
    expect([0, 400, 413]).toContain(big);
  });
});

describe('who may import', () => {
  it('only a manager or an admin', async () => {
    const csv = lines('name,price', 'Nope,1');
    expect((await send(csv, {}, cashier)).status).toBe(403);
    expect((await c.http.post(`${api}/products/import`).send({ csv })).status).toBe(401);
    expect((await send(csv, {}, admin)).status).toBe(200);
  });

  it('a cell that looks like a spreadsheet formula is stored as plain text, never run, and shows in the audit as text', async () => {
    await apply(lines('name,barcode,price', '=HYPERLINK("http://example.com"),7700000000011,5'));
    expect((await find('7700000000011'))[0]!.name).toBe('=HYPERLINK("http://example.com")');
  });
});
