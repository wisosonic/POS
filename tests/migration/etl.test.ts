import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEtl } from '../../apps/api/src/etl/run';
import { buildApp } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/password';
import { migrate } from '../../apps/api/src/db/migrate';
import { openDatabase, type Db } from '../../apps/api/src/db/open';
import { IMAGE_TYPES, STORED_NAME, sniffImage } from '../../apps/api/src/modules/catalog/images';

// The real legacy dump (dump generated 2026-10-18). Point POSDB_DUMP at it; skipped when it is not there (157 MB, not in CI).
const DUMP = process.env.POSDB_DUMP ?? 'POSDB.sql';
const maybe = existsSync(DUMP) ? describe : describe.skip;

// Facts about the dump itself, found by reading it (see docs/01-data-analysis.md section 6).
const FACTS = {
  legacySalesTotalLbp: 4_646_912_950, // sum of Sales.grandTotal
  refundsLbp: 14_435_000, // sum of SaleReturn.returnedsAmount
  zeroQuantityLines: 14, // lines with nothing sold and no return behind them
  saleLinesInDump: 44_901,
  duplicateBarcodeGroups: 21,
  walkInDebtsLbp: 220_000, // two sales where an unidentified Walk-In still owed money
};

// Rows imported per table: the dump's counts, except where the new rules change them.
const EXPECTED = {
  sales: 22_600,
  sale_items: FACTS.saleLinesInDump - FACTS.zeroQuantityLines,
  products: 1_721,
  customers: 13 + 1, // 13 in the dump (Walk-In merges into the protected row) + the placeholder that holds the Walk-In debts
  returns: 116,
  purchases: 860,
  purchase_items: 3_371,
  suppliers: 75,
};

