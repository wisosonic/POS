import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRole } from '../../auth/permissions';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError, E } from '../../errors';
import { findReplay, hashRequest, rememberResponse, requireIdempotencyKey } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';

// Duplicate barcodes (US-34, the last milestone). The old data shares some barcodes between products, so the rule starts off.
// This is how they are cleaned up: a report of every shared barcode, re-coding a product (the product screen), merging
// products into one, and finally turning the rule on so the database refuses new duplicates (migration 0010).
// Only ACTIVE products count: the till only finds active ones, and a hidden product may keep an old code.

const MERGE_SCOPE = 'POST /products/merge';

const duplicates = (db: Db) => {
  const codes = db
    .prepare(`SELECT barcode FROM products WHERE active = 1 AND barcode <> '' GROUP BY barcode HAVING count(*) > 1 ORDER BY barcode`)
    .all() as { barcode: string }[];
  const members = db.prepare(
    `SELECT p.id, p.name, p.price_minor AS price, p.currency,
            COALESCE((SELECT SUM(l.qty_milli) FROM stock_levels l WHERE l.product_id = p.id), 0) AS qty_milli,
            (SELECT count(*) FROM sale_items si WHERE si.product_id = p.id) AS sold_lines,
            (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = p.id) AS last_sold
     FROM products p WHERE p.active = 1 AND p.barcode = ? ORDER BY p.id`,
  );
  return codes.map(({ barcode }) => ({
    barcode,
    products: (
      members.all(barcode) as {
        id: number;
        name: string;
        price: number;
        currency: 'USD' | 'LBP';
        qty_milli: number;
        sold_lines: number;
        last_sold: string | null;
      }[]
    ).map((m) => ({
      id: m.id,
      name: m.name,
      priceMinor: m.price,
      currency: m.currency,
      qty: milliToQty(m.qty_milli),
      soldLines: m.sold_lines,
      lastSoldAt: m.last_sold,
    })),
  }));
};

const enforced = (db: Db) =>
  (db.prepare('SELECT barcode_unique AS on_ FROM store_settings WHERE id = 1').get() as { on_: number }).on_ === 1;

const status = (db: Db) => {
  const groups = duplicates(db);
  return { enforced: enforced(db), duplicateGroups: groups.length, duplicateProducts: groups.reduce((n, g) => n + g.products.length, 0) };
};

const mergeBody = z.object({
  /** The product that stays. */
  keepId: z.number().int().positive(),
  /** The products folded into it. They must share its barcode. */
  retireIds: z.array(z.number().int().positive()).min(1).max(20),
});

export default async function barcodeRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  app.get('/barcodes/status', manager, async () => status(db));

  app.get('/barcodes/duplicates', manager, async () => ({ data: duplicates(db), ...status(db) }));

  // Turn the rule on (once nothing is shared) or off. Off is for an admin only: it weakens a guarantee.
  app.post('/barcodes/enforce', manager, async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    if (!enabled && !hasRole(req.auth.role, 'admin')) throw E.forbidden();
    return inWriteTransaction(db, () => {
      if (enabled) {
        const left = duplicates(db);
        if (left.length > 0)
          throw new AppError(
            409,
            'DUPLICATES_REMAIN',
            `${left.length} barcode${left.length === 1 ? ' is' : 's are'} still shared by several products`,
            {
              duplicateGroups: left.length,
            },
          );
      }
      db.prepare('UPDATE store_settings SET barcode_unique = ? WHERE id = 1').run(enabled ? 1 : 0);
      writeAudit(db, {
        userId: req.auth.id,
        action: enabled ? 'barcodes.enforce.on' : 'barcodes.enforce.off',
        entity: 'settings',
        entityId: 1,
      });
      return status(db);
    });
  });

  // Fold products that share a barcode into one. History is never rewritten (old sales keep pointing at the product they sold), so
  // the retired products are hidden, their stock is moved across as transfers, and their barcode is freed.
  app.post('/products/merge', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const b = parse(mergeBody, req.body);
    if (new Set(b.retireIds).size !== b.retireIds.length || b.retireIds.includes(b.keepId))
      throw E.validation('Each product may appear once, and the one that stays cannot be retired');
    const hash = hashRequest(b);
    const result = inWriteTransaction(db, () => {
      const replay = findReplay(db, MERGE_SCOPE, key, hash);
      if (replay) return { ...replay, replay: true };

      const row = (id: number) =>
        db.prepare('SELECT id, name, barcode, active FROM products WHERE id = ?').get(id) as
          { id: number; name: string; barcode: string; active: number } | undefined;
      const keep = row(b.keepId);
      if (!keep) throw E.notFound('Product');
      if (keep.active !== 1) throw E.unprocessable('PRODUCT_INACTIVE', `"${keep.name}" is hidden, so it cannot be the one that stays`);
      if (keep.barcode === '') throw E.unprocessable('NOT_DUPLICATES', 'Only products that share a barcode can be merged');

      const moved: { id: number; name: string; qty: string }[] = [];
      const levels = db.prepare('SELECT warehouse_id AS w, qty_milli AS q FROM stock_levels WHERE product_id = ? AND qty_milli <> 0');
      const move = db.prepare(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note) VALUES (?, ?, ?, 'transfer', 'merge', ?, ?, ?)`,
      );
      const level = db.prepare(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
      );
      for (const id of b.retireIds) {
        const p = row(id);
        if (!p) throw E.notFound('Product');
        if (p.active !== 1) throw E.unprocessable('PRODUCT_INACTIVE', `"${p.name}" is already hidden`);
        if (p.barcode !== keep.barcode)
          throw E.unprocessable('NOT_DUPLICATES', `"${p.name}" does not have the same barcode as "${keep.name}"`);
        let total = 0;
        for (const l of levels.all(id) as { w: number; q: number }[]) {
          move.run(id, l.w, -l.q, keep.id, req.auth.id, `Merged into "${keep.name}"`);
          level.run(id, l.w, -l.q);
          move.run(keep.id, l.w, l.q, id, req.auth.id, `Merged from "${p.name}"`);
          level.run(keep.id, l.w, l.q);
          total += l.q;
        }
        db.prepare(`UPDATE products SET active = 0, barcode = '', updated_at = ? WHERE id = ?`).run(nowIso(), id);
        moved.push({ id, name: p.name, qty: milliToQty(total) });
      }
      db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(nowIso(), keep.id);
      writeAudit(db, {
        userId: req.auth.id,
        action: 'product.merge',
        entity: 'product',
        entityId: keep.id,
        after: { barcode: keep.barcode, kept: keep.name, retired: moved },
      });
      const body = { keepId: keep.id, barcode: keep.barcode, retired: moved, ...status(db) };
      rememberResponse(db, MERGE_SCOPE, key, hash, 200, body);
      return { statusCode: 200, body: body as unknown, replay: false };
    });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });
}
