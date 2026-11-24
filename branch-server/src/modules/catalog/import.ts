import { parseCsv, parseDecimalMinor, toReceiptName } from '@pos/shared';
import { z } from 'zod';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError } from '../../errors';
import { nowIso } from '../../util/time';
import { writeAudit } from '../audit/service';

// Product import from a spreadsheet's CSV (US-15). Nothing is guessed: every row is checked, a file with any problem writes
// nothing, and the answer names the row and the reason. A first call with dryRun shows what would happen; the same file sent
// again without dryRun does it, in one transaction. Running the same file twice changes nothing the second time.

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 3_000_000;

export const importBody = z.object({
  csv: z.string().max(MAX_IMPORT_BYTES),
  /** Default true, so forgetting the flag can never write anything. */
  dryRun: z.boolean().default(true),
  /** Create categories, brands and suppliers that are not there yet. Units are never created (they decide fractional sales). */
  createMissing: z.boolean().default(false),
});
export type ImportBody = z.infer<typeof importBody>;

const COLUMNS = [
  'name',
  'barcode',
  'price',
  'cost',
  'currency',
  'category',
  'brand',
  'unit',
  'supplier',
  'stock_alert',
  'receipt_name',
] as const;
type Column = (typeof COLUMNS)[number];
type LookupKind = 'category' | 'brand' | 'unit' | 'supplier';
const TABLE: Record<LookupKind, string> = { category: 'categories', brand: 'brands', unit: 'units', supplier: 'suppliers' };
const COLUMN_OF: Record<LookupKind, string> = { category: 'category_id', brand: 'brand_id', unit: 'unit_id', supplier: 'supplier_id' };

/** A lookup that does not exist yet and will be created when the import is applied. */
type Pending = { pending: LookupKind; name: string };
type Resolved = number | Pending;
const isPending = (v: Resolved | null | undefined): v is Pending => typeof v === 'object' && v !== null;

type Existing = {
  id: number;
  name: string;
  barcode: string;
  price_minor: number;
  cost_minor: number;
  currency: 'USD' | 'LBP';
  category_id: number | null;
  brand_id: number | null;
  unit_id: number | null;
  supplier_id: number | null;
  stock_alert_milli: number | null;
  receipt_name: string | null;
  receipt_name_manual: number;
};

/** What a row wants to set, already checked. A column left out (or an empty cell) is not here, so it is left alone. */
type Wanted = {
  name: string;
  barcode?: string;
  price?: number;
  cost?: number;
  currency?: 'USD' | 'LBP';
  lookups: Partial<Record<LookupKind, Resolved>>;
  stockAlertMilli?: number;
  receiptName?: string;
};

export type RowResult = {
  /** The row as a spreadsheet numbers it: the header is row 1. */
  row: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  name: string;
  barcode: string;
  changes: string[];
  errors: string[];
  warnings: string[];
};

type Planned = RowResult & { wanted?: Wanted; existing?: Existing };

export type ImportResult = {
  dryRun: boolean;
  applied: boolean;
  summary: { create: number; update: number; unchanged: number; errors: number };
  /** Columns in the file that are not used. */
  ignoredColumns: string[];
  /** Categories, brands and suppliers that are (or, on a dry run, would be) created. */
  newLookups: { kind: string; name: string }[];
  rows: RowResult[];
};

const invalidFile = (detail: string) => new AppError(422, 'IMPORT_INVALID_FILE', detail);
const normalizeHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
const SCIENTIFIC = /^\d(\.\d+)?e\+?\d+$/i;