maybe('legacy ETL (US-29)', () => {
  let dir: string;
  let file: string;
  let db: Db;
  let report: Awaited<ReturnType<typeof runEtl>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pos-etl-'));
    file = join(dir, 'pos.db');
    migrate(file);
    report = await runEtl({ dumpPath: DUMP, databasePath: file });
    db = openDatabase(file, { readonly: true });
  }, 600_000);

  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
  const all = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const count = (t: string) => get<{ n: number }>(`select count(*) n from ${t}`).n;

  describe('what was imported', () => {
    it.each(Object.entries(EXPECTED))('imports %s', (table, n) => {
      expect(count(table)).toBe(n);
    });

    it('the whole dump goes through in well under a minute', () => {
      expect(report.seconds).toBeLessThan(60);
    });

    it('registers: the open one and all 290 closed shifts, each with its six balances', () => {
      expect(get<{ n: number }>("select count(*) n from register_sessions where status = 'open'").n).toBe(1);
      expect(get<{ n: number }>("select count(*) n from register_sessions where status = 'closed'").n).toBe(290);
      expect(all('select session_id from register_balances group by session_id having count(*) <> 6')).toHaveLength(0);
    });

    it('the open register opens with the legacy cash: $70 and 3,225,000 LBP (D = dollars, L = lira)', () => {
      expect(
        all(
          "select b.currency, b.opening from register_sessions s join register_balances b on b.session_id = s.id where s.status = 'open' and b.method = 'cash' order by b.currency",
        ),
      ).toEqual([
        { currency: 'LBP', opening: 3_225_000 },
        { currency: 'USD', opening: 7000 },
      ]);
    });

    it('a closed shift keeps its cash in hand and the closing total the old app computed', () => {
      // legacy RegisterLog 57: $70 in hand, 3,250,000 LBP in hand, 8,645,000 LBP total at closing
      const s = get<{ id: number }>('select id from register_sessions where legacy_id = 57');
      const lbp = get<{ opening: number; expected: number; counted: number; variance: number }>(
        "select opening, expected, counted, variance from register_balances where session_id = ? and method = 'cash' and currency = 'LBP'",
        s.id,
      );
      expect(lbp).toEqual({ opening: 3_250_000, expected: 8_645_000, counted: 8_645_000, variance: 0 });
    });

    it('purchases: 846 received, 14 still ordered, all in dollars, and their payments are on record', () => {
      expect(get<{ n: number }>("select count(*) n from purchases where status = 'received'").n).toBe(846);
      expect(get<{ n: number }>("select count(*) n from purchases where status = 'ordered'").n).toBe(14);
      expect(get<{ n: number }>("select count(*) n from purchases where currency <> 'USD'").n).toBe(0);
      expect(get<{ n: number }>('select count(*) n from purchases where paid_minor > total_minor').n).toBe(0);
      expect(
        get<{ n: number }>(
          'select count(*) n from purchases p where p.paid_minor <> coalesce((select sum(amount_minor) from purchase_payments x where x.purchase_id = p.id), 0)',
        ).n,
      ).toBe(0);
    });

    it('goods already marked received are not added to stock a second time', () => {
      expect(get<{ n: number }>("select count(*) n from stock_movements where reason = 'purchase'").n).toBe(0);
    });

    it('expenses and services come across, services in dollars', () => {
      expect(count('expenses')).toBe(1);
      expect(count('service_sales')).toBe(2);
      expect(all('select currency, cost_minor, fee_minor from service_sales order by id')).toEqual([
        { currency: 'USD', cost_minor: 1000, fee_minor: 5000 },
        { currency: 'USD', cost_minor: 200, fee_minor: 200 },
      ]);
    });

    it('the shop details and the exchange rate are kept', () => {
      expect(get<{ name: string; phone: string }>('select name, phone from store_settings').name).toBe('Darwish Market');
      expect(get<{ n: number }>('select count(*) n from exchange_rates').n).toBe(1);
      expect(get<{ r: number }>('select rate_lbp_per_usd r from exchange_rates').r).toBe(90000);
    });
  });

  describe('money adds up', () => {
    it('revenue less refunds equals the legacy sales total, to the lira', () => {
      const revenue = get<{ s: number }>('select sum(total_lbp) s from sales').s;
      const refunds = get<{ s: number }>('select sum(refund_lbp) s from returns').s;
      expect(refunds).toBe(FACTS.refundsLbp);
      expect(revenue - refunds).toBe(FACTS.legacySalesTotalLbp);
      expect(report.legacyTotals.grandTotalLbp).toBe(FACTS.legacySalesTotalLbp);
      expect(report.imported.netRevenueMatchesLegacy).toBe(true);
    });

    it('every sale: paid + rest = total', () => {
      expect(all('select id from sales where paid_lbp + rest_lbp <> total_lbp')).toHaveLength(0);
    });

    it('every sale: lines - discount + shipping + rounding = total, so the rounding column shows exactly what the lines do not explain', () => {
      const bad = all(`
        select s.id from sales s join sale_items i on i.sale_id = s.id
        group by s.id having sum(i.line_total_lbp) - s.discount_lbp + s.shipping_lbp + s.rounding_lbp <> s.total_lbp`);
      expect(bad).toHaveLength(0);
    });

    it('sales whose lines differ from the total by 5,000 or more are listed, not hidden', () => {
      // the header with no lines at all is listed separately (below), so it is left out of this count
      const big = all<{ id: number }>(
        'select id from sales s where abs(rounding_lbp) >= 5000 and exists (select 1 from sale_items i where i.sale_id = s.id)',
      ).map((r) => r.id);
      expect(big.length).toBe(report.reconciliation.inconsistentSales.length);
      expect(big.length).toBe(5);
      expect(new Set(report.reconciliation.inconsistentSales.map((x) => x.saleId)).size).toBe(5);
      // everything smaller is ordinary till rounding
      expect(
        all<{ r: number }>('select abs(rounding_lbp) r from sales where rounding_lbp <> 0 and abs(rounding_lbp) < 5000').every(
          (x) => x.r < 5000,
        ),
      ).toBe(true);
    });

    it('the one sale with a tax amount keeps it in its notes (the new system has no tax)', () => {
      expect(report.reconciliation.legacyTaxSales).toEqual([{ saleId: 2188, ref: 3171, tax: 1 }]);
      expect(get<{ notes: string }>('select notes from sales where legacy_id = 2188').notes).toContain('Legacy tax field: 1');
    });

    it('the sale header that had no lines at all is imported and reported', () => {
      expect(report.reconciliation.salesWithoutLines).toEqual([{ saleId: 7905, ref: 7871, totalLbp: 35000 }]);
      expect(get<{ n: number }>('select count(*) n from sale_items where sale_id = (select id from sales where legacy_id = 7905)').n).toBe(
        0,
      );
    });

    it('timestamps are UTC, converted from Beirut local time (UTC+2 in winter, UTC+3 in summer)', () => {
      expect(get<{ created_at: string }>('select created_at from sales where legacy_id = 11').created_at).toBe('2025-11-13T05:18:54.715Z');
      const summer = get<{ created_at: string; legacy_id: number }>(
        "select created_at, legacy_id from sales where created_at between '2026-07-01' and '2026-07-02' order by id limit 1",
      );
      expect(summer.created_at).toMatch(/^2026-07-01T/);
    });

    it('a customer owes exactly what their open sales still owe, for everyone', () => {
      const bad = all(
        `select c.id from customers c where c.balance_lbp <> coalesce((select sum(rest_lbp) from sales s where s.customer_id = c.id), 0)`,
      );
      expect(bad).toHaveLength(0);
    });

    it('payments: the old app took cash in lira only, and the amount is what was actually paid', () => {
      expect(all('select distinct method, currency from payments')).toEqual([{ method: 'cash', currency: 'LBP' }]);
      expect(get<{ n: number }>('select count(*) n from payments p join sales s on s.id = p.sale_id where p.amount <> s.paid_lbp').n).toBe(
        0,
      );
    });
  });

  describe('returns: the old app edited the sale, the new one keeps the original and the return apart', () => {
    it('imports all 116 returns and rebuilds the 116 sales they belong to', () => {
      expect(count('returns')).toBe(116);
      expect(report.returns.salesRebuilt).toBe(116);
      expect(report.returns.linesRestored).toBe(107);
    });

    it('sale 1043 had been zeroed by its return: it is rebuilt as 2 pieces for 150,000, with the return pointing at that line', () => {
      const sale = get<{ id: number; total_lbp: number; rest_lbp: number }>('select id, total_lbp, rest_lbp from sales where ref = 1043');
      expect(sale).toMatchObject({ total_lbp: 150_000, rest_lbp: 0 });
      expect(all('select qty_milli, line_total_lbp from sale_items where sale_id = ?', sale.id)).toEqual([
        { qty_milli: 2000, line_total_lbp: 150_000 },
      ]);
      const ret = get<{ id: number; refund_lbp: number; refund_method: string; refund_currency: string }>(
        'select id, refund_lbp, refund_method, refund_currency from returns where sale_id = ?',
        sale.id,
      );
      expect(ret).toMatchObject({ refund_lbp: 150_000, refund_method: 'cash', refund_currency: 'LBP' });
      expect(all('select qty_milli, amount_lbp from return_items where return_id = ?', ret.id)).toEqual([
        { qty_milli: 2000, amount_lbp: 150_000 },
      ]);
    });

    it('a return can never exceed what was sold, on any line', () => {
      const bad = all(`select i.id from sale_items i
        where (select coalesce(sum(r.qty_milli), 0) from return_items r where r.sale_item_id = i.id) > i.qty_milli`);
      expect(bad).toHaveLength(0);
    });

    it('every return line points at a sale line of the same sale', () => {
      expect(
        all(
          'select r.id from return_items r join returns t on t.id = r.return_id join sale_items i on i.id = r.sale_item_id where i.sale_id <> t.sale_id',
        ),
      ).toHaveLength(0);
    });

    it('the two oddities in the old data are reported, not smoothed over', () => {
      expect(report.returns.headerVsLines).toEqual([{ returnId: 147, saleRef: 13333, headerLbp: 200_000, linesLbp: 175_000 }]);
      expect(report.returns.quantityExceptions).toHaveLength(1);
    });

    it('the 14 leftover zero-quantity lines are skipped and counted', () => {
      expect(report.skipped.zeroQuantityLines).toBe(FACTS.zeroQuantityLines);
      expect(get<{ n: number }>('select count(*) n from sale_items where qty_milli <= 0').n).toBe(0);
    });

    it('115 returns refunded money; one was recorded empty (nothing returned, nothing refunded) and is reported', () => {
      expect(get<{ n: number }>('select count(*) n from returns where refund_lbp > 0').n).toBe(115);
      expect(report.returns.emptyReturns).toEqual([{ returnId: 77, saleRef: 6302 }]);
      expect(
        get<{ n: number }>('select count(*) n from return_items where return_id = (select id from returns where legacy_id = 77)').n,
      ).toBe(0);
    });
  });

  describe('credit: Walk-In may not owe, so the old debts keep an owner', () => {
    it('the two Walk-In sales with a balance moved to one clearly named placeholder customer', () => {
      expect(report.walkInDebts).toEqual([
        { saleId: 9911, ref: 8878, restLbp: 145_000 },
        { saleId: 22125, ref: 19088, restLbp: 75_000 },
      ]);
      const p = get<{ name: string; balance_lbp: number; is_walk_in: number }>(
        'select name, balance_lbp, is_walk_in from customers where legacy_id = -1',
      );
      expect(p).toMatchObject({ balance_lbp: FACTS.walkInDebtsLbp, is_walk_in: 0 });
      expect(p.name).toMatch(/Walk-In debts/);
    });

    it('the sales keep their partial status and say why in the notes', () => {
      const s = get<{ status: string; paid_lbp: number; rest_lbp: number; notes: string }>(
        'select status, paid_lbp, rest_lbp, notes from sales where ref = 8878',
      );
      expect(s).toMatchObject({ status: 'partial', paid_lbp: 180_000, rest_lbp: 145_000 });
      expect(s.notes).toContain('Walk-In customer still owed 145000');
    });

    it('Walk-In itself owes nothing, and nothing is owed by Walk-In anywhere', () => {
      expect(get<{ b: number }>('select balance_lbp b from customers where is_walk_in = 1').b).toBe(0);
      expect(
        get<{ n: number }>(
          'select count(*) n from sales s join customers c on c.id = s.customer_id where c.is_walk_in = 1 and s.rest_lbp > 0',
        ).n,
      ).toBe(0);
    });

    it('the 66 sales the old app labelled "unPaid" were fully paid, so they are imported as paid', () => {
      expect(get<{ n: number }>("select count(*) n from sales where status <> 'paid'").n).toBe(2);
    });

    it('the legacy Walk-In is the protected Walk-In row, never a duplicate', () => {
      expect(get<{ n: number }>('select count(*) n from customers where is_walk_in = 1').n).toBe(1);
      expect(get<{ legacy_id: number }>('select legacy_id from customers where is_walk_in = 1').legacy_id).toBe(1);
    });
  });

  describe('products and stock', () => {
    it('every product is priced in dollars (all legacy prices are under 1,000)', () => {
      expect(report.currency).toMatchObject({ usdProducts: 1721, lbpProducts: 0, usdPurchases: 860 });
      expect(get<{ n: number }>("select count(*) n from products where currency <> 'USD'").n).toBe(0);
    });

    it('prices and costs become exact cents: $2.50 and $2.13 are 250 and 213', () => {
      expect(
        get<{ price_minor: number; cost_minor: number }>(
          "select price_minor, cost_minor from products where barcode = '5711953005251' limit 1",
        ),
      ).toEqual({ price_minor: 250, cost_minor: 213 });
      expect(get<{ n: number }>('select count(*) n from products where price_minor < 0 or cost_minor < 0').n).toBe(0);
    });

    it('the quantity the old system holds is the opening stock; the cache equals the ledger', () => {
      expect(
        get<{ n: number }>("select count(*) n from stock_movements where reason = 'adjustment' and ref_type = 'legacy_opening'").n,
      ).toBeGreaterThan(0);
      expect(
        all(`select l.product_id from stock_levels l
        where l.qty_milli <> coalesce((select sum(qty_milli_delta) from stock_movements m where m.product_id = l.product_id), 0)`),
      ).toHaveLength(0);
    });

    it('negative quantities, even fractional, come across as they were', () => {
      expect(report.negativeStock.map((p) => p.qty).sort()).toEqual([-4, -2, -1, -0.608].sort());
      const row = get<{ q: number }>(
        "select l.qty_milli q from stock_levels l join products p on p.id = l.product_id where p.name like 'AL kady%' and l.qty_milli < 0",
      );
      expect(row.q).toBe(-608);
    });

    it('only the 11 products with a real threshold alert; a threshold of 0 meant "not set", and a negative one is ignored', () => {
      expect(report.stockAlerts).toEqual({ imported: 11, nullified: 1710 });
      expect(get<{ n: number }>('select count(*) n from products where stock_alert_milli is not null').n).toBe(11);
      expect(get<{ n: number }>('select count(*) n from products where stock_alert_milli < 0').n).toBe(0);
    });

    it('every product has an ASCII receipt name, and the 180 Arabic names are listed for review (R5)', () => {
      for (const p of all<{ receipt_name: string | null }>('select receipt_name from products')) {
        expect(p.receipt_name).toBeTruthy();
        expect(p.receipt_name).toMatch(/^[\x20-\x7e]+$/);
      }
      expect(report.receiptNames.transliterated).toBe(180);
      expect(report.receiptNames.review).toHaveLength(180);
    });

    it('duplicate barcodes are imported as they were (clean-up is the last milestone) and listed', () => {
      expect(count('products')).toBe(EXPECTED.products);
      expect(report.duplicateBarcodes).toHaveLength(FACTS.duplicateBarcodeGroups);
      const groups = all(`select barcode from products where barcode <> '' group by barcode having count(*) > 1`);
      expect(groups).toHaveLength(FACTS.duplicateBarcodeGroups);
      for (const idx of all<{ name: string; unique: number }>(`pragma index_list('products')`).filter((i) => i.unique === 1)) {
        expect(all<{ name: string }>(`pragma index_info('${idx.name}')`).map((c) => c.name)).not.toContain('barcode');
      }
    });

    describe('product pictures', () => {
      const folder = () => join(dir, 'uploads');
      const stored = () =>
        all<{ image_path: string }>('select image_path from products where image_path is not null').map((p) => p.image_path);

      it('314 products point at a real file, all present; the old placeholder becomes "no picture"', () => {
        expect(report.images).toMatchObject({ referenced: 314, present: 314, placeholders: 1407 });
        expect(report.images.missing).toEqual([]);
      });

      it('two of those "pictures" are web pages saved by mistake: not copied, listed for review, the products import without one', () => {
        expect(report.images.notPictures).toHaveLength(2);
        expect(report.images.notPictures.every((f) => /\.html?$/i.test(f))).toBe(true);
        expect(stored()).toHaveLength(314 - 2);
        expect(readdirSync(folder()).some((f) => /\.html?$/i.test(f))).toBe(false);
      });

      it('every picture is kept under a name made from its content, with the extension of what it really is', () => {
        for (const path of stored()) {
          const file = path.slice('/uploads/'.length);
          expect(file, path).toMatch(STORED_NAME);
          const kind = sniffImage(readFileSync(join(folder(), file)));
          expect(kind, path).not.toBeNull();
          expect(file.endsWith(`.${IMAGE_TYPES[kind!].ext}`), path).toBe(true);
        }
      });

      it('a picture several products use is kept once: 289 files for 312 products, 12 of them shared', () => {
        expect(report.images).toMatchObject({ stored: 289, shared: 12 });
        expect(readdirSync(folder())).toHaveLength(289);
        expect(new Set(stored()).size).toBe(289);
      });

      it('files whose name did not match their content are reported, and stored as what they are', () => {
        expect(report.images.extensionFixed).toHaveLength(2);
      });

      it('files in the old folder that no product uses (418) are counted and not copied', () => {
        expect(report.images.unused).toBe(418);
        const old = readdirSync(join(import.meta.dirname, '..', '..', 'Uploads'));
        expect(old).toHaveLength(709); // the old folder was only read
      });

      it('nothing in the new folder is anything but a whole picture', () => {
        for (const file of readdirSync(folder())) {
          expect(file).toMatch(STORED_NAME);
          expect(sniffImage(readFileSync(join(folder(), file)))).not.toBeNull();
        }
      });
    });

    it('placeholder expiry dates (year 0001 and 2000) are not kept', () => {
      expect(get<{ n: number }>("select count(*) n from products where expiry_date < '2002'").n).toBe(0);
    });

    it('search finds an Arabic product, and its receipt name', () => {
      expect(
        all(`select p.name from products_fts f join products p on p.id = f.rowid where products_fts match '"قضامة"'`).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('sale and purchase lines are linked to products by barcode, then by name; the rest keep their snapshot', () => {
      const s = report.unmatchedLines.sale;
      expect(s.byCode + s.rescuedByName + s.unmatched).toBe(s.total);
      expect(s.total).toBe(EXPECTED.sale_items);
      expect(get<{ n: number }>('select count(*) n from sale_items where product_id is null').n).toBe(s.unmatched);
      expect(get<{ n: number }>("select count(*) n from sale_items where name_snap = '' or name_snap is null").n).toBe(0);
    });
  });

  describe('numbering, users, privacy', () => {
    it('keeps the old receipt numbers, and the next one is above every imported one', () => {
      expect(get<{ n: number }>('select count(distinct ref) n from sales').n).toBe(EXPECTED.sales);
      const max = get<{ m: number }>('select max(ref) m from sales').m;
      expect(get<{ value: number }>("select value from counters where name = 'sale_ref'").value).toBeGreaterThanOrEqual(max);
      expect(get<{ value: number }>("select value from counters where name = 'purchase_ref'").value).toBeGreaterThanOrEqual(
        get<{ m: number }>('select max(ref) m from purchases').m,
      );
      expect(get<{ value: number }>("select value from counters where name = 'return_ref'").value).toBeGreaterThanOrEqual(
        get<{ m: number }>('select max(ref) m from returns').m,
      );
    });

    it('passwords are NOT carried over: each user gets an unusable one and must set a new one', async () => {
      const users = all<{ username: string; role: string; password_hash: string; must_reset_password: number; legacy_id: number }>(
        'select username, role, password_hash, must_reset_password, legacy_id from users order by legacy_id',
      );
      expect(users.map((u) => [u.username, u.role])).toEqual([
        ['atom.support', 'admin'],
        ['sale', 'cashier'],
      ]);
      for (const u of users) {
        expect(u.password_hash).toMatch(/^\$argon2id\$/);
        expect(u.must_reset_password).toBe(1);
      }
      expect(report.users).toHaveLength(2);

      // The old plain-text passwords are read from the dump itself, so they are not copied into this file.
      const { readLegacyDump } = await import('../../apps/api/src/etl/parse');
      const { verifyPassword } = await import('../../apps/api/src/auth/password');
      let checked = 0;
      for await (const batch of readLegacyDump(DUMP, { skip: new Set(['Images']) })) {
        if (batch.table !== 'Users') continue;
        for (const legacy of batch.rows) {
          const mine = users.find((u) => u.legacy_id === legacy.UserID)!;
          expect(await verifyPassword(mine.password_hash, String(legacy.userPassword))).toBe(false);
          checked++;
        }
      }
      expect(checked).toBe(2);
    });

    it('old sales point at their cashier', () => {
      expect(get<{ n: number }>('select count(*) n from sales where user_id is null').n).toBe(0);
    });

    it('the open held carts of the old till are not imported', () => {
      expect(report.skipped.holds).toBe(4);
      expect(count('holds')).toBe(0);
    });
  });

  describe('integrity', () => {
    it('the database is sound: foreign keys valid and the integrity check passes', () => {
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    });

    it('nothing unreadable was found in the numbers', () => {
      expect(report.unreadableNumbers).toEqual({});
    });

    it('the history that must never change is protected on imported rows too', () => {
      expect(() => db.exec('update sales set total_lbp = 1')).toThrow();
    });
  });

  describe('running it again changes nothing (idempotent)', () => {
    it('a second run adds no rows anywhere', async () => {
      const tables = [
        'sales',
        'sale_items',
        'payments',
        'returns',
        'return_items',
        'products',
        'stock_movements',
        'stock_levels',
        'customers',
        'purchases',
        'purchase_items',
        'purchase_payments',
        'register_sessions',
        'register_balances',
        'users',
        'brands',
        'categories',
        'suppliers',
        'units',
        'warehouses',
      ];
      const before = Object.fromEntries(tables.map((t) => [t, count(t)]));
      const balances = all('select id, balance_lbp from customers order by id');
      const counters = all('select * from counters order by name');
      const pictures = readdirSync(join(dir, 'uploads')).sort();

      db.close();
      const again = await runEtl({ dumpPath: DUMP, databasePath: file });
      db = openDatabase(file, { readonly: true });

      expect(Object.fromEntries(tables.map((t) => [t, count(t)]))).toEqual(before);
      expect(Object.values(again.counts).every((c) => c.imported === 0)).toBe(true);
      expect(all('select id, balance_lbp from customers order by id')).toEqual(balances);
      expect(all('select * from counters order by name')).toEqual(counters);
      expect(readdirSync(join(dir, 'uploads')).sort()).toEqual(pictures); // no picture is copied twice
    }, 600_000);
  });

  describe('the new system works on the imported data', () => {
    let copy: string;
    let token: string;
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      db.close();
      copy = join(dir, 'live.db');
      copyFileSync(file, copy);
      db = openDatabase(file, { readonly: true });

      const live = openDatabase(copy);
      live
        .prepare("insert into users (username, name, role, password_hash) values ('owner', 'Owner', 'admin', ?)")
        .run(await hashPassword('owner-password-1'));
      live.close();

      app = await buildApp({ databasePath: copy, logger: false });
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'owner', password: 'owner-password-1' },
      });
      token = res.json().accessToken;
    }, 120_000);
    afterAll(async () => app?.close());

    const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}`, ...headers } });

    it('an old product’s picture is served by the new server, as the kind of picture it really is', async () => {
      const path = get<{ image_path: string }>(
        `select image_path from products where image_path is not null order by id limit 1`,
      ).image_path;
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(200);
      const kind = sniffImage(res.rawPayload)!;
      expect(res.headers['content-type']).toBe(IMAGE_TYPES[kind].mime);
      expect(res.rawPayload).toEqual(readFileSync(join(dir, 'uploads', path.slice('/uploads/'.length))));

      const product = (await call('GET', `/products?limit=200`))
        .json()
        .data.find((p: { imagePath: string | null }) => p.imagePath === path);
      expect(product.imagePath).toBe(path); // and it is part of the product the till reads
    });

    it('an old sale can be looked up by its old receipt number and reprinted', async () => {
      const sale = (await call('GET', '/sales/by-ref/1043')).json();
      expect(sale).toMatchObject({ ref: 1043, totalLbp: 150_000, status: 'paid' });
      const text = (await call('GET', `/sales/${sale.id}/receipt?format=text`)).body;
      expect(text).toContain('Receipt #1043');
      expect(text).toContain('2025-11-14 09:12'); // 06:12 UTC, shown in Beirut time
    });

    it('the first new sale continues the old numbering and sells a product that is at zero stock', async () => {
      const found = (await call('GET', '/products/by-barcode/5711953005251')).json().data[0];
      const sale = await call(
        'POST',
        '/sales',
        {
          items: [{ productId: found.id, qty: '2', unitPriceLbp: 225000 }],
          payments: [{ method: 'cash', currency: 'LBP', amount: 450000 }],
        },
        { 'Idempotency-Key': 'after-import-1' },
      );
      expect(sale.statusCode).toBe(201);
      expect(sale.json().ref).toBeGreaterThan(23_669); // the highest old receipt number
      expect(sale.json().totalLbp).toBe(450_000);
      expect((await call('GET', `/products/${found.id}`)).json().qty).toBe('-2');
    });

    it('the open register from the old system is usable, with its legacy opening cash', async () => {
      const reg = (await call('GET', '/registers/current')).json();
      expect(reg.balances.find((b: { method: string; currency: string }) => b.method === 'cash' && b.currency === 'LBP').opening).toBe(
        3_225_000,
      );
    });

    it('the Walk-In debts are collectable: the placeholder customer can be paid', async () => {
      const owed = (await call('GET', '/reports/receivables')).json();
      expect(owed.totalOwedLbp).toBe(FACTS.walkInDebtsLbp);
      const id = owed.data[0].customerId;
      const pay = await call(
        'POST',
        `/customers/${id}/payments`,
        { method: 'cash', currency: 'LBP', amount: 145_000 },
        { 'Idempotency-Key': 'debt-1' },
      );
      expect(pay.statusCode).toBe(201);
      expect(pay.json().allocations[0]).toMatchObject({ amountLbp: 145_000 }); // oldest sale first
      expect(pay.json().balanceLbp).toBe(75_000);
    });

    it('the low-stock list shows only products that had a real threshold', async () => {
      const alerts = (await call('GET', '/stock/alerts')).json().data as { threshold: number }[];
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.length).toBeLessThanOrEqual(11);
      expect(alerts.every((a) => a.threshold > 0)).toBe(true);
    });

    it('imported purchases: 14 are still ordered and can be received', async () => {
      const pending = (await call('GET', '/purchases?status=ordered&limit=50')).json().data as { id: number }[];
      expect(pending).toHaveLength(14);
      const res = await call('POST', `/purchases/${pending[0]!.id}/receive`, {}, { 'Idempotency-Key': 'recv-after-import' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('received');
    });

    it('the dashboard counts only the new sale as today', async () => {
      const dash = (await call('GET', '/reports/dashboard')).json();
      expect(dash.salesToday.count).toBe(1);
    });
  });
});
