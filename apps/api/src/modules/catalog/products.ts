import type { FastifyInstance } from 'fastify';
import { normalizeBarcode, toReceiptName } from '@pos/shared';
import { z } from 'zod';
import { E } from '../../errors';
import { inWriteTransaction, type Db } from '../../db/open';
import { milliToQty, qtyNumberToMilli } from '../../util/qty';
import { nowIso } from '../../util/time';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { MAX_IMAGE_BYTES, storeImage } from './images';
import { importBody, importProducts, MAX_IMPORT_BYTES } from './import';

// ------------------------------------------------------------------ shapes

type Row = {
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
  qty_milli: number;
  unit_name: string | null;
  fractional: number | null;
};

export const SELECT_PRODUCT = `SELECT p.*, COALESCE((SELECT SUM(l.qty_milli) FROM stock_levels l WHERE l.product_id = p.id), 0) AS qty_milli,
  u.name AS unit_name, u.fractional AS fractional
  FROM products p LEFT JOIN units u ON u.id = p.unit_id`;

export const productJson = (r: Row) => ({
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
  qty: milliToQty(r.qty_milli),
  unitName: r.unit_name,
  /** Sold by weight or volume: the quantity may have up to 3 decimals. */
  fractional: r.fractional === 1,
  updatedAt: r.updated_at,
});

// ------------------------------------------------------------------ validation

// Threshold in whole units (up to 3 decimals). null = never alert. Never negative.
const stockAlert = z
  .number()
  .min(0)
  .refine((v) => qtyNumberToMilli(v) !== null, 'At most 3 decimals')
  .nullable();

// The fields carry NO defaults. Zod applies `.default()` even inside `.partial()`, so a patch built from
// defaulted fields would silently reset cost, barcode and currency on every edit. Defaults belong to create only.
const fields = {
  name: z.string().trim().min(1).max(200),
  receiptName: z.string().trim().max(200).nullish(),
  barcode: z.string().max(64),
  priceMinor: z.number().int().min(0),
  costMinor: z.number().int().min(0),
  currency: z.enum(['USD', 'LBP']),
  categoryId: z.number().int().positive().nullish(),
  brandId: z.number().int().positive().nullish(),
  unitId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
  stockAlert: stockAlert.optional(),
  expiryDate: z.string().max(40).nullish(),
};

const createBody = z.object({
  ...fields,
  barcode: fields.barcode.default(''),
  costMinor: fields.costMinor.default(0),
  currency: fields.currency.default('LBP'),
});

const patchBody = z.object(fields).partial().extend({ active: z.boolean().optional() });

