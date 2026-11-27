import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminAuth, startHq, type Hq } from '../helpers';
import { api, auth, startFreshBranch, until, type FreshBranch } from './freshBranch';

// The product import at HQ (docs/12 §19): a spreadsheet's CSV becomes the chain's catalog. Nothing is guessed, a file with one problem writes
// nothing, and what is written reaches the branches like any product.
let hq: Hq;
let b: FreshBranch;
type Result = {
  applied: boolean;
  dryRun: boolean;
  summary: { create: number; update: number; unchanged: number; errors: number };
  newLookups: { kind: string; name: string }[];
  rows: { row: number; action: string; errors: string[]; changes: string[]; warnings: string[] }[];
};
const importCsv = async (csv: string, extra: Record<string, unknown> = {}) =>
  hq.http
    .post(`${api}/products/import`)
    .set(adminAuth)
    .send({ csv, ...extra });
const count = async (sql = 'SELECT COUNT(*) AS n FROM products') => (await hq.app.database.one<{ n: number }>(sql))!.n;
const logLines = () => count('SELECT COUNT(*) AS n FROM change_log');

const GOOD = [
  'name,barcode,price,cost,currency,category,brand,unit,supplier,stock_alert',
  'Milk 1L,5281000001001,120000,90000,LBP,Dairy,Almarai,Piece,,5',
  'Rice 5kg,5281000001018,4.50,3.10,USD,Grocery,,KG,,',
].join('\n');

beforeAll(async () => {
  hq = await startHq();
  b = await startFreshBranch();
});
afterAll(async () => {
  await b.close();
  await hq.close();
});

describe('a dry run says what would happen and writes nothing (US-15)', () => {
  it('is the default, even with a forgotten flag', async () => {
    const before = [await count(), await logLines()];
    const r = await importCsv(GOOD, { createMissing: true });
    expect(r.status).toBe(200);
    const body = r.body as Result;
    expect(body).toMatchObject({ dryRun: true, applied: false, summary: { create: 2, update: 0, unchanged: 0, errors: 0 } });
    expect(body.newLookups.map((l) => `${l.kind}:${l.name}`).sort()).toEqual(['brand:Almarai', 'category:Dairy', 'category:Grocery']);
    expect([await count(), await logLines()]).toEqual(before);
  });

  it('names the row and the reason for every problem, and a file with any problem is never applied', async () => {
    const csv = [
      'name,barcode,price,unit,category',
      'Fine,5281000002001,1000,Piece,',
      ',5281000002018,1000,Piece,', // no name
      'No price,5281000002025,,Piece,',
      'Shortened,5.28E+12,1000,Piece,',
      'Odd unit,5281000002032,1000,Stone,',
      'Odd category,5281000002049,1000,Piece,Nowhere',
      'Twice,5281000002001,1000,Piece,', // the barcode of row 2
    ].join('\n');
    const before = [await count(), await logLines()];
    const r = await importCsv(csv, { dryRun: false });
    const body = r.body as Result;
    expect(body.applied).toBe(false);
    expect(body.summary.errors).toBe(6);
    const err = (row: number) => body.rows.find((x) => x.row === row)!.errors.join(' | ');
    expect(err(3)).toMatch(/name is empty/);
    expect(err(4)).toMatch(/needs a price/);
    expect(err(5)).toMatch(/shortened/);
    expect(err(6)).toMatch(/no unit called "Stone"/);
    expect(err(7)).toMatch(/no category called "Nowhere"/);
    expect(err(8)).toMatch(/already used by row 2/);
    expect([await count(), await logLines()]).toEqual(before); // not even the one good row
  });

  it('refuses a file that cannot be read at all', async () => {
    for (const csv of ['', 'name\n', 'price\n100', 'name,name\nx,y']) {
      const r = await importCsv(csv);
      expect([csv, r.status, r.body.code]).toEqual([csv, 422, 'IMPORT_INVALID_FILE']);
    }
  });
});

describe('applying a file', () => {
  it('creates the products, and the lists it was told to create, in one go; the cost and the dollars are exact', async () => {
    const r = await importCsv(GOOD, { dryRun: false, createMissing: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, summary: { create: 2, errors: 0 } });
    const rice = (await hq.http.get(`${api}/products?q=5281000001018`).set(adminAuth)).body.data[0];
    expect(rice).toMatchObject({ name: 'Rice 5kg', priceMinor: 450, costMinor: 310, currency: 'USD', unitId: 2 }); // dollars in cents
    const milk = (await hq.http.get(`${api}/products?q=5281000001001`).set(adminAuth)).body.data[0];
    expect(milk).toMatchObject({ priceMinor: 120000, stockAlert: 5, unitId: 1 });
    expect(milk.categoryId).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) AS n FROM hq_audit WHERE action = 'product.import'`)).toBe(1);
  });

  it('the same file again changes nothing', async () => {
    const lines = await logLines();
    const r = await importCsv(GOOD, { dryRun: false, createMissing: true });
    expect(r.body).toMatchObject({ applied: true, summary: { create: 0, update: 0, unchanged: 2, errors: 0 } });
    expect(await logLines()).toBe(lines + 0); // no product line, no list line: (only the import's audit row is new)
  });

  it('an empty cell leaves a product as it is; a filled one changes only that', async () => {
    const r = await importCsv('name,barcode,price,cost\nMilk 1L,5281000001001,125000,', { dryRun: false });
    const body = r.body as Result;
    expect(body.summary).toMatchObject({ update: 1, errors: 0 });
    expect(body.rows[0]!.changes).toEqual(['price 120000 LBP → 125000 LBP']);
    const milk = (await hq.http.get(`${api}/products?q=5281000001001`).set(adminAuth)).body.data[0];
    expect(milk).toMatchObject({ priceMinor: 125000, costMinor: 90000 }); // the cost was not touched
  });

  it('a retired product’s barcode is free again: the import adds a new product instead of reviving the old one', async () => {
    const old = (await hq.http.get(`${api}/products?q=5281000001018`).set(adminAuth)).body.data[0];
    expect((await hq.http.delete(`${api}/products/${old.id}`).set(adminAuth)).status).toBe(204);
    const r = await importCsv('name,barcode,price\nRice 5kg new,5281000001018,500', { dryRun: false });
    expect((r.body as Result).summary).toMatchObject({ create: 1, errors: 0 });
    const active = (await hq.http.get(`${api}/products?q=5281000001018`).set(adminAuth)).body.data as { id: number; name: string }[];
    expect(active.map((p) => p.name)).toEqual(['Rice 5kg new']);
  });
});

describe('what is imported reaches a branch', () => {
  it('a fresh branch that connects afterwards ends with every imported product, under HQ’s ids', async () => {
    expect((await b.connect(hq, 'I1')).status).toBe(200);
    const hqRows = await hq.app.database.all<{ id: number; name: string; price_minor: number }>(
      'SELECT id, name, price_minor FROM products ORDER BY id',
    );
    const there = async () =>
      (await b.http.get(`${api}/products?active=all&limit=200`).set(auth(b.admin))).body.data as {
        id: number;
        name: string;
        priceMinor: number;
      }[];
    expect(await until(async () => (await there()).length === hqRows.length)).toBe(true);
    expect((await there()).map((p) => [p.id, p.name, p.priceMinor])).toEqual(hqRows.map((p) => [p.id, p.name, p.price_minor]));
  });
});
