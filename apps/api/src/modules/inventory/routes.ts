import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param, Queryable } from '../../db/adapter';
import { E } from '../../errors';
import { milliToQty, qtyNumberToMilli } from '../../util/qty';
import { writeAuditQ } from '../audit/service';
import { defaultWarehouseIdQ } from '../settings/context';
import { parse } from '../../util/validate';
import { registerStocktakeRoutes } from './stocktake';

// Stock is informational (decision R2): it tells the owner what to reorder and never blocks a sale or a purchase.

type StockRow = { id: number; name: string; receipt_name: string | null; total_milli: number; threshold_milli: number | null };

const STOCK = `
  SELECT p.id, p.name, p.receipt_name, p.stock_alert_milli AS threshold_milli,
         COALESCE(SUM(l.qty_milli), 0) AS total_milli
  FROM products p LEFT JOIN stock_levels l ON l.product_id = p.id`;

const stockJson = (r: StockRow) => ({
  productId: r.id,
  name: r.name,
  receiptName: r.receipt_name,
  qty: milliToQty(r.total_milli),
  threshold: r.threshold_milli === null ? null : r.threshold_milli / 1000,
});

/**
 * Active products with a threshold whose quantity is at or below it, most urgent first.
 * HAVING and ORDER BY repeat the sum instead of using its alias, and the floor of 1000 is a CASE, not a two-argument MAX(),
 * because those two shortcuts only work on SQLite (the query must run unchanged on PostgreSQL later).
 */
export async function lowStock(q: Queryable): Promise<ReturnType<typeof stockJson>[]> {
  const rows = await q.all<StockRow>(
    `${STOCK}
       WHERE p.active = 1 AND p.stock_alert_milli IS NOT NULL
       GROUP BY p.id
       HAVING COALESCE(SUM(l.qty_milli), 0) <= p.stock_alert_milli
       ORDER BY COALESCE(SUM(l.qty_milli), 0) * 1.0 / CASE WHEN p.stock_alert_milli > 1000 THEN p.stock_alert_milli ELSE 1000 END, p.name`,
  );
  return rows.map(stockJson);
}

const adjustmentBody = z.object({
  productId: z.number().int().positive(),
  /** Plus adds stock, minus removes it. Up to 3 decimals. As a string it is exact; as a number it must not exceed 3 decimals. */
  qtyDelta: z.union([z.string().regex(/^-?\d+(\.\d{1,3})?$/, 'Use a number with at most 3 decimals'), z.number()]),
  reason: z.string().trim().min(1, 'A reason is required').max(200),
});

const stockQuery = z.object({
  productId: z.coerce.number().int().positive().optional(),
  lowOnly: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export default async function inventoryRoutes(app: FastifyInstance) {
  const db = app.database;
  const read = { preHandler: app.authenticate };

  app.get('/stock', read, async (req) => {
    const q = parse(stockQuery, req.query);
    if (q.lowOnly === 'true') return { data: await lowStock(db), nextCursor: null };

    const where: string[] = ['p.active = 1'];
    const params: Param[] = [];
    if (q.productId) {
      where.push('p.id = ?');
      params.push(q.productId);
    }
    if (q.cursor) {
      where.push('p.id > ?');
      params.push(q.cursor);
    }
    const rows = await db.all<StockRow>(`${STOCK} WHERE ${where.join(' AND ')} GROUP BY p.id ORDER BY p.id LIMIT ?`, [
      ...params,
      q.limit + 1,
    ]);
    const page = rows.slice(0, q.limit);
    return { data: page.map(stockJson), nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  // A manager corrects the quantity (a miscount, damage, a gift). It is a ledger entry, never an edit of history.
  app.post('/stock/adjustments', { preHandler: app.requireRole('manager') }, async (req, reply) => {
    const b = parse(adjustmentBody, req.body);
    const delta = typeof b.qtyDelta === 'string' ? Math.round(Number(b.qtyDelta) * 1000) : qtyNumberToMilli(b.qtyDelta);
    if (delta === null || delta === 0) throw E.validation('qtyDelta must be a non-zero number with at most 3 decimals');
    if (!(await db.one('SELECT 1 FROM products WHERE id = ?', [b.productId]))) throw E.notFound('Product');

    const result = await db.tx(async (tx) => {
      const warehouseId = await defaultWarehouseIdQ(tx);
      const created = await tx.one<{ id: number }>(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, user_id, note) VALUES (?, ?, ?, 'adjustment', 'adjustment', ?, ?) RETURNING id`,
        [b.productId, warehouseId, delta, req.auth.id, b.reason],
      );
      await tx.run(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
        [b.productId, warehouseId, delta],
      );
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'stock.adjust',
        entity: 'product',
        entityId: b.productId,
        after: { qtyDelta: milliToQty(delta), reason: b.reason },
      });
      return created!.id;
    });
    const row = (await db.one<StockRow>(`${STOCK} WHERE p.id = ? GROUP BY p.id`, [b.productId]))!;
    return reply.status(201).send({ movementId: result, ...stockJson(row), qtyDelta: milliToQty(delta), reason: b.reason });
  });

  // The ledger behind a product's quantity: every sale, return, purchase and adjustment, newest first.
  app.get('/stock/:productId/movements', { preHandler: app.requireRole('manager') }, async (req) => {
    const productId = Number((req.params as { productId: string }).productId);
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    const rows = await db.all<{
      id: number;
      qty_milli_delta: number;
      reason: string;
      ref_type: string | null;
      ref_id: number | null;
      user_id: number | null;
      note: string | null;
      created_at: string;
    }>(
      `SELECT id, qty_milli_delta, reason, ref_type, ref_id, user_id, note, created_at FROM stock_movements
         WHERE product_id = ? ${q.cursor ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      [productId, ...(q.cursor ? [q.cursor] : []), q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((m) => ({
        id: m.id,
        qtyDelta: milliToQty(m.qty_milli_delta),
        reason: m.reason,
        refType: m.ref_type,
        refId: m.ref_id,
        userId: m.user_id,
        note: m.note,
        createdAt: m.created_at,
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // Cashiers can read alerts so the till can show a badge. Thresholds are edited on the product (managers only).
  app.get('/stock/alerts', read, async () => ({ data: await lowStock(db) }));

  registerStocktakeRoutes(app);
}
