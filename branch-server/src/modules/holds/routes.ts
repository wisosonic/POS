import type { FastifyInstance } from 'fastify';
import { parseQtyMilli, usdToLbp, lineTotal } from '@pos/shared';
import { z } from 'zod';
import type { Queryable } from '../../db/adapter';
import { E } from '../../errors';
import { milliToQty } from '../../util/qty';
import { parse } from '../../util/validate';
import { currentRateQ } from '../settings/context';

// Held carts (US-07): a cart parked while the cashier serves someone else. There is one till, so every held cart is
// visible to whoever is signed in. A hold is only a note of intent: nothing is reserved and no price is promised,
// so recalling re-checks prices (the till re-prices through POST /sales anyway).
//
// First module on the portable database adapter (docs/11-multi-branch.md §4): no better-sqlite3, no lastInsertRowid.

const MAX_OPEN_HOLDS = 100;

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

const holdBody = z.object({
  customerId: z.number().int().positive().nullish(),
  note: z.string().trim().max(200).default(''),
  items: z
    .array(z.object({ productId: z.number().int().positive(), qty, priceLbp: z.number().int().min(0) }))
    .min(1, 'A held cart needs at least one item')
    .max(200),
});

type HoldRow = { id: number; user_id: number | null; customer_id: number | null; note: string; created_at: string };
type HoldItemRow = {
  product_id: number;
  qty_milli: number;
  price_lbp: number;
  name: string;
  barcode: string;
  price_minor: number;
  currency: 'USD' | 'LBP';
  active: number;
};

export default async function holdRoutes(app: FastifyInstance) {
  const db = app.database;
  const user = { preHandler: app.authenticate };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  const itemsOf = (q: Queryable, holdId: number) =>
    q.all<HoldItemRow>(
      `SELECT h.product_id, h.qty_milli, h.price_lbp, p.name, p.barcode, p.price_minor, p.currency, p.active
         FROM hold_items h JOIN products p ON p.id = h.product_id WHERE h.hold_id = ? ORDER BY h.id`,
      [holdId],
    );

  const summary = async (q: Queryable, h: HoldRow) => {
    const items = await itemsOf(q, h.id);
    const customer = h.customer_id ? await q.one<{ name: string }>('SELECT name FROM customers WHERE id = ?', [h.customer_id]) : undefined;
    const by = h.user_id ? await q.one<{ name: string }>('SELECT name FROM users WHERE id = ?', [h.user_id]) : undefined;
    return {
      id: h.id,
      userId: h.user_id,
      userName: by?.name ?? null,
      customerId: h.customer_id,
      customerName: customer?.name ?? null,
      note: h.note,
      createdAt: h.created_at,
      itemCount: items.length,
      totalLbp: items.reduce((sum, i) => sum + lineTotal(i.price_lbp, milliToQty(i.qty_milli)), 0),
      items: items.map((i) => ({ productId: i.product_id, name: i.name, qty: milliToQty(i.qty_milli), priceLbp: i.price_lbp })),
    };
  };

  app.post('/holds', user, async (req, reply) => {
    const b = parse(holdBody, req.body);
    const open = await db.one<{ n: number }>('SELECT count(*) AS n FROM holds');
    if ((open?.n ?? 0) >= MAX_OPEN_HOLDS) {
      throw E.unprocessable('TOO_MANY_HOLDS', `There are already ${MAX_OPEN_HOLDS} held carts. Recall or discard some first.`);
    }
    for (const i of b.items)
      if (!(await db.one('SELECT id FROM products WHERE id = ?', [i.productId])))
        throw E.unprocessable('INVALID_REFERENCE', `Product ${i.productId} does not exist`);
    if (b.customerId && !(await db.one('SELECT 1 FROM customers WHERE id = ? AND deleted_at IS NULL', [b.customerId])))
      throw E.unprocessable('INVALID_REFERENCE', 'That customer does not exist');

    const quantities = b.items.map((i) => parseQtyMilli(i.qty)); // parse before the transaction
    const created = await db.tx(async (tx) => {
      const row = await tx.one<{ id: number }>('INSERT INTO holds (user_id, customer_id, note) VALUES (?, ?, ?) RETURNING id', [
        req.auth.id,
        b.customerId ?? null,
        b.note,
      ]);
      const holdId = row!.id;
      for (const [n, i] of b.items.entries())
        await tx.run('INSERT INTO hold_items (hold_id, product_id, qty_milli, price_lbp) VALUES (?, ?, ?, ?)', [
          holdId,
          i.productId,
          quantities[n]!,
          i.priceLbp,
        ]);
      return holdId;
    });
    const hold = (await db.one<HoldRow>('SELECT * FROM holds WHERE id = ?', [created]))!;
    return reply.status(201).send(await summary(db, hold));
  });

  app.get('/holds', user, async () => {
    const holds = await db.all<HoldRow>('SELECT * FROM holds ORDER BY id DESC');
    return { data: await Promise.all(holds.map((h) => summary(db, h))) };
  });

  // Take a cart back: it is returned and removed in one step, so two tills (or two taps) cannot both recall it.
  app.post('/holds/:id/recall', user, async (req) => {
    const id = idOf(req);
    return db.tx(async (tx) => {
      const h = await tx.one<HoldRow>('SELECT * FROM holds WHERE id = ?', [id]);
      if (!h) throw E.notFound('Held cart');
      const rate = await currentRateQ(tx);
      const items = (await itemsOf(tx, id)).map((i) => {
        const currentPriceLbp = i.currency === 'LBP' ? i.price_minor : usdToLbp(i.price_minor, rate);
        return {
          productId: i.product_id,
          name: i.name,
          barcode: i.barcode,
          qty: milliToQty(i.qty_milli),
          priceLbp: i.price_lbp,
          currentPriceLbp,
          priceChanged: currentPriceLbp !== i.price_lbp,
          active: i.active === 1,
        };
      });
      await tx.run('DELETE FROM holds WHERE id = ?', [id]); // hold_items go with it (ON DELETE CASCADE)
      return { id: h.id, customerId: h.customer_id, note: h.note, createdAt: h.created_at, items };
    });
  });

  app.delete('/holds/:id', user, async (req, reply) => {
    const r = await db.run('DELETE FROM holds WHERE id = ?', [idOf(req)]);
    if (r.changes === 0) throw E.notFound('Held cart');
    return reply.status(204).send();
  });
}
