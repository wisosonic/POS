import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { parseCsv, parseDecimalMinor, toReceiptName } from '@pos/shared';
import { z } from 'zod';
import { createRow, LIST_KINDS } from './lists';
import { createProduct, updateProduct, type ProductInput } from './products';

// Product import at HQ from a spreadsheet's CSV (docs/12 §19; the same rules as the branch's import before products became HQ's, US-15).
// Nothing is guessed: every row is checked, a file with any problem writes nothing, and the answer names the row and the reason. A first
// call with dryRun shows what would happen; the same file sent again without dryRun does it, in ONE transaction. Running the same file twice
// changes nothing the second time. Differences from the branch's: only ACTIVE products are matched (a retired product's barcode is free),
// and the limits are larger because HQ holds the whole chain's catalog.

export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_BYTES = 8_000_000;

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
const KIND_KEY: Record<LookupKind, string> = { category: 'categories', brand: 'brands', unit: 'units', supplier: 'suppliers' };
const COLUMN_OF: Record<LookupKind, 'category_id' | 'brand_id' | 'unit_id' | 'supplier_id'> = {
  category: 'category_id',
  brand: 'brand_id',
  unit: 'unit_id',
  supplier: 'supplier_id',
};
const INPUT_OF: Record<LookupKind, 'categoryId' | 'brandId' | 'unitId' | 'supplierId'> = {
  category: 'categoryId',
  brand: 'brandId',
  unit: 'unitId',
  supplier: 'supplierId',
};

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

const EXISTING_COLUMNS = `id, name, barcode, price_minor, cost_minor, currency, category_id, brand_id, unit_id, supplier_id, stock_alert_milli,
  receipt_name, receipt_name_manual`;

/** Check the file against the catalog and say what each row would do. Reads only. */
async function plan(q: Queryable, input: ImportBody) {
  const { index, body, ignored, width } = readFile(input.csv);

  // The lists a name can point at, by lower-case name.
  const lookups = {} as Record<LookupKind, Map<string, number[]>>;
  for (const kind of Object.keys(KIND_KEY) as LookupKind[]) {
    const map = new Map<string, number[]>();
    for (const r of await q.all<{ id: number; name: string }>(`SELECT id, name FROM ${LIST_KINDS[KIND_KEY[kind]]!.table} ORDER BY id`)) {
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

  const seenBarcode = new Map<string, number>();
  const seenName = new Map<string, number>();
  const seenProduct = new Map<number, number>();
  const planned: Planned[] = [];

  for (const [i, cells] of body.entries()) {
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

    // Which product this row is about: its barcode, else its name. Only ACTIVE products count (a retired product's barcode is free).
    let existing: Existing | undefined;
    if (barcode !== '') {
      existing = await q.one<Existing>(`SELECT ${EXISTING_COLUMNS} FROM products WHERE barcode = ? AND active = 1`, [barcode]);
    } else if (name !== '') {
      const found = await q.all<Existing>(
        `SELECT ${EXISTING_COLUMNS} FROM products WHERE lower(name) = lower(?) AND active = 1 ORDER BY id`,
        [name],
      );
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
    for (const kind of Object.keys(KIND_KEY) as LookupKind[]) {
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

    if (errors.length) {
      planned.push(out('error'));
      continue;
    }

    if (!existing) {
      const same = await q.one('SELECT 1 AS x FROM products WHERE lower(name) = lower(?) AND active = 1 LIMIT 1', [name]);
      if (same) warnings.push(`A product called "${name}" already exists (with another barcode); this adds a second one`);
      changes.push('new product');
      planned.push(out('create', { wanted }));
      continue;
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
      if (isPending(v) || v !== existing[COLUMN_OF[kind]]) changes.push(`${kind} → ${isPending(v) ? `${v.name} (new)` : cell(kind)}`);
    }
    if (wanted.stockAlertMilli !== undefined && wanted.stockAlertMilli !== existing.stock_alert_milli)
      changes.push(`stock alert → ${alert}`);
    if (wanted.receiptName !== undefined) {
      const next = toReceiptName({ name: wanted.name, receiptName: wanted.receiptName });
      if (next !== existing.receipt_name || existing.receipt_name_manual === 0) changes.push(`receipt name → ${next}`);
    }
    planned.push(out(changes.length ? 'update' : 'unchanged', { wanted, existing }));
  }

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
 * Check, and if asked, apply. A file with any error is never applied. Applying must run inside ONE transaction (the caller opens it): every
 * product, every new list entry, every change_log line and every audit row commit together, or none do. A dry run only reads.
 */
export async function importProducts(q: Queryable, input: ImportBody): Promise<ImportResult> {
  const { planned, ignored } = await plan(q, input);
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
  for (const [key, l] of newLookups) ids.set(key, (await createRow(q, LIST_KINDS[KIND_KEY[l.kind]]!, l.name, {})).id);
  const idOf = (v: Resolved) => (isPending(v) ? ids.get(`${v.pending}:${v.name.toLowerCase()}`)! : v);

  for (const p of planned) {
    const w = p.wanted;
    if (!w || p.action === 'unchanged') continue;
    const patch: ProductInput = {};
    for (const kind of Object.keys(w.lookups) as LookupKind[]) patch[INPUT_OF[kind]] = idOf(w.lookups[kind]!);
    if (w.barcode !== undefined) patch.barcode = w.barcode;
    if (w.price !== undefined) patch.priceMinor = w.price;
    if (w.cost !== undefined) patch.costMinor = w.cost;
    if (w.currency !== undefined) patch.currency = w.currency;
    if (w.stockAlertMilli !== undefined) patch.stockAlert = w.stockAlertMilli / 1000;
    if (w.receiptName !== undefined) patch.receiptName = w.receiptName;

    if (p.action === 'create') await createProduct(q, { ...patch, name: w.name });
    else await updateProduct(q, p.existing!.id, { ...patch, name: w.name });
  }
  const now = new Date().toISOString();
  await q.run('INSERT INTO hq_audit (action, entity, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [
    'product.import',
    'product',
    null,
    JSON.stringify({ ...summary, newLookups: newLookups.size }),
    now,
  ]);
  result.applied = true;
  return result;
}
