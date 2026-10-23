import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEtl } from '../../apps/api/src/etl/run';
import { migrate } from '../../apps/api/src/db/migrate';
import { seedReference } from '../../apps/api/src/db/seed';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { html, jpeg, png, svg } from '../helpers/images';
import { product, returnRow, sale, line, smallShop, writeDump, type Tables } from '../helpers/legacy-dump';

// The importer on tiny hand-made dumps. These need no real data, so they run everywhere (CI included), and they cover
// the cases the real dump cannot show: failing halfway, clashing with what is already in the database, and bad files.
let dir: string;
let dbFile: string;
let dumpFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pos-etl-syn-'));
  dbFile = join(dir, 'pos.db');
  dumpFile = join(dir, 'dump.sql');
  migrate(dbFile);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (tables: Tables) => runEtl({ dumpPath: writeDump(dumpFile, tables), databasePath: dbFile });
const query = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] => {
  const db = openDatabase(dbFile, { readonly: true });
  try {
    return db.prepare(sql).all(...p) as T[];
  } finally {
    db.close();
  }
};
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => query<T>(sql, ...p)[0]!;
const count = (table: string) => one<{ n: number }>(`select count(*) n from ${table}`).n;
const withDb = <T>(fn: (db: Db) => T): T => {
  const db = openDatabase(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe('a small shop imports completely and correctly', () => {
  it('brings every record across', async () => {
    const report = await run(smallShop());
    expect(count('sales')).toBe(5);
    expect(count('sale_items')).toBe(6); // 7 in the dump, minus one leftover zero line
    expect(count('products')).toBe(4);
    expect(count('returns')).toBe(1);
    expect(report.counts.sales).toEqual({ legacy: 5, imported: 5, existing: 0 });
  });

  it('net revenue equals what the old system recorded', async () => {
    const report = await run(smallShop());
    // legacy totals: 75,000 + 0 + 100,000 + 50,000 + 30,000
    expect(report.legacyTotals.grandTotalLbp).toBe(255_000);
    expect(one<{ s: number }>('select sum(total_lbp) s from sales').s - one<{ s: number }>('select sum(refund_lbp) s from returns').s).toBe(
      255_000,
    );
    expect(report.imported).toMatchObject({ revenueLbp: 405_000, refundsLbp: 150_000, netRevenueMatchesLegacy: true });
  });

  it('rebuilds the sale the old app zeroed when something was returned, and keeps the return separate', async () => {
    await run(smallShop());
    const s = one<{ id: number; total_lbp: number; paid_lbp: number; profit_lbp: number; created_at: string }>(
      'select id, total_lbp, paid_lbp, profit_lbp, created_at from sales where ref = 5002',
    );
    expect(s).toMatchObject({ total_lbp: 150_000, paid_lbp: 150_000, created_at: '2026-07-01T09:00:00.000Z' });
    expect(s.profit_lbp).toBe(150_000 - 2 * 67_000); // 0 recorded + the profit on the 2 returned pieces
    expect(query('select qty_milli, line_total_lbp from sale_items where sale_id = ?', s.id)).toEqual([
      { qty_milli: 2000, line_total_lbp: 150_000 },
    ]);
    const r = one<{ refund_lbp: number; created_at: string; id: number }>(
      'select id, refund_lbp, created_at from returns where sale_id = ?',
      s.id,
    );
    expect(r).toMatchObject({ refund_lbp: 150_000, created_at: '2026-07-01T10:00:00.000Z' });
    expect(query('select qty_milli, amount_lbp from return_items where return_id = ?', r.id)).toEqual([
      { qty_milli: 2000, amount_lbp: 150_000 },
    ]);
  });

  it('converts Beirut local time to UTC, in winter and summer', async () => {
    await run(smallShop());
    expect(one<{ created_at: string }>('select created_at from sales where ref = 5001').created_at).toBe('2026-01-15T10:00:00.000Z');
    expect(one<{ created_at: string }>('select created_at from products where legacy_id = 10').created_at).toBe('2026-01-10T07:00:00.500Z');
  });

  it('prices products in exact dollars, with the opening stock, the receipt name and the threshold', async () => {
    const report = await run(smallShop());
    expect(one('select price_minor, cost_minor, currency, stock_alert_milli, image_path from products where legacy_id = 10')).toEqual({
      price_minor: 83,
      cost_minor: 75,
      currency: 'USD',
      stock_alert_milli: 3000,
      image_path: null, // the picture is not in the Uploads folder (there is none beside this dump), so there is nothing to point at
    });
    expect(
      one<{ qty_milli: number }>('select l.qty_milli from stock_levels l join products p on p.id = l.product_id where p.legacy_id = 10')
        .qty_milli,
    ).toBe(10_000);
    expect(one<{ receipt_name: string }>('select receipt_name from products where legacy_id = 11').receipt_name).toBe('khbz kbyr');
    expect(report.stockAlerts).toEqual({ imported: 1, nullified: 3 });
    expect(report.receiptNames.transliterated).toBe(1);
  });

  it('keeps negative stock, and the cache still equals the ledger', async () => {
    const report = await run(smallShop());
    expect(report.negativeStock).toEqual([{ legacyId: 11, name: 'خبز كبير', qty: -2 }]);
    expect(
      query(
        'select l.product_id from stock_levels l where l.qty_milli <> coalesce((select sum(qty_milli_delta) from stock_movements m where m.product_id = l.product_id), 0)',
      ),
    ).toEqual([]);
  });

  it('links lines to products by barcode, uses the name to tell shared barcodes apart, and rescues by name', async () => {
    const report = await run(smallShop());
    const twinB = one<{ id: number }>("select id from products where name = 'Twin B'").id;
    expect(one<{ product_id: number }>("select product_id from sale_items where name_snap = 'Twin B'").product_id).toBe(twinB);
    expect(
      one<{ product_id: number | null }>("select product_id from sale_items where barcode_snap = 'no-such-code'").product_id,
    ).not.toBeNull();
    expect(one<{ product_id: number | null }>("select product_id from sale_items where barcode_snap = '999'").product_id).toBeNull();
    expect(report.unmatchedLines.sale).toMatchObject({ total: 6, byCode: 4, rescuedByName: 1, unmatched: 1 });
  });

  it('lists what needs a person to look at, instead of fixing it quietly', async () => {
    const report = await run(smallShop());
    expect(report.skipped.zeroQuantityLines).toBe(1);
    expect(report.duplicateBarcodes).toEqual([
      {
        barcode: '333',
        products: [
          { legacyId: 12, name: 'Twin A' },
          { legacyId: 13, name: 'Twin B' },
        ],
      },
    ]);
    expect(report.reconciliation.inconsistentSales).toEqual([
      { saleId: 104, ref: 5005, roundingLbp: -35_000, linesTotalLbp: 65_000, totalLbp: 30_000 },
    ]);
    expect(report.images.missing).toEqual(['towel.jpg']); // no Uploads folder beside this dump
  });

  it('a Walk-In balance moves to a placeholder customer, so it stays collectable', async () => {
    const report = await run(smallShop());
    expect(report.walkInDebts).toEqual([{ saleId: 102, ref: 5003, restLbp: 60_000 }]);
    const placeholder = one<{ id: number; balance_lbp: number; is_walk_in: number }>(
      'select id, balance_lbp, is_walk_in from customers where legacy_id = -1',
    );
    expect(placeholder).toMatchObject({ balance_lbp: 60_000, is_walk_in: 0 });
    expect(one('select status, paid_lbp, rest_lbp, customer_id from sales where ref = 5003')).toEqual({
      status: 'partial',
      paid_lbp: 40_000,
      rest_lbp: 60_000,
      customer_id: placeholder.id,
    });
    expect(one<{ balance_lbp: number }>('select balance_lbp from customers where is_walk_in = 1').balance_lbp).toBe(0);
  });

  it('merges the legacy Walk-In and units into the seeded ones, and tidies names', async () => {
    await run(smallShop());
    expect(count('customers')).toBe(3); // Walk-In (merged), Ahmad, placeholder
    expect(one('select name, phone, legacy_id from customers where is_walk_in = 1')).toEqual({
      name: 'Walk-In',
      phone: null,
      legacy_id: 1,
    });
    expect(one('select name, phone from customers where legacy_id = 2')).toEqual({ name: 'Ahmad Darwish', phone: null });
    expect(query('select name, fractional from units order by name').map((u) => (u as { name: string }).name)).toEqual([
      'Box',
      'KG',
      'Liter',
      'Piece',
    ]);
    expect(one<{ fractional: number }>("select fractional from units where name = 'Liter'").fractional).toBe(1);
    expect(one<{ legacy_id: number }>("select legacy_id from units where name = 'Piece'").legacy_id).toBe(2);
    expect(count('warehouses')).toBe(1);
    expect(one<{ name: string }>('select name from suppliers').name).toBe('Acme Trading');
    expect(one<{ name: string; phone: string }>('select name, phone from store_settings').name).toBe('Test Market');
  });

  it('does not carry over passwords: the user must be given a new one', async () => {
    const report = await run(smallShop());
    const u = one<{ username: string; role: string; password_hash: string; must_reset_password: number }>('select * from users');
    expect(u).toMatchObject({ username: 'atom.support', role: 'admin', must_reset_password: 1 });
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(query('select * from users'))).not.toContain('LegacySecret');
    const { verifyPassword } = await import('../../apps/api/src/auth/password');
    expect(await verifyPassword(u.password_hash, 'LegacySecret-1')).toBe(false);
    expect(report.users).toEqual([expect.objectContaining({ username: 'atom.support', role: 'admin' })]);
  });

  it('sets the numbering counters above every imported number', async () => {
    await run(smallShop());
    expect(one<{ value: number }>("select value from counters where name = 'sale_ref'").value).toBe(5005);
    expect(one<{ value: number }>("select value from counters where name = 'return_ref'").value).toBe(7);
  });

  it('keeps the old exchange rate when it matches, and adds it when it differs', async () => {
    expect((await run(smallShop())).exchangeRate.action).toBe('unchanged: 90000');
    rmSync(dbFile);
    migrate(dbFile);
    const tables = smallShop();
    tables.Exchanges = [{ ExchangeID: 1, Currency: '.ل.ل', Rate: '95000' }];
    const report = await run(tables);
    expect(report.exchangeRate.action).toMatch(/added 95000/);
    expect(one<{ r: number }>('select rate_lbp_per_usd r from exchange_rates order by effective_from desc limit 1').r).toBe(95_000);
  });

  it('imports a legacy sale priced in a currency it cannot read as zero and says so', async () => {
    const tables = smallShop();
    tables.Sales = [...tables.Sales!, sale({ id: 105, ref: '5006', total: 1000 })];
    tables.Sales![5]!.profit = 'n/a';
    const report = await run(tables);
    expect(report.unreadableNumbers['Sales.profit']).toBe(1);
    expect(one<{ profit_lbp: number }>('select profit_lbp from sales where ref = 5006').profit_lbp).toBe(0);
  });
});

describe('all or nothing', () => {
  it('a failure in the middle saves nothing at all, not even the products read before it', async () => {
    const tables = smallShop();
    tables.SaleProducts = [
      ...tables.SaleProducts!,
      line({ id: 9001, ref: '5001', name: 'Bad price', code: '111', qty: 1, price: -5, subtotal: -5 }),
    ];
    await expect(run(tables)).rejects.toThrow(/CHECK|constraint/i);
    for (const t of ['products', 'sales', 'sale_items', 'customers', 'users', 'units', 'returns', 'stock_movements']) {
      // only the seeded reference data may exist (Walk-In, three units, the warehouse)
      expect(count(t), t).toBe({ customers: 1, units: 3 }[t as 'customers' | 'units'] ?? 0);
    }
    expect(one<{ value: number }>("select value from counters where name = 'sale_ref'").value).toBe(0);
  });

  it('the import can then be run again once the file is fixed', async () => {
    const bad = smallShop();
    bad.SaleProducts = [
      ...bad.SaleProducts!,
      line({ id: 9001, ref: '5001', name: 'Bad price', code: '111', qty: 1, price: -5, subtotal: -5 }),
    ];
    await expect(run(bad)).rejects.toThrow();
    const report = await run(smallShop());
    expect(report.counts.sales!.imported).toBe(5);
    expect(count('sales')).toBe(5);
  });

  it('refuses to save when the money does not add up (two returns for one sale)', async () => {
    const tables = smallShop();
    tables.SaleReturn = [
      ...tables.SaleReturn!,
      returnRow({
        id: 8,
        saleRef: '5002',
        refund: 10_000,
        items: [{ id: 2001, reference: 5002, name: 'Cedars towel', qty: 2, price: 75000, rqty: 0, rsubtotal: '0' }],
      }),
    ];
    await expect(run(tables)).rejects.toThrow(/does not reconcile.*Nothing was saved/);
    expect(count('sales')).toBe(0);
    expect(count('returns')).toBe(0);
  });

  it('refuses a dump that is not the right file', async () => {
    await expect(run({ Units: [{ UnitID: 1, unitName: 'Piece' }] })).rejects.toThrow(/no Products/);
    expect(count('units')).toBe(0); // rejected before the database was touched: not even the starter data was added
  });

  it('refuses a truncated dump', async () => {
    writeDump(dumpFile, smallShop());
    const { readFileSync, writeFileSync } = await import('node:fs');
    const text = readFileSync(dumpFile, 'utf8');
    writeFileSync(dumpFile, text.slice(0, text.lastIndexOf('INSERT INTO [dbo].[SaleProducts]') + 150)); // cut in the middle of an insert
    await expect(runEtl({ dumpPath: dumpFile, databasePath: dbFile })).rejects.toThrow();
    expect(count('sales')).toBe(0);
  });
});

describe('running it again, and meeting data that is already there', () => {
  it('a second run imports nothing and changes nothing', async () => {
    await run(smallShop());
    const before = ['sales', 'sale_items', 'payments', 'returns', 'return_items', 'products', 'stock_movements', 'customers'].map((t) => [
      t,
      count(t),
    ]);
    const again = await run(smallShop());
    expect(
      ['sales', 'sale_items', 'payments', 'returns', 'return_items', 'products', 'stock_movements', 'customers'].map((t) => [t, count(t)]),
    ).toEqual(before);
    expect(Object.values(again.counts).every((c) => c.imported === 0)).toBe(true);
    expect(again.counts.sales).toEqual({ legacy: 5, imported: 0, existing: 5 });
  });

  it('a sale already made in the new system keeps its number; the old one that clashes is renumbered, not lost', async () => {
    withDb((db) => {
      seedReference(db);
      db.prepare(
        `insert into sales (ref, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, total_lbp, paid_lbp, status)
         values (5001, 1, 1, 90000, 1000, 1000, 1000, 'paid')`,
      ).run();
    });
    const report = await run(smallShop());
    expect(count('sales')).toBe(6);
    expect(new Set(query<{ ref: number }>('select ref from sales').map((r) => r.ref)).size).toBe(6);
    expect(one<{ total_lbp: number }>('select total_lbp from sales where ref = 5001').total_lbp).toBe(1000); // the new-system sale is untouched
    expect(report.notes.some((n) => /reference "5001" was not a usable unique number/.test(n))).toBe(true);
  });

  it('does not open a second register when the new system already has one open', async () => {
    withDb((db) => {
      seedReference(db);
      db.prepare(`insert into register_sessions (terminal_id) values ('T1')`).run();
    });
    const tables = smallShop();
    tables.Register = [
      {
        RegisterID: 1,
        OpenRegDate: '2026-10-18 17:53:33.943',
        DcashInHand: '70',
        DcashPaid: '0',
        Dcheque: '0',
        DbankTransfer: '0',
        DtotalSale: '0',
        DtotalCash: '70',
        LcashInHand: '3225000',
        LcashPaid: '0',
        Lcheque: '0',
        LbankTransfer: '0',
        LtotalSale: '0',
        LtotalCash: '3225000',
        RegisterStatus: 'opened',
        DWithDraw: '0',
        LWithDraw: '0',
        DtotalService: '0',
        LtotalService: '0',
      },
    ];
    const report = await run(tables);
    expect(report.registers.openSession).toMatch(/skipped/);
    expect(count('register_sessions')).toBe(1);
  });

  it('a return that points at a sale not in the dump is reported and skipped, not fatal', async () => {
    const tables = smallShop();
    tables.SaleReturn = [...tables.SaleReturn!, returnRow({ id: 9, saleRef: '99999', refund: 5000, items: [] })];
    const report = await run(tables);
    expect(report.orphans.returnsWithoutSale).toBe(1);
    expect(count('returns')).toBe(1);
    expect(report.notes.join(' ')).toContain('return 9 refers to sale 99999');
  });

  it('an empty return (nothing returned, nothing refunded) is imported and reported', async () => {
    const tables = smallShop();
    tables.SaleReturn = [
      ...tables.SaleReturn!,
      returnRow({
        id: 10,
        saleRef: '5001',
        refund: 0,
        items: [{ id: 1001, reference: 5001, name: 'Cedars towel', qty: 1, price: 75000, rqty: 0, rsubtotal: '0' }],
      }),
    ];
    const report = await run(tables);
    expect(report.returns.emptyReturns).toEqual([{ returnId: 10, saleRef: 5001 }]);
    expect(count('returns')).toBe(2);
  });
});

describe('legacy data that the new rules cannot hold', () => {
  it('a line returned for more than was sold is reported', async () => {
    const tables = smallShop();
    tables.SaleReturn![0] = returnRow({
      id: 7,
      saleRef: '5002',
      refund: 150_000,
      items: [{ id: 2001, reference: 5002, name: 'Cedars towel', qty: 2, price: 75000, rqty: 1, rsubtotal: '75000.00' }], // 0 + 1 returned, but the return says 2 were sold
    });
    const report = await run(tables);
    expect(report.returns.quantityExceptions).toEqual([{ saleLineId: 2001, saleRef: 5002, soldNow: 0, returned: 1, originalInReturn: 2 }]);
    expect(report.returns.headerVsLines).toEqual([{ returnId: 7, saleRef: 5002, headerLbp: 150_000, linesLbp: 75_000 }]);
  });

  it('a product priced above 1,000 can only be in lira', async () => {
    const tables = smallShop();
    tables.Products = [...tables.Products!, product({ id: 14, name: 'Priced in lira', code: '444', cost: 40_000, price: 50_000 })];
    const report = await run(tables);
    expect(one('select currency, price_minor, cost_minor from products where legacy_id = 14')).toEqual({
      currency: 'LBP',
      price_minor: 50_000,
      cost_minor: 40_000,
    });
    expect(report.currency).toMatchObject({ usdProducts: 4, lbpProducts: 1 });
  });

  it('a stock threshold of zero or below means "not set"', async () => {
    const tables = smallShop();
    tables.Products = [
      product({ id: 20, name: 'Zero', code: '1', alert: '0' }),
      product({ id: 21, name: 'Negative', code: '2', alert: '-2' }),
      product({ id: 22, name: 'Real', code: '3', alert: '8' }),
      product({ id: 23, name: 'Blank', code: '4', alert: '' }),
    ];
    await run(tables);
    expect(query('select name, stock_alert_milli from products order by legacy_id')).toEqual([
      { name: 'Zero', stock_alert_milli: null },
      { name: 'Negative', stock_alert_milli: null },
      { name: 'Real', stock_alert_milli: 8000 },
      { name: 'Blank', stock_alert_milli: null },
    ]);
  });

  it('placeholder expiry years (0001, 2000) are dropped; real ones kept', async () => {
    const tables = smallShop();
    tables.Products = [
      { ...product({ id: 30, name: 'Placeholder', code: '5' }), expiryDate: '2000-01-01T00:00:00.0000000' },
      { ...product({ id: 31, name: 'Real', code: '6' }), expiryDate: '2027-03-31T00:00:00.0000000' },
    ];
    await run(tables);
    expect(query('select name, expiry_date from products order by legacy_id')).toEqual([
      { name: 'Placeholder', expiry_date: null },
      { name: 'Real', expiry_date: '2027-03-31' },
    ]);
  });
});

describe('product pictures (US-15)', () => {
  const uploads = () => join(dir, 'old-pictures');
  const pictures = () => join(dir, 'uploads');
  /** The importer, told where the old pictures are. */
  const run = (tables: Tables) => runEtl({ dumpPath: writeDump(dumpFile, tables), databasePath: dbFile, uploadsDir: uploads() });
  const picture = (id: number, file: string) =>
    product({ id, name: `Item ${id}`, code: `90${id}`, image: `http://localhost:5220/uploads/${file}` });

  /** A shop whose products 10 to 15 point at the given files (the rest of smallShop is left alone). */
  const shopWithPictures = (files: Record<number, string>): Tables => {
    const shop = smallShop();
    const extra = Object.entries(files).map(([id, file]) => picture(Number(id) + 100, file));
    return {
      ...shop,
      Products: [
        ...(shop.Products as Record<string, unknown>[]).map((p) => ({ ...p, ProdImage: 'http://localhost:5220/uploads/null.png' })),
        ...extra,
      ],
    } as Tables;
  };

  beforeEach(() => mkdirSync(uploads(), { recursive: true }));

  it('copies each picture under a name made from its content, with the extension of what it really is', async () => {
    writeFileSync(join(uploads(), 'towel.jpg'), png('towel')); // says JPEG, is PNG
    writeFileSync(join(uploads(), 'bread.png'), jpeg('bread')); // says PNG, is JPEG
    const report = await run(shopWithPictures({ 1: 'towel.jpg', 2: 'bread.png' }));
    const rows = query<{ image_path: string }>('select image_path from products where legacy_id in (101, 102) order by legacy_id');
    expect(rows[0]!.image_path).toMatch(/^\/uploads\/[0-9a-f]{24}\.png$/);
    expect(rows[1]!.image_path).toMatch(/^\/uploads\/[0-9a-f]{24}\.jpg$/);
    expect(report.images).toMatchObject({ referenced: 2, present: 2, stored: 2, shared: 0, missing: [], notPictures: [] });
    expect(report.images.extensionFixed.sort()).toEqual(['bread.png', 'towel.jpg']);
    expect(readdirSync(pictures()).sort()).toEqual(rows.map((r) => r.image_path.slice('/uploads/'.length)).sort());
  });

  it('keeps one copy of a picture that two products use, and of two files with identical bytes', async () => {
    writeFileSync(join(uploads(), 'a.jpg'), jpeg('same'));
    writeFileSync(join(uploads(), 'a (1).jpg'), jpeg('same')); // a duplicate file, as the legacy folder has
    const report = await run(shopWithPictures({ 1: 'a.jpg', 2: 'a.jpg', 3: 'a (1).jpg' }));
    const paths = query<{ image_path: string }>('select image_path from products where legacy_id in (101, 102, 103)').map(
      (r) => r.image_path,
    );
    expect(new Set(paths).size).toBe(1);
    expect(readdirSync(pictures())).toHaveLength(1);
    expect(report.images).toMatchObject({ stored: 1, shared: 1 });
  });

  it('a saved web page is not a picture: not copied, listed, and the product imports without one', async () => {
    writeFileSync(join(uploads(), 'page.html'), html());
    writeFileSync(join(uploads(), 'also.htm'), svg());
    const report = await run(shopWithPictures({ 1: 'page.html', 2: 'also.htm' }));
    expect(report.images.notPictures.sort()).toEqual(['also.htm', 'page.html']);
    expect(query('select image_path from products where legacy_id in (101, 102)')).toEqual([{ image_path: null }, { image_path: null }]);
    expect(existsSync(pictures()) ? readdirSync(pictures()) : []).toEqual([]);
  });

  it('a picture the folder does not have is listed as missing, and the product has none', async () => {
    const report = await run(shopWithPictures({ 1: 'nowhere.png' }));
    expect(report.images.missing).toEqual(['nowhere.png']);
    expect(one('select image_path from products where legacy_id = 101')).toEqual({ image_path: null });
  });

  it('counts the files that no product uses, and does not copy them', async () => {
    writeFileSync(join(uploads(), 'used.png'), png('used'));
    writeFileSync(join(uploads(), 'spare-1.png'), png('spare1'));
    writeFileSync(join(uploads(), 'spare-2.png'), png('spare2'));
    const report = await run(shopWithPictures({ 1: 'used.png' }));
    expect(report.images.unused).toBe(2);
    expect(readdirSync(pictures())).toHaveLength(1);
  });

  it('never changes the old folder', async () => {
    writeFileSync(join(uploads(), 'towel.jpg'), png('towel'));
    writeFileSync(join(uploads(), 'page.html'), html());
    const before = readdirSync(uploads()).map((f) => [f, readFileSync(join(uploads(), f)).toString('hex')]);
    await run(shopWithPictures({ 1: 'towel.jpg', 2: 'page.html' }));
    expect(readdirSync(uploads()).map((f) => [f, readFileSync(join(uploads(), f)).toString('hex')])).toEqual(before);
  });

  it('running it again copies nothing new and changes no path', async () => {
    writeFileSync(join(uploads(), 'towel.jpg'), png('towel'));
    const shop = shopWithPictures({ 1: 'towel.jpg' });
    await run(shop);
    const first = readdirSync(pictures()).sort();
    const path = one<{ image_path: string }>('select image_path from products where legacy_id = 101').image_path;
    await run(shop);
    expect(readdirSync(pictures()).sort()).toEqual(first);
    expect(one<{ image_path: string }>('select image_path from products where legacy_id = 101').image_path).toBe(path);
  });

  it('puts the pictures where it is told to', async () => {
    writeFileSync(join(uploads(), 'towel.jpg'), png('towel'));
    const elsewhere = join(dir, 'somewhere', 'else');
    await runEtl({
      dumpPath: writeDump(dumpFile, shopWithPictures({ 1: 'towel.jpg' })),
      databasePath: dbFile,
      uploadsDir: uploads(),
      imagesDir: elsewhere,
    });
    expect(readdirSync(elsewhere)).toHaveLength(1);
    expect(existsSync(pictures())).toBe(false);
  });

  it('refuses to copy the pictures into the folder it reads them from (on Windows "Uploads" and "uploads" are one folder)', async () => {
    writeFileSync(join(uploads(), 'towel.jpg'), png('towel'));
    const dump = writeDump(dumpFile, shopWithPictures({ 1: 'towel.jpg' }));
    await expect(runEtl({ dumpPath: dump, databasePath: dbFile, uploadsDir: uploads(), imagesDir: uploads() })).rejects.toThrow(
      /same folder/,
    );
    // spelled differently, still the same folder
    await expect(
      runEtl({ dumpPath: dump, databasePath: dbFile, uploadsDir: uploads(), imagesDir: join(uploads(), '..', 'old-pictures') }),
    ).rejects.toThrow(/same folder/);
    expect(count('products')).toBe(0); // nothing was imported
    expect(readdirSync(uploads())).toEqual(['towel.jpg']); // and the old folder is as it was
  });
});
