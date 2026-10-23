import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { toReceiptName } from '@pos/shared';
import { hashPassword } from '../auth/password';
import { migrate } from '../db/migrate';
import { openDatabase, type Db } from '../db/open';
import { seedReference } from '../db/seed';
import { IMAGE_TYPES, storeImage } from '../modules/catalog/images';
import { readLegacyDump, type LegacyRow } from './parse';
import { emptyReport, type EtlReport, type LineMatch } from './report';
import { toUtcIso } from './time';

// Legacy SQL Server dump -> the new SQLite database (docs/01-data-analysis.md section 5).
// Principles: one transaction (all or nothing), idempotent (a re-run adds nothing), and never silently fix anything:
// odd rows are imported as faithfully as the new rules allow and listed in the report.

export type EtlOptions = {
  dumpPath: string;
  databasePath: string;
  /** Folder with the legacy product pictures. Defaults to ./Uploads beside the dump. It is only read, never changed. */
  uploadsDir?: string;
  /** Where the pictures products use are copied to (the new system's pictures folder). Defaults to ./uploads beside the database. */
  imagesDir?: string;
  /** Write the report here as JSON. */
  reportPath?: string;
  log?: (message: string) => void;
};

type Tables = Record<string, LegacyRow[]>;

// The Images table is 137 MB of binary pictures: skipped without being parsed. The rest are config leftovers.
const SKIP = new Set(['Images', '__EFMigrationsHistory', 'Durations', 'ProductStatistics']);

/** The legacy pictures folder (read only), where pictures go, and what has been seen on the way. */
type Pictures = {
  sourceDir: string;
  names: Set<string> | null;
  destDir: string;
  /** stored file → how many products use it */
  uses: Map<string, number>;
  referencedNames: Set<string>;
};

/** Are these two paths the same folder on disk (whatever capital letters or ".." they were written with)? */
function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false; // one of them does not exist yet, so it cannot be the other
  }
}

// ------------------------------------------------------------------ value helpers

const str = (v: unknown) => String(v ?? '').trim();
const collapse = (v: unknown) => str(v).replace(/\s+/g, ' ');
const lower = (v: unknown) => collapse(v).toLowerCase();
const orNull = (v: unknown) => str(v) || null;
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

/** Read a number the legacy app stored as text. Unreadable text is counted in the report and taken as zero. */
function numberReader(report: EtlReport) {
  return (v: unknown, what: string): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const text = str(v).replace(/,/g, '');
    if (text === '') return 0;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
    report.unreadableNumbers[what] = (report.unreadableNumbers[what] ?? 0) + 1;
    return 0;
  };
}
const lbp = (n: number) => Math.round(n);
const cents = (n: number) => Math.round(Number((n * 100).toFixed(6))); // 1.005 * 100 is 100.49999..., so settle it first
const milli = (n: number) => Math.round(Number((n * 1000).toFixed(6)));

function slug(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return s.length >= 3 ? s.slice(0, 32) : fallback;
}

async function loadDump(path: string): Promise<Tables> {
  const tables: Tables = {};
  for await (const batch of readLegacyDump(path, { skip: SKIP })) (tables[batch.table] ??= []).push(...batch.rows);
  return tables;
}

// ------------------------------------------------------------------ main

export async function runEtl(options: EtlOptions): Promise<EtlReport> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const report = emptyReport(options.dumpPath);

  migrate(options.databasePath);
  log('reading the dump');
  const T = await loadDump(options.dumpPath);
  for (const need of ['Products', 'Sales', 'SaleProducts'])
    if (!T[need]?.length) throw new Error(`The dump has no ${need}: is this the right file?`);
  log(
    `read ${Object.entries(T)
      .map(([k, v]) => `${k}:${v.length}`)
      .join(' ')}`,
  );

  // Hashing is async and a SQLite transaction is not, so every password is prepared first.
  // Legacy passwords were stored in plain text and are deliberately NOT carried over: each user gets an unusable one
  // and an admin sets a new one (see the report).
  const userHashes = new Map<number, string>();
  for (const u of T.Users ?? []) userHashes.set(Number(u.UserID), await hashPassword(randomBytes(32).toString('hex')));

  const uploadsDir = options.uploadsDir ?? join(dirname(options.dumpPath), 'Uploads');
  const imagesDir = options.imagesDir ?? join(dirname(options.databasePath), 'uploads');
  // On Windows "Uploads" and "uploads" are one folder. Copying the pictures into the folder they are read from would change the
  // old folder and count the import's own output as input, so refuse before anything is touched.
  if (sameFolder(uploadsDir, imagesDir))
    throw new Error(
      `The new pictures folder (${resolve(imagesDir)}) is the same folder as the old Uploads folder (${resolve(uploadsDir)}). ` +
        'Choose another one with --images, or keep the database somewhere else.',
    );
  const pictures: Pictures = {
    sourceDir: uploadsDir,
    names: existsSync(uploadsDir) ? new Set(readdirSync(uploadsDir)) : null,
    destDir: imagesDir,
    uses: new Map(),
    referencedNames: new Set(),
  };

  const db = openDatabase(options.databasePath);
  try {
    seedReference(db);
    db.transaction(() => importAll(db, T, report, userHashes, pictures, log)).immediate();
  } finally {
    db.close();
  }

  report.images.stored = pictures.uses.size;
  report.images.shared = [...pictures.uses.values()].filter((n) => n > 1).length;
  report.images.unused = pictures.names ? [...pictures.names].filter((f) => !pictures.referencedNames.has(f)).length : 0;

  report.finishedAt = new Date().toISOString();
  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  if (options.reportPath) writeFileSync(options.reportPath, JSON.stringify(report, null, 2));
  return report;
}

