import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { toReceiptName } from '@pos/shared/translit';
import { qtyNumberToMilli } from '../../util/qty';

// HQ's products (docs/12-sync-and-hq.md §17, P3b). A change writes the product, its change_log line and an hq_audit row in ONE transaction, so a
// branch cannot miss it. A product is never deleted: retiring it (active = 0) is the delete, and a retired product still goes down to the branches.

const nowIso = () => new Date().toISOString();

export type ProductRow = {
  id: number;
  name: string;
  receipt_name: string | null;
  receipt_name_manual: number;
  barcode: string;
  cost_minor: number;
  price_minor: number;
  currency: 'USD' | 'LBP';
  category_id: number | null;
  brand_id: number | null;
  unit_id: number | null;
  supplier_id: number | null;
  stock_alert_milli: number | null;
  expiry_date: string | null;
  image_path: string | null;
  active: number;
  updated_at: string;
};

const COLUMNS = `id, name, receipt_name, receipt_name_manual, barcode, cost_minor, price_minor, currency, category_id, brand_id, unit_id,
  supplier_id, stock_alert_milli, expiry_date, image_path, active, updated_at`;

export const productJson = (r: ProductRow) => ({
  id: r.id,
  name: r.name,
  receiptName: r.receipt_name,
  receiptNameManual: r.receipt_name_manual === 1,
  barcode: r.barcode,
  costMinor: r.cost_minor,
  priceMinor: r.price_minor,
  currency: r.currency,
  categoryId: r.category_id,
  brandId: r.brand_id,
  unitId: r.unit_id,
  supplierId: r.supplier_id,
  stockAlert: r.stock_alert_milli === null ? null : r.stock_alert_milli / 1000,
  expiryDate: r.expiry_date,
  imagePath: r.image_path,
  active: r.active === 1,
  updatedAt: r.updated_at,
});

/** What a person may set. `undefined` = leave as it is; for the optional links, `null` = clear. */
export type ProductInput = {
  name?: string;
  receiptName?: string | null;
  barcode?: string;
  priceMinor?: number;
  costMinor?: number;
  currency?: 'USD' | 'LBP';
  categoryId?: number | null;
  brandId?: number | null;
  unitId?: number | null;
  supplierId?: number | null;
  stockAlert?: number | null;
  expiryDate?: string | null;
  active?: boolean;
};

export const getProduct = (q: Queryable, id: number) => q.one<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);

/** Every link must point at something HQ has: a clear error instead of a foreign-key failure. */
async function checkLinks(q: Queryable, b: ProductInput): Promise<void> {
  const links: [string, string, number | null | undefined][] = [
    ['categories', 'category', b.categoryId],
    ['brands', 'brand', b.brandId],
    ['units', 'unit', b.unitId],
    ['suppliers', 'supplier', b.supplierId],
  ];
  for (const [table, label, id] of links) {
    if (id === undefined || id === null) continue;
    if (!(await q.one(`SELECT 1 AS x FROM ${table} WHERE id = ?`, [id])))
      throw new AppError(422, 'VALIDATION', `There is no ${label} ${id}`);
  }
}

/** The barcode rule: one ACTIVE product per barcode. Checked first for a clear answer; the unique index is the backstop. */
async function checkBarcode(q: Queryable, barcode: string, active: boolean, exceptId: number): Promise<void> {
  if (!barcode || !active) return;
  const other = await q.one<{ id: number; name: string }>(
    'SELECT id, name FROM products WHERE barcode = ? AND active = 1 AND id <> ? LIMIT 1',
    [barcode, exceptId],
  );
  if (other)
    throw new AppError(409, 'DUPLICATE_BARCODE', `The barcode ${barcode} is already used by "${other.name}" (product ${other.id})`);
}

async function record(q: Queryable, id: number, action: string, detail: unknown): Promise<void> {
  const now = nowIso();
  await q.run('INSERT INTO change_log (tbl, pk, op, created_at) VALUES (?, ?, ?, ?)', ['products', id, 'u', now]);
  await q.run('INSERT INTO hq_audit (action, entity, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', [
    action,
    'product',
    String(id),
    JSON.stringify(detail),
    now,
  ]);
}

