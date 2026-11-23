import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/adapter';
import { E } from '../../errors';
import { findReplayQ, hashRequest, rememberResponseQ, requireIdempotencyKey } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { nowIso } from '../../util/time';
import { parse } from '../../util/validate';
import { writeAuditQ } from '../audit/service';
import { defaultWarehouseIdQ } from '../settings/context';

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

const getCount = async (q: Queryable, id: number): Promise<Count> => {
  const c = await q.one<Count>('SELECT * FROM stocktakes WHERE id = ? AND deleted_at IS NULL', [id]);
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

const onHand = async (q: Queryable, productId: number) =>
  (await q.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM stock_levels WHERE product_id = ?', [productId]))!.n;

async function lines(q: Queryable, id: number) {
  const rows = await q.all<{
    pid: number;
    name: string;
    barcode: string;
    unit_name: string | null;
    sys: number;
    counted: number;
    counted_at: string;
  }>(
    `SELECT l.product_id AS pid, p.name, p.barcode, u.name AS unit_name, l.system_milli AS sys, l.counted_milli AS counted, l.counted_at
       FROM stocktake_lines l JOIN products p ON p.id = l.product_id LEFT JOIN units u ON u.id = p.unit_id
       WHERE l.stocktake_id = ? ORDER BY l.counted_at DESC, p.name`,
    [id],
  );
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

async function summary(q: Queryable, c: Count) {
  const t = (await q.one<{ n: number; diffs: number; surplus: number; shortage: number }>(
    `SELECT count(*) AS n, COALESCE(SUM(CASE WHEN counted_milli <> system_milli THEN 1 ELSE 0 END), 0) AS diffs,
              COALESCE(SUM(CASE WHEN counted_milli > system_milli THEN counted_milli - system_milli ELSE 0 END), 0) AS surplus,
              COALESCE(SUM(CASE WHEN counted_milli < system_milli THEN system_milli - counted_milli ELSE 0 END), 0) AS shortage
       FROM stocktake_lines WHERE stocktake_id = ?`,
    [c.id],
  ))!;
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
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };

  app.get('/stocktakes', manager, async () => {
    const counts = await db.all<Count>('SELECT * FROM stocktakes WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 100');
    const data = [];
    for (const c of counts) data.push(await summary(db, c));
    return { data };
  });

  app.post('/stocktakes', manager, async (req, reply) => {
    const b = parse(createBody, req.body ?? {});
    const id = await db.tx(async (tx) => {
      const created = await tx.one<{ id: number }>('INSERT INTO stocktakes (name, created_by) VALUES (?, ?) RETURNING id', [
        b.name,
        req.auth.id,
      ]);
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'stocktake.start',
        entity: 'stocktake',
        entityId: created!.id,
        after: { name: b.name },
      });
      return created!.id;
    });
    return reply.status(201).send({ ...(await summary(db, await getCount(db, id))), lines: [] });
  });

  app.get('/stocktakes/:id', manager, async (req) => {
    const c = await getCount(db, Number((req.params as { id: string }).id));
    return { ...(await summary(db, c)), lines: await lines(db, c.id) };
  });

  // Count one product. The quantity the system holds right now is kept with the count, so what is posted at the end is only
  // the real difference even though selling went on meanwhile.
  app.put('/stocktakes/:id/lines', manager, async (req) => {
    const c = await getCount(db, Number((req.params as { id: string }).id));
    requireOpen(c);
    const b = parse(lineBody, req.body);
    const product = await db.one<{ id: number; name: string; fractional: number | null; unit_name: string | null }>(
      'SELECT p.id, p.name, u.fractional AS fractional, u.name AS unit_name FROM products p LEFT JOIN units u ON u.id = p.unit_id WHERE p.id = ?',
      [b.productId],
    );
    if (!product) throw E.notFound('Product');
    let milli = toMilli(b.qty);
    if (product.unit_name !== null && product.fractional === 0 && milli % 1000 !== 0)
      throw E.unprocessable('FRACTIONAL_NOT_ALLOWED', `"${product.name}" is counted by the ${product.unit_name} and cannot be split`);

    await db.tx(async (tx) => {
      const existing = await tx.one<{ n: number }>(
        'SELECT counted_milli AS n FROM stocktake_lines WHERE stocktake_id = ? AND product_id = ?',
        [c.id, b.productId],
      );
      if (b.mode === 'add' && existing) milli += existing.n;
      await tx.run(
        `INSERT INTO stocktake_lines (stocktake_id, product_id, system_milli, counted_milli, counted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (stocktake_id, product_id) DO UPDATE SET system_milli = excluded.system_milli, counted_milli = excluded.counted_milli,
                                                              counted_at = excluded.counted_at`,
        [c.id, b.productId, await onHand(tx, b.productId), milli, nowIso()],
      );
    });
    const line = (await lines(db, c.id)).find((l) => l.productId === b.productId)!;
    return { line, ...(await summary(db, await getCount(db, c.id))) };
  });

  app.delete('/stocktakes/:id/lines/:productId', manager, async (req, reply) => {
    const p = req.params as { id: string; productId: string };
    const c = await getCount(db, Number(p.id));
    requireOpen(c);
    await db.run('DELETE FROM stocktake_lines WHERE stocktake_id = ? AND product_id = ?', [c.id, Number(p.productId)]);
    return reply.status(204).send();
  });

  app.post('/stocktakes/:id/cancel', manager, async (req) => {
    const c = await getCount(db, Number((req.params as { id: string }).id));
    requireOpen(c);
    await db.tx(async (tx) => {
      await tx.run(`UPDATE stocktakes SET status = 'cancelled', finished_by = ?, finished_at = ? WHERE id = ?`, [
        req.auth.id,
        nowIso(),
        c.id,
      ]);
      await writeAuditQ(tx, { userId: req.auth.id, action: 'stocktake.cancel', entity: 'stocktake', entityId: c.id });
    });
    return summary(db, await getCount(db, c.id));
  });

  // "Deleting" a count takes it off the list and no further. The count, its lines and the adjustments a finished one posted to the
  // stock ledger all stay (the ledger is never rewritten, and it names the count that caused each adjustment). A count still being
  // made is cancelled in the same step, so nothing is posted.
  app.delete('/stocktakes/:id', manager, async (req, reply) => {
    const c = await getCount(db, Number((req.params as { id: string }).id));
    await db.tx(async (tx) => {
      const now = new Date().toISOString();
      if (c.status === 'open')
        await tx.run("UPDATE stocktakes SET status = 'cancelled', finished_by = ?, finished_at = ?, deleted_at = ? WHERE id = ?", [
          req.auth.id,
          now,
          now,
          c.id,
        ]);
      else await tx.run('UPDATE stocktakes SET deleted_at = ? WHERE id = ?', [now, c.id]);
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'stocktake.delete',
        entity: 'stocktake',
        entityId: c.id,
        before: { name: c.name, status: c.status },
      });
    });
    return reply.status(204).send();
  });

  // Finish the count: every product whose count differs from what the system held when it was counted gets one adjustment.
  // Products that were not counted are left alone (a count of one aisle says nothing about the others).
  app.post('/stocktakes/:id/commit', manager, async (req, reply) => {
    const key = requireIdempotencyKey(req);
    const id = Number((req.params as { id: string }).id);
    const hash = hashRequest({ id });
    const result = await db.tx(async (tx) => {
      const replay = await findReplayQ(tx, COMMIT_SCOPE, key, hash);
      if (replay) return { ...replay, replay: true };
      const c = await getCount(tx, id);
      requireOpen(c);
      const warehouseId = await defaultWarehouseIdQ(tx);
      const diffs = await tx.all<{ pid: number; delta: number }>(
        'SELECT product_id AS pid, counted_milli - system_milli AS delta FROM stocktake_lines WHERE stocktake_id = ? AND counted_milli <> system_milli',
        [id],
      );
      for (const d of diffs) {
        await tx.run(
          `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
         VALUES (?, ?, ?, 'adjustment', 'stocktake', ?, ?, ?)`,
          [d.pid, warehouseId, d.delta, id, req.auth.id, `Stocktake ${id}${c.name ? `: ${c.name}` : ''}`],
        );
        await tx.run(
          `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
         ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
          [d.pid, warehouseId, d.delta],
        );
      }
      const t = await summary(tx, c);
      await tx.run(`UPDATE stocktakes SET status = 'committed', finished_by = ?, finished_at = ?, idempotency_key = ? WHERE id = ?`, [
        req.auth.id,
        nowIso(),
        key,
        id,
      ]);
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'stocktake.commit',
        entity: 'stocktake',
        entityId: id,
        after: { counted: t.lineCount, adjusted: diffs.length, surplusQty: t.surplusQty, shortageQty: t.shortageQty },
      });
      const body = { ...(await summary(tx, await getCount(tx, id))), adjusted: diffs.length, lines: await lines(tx, id) };
      await rememberResponseQ(tx, COMMIT_SCOPE, key, hash, 200, body);
      return { statusCode: 200, body: body as unknown, replay: false };
    });
    if (result.replay) void reply.header('Idempotent-Replay', 'true');
    return reply.status(result.statusCode).send(result.body);
  });
}