function importAll(db: Db, T: Tables, report: EtlReport, userHashes: Map<number, string>, pictures: Pictures, log: (m: string) => void) {
  const n = numberReader(report);
  const count = (name: string) => (report.counts[name] ??= { legacy: 0, imported: 0, existing: 0 });
  const legacyMap = (table: string) =>
    new Map(
      (db.prepare(`SELECT legacy_id, id FROM ${table} WHERE legacy_id IS NOT NULL`).all() as { legacy_id: number; id: number }[]).map(
        (r) => [r.legacy_id, r.id],
      ),
    );

  /** Insert each legacy row that is not already there. A re-run finds them all and adds nothing. */
  function importRows(
    label: string,
    rows: LegacyRow[] | undefined,
    idField: string,
    map: Map<number, number>,
    insert: (r: LegacyRow) => number | null,
  ) {
    const c = count(label);
    for (const r of rows ?? []) {
      c.legacy++;
      const legacyId = Number(r[idField]);
      if (map.has(legacyId)) {
        c.existing++;
        continue;
      }
      const id = insert(r);
      if (id === null) continue; // refused and already reported
      map.set(legacyId, id);
      c.imported++;
    }
  }

  const defaultWarehouse = (db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get() as { id: number }).id;
  const walkInId = (db.prepare('SELECT id FROM customers WHERE is_walk_in = 1').get() as { id: number }).id;
  const lbpRounding = (db.prepare('SELECT lbp_rounding AS r FROM store_settings WHERE id = 1').get() as { r: number }).r;
  const currentRate = (
    db.prepare('SELECT rate_lbp_per_usd AS r FROM exchange_rates ORDER BY effective_from DESC, id DESC LIMIT 1').get() as { r: number }
  ).r;

  // ---------------------------------------------------------------- settings and rate
  const settings = T.Settings?.[0];
  if (settings) {
    db.prepare(
      'UPDATE store_settings SET name = COALESCE(?, name), address = COALESCE(?, address), phone = COALESCE(?, phone), email = COALESCE(?, email) WHERE id = 1',
    ).run(orNull(settings.companyName), orNull(settings.companyAddress), orNull(settings.companyPhone), orNull(settings.companyEmail));
  }
  const legacyRate = lbp(n(T.Exchanges?.[0]?.Rate, 'Exchanges.Rate'));
  report.exchangeRate.legacy = legacyRate;
  if (legacyRate > 0 && legacyRate !== currentRate) {
    db.prepare('INSERT INTO exchange_rates (rate_lbp_per_usd, effective_from) VALUES (?, ?)').run(legacyRate, new Date().toISOString());
    report.exchangeRate.action = `added ${legacyRate} (the new system had ${currentRate})`;
  } else report.exchangeRate.action = legacyRate > 0 ? `unchanged: ${legacyRate}` : 'no rate in the dump';
  const rate = legacyRate > 0 ? legacyRate : currentRate;

  // ---------------------------------------------------------------- lookups
  const matchByName = (table: string, nameCol: string) =>
    db.prepare(`SELECT id, legacy_id FROM ${table} WHERE lower(trim(${nameCol})) = ? LIMIT 1`);

  // Warehouse: the seeded "Main Stock" is the legacy "Main Stock".
  const warehouses = legacyMap('warehouses');
  importRows('warehouses', T.Warehouses, 'WarehouseID', warehouses, (r) => {
    const same = matchByName('warehouses', 'name').get(lower(r.warehouseName)) as { id: number; legacy_id: number | null } | undefined;
    if (same) {
      if (same.legacy_id === null) db.prepare('UPDATE warehouses SET legacy_id = ? WHERE id = ?').run(Number(r.WarehouseID), same.id);
      return same.id;
    }
    return Number(
      db
        .prepare('INSERT INTO warehouses (name, address, phone, email, legacy_id) VALUES (?, ?, ?, ?, ?)')
        .run(
          collapse(r.warehouseName),
          orNull(r.warehouseAddress),
          orNull(r.warehousePhone),
          orNull(r.warehouseEmail),
          Number(r.WarehouseID),
        ).lastInsertRowid,
    );
  });

  const brands = legacyMap('brands');
  importRows('brands', T.Brands, 'BrandID', brands, (r) =>
    Number(
      db.prepare('INSERT INTO brands (name, legacy_id) VALUES (?, ?)').run(collapse(r.brandName) || '(no name)', Number(r.BrandID))
        .lastInsertRowid,
    ),
  );
  const categories = legacyMap('categories');
  importRows('categories', T.Categorys, 'CategoryID', categories, (r) =>
    Number(
      db
        .prepare('INSERT INTO categories (name, legacy_id) VALUES (?, ?)')
        .run(collapse(r.categoryName) || '(no name)', Number(r.CategoryID)).lastInsertRowid,
    ),
  );

  // Units: "Piece " is the seeded "Piece". Weighed units can be sold in fractions.
  const units = legacyMap('units');
  importRows('units', T.Units, 'UnitID', units, (r) => {
    const name = collapse(r.unitName);
    const same = matchByName('units', 'name').get(name.toLowerCase()) as { id: number; legacy_id: number | null } | undefined;
    if (same) {
      if (same.legacy_id === null) db.prepare('UPDATE units SET legacy_id = ? WHERE id = ?').run(Number(r.UnitID), same.id);
      return same.id;
    }
    const fractional = /^(kg|kilo|liter|litre)$/i.test(name) ? 1 : 0;
    return Number(
      db.prepare('INSERT INTO units (name, fractional, legacy_id) VALUES (?, ?, ?)').run(name, fractional, Number(r.UnitID))
        .lastInsertRowid,
    );
  });

  const suppliers = legacyMap('suppliers');
  importRows('suppliers', T.Suppliers, 'SupplierID', suppliers, (r) =>
    Number(
      db
        .prepare('INSERT INTO suppliers (name, address, phone, email, legacy_id) VALUES (?, ?, ?, ?, ?)')
        .run(
          collapse(r.supplierName) || '(no name)',
          orNull(r.supplierAddress),
          orNull(r.supplierPhone),
          orNull(r.supplierEmail),
          Number(r.SupplierID),
        ).lastInsertRowid,
    ),
  );

  // Customers: the legacy "Walk-In" is the protected Walk-In row, never a second one.
  const customers = legacyMap('customers');
  importRows('customers', T.Customers, 'CustomerID', customers, (r) => {
    if (lower(r.customerName) === 'walk-in') {
      db.prepare('UPDATE customers SET legacy_id = ? WHERE id = ? AND legacy_id IS NULL').run(Number(r.CustomerID), walkInId);
      return walkInId;
    }
    return Number(
      db
        .prepare('INSERT INTO customers (name, phone, address, email, legacy_id) VALUES (?, ?, ?, ?, ?)')
        .run(
          collapse(r.customerName) || '(no name)',
          orNull(r.customerPhone),
          orNull(r.customerAddress),
          orNull(r.customerEmail),
          Number(r.CustomerID),
        ).lastInsertRowid,
    );
  });

  // Users: no passwords are carried over (they were plain text). Each user must be given a new one by an admin.
  const users = legacyMap('users');
  const takenNames = new Set((db.prepare('SELECT lower(username) AS u FROM users').all() as { u: string }[]).map((r) => r.u));
  importRows('users', T.Users, 'UserID', users, (r) => {
    const id = Number(r.UserID);
    let username = slug(str(r.userName), `user${id}`);
    for (let k = 2; takenNames.has(username); k++) username = `${username.slice(0, 28)}${k}`;
    takenNames.add(username);
    const role = lower(r.userType) === 'admin' ? 'admin' : 'cashier';
    const newId = Number(
      db
        .prepare(
          'INSERT INTO users (username, name, role, password_hash, phone, email, must_reset_password, legacy_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        )
        .run(username, collapse(r.userName) || username, role, userHashes.get(id)!, orNull(r.userPhone), orNull(r.userEmail), id)
        .lastInsertRowid,
    );
    report.users.push({
      legacyId: id,
      username,
      role,
      note: 'the old password was not carried over: an admin must set a new one (PATCH /users/{id})',
    });
    return newId;
  });

  const expenseCategories = legacyMap('expense_categories');
  importRows('expense_categories', T.ExpenseCategorys, 'ExpenseCategoryID', expenseCategories, (r) =>
    Number(
      db
        .prepare('INSERT INTO expense_categories (name, legacy_id) VALUES (?, ?)')
        .run(collapse(r.expenseCategoryName), Number(r.ExpenseCategoryID)).lastInsertRowid,
    ),
  );
  const serviceCategories = legacyMap('service_categories');
  importRows('service_categories', T.ServiceCategory, 'ServiceCategoryID', serviceCategories, (r) =>
    Number(
      db
        .prepare('INSERT INTO service_categories (name, legacy_id) VALUES (?, ?)')
        .run(collapse(r.ServiceCategoryName), Number(r.ServiceCategoryID)).lastInsertRowid,
    ),
  );

  // ---------------------------------------------------------------- products and opening stock
  const products = legacyMap('products');
  const insertProduct = db.prepare(
    `INSERT INTO products (name, receipt_name, receipt_name_manual, barcode, cost_minor, price_minor, currency, category_id, brand_id, unit_id,
                           supplier_id, stock_alert_milli, expiry_date, image_path, active, legacy_id, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const insertLevel = db.prepare('INSERT OR IGNORE INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)');
  const insertOpening = db.prepare(
    `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, note, created_at)
     VALUES (?, ?, ?, 'adjustment', 'legacy_opening', ?, 'opening stock imported from the legacy system', ?)`,
  );
  const now = new Date().toISOString();
  const maxOf = (values: Iterable<number>) => {
    let m = 0;
    for (const v of values) if (v > m) m = v;
    return m;
  };

  importRows('products', T.Products, 'ProductID', products, (r) => {
    const legacyId = Number(r.ProductID);
    const name = collapse(r.ProductName) || '(unnamed)';
    const receiptName = toReceiptName({ name });
    if (hasArabic(name)) {
      report.receiptNames.transliterated++;
      report.receiptNames.review.push({ name, receiptName });
    }

    // The whole legacy catalog is priced in dollars (every price is under 1,000). A price of 1,000 or more could only be lira.
    const price = n(r.ProductPrice, 'Products.ProductPrice');
    const cost = n(r.ProductCost, 'Products.ProductCost');
    const usd = price < 1000;
    if (usd) report.currency.usdProducts++;
    else report.currency.lbpProducts++;
    const toMinor = (x: number) => Math.max(0, usd ? cents(x) : lbp(x));

    const alert = n(r.StockAlert, 'Products.StockAlert');
    const alertMilli = alert > 0 ? milli(alert) : null; // 0 was the legacy default, meaning "not set"
    if (alertMilli === null) report.stockAlerts.nullified++;
    else report.stockAlerts.imported++;

    const expiry = str(r.expiryDate).slice(0, 10);
    const expiryDate = /^\d{4}-\d{2}-\d{2}$/.test(expiry) && Number(expiry.slice(0, 4)) > 2001 ? expiry : null; // 0001 and 2000 were placeholders

    let imagePath: string | null = null;
    const image = str(r.ProdImage);
    if (image.startsWith('http://localhost:5220/uploads/')) {
      const file = decodeURIComponent(image.slice('http://localhost:5220/uploads/'.length));
      if (file === 'null.png' || file === '') report.images.placeholders++;
      else {
        report.images.referenced++;
        const name = basename(file);
        pictures.referencedNames.add(name);
        if (!pictures.names?.has(name)) report.images.missing.push(file);
        else {
          report.images.present++;
          // Judge the picture by its bytes, not its name, and keep it under a name made from its content.
          const stored = storeImage(pictures.destDir, readFileSync(join(pictures.sourceDir, name)));
          if (!stored) report.images.notPictures.push(file);
          else {
            imagePath = stored.path;
            pictures.uses.set(stored.file, (pictures.uses.get(stored.file) ?? 0) + 1);
            const claimed = extname(name).slice(1).toLowerCase().replace('jfif', 'jpg').replace('jpeg', 'jpg');
            if (claimed !== IMAGE_TYPES[stored.kind].ext) report.images.extensionFixed.push(file);
          }
        }
      }
    } else if (image) report.images.placeholders++; // /static/media/... was the old app's bundled placeholder

    const created = toUtcIso(str(r.PDate), now)!;
    const id = Number(
      insertProduct.run(
        name,
        receiptName,
        str(r.ProductCode),
        toMinor(cost),
        toMinor(price),
        usd ? 'USD' : 'LBP',
        categories.get(Number(r.CategoryID)) ?? null,
        brands.get(Number(r.BrandID)) ?? null,
        units.get(Number(r.UnitID)) ?? null,
        suppliers.get(Number(r.SupplierID)) ?? null,
        alertMilli,
        expiryDate,
        imagePath,
        legacyId,
        created,
        now,
      ).lastInsertRowid,
    );

    // Opening stock: the quantity the legacy system holds now. Zero and negative are kept; stock never blocks a sale.
    const qty = n(r.ProductQuantity, 'Products.ProductQuantity');
    if (qty !== 0) {
      const m = milli(qty);
      insertLevel.run(id, defaultWarehouse, m);
      insertOpening.run(id, defaultWarehouse, m, legacyId, now);
      if (qty < 0) report.negativeStock.push({ legacyId, name, qty });
    }
    return id;
  });

  // Barcode and name indexes over every product (new and already imported), for matching sale and purchase lines.
  const byBarcode = new Map<string, { id: number; name: string }[]>();
  const byName = new Map<string, number>();
  for (const p of db.prepare('SELECT id, name, barcode, legacy_id FROM products ORDER BY id').all() as {
    id: number;
    name: string;
    barcode: string;
    legacy_id: number | null;
  }[]) {
    if (p.barcode) (byBarcode.get(p.barcode) ?? byBarcode.set(p.barcode, []).get(p.barcode)!).push({ id: p.id, name: p.name });
    if (!byName.has(lower(p.name))) byName.set(lower(p.name), p.id);
  }
  for (const [barcode, list] of byBarcode) {
    if (list.length > 1) {
      const legacy = (T.Products ?? [])
        .filter((r) => str(r.ProductCode) === barcode)
        .map((r) => ({ legacyId: Number(r.ProductID), name: collapse(r.ProductName) }));
      report.duplicateBarcodes.push({ barcode, products: legacy });
    }
  }

  /** Link a legacy line to a product: by barcode (the name breaks ties), else by exact name, else leave it unlinked. */
  function matchProduct(code: unknown, name: unknown, stat: LineMatch, unmatchedCodes: Set<string>): number | null {
    stat.total++;
    const list = byBarcode.get(str(code));
    if (list?.length) {
      stat.byCode++;
      return (list.length === 1 ? list[0]! : (list.find((p) => lower(p.name) === lower(name)) ?? list[0]!)).id;
    }
    const byN = byName.get(lower(name));
    if (byN !== undefined) {
      stat.rescuedByName++;
      return byN;
    }
    stat.unmatched++;
    unmatchedCodes.add(str(code));
    return null;
  }

  // ---------------------------------------------------------------- sales (with returns rebuilt)
  const saleLines = new Map<string, LegacyRow[]>();
  for (const l of T.SaleProducts ?? []) {
    const k = str(l.SPreference);
    (saleLines.get(k) ?? saleLines.set(k, []).get(k)!).push(l);
  }
  const saleRefs = new Set((T.Sales ?? []).map((s) => str(s.reference)));
  report.orphans.saleProducts = (T.SaleProducts ?? []).filter((l) => !saleRefs.has(str(l.SPreference))).length;

  type ReturnedLine = { qty: number; rqty: number; rsubtotal: number };
  const returnByRef = new Map<string, { row: LegacyRow; items: Record<string, unknown>[] }>();
  const returnedLines = new Map<number, ReturnedLine>(); // by legacy sale-line id
  for (const r of T.SaleReturn ?? []) {
    const items = JSON.parse(str(r.rslist) || '[]') as Record<string, unknown>[];
    returnByRef.set(str(r.rsreference), { row: r, items });
    for (const it of items)
      returnedLines.set(Number(it.id), {
        qty: n(it.qty, 'SaleReturn.qty'),
        rqty: n(it.rqty, 'SaleReturn.rqty'),
        rsubtotal: n(it.rsubtotal, 'SaleReturn.rsubtotal'),
      });
  }

  const sales = legacyMap('sales');
  const usedRefs = new Set((db.prepare('SELECT ref FROM sales').all() as { ref: number }[]).map((r) => r.ref));
  let maxRef = maxOf(usedRefs);
  const saleUnmatched = new Set<string>();

  // Two sales had an unpaid balance for a Walk-In customer. The new system does not allow Walk-In to owe money, so the
  // debt is kept on one clearly named placeholder customer that the owner can settle or rename.
  let debtCustomer: number | null = null;
  const debtCustomerId = () =>
    (debtCustomer ??= Number(
      (db.prepare(`SELECT id FROM customers WHERE legacy_id = -1`).get() as { id: number } | undefined)?.id ??
        db
          .prepare(
            `INSERT INTO customers (name, address, legacy_id) VALUES ('Walk-In debts (from the old system)', 'Placeholder for unpaid balances that had no customer', -1)`,
          )
          .run().lastInsertRowid,
    ));

  const insertSale = db.prepare(
    `INSERT INTO sales (ref, session_id, user_id, customer_id, warehouse_id, rate_lbp_per_usd, subtotal_lbp, discount_lbp, shipping_lbp, rounding_lbp, total_lbp,
                        paid_lbp, change_lbp, rest_lbp, profit_lbp, status, notes, legacy_id, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.prepare(
    `INSERT INTO sale_items (sale_id, product_id, name_snap, receipt_name_snap, barcode_snap, brand_snap, unit_snap, qty_milli, unit_price_lbp, unit_cost_lbp, line_total_lbp, legacy_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPayment = db.prepare(
    'INSERT INTO payments (sale_id, method, currency, amount, rate_snap, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const saleCount = count('sales');
  let runRevenue = 0;
  let runRefunds = 0;
  let runLegacyNet = 0;
  const newSaleIds = new Set<number>();

  for (const s of T.Sales ?? []) {
    saleCount.legacy++;
    const legacyId = Number(s.SaleID);
    const legacyTotal = lbp(n(s.grandTotal, 'Sales.grandTotal'));
    report.legacyTotals.saleCount++;
    report.legacyTotals.grandTotalLbp += legacyTotal;
    if (sales.has(legacyId)) {
      saleCount.existing++;
      continue;
    }

    const reference = str(s.reference);
    let ref = Number(reference);
    if (!Number.isInteger(ref) || ref <= 0 || usedRefs.has(ref)) {
      ref = ++maxRef;
      report.notes.push(`sale ${legacyId}: reference "${reference}" was not a usable unique number, so it was numbered ${ref}`);
    }
    usedRefs.add(ref);
    maxRef = Math.max(maxRef, ref);

    const lines = saleLines.get(reference) ?? [];
    const ret = returnByRef.get(reference);
    const refund = ret ? lbp(n(ret.row.returnedsAmount, 'SaleReturn.returnedsAmount')) : 0;

    // The legacy app zeroed a sale when something was returned. The original total is what it was plus what was refunded.
    const total = legacyTotal + refund;
    const rest = Math.min(total, Math.max(0, lbp(n(s.restAmount, 'Sales.restAmount'))));
    const discount = lbp(n(s.discount, 'Sales.discount'));
    const shipping = lbp(n(s.shipping, 'Sales.shipping'));
    const tax = n(s.tax, 'Sales.tax');
    let notes = str(s.notes);
    if (tax !== 0) {
      report.reconciliation.legacyTaxSales.push({ saleId: legacyId, ref, tax });
      notes = `${notes ? `${notes} | ` : ''}Legacy tax field: ${tax}`;
    }

    // Lines, with returned lines restored to the quantity originally sold.
    const items: { legacyId: number; product: number | null; l: LegacyRow; qty: number; price: number; cost: number; total: number }[] = [];
    let returnedProfit = 0;
    for (const l of lines) {
      const spid = Number(l.SPID);
      const back = returnedLines.get(spid);
      const price = lbp(n(l.SPprice, 'SaleProducts.SPprice'));
      const cost = lbp(n(l.SPcost, 'SaleProducts.SPcost'));
      let qty = n(l.SPqty, 'SaleProducts.SPqty');
      let lineTotal = lbp(n(l.SPsubtotal, 'SaleProducts.SPsubtotal'));
      if (back) {
        if (qty + back.rqty !== back.qty) {
          report.returns.quantityExceptions.push({
            saleLineId: spid,
            saleRef: ref,
            soldNow: qty,
            returned: back.rqty,
            originalInReturn: back.qty,
          });
        }
        if (qty <= 0 && back.qty > 0) report.returns.linesRestored++;
        qty = back.qty;
        lineTotal = lbp(back.qty * price);
        if (back.rqty > 0) returnedProfit += lbp(back.rsubtotal) - cost * back.rqty;
      }
      if (!(qty > 0)) {
        report.skipped.zeroQuantityLines++; // a leftover line with nothing sold and no return behind it
        continue;
      }
      items.push({
        legacyId: spid,
        product: matchProduct(l.SPcode, l.SPName, report.unmatchedLines.sale, saleUnmatched),
        l,
        qty,
        price,
        cost,
        total: lineTotal,
      });
    }
    if (ret) report.returns.salesRebuilt++;

    const subtotal = items.reduce((sum, i) => sum + i.total, 0);
    const rounding = total - (subtotal - discount + shipping); // the till rounds to 5,000; anything larger is reported
    if (lines.length === 0) report.reconciliation.salesWithoutLines.push({ saleId: legacyId, ref, totalLbp: total });
    else if (Math.abs(rounding) >= lbpRounding) {
      report.reconciliation.inconsistentSales.push({
        saleId: legacyId,
        ref,
        roundingLbp: rounding,
        linesTotalLbp: subtotal - discount + shipping,
        totalLbp: total,
      });
    }

    // A Walk-In may not owe money here: keep the debt on the placeholder customer.
    let customer = customers.get(Number(s.CustomerID)) ?? walkInId;
    if (customer === walkInId && rest > 0) {
      report.walkInDebts.push({ saleId: legacyId, ref, restLbp: rest });
      notes = `${notes ? `${notes} | ` : ''}Legacy: a Walk-In customer still owed ${rest} LBP on this sale`;
      customer = debtCustomerId();
    }

    const paid = total - rest;
    const status = rest === 0 ? 'paid' : paid === 0 ? 'unpaid' : 'partial';
    const profit = lbp(n(s.profit, 'Sales.profit')) + returnedProfit;
    const saleRate = lbp(n(s.rate, 'Sales.rate')) || rate;
    const created = toUtcIso(str(s.sDate), now)!;
    if (lower(s.paymentType) !== 'cash') report.nonCashSales++;

    const saleId = Number(
      insertSale.run(
        ref,
        users.get(Number(s.UserID)) ?? null,
        customer,
        defaultWarehouse,
        saleRate,
        subtotal,
        discount,
        shipping,
        rounding,
        total,
        paid,
        rest,
        profit,
        status,
        notes,
        legacyId,
        created,
      ).lastInsertRowid,
    );
    newSaleIds.add(saleId);
    for (const i of items) {
      insertItem.run(
        saleId,
        i.product,
        collapse(i.l.SPName),
        toReceiptName({ name: collapse(i.l.SPName) }),
        str(i.l.SPcode),
        collapse(i.l.SPbrand),
        collapse(i.l.SPunit),
        milli(i.qty),
        i.price,
        i.cost,
        i.total,
        i.legacyId,
      );
    }
    if (paid > 0) insertPayment.run(saleId, 'cash', 'LBP', paid, saleRate, created); // the legacy app only ever took cash, in lira

    sales.set(legacyId, saleId);
    saleCount.imported++;
    runRevenue += total;
    runLegacyNet += legacyTotal;
  }

  // ---------------------------------------------------------------- returns (kept as returns, linked to the rebuilt lines)
  const returns = legacyMap('returns');
  const saleIdByRef = new Map((T.Sales ?? []).map((s) => [str(s.reference), Number(s.SaleID)]));
  const lineIdBySpid = db.prepare('SELECT id FROM sale_items WHERE legacy_id = ?');
  const insertReturn = db.prepare(
    `INSERT INTO returns (ref, sale_id, session_id, user_id, reason, refund_lbp, balance_reduced_lbp, refund_method, refund_currency, refund_amount, legacy_id, created_at)
     VALUES (?, ?, NULL, NULL, '', ?, 0, 'cash', 'LBP', ?, ?, ?)`,
  );
  const insertReturnItem = db.prepare('INSERT INTO return_items (return_id, sale_item_id, qty_milli, amount_lbp) VALUES (?, ?, ?, ?)');
  const usedReturnRefs = new Set((db.prepare('SELECT ref FROM returns').all() as { ref: number }[]).map((r) => r.ref));
  let maxReturnRef = maxOf(usedReturnRefs);

  importRows('returns', T.SaleReturn, 'RSaleID', returns, (r) => {
    const saleLegacy = saleIdByRef.get(str(r.rsreference));
    const saleNewId = saleLegacy === undefined ? undefined : sales.get(saleLegacy);
    const items = (returnByRef.get(str(r.rsreference))?.items ?? []).filter((it) => n(it.rqty, 'SaleReturn.rqty') > 0);
    const refund = lbp(n(r.returnedsAmount, 'SaleReturn.returnedsAmount'));
    if (saleNewId === undefined) {
      report.orphans.returnsWithoutSale++;
      report.notes.push(`return ${r.RSaleID} refers to sale ${str(r.rsreference)}, which is not in the dump, so it was not imported`);
      return null;
    }
    let ref = Number(r.RSaleID);
    if (!Number.isInteger(ref) || ref <= 0 || usedReturnRefs.has(ref)) ref = ++maxReturnRef;
    usedReturnRefs.add(ref);
    maxReturnRef = Math.max(maxReturnRef, ref);

    const linesTotal = items.reduce((sum, it) => sum + lbp(n(it.rsubtotal, 'SaleReturn.rsubtotal')), 0);
    if (linesTotal !== refund)
      report.returns.headerVsLines.push({
        returnId: Number(r.RSaleID),
        saleRef: Number(r.rsreference),
        headerLbp: refund,
        linesLbp: linesTotal,
      });
    if (items.length === 0 && refund === 0)
      report.returns.emptyReturns.push({ returnId: Number(r.RSaleID), saleRef: Number(r.rsreference) });

    const id = Number(
      insertReturn.run(ref, saleNewId, refund, refund > 0 ? refund : null, Number(r.RSaleID), toUtcIso(str(r.rsDate), now)).lastInsertRowid,
    );
    for (const it of items) {
      const line = lineIdBySpid.get(Number(it.id)) as { id: number } | undefined;
      if (!line) {
        report.orphans.returnLinesWithoutSaleLine++;
        continue;
      }
      insertReturnItem.run(id, line.id, milli(n(it.rqty, 'SaleReturn.rqty')), lbp(n(it.rsubtotal, 'SaleReturn.rsubtotal')));
    }
    if (newSaleIds.has(saleNewId)) runRefunds += refund;
    return id;
  });

  // Safety net: what was imported must add up to what the legacy system said. Otherwise nothing is saved.
  report.imported.revenueLbp = runRevenue;
  report.imported.refundsLbp = runRefunds;
  report.imported.netRevenueMatchesLegacy = runRevenue - runRefunds === runLegacyNet;
  if (!report.imported.netRevenueMatchesLegacy) {
    throw new Error(
      `Revenue does not reconcile: imported ${runRevenue} less refunds ${runRefunds} is ${runRevenue - runRefunds}, the legacy sales total ${runLegacyNet}. Nothing was saved.`,
    );
  }
  if (report.orphans.returnLinesWithoutSaleLine > 0)
    report.notes.push(`${report.orphans.returnLinesWithoutSaleLine} return lines could not be linked to a sale line`);
  report.unmatchedLines.sale.distinctUnmatchedCodes = saleUnmatched.size;
  report.skipped.holds = T.Holds?.length ?? 0;
  if (report.skipped.holds)
    report.notes.push(`${report.skipped.holds} open held carts from the old till were not imported: they are transient and days old`);

  // ---------------------------------------------------------------- purchases
  const purchases = legacyMap('purchases');
  const usedPurchaseRefs = new Set((db.prepare('SELECT ref FROM purchases').all() as { ref: number }[]).map((r) => r.ref));
  let maxPurchaseRef = maxOf(usedPurchaseRefs);
  const purchaseLines = new Map<string, LegacyRow[]>();
  for (const l of T.PurchaseProducts ?? []) {
    const k = str(l.PurPreference);
    (purchaseLines.get(k) ?? purchaseLines.set(k, []).get(k)!).push(l);
  }
  const purchaseRefs = new Set((T.Purchases ?? []).map((p) => str(p.reference)));
  report.orphans.purchaseProducts = (T.PurchaseProducts ?? []).filter((l) => !purchaseRefs.has(str(l.PurPreference))).length;
  const purchaseUnmatched = new Set<string>();
  const insertPurchase = db.prepare(
    `INSERT INTO purchases (ref, supplier_id, warehouse_id, status, currency, total_minor, paid_minor, payment_type, legacy_id, created_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPurchaseItem = db.prepare(
    'INSERT INTO purchase_items (purchase_id, product_id, name_snap, qty_milli, cost_minor, received_milli, legacy_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertSupplierPayment = db.prepare(
    'INSERT INTO purchase_payments (purchase_id, amount_minor, note, created_at) VALUES (?, ?, ?, ?)',
  );

  importRows('purchases', T.Purchases, 'PurchaseID', purchases, (p) => {
    const reference = str(p.reference);
    let ref = Number(reference);
    if (!Number.isInteger(ref) || ref <= 0 || usedPurchaseRefs.has(ref)) ref = ++maxPurchaseRef;
    usedPurchaseRefs.add(ref);
    maxPurchaseRef = Math.max(maxPurchaseRef, ref);

    // Purchase amounts are small decimals (the largest is 485): dollars.
    const total = n(p.grandTotal, 'Purchases.grandTotal');
    const usd = total < 10000;
    if (usd) report.currency.usdPurchases++;
    else report.currency.lbpPurchases++;
    const minor = (x: number) => Math.max(0, usd ? cents(x) : lbp(x));
    const totalMinor = minor(total);
    const paidMinor = Math.min(totalMinor, minor(n(p.paidAmount, 'Purchases.paidAmount')));
    const received = lower(p.status) === 'received';
    const created = toUtcIso(str(p.PurDate), now)!;

    const id = Number(
      insertPurchase.run(
        ref,
        suppliers.get(Number(p.SupplierID)) ?? null,
        defaultWarehouse,
        received ? 'received' : 'ordered',
        usd ? 'USD' : 'LBP',
        totalMinor,
        paidMinor,
        orNull(p.paymentType),
        Number(p.PurchaseID),
        created,
        received ? created : null,
      ).lastInsertRowid,
    );
    // Goods marked received are already inside the legacy stock quantity, so no stock movement is made for them.
    for (const l of purchaseLines.get(reference) ?? []) {
      const qty = n(l.PurPqty, 'PurchaseProducts.PurPqty');
      if (!(qty > 0)) continue;
      insertPurchaseItem.run(
        id,
        matchProduct(l.PurPcode, l.PurPName, report.unmatchedLines.purchase, purchaseUnmatched),
        collapse(l.PurPName),
        milli(qty),
        minor(n(l.PurPcost, 'PurchaseProducts.PurPcost')),
        received ? milli(qty) : 0,
        Number(l.PurPID),
      );
    }
    if (paidMinor > 0) insertSupplierPayment.run(id, paidMinor, 'imported from the old system', created);
    return id;
  });
  report.unmatchedLines.purchase.distinctUnmatchedCodes = purchaseUnmatched.size;

  // ---------------------------------------------------------------- expenses and services
  importRows('expenses', T.Expenses, 'ExpenseID', legacyMap('expenses'), (r) => {
    const usd = str(r.expenseCurrency).includes('$');
    const amount = n(r.expenseAmount, 'Expenses.expenseAmount');
    return Number(
      db
        .prepare(
          'INSERT INTO expenses (category_id, session_id, title, reference, note, amount_minor, currency, legacy_id, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          expenseCategories.get(Number(r.ExpenseCategoryID)) ?? null,
          collapse(r.expenseTitle),
          str(r.expenseReference),
          orNull(r.expenseNote),
          Math.max(0, usd ? cents(amount) : lbp(amount)),
          usd ? 'USD' : 'LBP',
          Number(r.ExpenseID),
          toUtcIso(str(r.expenseDate), now),
        ).lastInsertRowid,
    );
  });
  importRows('service_sales', T.Services, 'ServiceID', legacyMap('service_sales'), (r) => {
    const usd = str(r.ServiceCurrency).includes('$');
    const minor = (v: unknown, what: string) => (usd ? cents(n(v, what)) : lbp(n(v, what)));
    return Number(
      db
        .prepare(
          'INSERT INTO service_sales (category_id, customer_id, user_id, reference, note, cost_minor, fee_minor, profit_minor, currency, legacy_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          serviceCategories.get(Number(r.ServiceCategoryID)) ?? null,
          customers.get(Number(r.CustomerID)) ?? null,
          users.get(Number(r.UserID)) ?? null,
          str(r.ServiceReference),
          orNull(r.ServiceNote),
          minor(r.ServiceCost, 'Services.ServiceCost'),
          minor(r.ServiceFee, 'Services.ServiceFee'),
          minor(r.Serviceprofit, 'Services.Serviceprofit'),
          usd ? 'USD' : 'LBP',
          Number(r.ServiceID),
          toUtcIso(str(r.ServiceDate), now),
        ).lastInsertRowid,
    );
  });

  // ---------------------------------------------------------------- register history
  // The legacy register recorded cash in hand and a computed closing total, never a physical count. So each closed shift is
  // imported with expected = counted = that total (zero variance), and the open one as an open session.
  const sessions = legacyMap('register_sessions');
  const insertSession = db.prepare(
    'INSERT INTO register_sessions (terminal_id, opened_by, opened_at, closed_by, closed_at, status, legacy_id) VALUES (?, NULL, ?, NULL, ?, ?, ?)',
  );
  const insertBalance = db.prepare(
    'INSERT INTO register_balances (session_id, method, currency, opening, expected, counted, variance) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const methods = (db.prepare('SELECT code FROM payment_methods WHERE active = 1 ORDER BY sort').all() as { code: string }[]).map(
    (m) => m.code,
  );

  function addSession(r: LegacyRow, legacyId: number, closedAt: string | null) {
    const id = Number(
      insertSession.run('T1', toUtcIso(str(r.OpenRegDate), now), closedAt, closedAt ? 'closed' : 'open', legacyId).lastInsertRowid,
    );
    const opening = {
      USD: Math.max(0, cents(n(r.DcashInHand, 'Register.DcashInHand'))),
      LBP: Math.max(0, lbp(n(r.LcashInHand, 'Register.LcashInHand'))),
    };
    const closing = {
      USD: Math.max(0, cents(n(r.DtotalCash, 'Register.DtotalCash'))),
      LBP: Math.max(0, lbp(n(r.LtotalCash, 'Register.LtotalCash'))),
    };
    for (const method of methods) {
      for (const cur of ['USD', 'LBP'] as const) {
        const open = method === 'cash' ? opening[cur] : 0;
        const end = method === 'cash' ? closing[cur] : 0;
        if (closedAt) insertBalance.run(id, method, cur, open, end, end, 0);
        else insertBalance.run(id, method, cur, open, open, null, null);
      }
    }
    return id;
  }

  importRows('register_logs', T.RegisterLogs, 'RegisterLogID', sessions, (r) =>
    addSession(r, Number(r.RegisterLogID), toUtcIso(str(r.CloseRegDate), toUtcIso(str(r.OpenRegDate), now))!),
  );
  report.registers.closedSessions = count('register_logs').imported + count('register_logs').existing;

  const open = T.Register?.[0];
  if (open) {
    const legacyId = -Number(open.RegisterID); // negative: keeps the open row's id apart from the closed shifts' ids
    if (sessions.has(legacyId)) report.registers.openSession = 'already imported';
    else if (db.prepare(`SELECT 1 FROM register_sessions WHERE status = 'open'`).get())
      report.registers.openSession = 'skipped: the new system already has an open register';
    else {
      sessions.set(legacyId, addSession(open, legacyId, null));
      report.registers.openSession = `imported as the open register (opening cash $${n(open.DcashInHand, 'x')} and ${n(open.LcashInHand, 'x')} LBP)`;
      report.registers.note = 'Close or count this register before the first real day on the new system, so a fresh one can be opened.';
    }
  }

  // ---------------------------------------------------------------- finish: counters and balances
  const bump = db.prepare('UPDATE counters SET value = MAX(value, ?) WHERE name = ?');
  bump.run(maxRef, 'sale_ref');
  bump.run(maxReturnRef, 'return_ref');
  bump.run(maxPurchaseRef, 'purchase_ref');
  // A customer owes exactly what their open sales still owe.
  db.prepare('UPDATE customers SET balance_lbp = COALESCE((SELECT SUM(rest_lbp) FROM sales WHERE customer_id = customers.id), 0)').run();

  log(`imported ${count('sales').imported} sales, ${count('products').imported} products`);
}