function readFile(csv: string) {
  let table: string[][];
  try {
    table = parseCsv(csv);
  } catch (e) {
    throw invalidFile(e instanceof Error ? e.message : 'The file could not be read');
  }
  if (table.length === 0) throw invalidFile('The file is empty');
  const header = table[0]!.map(normalizeHeader);
  const index = new Map<Column, number>();
  const ignored: string[] = [];
  header.forEach((h, i) => {
    if (h === '') return;
    if ((COLUMNS as readonly string[]).includes(h)) {
      if (index.has(h as Column)) throw invalidFile(`The column "${h}" appears twice in the first row`);
      index.set(h as Column, i);
    } else ignored.push(table[0]![i]!.trim());
  });
  if (!index.has('name')) throw invalidFile('The first row must name the columns, and one of them must be "name"');
  const body = table.slice(1);
  if (body.length === 0) throw invalidFile('The file has the column names but no products');
  if (body.length > MAX_IMPORT_ROWS)
    throw invalidFile(`The file has ${body.length} products; the most that can be imported at once is ${MAX_IMPORT_ROWS}`);
  return { index, body, ignored, width: table[0]!.length };
}

/** Check the file against the catalog and say what each row would do. Reads only. */
function plan(db: Db, input: ImportBody) {
  const { index, body, ignored, width } = readFile(input.csv);

  // The lists a name can point at, by lower-case name.
  const lookups = {} as Record<LookupKind, Map<string, number[]>>;
  for (const kind of Object.keys(TABLE) as LookupKind[]) {
    const map = new Map<string, number[]>();
    for (const r of db.prepare(`SELECT id, name FROM ${TABLE[kind]} ORDER BY id`).all() as { id: number; name: string }[]) {
      const key = r.name.trim().toLowerCase();
      map.set(key, [...(map.get(key) ?? []), r.id]);
    }
    lookups[kind] = map;
  }
  const resolve = (kind: LookupKind, text: string, errors: string[]): Resolved | undefined => {
    const ids = lookups[kind].get(text.toLowerCase());
    if (ids && ids.length === 1) return ids[0]!;
    if (ids && ids.length > 1) {
      errors.push(`There is more than one ${kind} called "${text}" (fix it in Lists first)`);
      return undefined;
    }
    if (kind === 'unit') {
      errors.push(
        `There is no unit called "${text}". Units are set up in Lists, because they decide whether a product can be sold by weight`,
      );
      return undefined;
    }
    if (input.createMissing) return { pending: kind, name: text };
    errors.push(`There is no ${kind} called "${text}". Add it in Lists, or tick the box to create missing ones`);
    return undefined;
  };

  const byBarcode = db.prepare('SELECT * FROM products WHERE barcode = ? ORDER BY id');
  const byName = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE ORDER BY id');
  const sameName = db.prepare('SELECT 1 FROM products WHERE name = ? COLLATE NOCASE LIMIT 1');

  const seenBarcode = new Map<string, number>();
  const seenName = new Map<string, number>();
  const seenProduct = new Map<number, number>();
  const planned: Planned[] = [];

  body.forEach((cells, i) => {
    const rowNo = i + 2;
    const cell = (c: Column) => {
      const at = index.get(c);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const errors: string[] = [];
    const warnings: string[] = [];
    const changes: string[] = [];
    const name = cell('name');
    const barcode = cell('barcode');
    const out = (action: RowResult['action'], extra: Partial<Planned> = {}): Planned => ({
      row: rowNo,
      action: errors.length ? 'error' : action,
      name,
      barcode,
      changes,
      errors,
      warnings,
      ...extra,
    });

    if (cells.length > width && cells.slice(width).some((c) => c.trim() !== '')) {
      // a comma inside an unquoted name pushes every later cell one place to the right
      errors.push('This row has more cells than the first row has columns (a name with a comma in it needs quotes around it)');
    }
    if (name === '') errors.push('The name is empty');
    else if (name.length > 200) errors.push('The name is longer than 200 characters');
    if (barcode.length > 64) errors.push('The barcode is longer than 64 characters');
    if (SCIENTIFIC.test(barcode)) {
      errors.push(
        `The barcode "${barcode}" looks like a number the spreadsheet has shortened. Format the barcode column as Text and type the codes again`,
      );
    }

    // Which product this row is about: its barcode, else its name.
    let existing: Existing | undefined;
    if (barcode !== '') {
      const found = byBarcode.all(barcode) as Existing[];
      if (found.length > 1) errors.push(`${found.length} products already share the barcode ${barcode} (an old duplicate); fix that first`);
      else existing = found[0];
    } else if (name !== '') {
      const found = byName.all(name) as Existing[];
      if (found.length > 1) errors.push(`${found.length} products are called "${name}", and this row has no barcode to tell them apart`);
      else existing = found[0];
    }

    // The same thing twice in one file is almost always a mistake.
    if (barcode !== '') {
      const before = seenBarcode.get(barcode);
      if (before !== undefined) errors.push(`The barcode ${barcode} is already used by row ${before}`);
      else seenBarcode.set(barcode, rowNo);
    } else if (name !== '') {
      const key = name.toLowerCase();
      const before = seenName.get(key);
      if (before !== undefined) errors.push(`The name "${name}" is already used by row ${before} (and neither has a barcode)`);
      else seenName.set(key, rowNo);
    }
    if (existing) {
      const before = seenProduct.get(existing.id);
      if (before !== undefined) errors.push(`This is the same product as row ${before}`);
      else seenProduct.set(existing.id, rowNo);
    }

    // Money. The row's currency decides how the amounts are read: lira whole, dollars to the cent.
    const wanted: Wanted = { name, lookups: {} };
    const currencyText = cell('currency').toUpperCase();
    let currency: 'USD' | 'LBP' | undefined;
    if (currencyText !== '') {
      if (currencyText === 'USD' || currencyText === 'LBP') currency = currencyText;
      else errors.push(`The currency "${cell('currency')}" must be LBP or USD`);
    }
    const effective = currency ?? existing?.currency ?? 'LBP';
    if (currency) wanted.currency = currency;
    const money = (c: 'price' | 'cost') => {
      const text = cell(c);
      if (text === '') return undefined;
      try {
        return parseDecimalMinor(text, effective === 'USD' ? 2 : 0);
      } catch (e) {
        errors.push(`The ${c}: ${e instanceof Error ? e.message : 'not a valid amount'}`);
        return undefined;
      }
    };
    wanted.price = money('price');
    wanted.cost = money('cost');
    if (existing === undefined && cell('price') === '' && !errors.some((e) => e.startsWith('The price'))) {
      errors.push('A new product needs a price');
    }
    if (existing && currency && currency !== existing.currency && (cell('price') === '' || cell('cost') === '')) {
      errors.push(
        `The currency changes from ${existing.currency} to ${currency}, so the price and the cost must both be given in ${currency}`,
      );
    }

    if (barcode !== '') wanted.barcode = barcode;
    for (const kind of Object.keys(TABLE) as LookupKind[]) {
      const text = cell(kind);
      if (text === '') continue;
      const id = resolve(kind, text, errors);
      if (id !== undefined) wanted.lookups[kind] = id;
    }
    const alert = cell('stock_alert');
    if (alert !== '') {
      if (/^\d+(\.\d{1,3})?$/.test(alert)) {
        const [w = '0', f = ''] = alert.split('.');
        wanted.stockAlertMilli = Number(w) * 1000 + Number(f.padEnd(3, '0'));
      } else errors.push(`The stock alert "${alert}" must be a number with at most 3 decimals`);
    }
    const receipt = cell('receipt_name');
    if (receipt.length > 200) errors.push('The receipt name is longer than 200 characters');
    else if (receipt !== '') wanted.receiptName = receipt;

    if (errors.length) return void planned.push(out('error'));

    if (!existing) {
      if ((sameName.get(name) as unknown) !== undefined)
        warnings.push(`A product called "${name}" already exists (with another barcode); this adds a second one`);
      changes.push('new product');
      return void planned.push(out('create', { wanted }));
    }

    // What would change on an existing product.
    const fmt = (v: number, c: 'USD' | 'LBP') => (c === 'USD' ? (v / 100).toFixed(2) : String(v));
    const newCurrency = wanted.currency ?? existing.currency;
    if (wanted.name !== existing.name) changes.push(`name "${existing.name}" → "${wanted.name}"`);
    if (wanted.price !== undefined && (wanted.price !== existing.price_minor || newCurrency !== existing.currency))
      changes.push(
        `price ${fmt(existing.price_minor, existing.currency)} ${existing.currency} → ${fmt(wanted.price, newCurrency)} ${newCurrency}`,
      );
    if (wanted.cost !== undefined && (wanted.cost !== existing.cost_minor || newCurrency !== existing.currency))
      changes.push(`cost ${fmt(existing.cost_minor, existing.currency)} → ${fmt(wanted.cost, newCurrency)}`);
    if (wanted.barcode !== undefined && wanted.barcode !== existing.barcode)
      changes.push(`barcode ${existing.barcode || '(none)'} → ${wanted.barcode}`);
    for (const kind of Object.keys(wanted.lookups) as LookupKind[]) {
      const v = wanted.lookups[kind]!;
      const now = existing[COLUMN_OF[kind] as keyof Existing];
      if (isPending(v) || v !== now) changes.push(`${kind} → ${isPending(v) ? `${v.name} (new)` : cell(kind)}`);
    }
    if (wanted.stockAlertMilli !== undefined && wanted.stockAlertMilli !== existing.stock_alert_milli)
      changes.push(`stock alert → ${alert}`);
    if (wanted.receiptName !== undefined) {
      const next = toReceiptName({ name: wanted.name, receiptName: wanted.receiptName });
      if (next !== existing.receipt_name || existing.receipt_name_manual === 0) changes.push(`receipt name → ${next}`);
    }
    planned.push(out(changes.length ? 'update' : 'unchanged', { wanted, existing }));
  });

  return { planned, ignored };
}

const publicRow = ({ row, action, name, barcode, changes, errors, warnings }: Planned): RowResult => ({
  row,
  action,
  name,
  barcode,
  changes,
  errors,
  warnings,
});

/**
 * Check, and if asked, apply. A file with any error is never applied. Applying is one transaction: every product, every new
 * list entry and the audit rows commit together, or none do.
 */
export function importProducts(db: Db, actorId: number, input: ImportBody): ImportResult {
  const run = (): ImportResult => {
    const { planned, ignored } = plan(db, input);
    const summary = { create: 0, update: 0, unchanged: 0, errors: 0 };
    for (const p of planned) {
      if (p.action === 'error') summary.errors++;
      else summary[p.action]++;
    }
    const newLookups = new Map<string, { kind: LookupKind; name: string }>();
    for (const p of planned) {
      if (p.action === 'error' || !p.wanted) continue;
      for (const v of Object.values(p.wanted.lookups))
        if (isPending(v)) newLookups.set(`${v.pending}:${v.name.toLowerCase()}`, { kind: v.pending, name: v.name });
    }
    const result: ImportResult = {
      dryRun: input.dryRun,
      applied: false,
      summary,
      ignoredColumns: ignored,
      newLookups: [...newLookups.values()],
      rows: planned.map(publicRow),
    };
    if (input.dryRun || summary.errors > 0) return result;

    // ---- write
    const ids = new Map<string, number>();
    for (const [key, l] of newLookups) {
      const id = Number(db.prepare(`INSERT INTO ${TABLE[l.kind]} (name) VALUES (?)`).run(l.name).lastInsertRowid);
      ids.set(key, id);
      writeAudit(db, { userId: actorId, action: `${l.kind}.create`, entity: l.kind, entityId: id, after: { name: l.name, via: 'import' } });
    }
    const idOf = (v: Resolved) => (isPending(v) ? ids.get(`${v.pending}:${v.name.toLowerCase()}`)! : v);

    for (const p of planned) {
      const w = p.wanted;
      if (!w || p.action === 'unchanged') continue;
      const cat = w.lookups.category === undefined ? null : idOf(w.lookups.category);
      const brand = w.lookups.brand === undefined ? null : idOf(w.lookups.brand);
      const unit = w.lookups.unit === undefined ? null : idOf(w.lookups.unit);
      const supplier = w.lookups.supplier === undefined ? null : idOf(w.lookups.supplier);

      if (p.action === 'create') {
        const manual = w.receiptName !== undefined;
        const currency = w.currency ?? 'LBP';
        const newId = Number(
          db
            .prepare(
              `INSERT INTO products (name, receipt_name, receipt_name_manual, barcode, cost_minor, price_minor, currency, category_id, brand_id,
                                     unit_id, supplier_id, stock_alert_milli)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              w.name,
              toReceiptName({ name: w.name, receiptName: w.receiptName }),
              manual ? 1 : 0,
              w.barcode ?? '',
              w.cost ?? 0,
              w.price!,
              currency,
              cat,
              brand,
              unit,
              supplier,
              w.stockAlertMilli ?? null,
            ).lastInsertRowid,
        );
        writeAudit(db, {
          userId: actorId,
          action: 'product.create',
          entity: 'product',
          entityId: newId,
          after: { name: w.name, barcode: w.barcode ?? '', priceMinor: w.price, costMinor: w.cost ?? 0, currency, via: 'import' },
        });
        continue;
      }

      // update: only the cells that were filled in
      const before = p.existing!;
      const sets: string[] = [];
      const vals: unknown[] = [];
      const set = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        vals.push(v);
      };
      if (w.name !== before.name) set('name', w.name);
      if (w.barcode !== undefined) set('barcode', w.barcode);
      if (w.price !== undefined) set('price_minor', w.price);
      if (w.cost !== undefined) set('cost_minor', w.cost);
      if (w.currency !== undefined) set('currency', w.currency);
      if (w.lookups.category !== undefined) set('category_id', cat);
      if (w.lookups.brand !== undefined) set('brand_id', brand);
      if (w.lookups.unit !== undefined) set('unit_id', unit);
      if (w.lookups.supplier !== undefined) set('supplier_id', supplier);
      if (w.stockAlertMilli !== undefined) set('stock_alert_milli', w.stockAlertMilli);
      if (w.receiptName !== undefined) {
        set('receipt_name', toReceiptName({ name: w.name, receiptName: w.receiptName }));
        set('receipt_name_manual', 1);
      } else if (w.name !== before.name && before.receipt_name_manual === 0) set('receipt_name', toReceiptName({ name: w.name }));
      set('updated_at', nowIso());
      db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals, before.id);

      const after = db.prepare('SELECT * FROM products WHERE id = ?').get(before.id) as Existing;
      const money = (r: Existing) => ({ priceMinor: r.price_minor, costMinor: r.cost_minor, currency: r.currency });
      if (JSON.stringify(money(before)) !== JSON.stringify(money(after))) {
        writeAudit(db, {
          userId: actorId,
          action: 'product.price.update',
          entity: 'product',
          entityId: before.id,
          before: money(before),
          after: { ...money(after), via: 'import' },
        });
      }
      const other = (r: Existing) => ({
        name: r.name,
        receiptName: r.receipt_name,
        barcode: r.barcode,
        categoryId: r.category_id,
        brandId: r.brand_id,
        unitId: r.unit_id,
        supplierId: r.supplier_id,
        stockAlert: r.stock_alert_milli === null ? null : r.stock_alert_milli / 1000,
      });
      if (JSON.stringify(other(before)) !== JSON.stringify(other(after))) {
        writeAudit(db, {
          userId: actorId,
          action: 'product.update',
          entity: 'product',
          entityId: before.id,
          before: other(before),
          after: { ...other(after), via: 'import' },
        });
      }
    }
    writeAudit(db, { userId: actorId, action: 'product.import', entity: 'product', after: { ...summary, newLookups: newLookups.size } });
    result.applied = true;
    return result;
  };

  // A dry run only reads. Applying checks and writes inside one transaction, so what was checked is what is written.
  return input.dryRun ? run() : inWriteTransaction(db, run);
}
