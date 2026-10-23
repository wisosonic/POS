import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inWriteTransaction, type Db } from '../../db/open';
import { E } from '../../errors';
import { findReplay, hashRequest, rememberResponse, requireIdempotencyKey } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { defaultWarehouseId } from '../settings/context';

// Stocktake (US-18): count the shelf, then post only the real differences as adjustments. Stock is informational (R2), so none
// of this ever blocks a sale; it keeps the low-stock alerts honest. See migration 0008 for how a count is stored.

const COMMIT_SCOPE = 'POST /stocktakes/{id}/commit';

type Count = {
  id: number;
  name: string;
  status: string;
  created_by: number | null;
  created_at: string;
  finished_by: number | null;
  finished_at: string | null;
};

const qtyText = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Use a number of zero or more, with at most 3 decimals')
  .or(
    z
      .number()
      .min(0)
      .refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, 'At most 3 decimals')
      .transform(String),
  );

const toMilli = (text: string): number => {
  const [whole = '0', frac = ''] = text.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
};

const createBody = z.object({ name: z.string().trim().max(100).default('') });
const lineBody = z.object({
  productId: z.number().int().positive(),
  qty: qtyText,
  /** `set` replaces what was counted for this product; `add` counts more of it (a scan adds one). */
  mode: z.enum(['set', 'add']).default('set'),
});

const getCount = (db: Db, id: number): Count => {
  const c = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id) as Count | undefined;
  if (!c) throw E.notFound('Stocktake');
  return c;
};
const requireOpen = (c: Count) => {
  if (c.status !== 'open')
    throw E.unprocessable(
      'STOCKTAKE_NOT_OPEN',
      `This count is ${c.status === 'committed' ? 'finished' : 'cancelled'} and cannot be changed`,
    );
};

const onHand = (db: Db, productId: number) =>
  (db.prepare('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?').get(productId) as { n: number }).n;

function lines(db: Db, id: number) {
  const rows = db
    .prepare(
      `SELECT l.product_id AS pid, p.name, p.barcode, u.name AS unit_name, l.system_milli AS sys, l.counted_milli AS counted, l.counted_at
       FROM stocktake_lines l JOIN products p ON p.id = l.product_id LEFT JOIN units u ON u.id = p.unit_id
       WHERE l.stocktake_id = ? ORDER BY l.counted_at DESC, p.name`,
    )
    .all(id) as {
    pid: number;
    name: string;
    barcode: string;
    unit_name: string | null;
    sys: number;
    counted: number;
    counted_at: string;
  }[];
  return rows.map((r) => ({
    productId: r.pid,
    name: r.name,
    barcode: r.barcode,
    unitName: r.unit_name,
    systemQty: milliToQty(r.sys),
    countedQty: milliToQty(r.counted),
    differenceQty: milliToQty(r.counted - r.sys),
    countedAt: r.counted_at,
  }));
}

function summary(db: Db, c: Count) {
  const t = db
    .prepare(
      `SELECT count(*) AS n, COALESCE(SUM(counted_milli <> system_milli), 0) AS diffs,
              COALESCE(SUM(CASE WHEN counted_milli > system_milli THEN counted_milli - system_milli ELSE 0 END), 0) AS surplus,
              COALESCE(SUM(CASE WHEN counted_milli < system_milli THEN system_milli - counted_milli ELSE 0 END), 0) AS shortage
       FROM stocktake_lines WHERE stocktake_id = ?`,
    )
    .get(c.id) as { n: number; diffs: number; surplus: number; shortage: number };
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    createdBy: c.created_by,
    createdAt: c.created_at,
    finishedAt: c.finished_at,
    lineCount: t.n,
    differenceCount: t.diffs,
    surplusQty: milliToQty(t.surplus),
    shortageQty: milliToQty(t.shortage),
  };
}