export async function createProduct(q: Queryable, b: ProductInput & { name: string }): Promise<ProductRow> {
  await checkLinks(q, b);
  const barcode = b.barcode ?? '';
  await checkBarcode(q, barcode, b.active !== false, 0);
  const now = nowIso();
  const manual = !!b.receiptName;
  const row = (await q.one<{ id: number }>(
    `INSERT INTO products (name, receipt_name, receipt_name_manual, barcode, cost_minor, price_minor, currency, category_id, brand_id, unit_id,
                           supplier_id, stock_alert_milli, expiry_date, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      b.name,
      toReceiptName({ name: b.name, receiptName: b.receiptName }),
      manual ? 1 : 0,
      barcode,
      b.costMinor ?? 0,
      b.priceMinor ?? 0,
      b.currency ?? 'LBP',
      b.categoryId ?? null,
      b.brandId ?? null,
      b.unitId ?? null,
      b.supplierId ?? null,
      b.stockAlert === undefined || b.stockAlert === null ? null : qtyNumberToMilli(b.stockAlert),
      b.expiryDate ?? null,
      b.active === false ? 0 : 1,
      now,
      now,
    ],
  ))!;
  await record(q, row.id, 'product.create', { name: b.name, barcode, priceMinor: b.priceMinor ?? 0, currency: b.currency ?? 'LBP' });
  return (await getProduct(q, row.id))!;
}

/** Change a product; only the fields given. A change that changes nothing writes nothing (no log line, no new `updated_at`). */
export async function updateProduct(q: Queryable, id: number, b: ProductInput): Promise<ProductRow> {
  const before = await getProduct(q, id);
  if (!before) throw new AppError(404, 'NOT_FOUND', 'No such product');
  await checkLinks(q, b);
  // A branch's own price is in the product's currency: changing the currency under it would silently change what it means.
  if (
    b.currency !== undefined &&
    b.currency !== before.currency &&
    (await q.one('SELECT 1 AS x FROM branch_prices WHERE product_id = ? LIMIT 1', [id]))
  )
    throw new AppError(
      409,
      'PRICE_OVERRIDES_EXIST',
      'Some branches have their own price for this product in the current currency. Remove those first, then change the currency.',
    );
  const barcode = b.barcode ?? before.barcode;
  const active = b.active === undefined ? before.active === 1 : b.active;
  if (b.barcode !== undefined || b.active !== undefined) await checkBarcode(q, barcode, active, id);

  const sets: [string, string | number | null][] = [];
  const set = (col: string, v: string | number | null) => {
    if ((before as unknown as Record<string, unknown>)[col] !== v) sets.push([col, v]);
  };
  if (b.name !== undefined) set('name', b.name);
  if (b.barcode !== undefined) set('barcode', b.barcode);
  if (b.priceMinor !== undefined) set('price_minor', b.priceMinor);
  if (b.costMinor !== undefined) set('cost_minor', b.costMinor);
  if (b.currency !== undefined) set('currency', b.currency);
  if (b.categoryId !== undefined) set('category_id', b.categoryId);
  if (b.brandId !== undefined) set('brand_id', b.brandId);
  if (b.unitId !== undefined) set('unit_id', b.unitId);
  if (b.supplierId !== undefined) set('supplier_id', b.supplierId);
  if (b.expiryDate !== undefined) set('expiry_date', b.expiryDate);
  if (b.active !== undefined) set('active', b.active ? 1 : 0);
  if (b.stockAlert !== undefined) set('stock_alert_milli', b.stockAlert === null ? null : qtyNumberToMilli(b.stockAlert));
  // Receipt name: a manual edit sticks (a later rename does not overwrite it); an empty one goes back to automatic.
  const newName = b.name ?? before.name;
  if (b.receiptName !== undefined) {
    set('receipt_name', toReceiptName({ name: newName, receiptName: b.receiptName }));
    set('receipt_name_manual', b.receiptName ? 1 : 0);
  } else if (b.name !== undefined && b.name !== before.name && before.receipt_name_manual === 0) {
    set('receipt_name', toReceiptName({ name: newName }));
  }
  if (sets.length === 0) return before;

  await q.run(`UPDATE products SET ${sets.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...sets.map(([, v]) => v),
    nowIso(),
    id,
  ]);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [c, v] of sets) changed[c] = { from: (before as unknown as Record<string, unknown>)[c], to: v };
  await record(q, id, 'product.update', changed);
  return (await getProduct(q, id))!;
}

/** Set (or, with null, remove) a product's picture: the name of a file already kept in the pictures folder. A no-op writes nothing. */
export async function setProductImage(q: Queryable, id: number, imagePath: string | null): Promise<ProductRow> {
  const before = await getProduct(q, id);
  if (!before) throw new AppError(404, 'NOT_FOUND', 'No such product');
  if (before.image_path === imagePath) return before;
  await q.run('UPDATE products SET image_path = ?, updated_at = ? WHERE id = ?', [imagePath, nowIso(), id]);
  await record(q, id, imagePath === null ? 'product.image.remove' : 'product.image.update', { from: before.image_path, to: imagePath });
  return (await getProduct(q, id))!;
}

export type ProductQuery = {
  q?: string;
  categoryId?: number;
  brandId?: number;
  supplierId?: number;
  active: 'true' | 'false' | 'all';
  limit: number;
  cursor?: number;
};

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listProducts(q: Queryable, f: ProductQuery): Promise<{ data: ProductRow[]; nextCursor: number | null }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const filter = (sql: string, value: string | number) => {
    where.push(sql);
    params.push(value);
  };
  if (f.active !== 'all') filter('active = ?', f.active === 'true' ? 1 : 0);
  if (f.categoryId) filter('category_id = ?', f.categoryId);
  if (f.brandId) filter('brand_id = ?', f.brandId);
  if (f.supplierId) filter('supplier_id = ?', f.supplierId);
  if (f.cursor) filter('id > ?', f.cursor);
  const text = f.q?.trim();
  if (text) {
    where.push(`(name LIKE ? ESCAPE '\\' OR barcode = ? OR barcode LIKE ? ESCAPE '\\')`);
    params.push(`%${likeEscape(text)}%`, text, `${likeEscape(text)}%`);
  }
  const rows = await q.all<ProductRow>(
    `SELECT ${COLUMNS} FROM products ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`,
    [...params, f.limit + 1],
  );
  const page = rows.slice(0, f.limit);
  return { data: page, nextCursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null };
}