const listQuery = z.object({
  q: z.string().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  brandId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

// ------------------------------------------------------------------ helpers

const getRow = (db: Db, id: number) => db.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`).get(id) as Row | undefined;

/** Quote user text as one FTS5 phrase so operators and punctuation in it are plain characters. */
const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`;
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function priceSnapshot(r: Row) {
  return { priceMinor: r.price_minor, costMinor: r.cost_minor, currency: r.currency };
}

export default async function productRoutes(app: FastifyInstance) {
  const db = app.db;
  const read = { preHandler: app.authenticate };
  const write = { preHandler: app.requireRole('manager') };

  // A picture arrives as the request body itself (not a form), so no upload library is needed. The type the sender claims is
  // not trusted: the bytes decide (storeImage). octet-stream is accepted for files a browser could not put a type on.
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/products', read, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];

    const filter = (sql: string, value: unknown) => {
      where.push(sql);
      params.push(value);
    };
    if (q.active !== 'all') filter('p.active = ?', q.active === 'true' ? 1 : 0);
    if (q.categoryId) filter('p.category_id = ?', q.categoryId);
    if (q.brandId) filter('p.brand_id = ?', q.brandId);
    if (q.supplierId) filter('p.supplier_id = ?', q.supplierId);
    if (q.cursor) filter('p.id > ?', q.cursor);

    const text = q.q?.trim();
    if (text) {
      if ([...text].length >= 3) {
        // Trigram index: substring match on Latin and Arabic names, receipt names and barcodes.
        where.push('(p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?) OR p.barcode = ?)');
        params.push(ftsPhrase(text), text);
      } else {
        where.push(`(p.name LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\')`);
        params.push(`%${likeEscape(text)}%`, `${likeEscape(text)}%`);
      }
    }

    const rows = db
      .prepare(`${SELECT_PRODUCT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id LIMIT ?`)
      .all(...params, q.limit + 1) as Row[];
    const page = rows.slice(0, q.limit);
    return { data: page.map(productJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  /**
   * Barcode lookup for the till. Always `{ data: [...] }`. More than one entry means the code is shared by several
   * products (legacy duplicates are cleaned up last), so the till shows a picker.
   */
  app.get('/products/by-barcode/:code', read, async (req) => {
    const code = normalizeBarcode((req.params as { code: string }).code);
    const rows = code ? (db.prepare(`${SELECT_PRODUCT} WHERE p.barcode = ? AND p.active = 1 ORDER BY p.id`).all(code) as Row[]) : [];
    if (rows.length === 0) throw E.notFound('Barcode');
    return { data: rows.map(productJson) };
  });

  // Delta feed for the till's local catalog cache: everything changed (or deactivated) since a timestamp.
  app.get('/products/sync', read, async (req) => {
    const { since } = parse(z.object({ since: z.string().max(40).optional() }), req.query);
    const serverTime = nowIso();
    const rows = db.prepare(`${SELECT_PRODUCT} WHERE p.updated_at > ? ORDER BY p.updated_at, p.id`).all(since ?? '') as Row[];
    return { data: rows.map(productJson), serverTime };
  });

  app.get('/products/:id', read, async (req) => {
    const row = getRow(db, Number((req.params as { id: string }).id));
    if (!row) throw E.notFound('Product');
    return productJson(row);
  });

  // Products from a spreadsheet's CSV. dryRun (the default) only says what would happen; a file with any error writes nothing.
  app.post('/products/import', { ...write, bodyLimit: MAX_IMPORT_BYTES + 4096 }, async (req) => {
    const body = parse(importBody, req.body);
    return importProducts(db, req.auth.id, body);
  });

  app.post('/products', write, async (req, reply) => {
    const b = parse(createBody, req.body);
    const manual = !!b.receiptName;
    const receiptName = toReceiptName({ name: b.name, receiptName: b.receiptName });
    const duplicate = b.barcode ? !!db.prepare('SELECT 1 FROM products WHERE barcode = ? LIMIT 1').get(b.barcode) : false;

    const id = inWriteTransaction(db, () => {
      const newId = Number(
        db
          .prepare(
            `INSERT INTO products (name, receipt_name, receipt_name_manual, barcode, cost_minor, price_minor, currency, category_id, brand_id,
                                   unit_id, supplier_id, stock_alert_milli, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            b.name,
            receiptName,
            manual ? 1 : 0,
            b.barcode,
            b.costMinor,
            b.priceMinor,
            b.currency,
            b.categoryId ?? null,
            b.brandId ?? null,
            b.unitId ?? null,
            b.supplierId ?? null,
            b.stockAlert === undefined || b.stockAlert === null ? null : qtyNumberToMilli(b.stockAlert),
            b.expiryDate ?? null,
          ).lastInsertRowid,
      );
      writeAudit(db, {
        userId: req.auth.id,
        action: 'product.create',
        entity: 'product',
        entityId: newId,
        after: { name: b.name, barcode: b.barcode, priceMinor: b.priceMinor, costMinor: b.costMinor, currency: b.currency },
      });
      return newId;
    });
    return reply.status(201).send({ ...productJson(getRow(db, id)!), warnings: duplicate ? ['DUPLICATE_BARCODE'] : [] });
  });

  app.patch('/products/:id', write, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(patchBody, req.body);
    const before = getRow(db, id);
    if (!before) throw E.notFound('Product');

    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
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

    // Receipt name: a manual edit sticks (never overwritten by name edits). null/empty goes back to automatic.
    const newName = b.name ?? before.name;
    if (b.receiptName !== undefined) {
      const manual = !!b.receiptName;
      set('receipt_name', toReceiptName({ name: newName, receiptName: b.receiptName }));
      set('receipt_name_manual', manual ? 1 : 0);
    } else if (b.name !== undefined && b.name !== before.name && before.receipt_name_manual === 0) {
      set('receipt_name', toReceiptName({ name: newName }));
    }

    if (sets.length === 0) return productJson(before);
    set('updated_at', nowIso());

    inWriteTransaction(db, () => {
      db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      const after = getRow(db, id)!;

      const priceBefore = priceSnapshot(before);
      const priceAfter = priceSnapshot(after);
      const priceChanged = JSON.stringify(priceBefore) !== JSON.stringify(priceAfter);
      if (priceChanged) {
        writeAudit(db, {
          userId: req.auth.id,
          action: 'product.price.update',
          entity: 'product',
          entityId: id,
          before: priceBefore,
          after: priceAfter,
        });
      }

      const other = (r: Row) => ({
        name: r.name,
        receiptName: r.receipt_name,
        barcode: r.barcode,
        categoryId: r.category_id,
        brandId: r.brand_id,
        unitId: r.unit_id,
        supplierId: r.supplier_id,
        stockAlert: r.stock_alert_milli === null ? null : r.stock_alert_milli / 1000,
        expiryDate: r.expiry_date,
        active: r.active === 1,
      });
      if (JSON.stringify(other(before)) !== JSON.stringify(other(after))) {
        writeAudit(db, {
          userId: req.auth.id,
          action: 'product.update',
          entity: 'product',
          entityId: id,
          before: other(before),
          after: other(after),
        });
      }
    });
    return productJson(getRow(db, id)!);
  });

  // Set or replace a product's picture. The file is kept under a name made from its content and the product just points at it.
  app.post('/products/:id/image', write, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const before = getRow(db, id);
    if (!before) throw E.notFound('Product');
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw E.validation('Send the picture file as the body of the request');
    const stored = storeImage(app.uploadsDir, bytes);
    if (!stored)
      throw E.unprocessable(
        'UNSUPPORTED_IMAGE',
        'That file is not a picture the shop can use. Use a JPEG, PNG, GIF, WebP or AVIF picture.',
      );

    inWriteTransaction(db, () => {
      db.prepare('UPDATE products SET image_path = ?, updated_at = ? WHERE id = ?').run(stored.path, nowIso(), id);
      writeAudit(db, {
        userId: req.auth.id,
        action: 'product.image.update',
        entity: 'product',
        entityId: id,
        before: { imagePath: before.image_path },
        after: { imagePath: stored.path },
      });
    });
    return productJson(getRow(db, id)!);
  });

  // Take the picture off a product. The file stays in the folder: another product may use the same one.
  app.delete('/products/:id/image', write, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const before = getRow(db, id);
    if (!before) throw E.notFound('Product');
    if (before.image_path !== null) {
      inWriteTransaction(db, () => {
        db.prepare('UPDATE products SET image_path = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
        writeAudit(db, {
          userId: req.auth.id,
          action: 'product.image.remove',
          entity: 'product',
          entityId: id,
          before: { imagePath: before.image_path },
          after: { imagePath: null },
        });
      });
    }
    return productJson(getRow(db, id)!);
  });

  // Soft delete: sales history keeps pointing at the product.
  app.delete('/products/:id', write, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const before = getRow(db, id);
    if (!before) throw E.notFound('Product');
    inWriteTransaction(db, () => {
      db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(db, {
        userId: req.auth.id,
        action: 'product.deactivate',
        entity: 'product',
        entityId: id,
        before: { active: before.active === 1 },
        after: { active: false },
      });
    });
    return reply.status(204).send();
  });
}