export function registerStocktakeRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  app.get('/stocktakes', manager, async () => ({
    data: (db.prepare('SELECT * FROM stocktakes ORDER BY id DESC LIMIT 100').all() as Count[]).map((c) => summary(db, c)),
  }));

  app.post('/stocktakes', manager, async (req, reply) => {
    const b = parse(createBody, req.body ?? {});
    const id = inWriteTransaction(db, () => {
      const newId = Number(db.prepare('INSERT INTO stocktakes (name, created_by) VALUES (?, ?)').run(b.name, req.auth.id).lastInsertRowid);
      writeAudit(db, { userId: req.auth.id, action: 'stocktake.start', entity: 'stocktake', entityId: newId, after: { name: b.name } });
      return newId;
    });
    return reply.status(201).send({ ...summary(db, getCount(db, id)), lines: [] });
  });

  app.get('/stocktakes/:id', manager, async (req) => {
    const c = getCount(db, Number((req.params as { id: string }).id));
    return { ...summary(db, c), lines: lines(db, c.id) };
  });

  // Count one product. The quantity the system holds right now is kept with the count, so what is posted at the end is only
  // the real difference even though selling went on meanwhile.
  app.put('/stocktakes/:id/lines', manager, async (req) => {
    const c = getCount(db, Number((req.params as { id: string }).id));
    requireOpen(c);
    const b = parse(lineBody, req.body);
    const product = db
      .prepare(
        'SELECT p.id, p.name, u.fractional AS fractional, u.name AS unit_name FROM products p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = ?',
      )
      .get(b.productId) as { id: number; name: string; fractional: number | null; unit_name: string | null } | undefined;
    if (!product) throw E.notFound('Product');
    let milli = toMilli(b.qty);
    if (product.unit_name !== null && product.fractional === 0 && milli % 1000 !== 0)
      throw E.unprocessable('FRACTIONAL_NOT_ALLOWED', `"${product.name}" is counted by the ${product.unit_name} and cannot be split`);

    inWriteTransaction(db, () => {
      const existing = db
        .prepare('SELECT counted_milli AS n FROM stocktake_lines WHERE stocktake_id = ? AND product_id = ?')
        .get(c.id, b.productId) as { n: number } | undefined;
      if (b.mode === 'add' && existing) milli += existing.n;
      db.prepare(
        `INSERT INTO stocktake_lines (stocktake_id, product_id, system_milli, counted_milli) VALUES (?, ?, ?, ?)
         ON CONFLICT (stocktake_id, product_id) DO UPDATE SET system_milli = excluded.system_milli, counted_milli = excluded.counted_milli,
                                                              counted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(c.id, b.productId, onHand(db, b.productId), milli);
    });
    const line = lines(db, c.id).find((l) => l.productId === b.productId)!;
    return { line, ...summary(db, getCount(db, c.id)) };
  });

  app.delete('/stocktakes/:id/lines/:productId', manager, async (req, reply) => {
    const p = req.params as { id: string; productId: string };
    const c = getCount(db, Number(p.id));
    requireOpen(c);
    inWriteTransaction(db, () =>
      db.prepare('DELETE FROM stocktake_lines WHERE stocktake_id = ? AND product_id = ?').run(c.id, Number(p.productId)),
    );
    return reply.status(204).send();
  });

  app.post('/stocktakes/:id/cancel', manager, async (req) => {
    const c = getCount(db, Number((req.params as { id: string }).id));
    requireOpen(c);
    inWriteTransaction(db, () => {
      db.prepare(
        `UPDATE stocktakes SET status = 'cancelled', finished_by = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(req.auth.id, c.id);
      writeAudit(db, { userId: req.auth.id, action: 'stocktake.cancel', entity: 'stocktake', entityId: c.id });
    });
    return summary(db, getCount(db, c.id));
  });

  // Finish the count: every product whose count differs from what the system held when it was counted gets one adjustment.
  // Products that were not counted are left alone (a count of one aisle says nothing about the others).
  app.post('/stocktakes/:id/commit', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const id = Number((req.params as { id: string }).id);
    const hash = hashRequest({ id });
    const result = inWriteTransaction(db, () => {
      const replay = findReplay(db, COMMIT_SCOPE, key, hash);
      if (replay) return { ...replay, replay: true };
      const c = getCount(db, id);
      requireOpen(c);
      const warehouseId = defaultWarehouseId(db);
      const diffs = db
        .prepare(
          'SELECT product_id AS pid, counted_milli - system_milli AS delta FROM stocktake_lines WHERE stocktake_id = ? AND counted_milli <> system_milli',
        )
        .all(id) as { pid: number; delta: number }[];
      const move = db.prepare(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
         VALUES (?, ?, ?, 'adjustment', 'stocktake', ?, ?, ?)`,
      );
      const level = db.prepare(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
      );
      for (const d of diffs) {
        move.run(d.pid, warehouseId, d.delta, id, req.auth.id, `Stocktake ${id}${c.name ? `: ${c.name}` : ''}`);
        level.run(d.pid, warehouseId, d.delta);
      }
      const t = summary(db, c);
      db.prepare(
        `UPDATE stocktakes SET status = 'committed', finished_by = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), idempotency_key = ? WHERE id = ?`,
      ).run(req.auth.id, key, id);
      writeAudit(db, {
        userId: req.auth.id,
        action: 'stocktake.commit',
        entity: 'stocktake',
        entityId: id,
        after: { counted: t.lineCount, adjusted: diffs.length, surplusQty: t.surplusQty, shortageQty: t.shortageQty },
      });
      const body = { ...summary(db, getCount(db, id)), adjusted: diffs.length, lines: lines(db, id) };
      rememberResponse(db, COMMIT_SCOPE, key, hash, 200, body);
      return { statusCode: 200, body: body as unknown, replay: false };
    });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });
}
