import type { FastifyInstance } from 'fastify';
import { parseQtyMilli, usdToLbp, lineTotal } from '@pos/shared';
import { z } from 'zod';
import { inWriteTransaction } from '../../db/open';
import { E } from '../../errors';
import { milliToQty } from '../../util/qty';
import { parse } from '../../util/validate';
import { currentRate } from '../settings/context';

// Held carts (US-07): a cart parked while the cashier serves someone else. There is one till, so every held cart is
// visible to whoever is signed in. A hold is only a note of intent: nothing is reserved and no price is promised,
// so recalling re-checks prices (the till re-prices through POST /sales anyway).

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
  const db = app.db;
  const user = { preHandler: app.authenticate };
  const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

  const itemsOf = (holdId: number) =>
    db
      .prepare(
        `SELECT h.product_id, h.qty_milli, h.price_lbp, p.name, p.barcode, p.price_minor, p.currency, p.active
         FROM hold_items h JOIN products p ON p.id = h.product_id WHERE h.hold_id = ? ORDER BY h.id`,
      )
      .all(holdId) as HoldItemRow[];

  const summary = (h: HoldRow) => {
    const items = itemsOf(h.id);
    const customer = h.customer_id
      ? (db.prepare('SELECT name FROM customers WHERE id = ?').get(h.customer_id) as { name: string } | undefined)
      : undefined;
    const by = h.user_id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(h.user_id) as { name: string } | undefined) : undefined;
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
    if ((db.prepare('SELECT count(*) AS n FROM holds').get() as { n: number }).n >= MAX_OPEN_HOLDS) {
      throw E.unprocessable('TOO_MANY_HOLDS', `There are already ${MAX_OPEN_HOLDS} held carts. Recall or discard some first.`);
    }
    const find = db.prepare('SELECT id FROM products WHERE id = ?');
    for (const i of b.items)
      if (!find.get(i.productId)) throw E.unprocessable('INVALID_REFERENCE', `Product ${i.productId} does not exist`);
    if (b.customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(b.customerId))
      throw E.unprocessable('INVALID_REFERENCE', 'That customer does not exist');

    const id = inWriteTransaction(db, () => {
      const holdId = Number(
        db.prepare('INSERT INTO holds (user_id, customer_id, note) VALUES (?, ?, ?)').run(req.auth.id, b.customerId ?? null, b.note)
          .lastInsertRowid,
      );
      const ins = db.prepare('INSERT INTO hold_items (hold_id, product_id, qty_milli, price_lbp) VALUES (?, ?, ?, ?)');
      for (const i of b.items) ins.run(holdId, i.productId, parseQtyMilli(i.qty), i.priceLbp);
      return holdId;
    });
    return reply.status(201).send(summary(db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow));
  });

  app.get('/holds', user, async () => ({
    data: (db.prepare('SELECT * FROM holds ORDER BY id DESC').all() as HoldRow[]).map(summary),
  }));

  // Take a cart back: it is returned and removed in one step, so two tills (or two taps) cannot both recall it.
  app.post('/holds/:id/recall', user, async (req) => {
    const id = idOf(req);
    return inWriteTransaction(db, () => {
      const h = db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow | undefined;
      if (!h) throw E.notFound('Held cart');
      const rate = currentRate(db);
      const items = itemsOf(id).map((i) => {
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
      db.prepare('DELETE FROM holds WHERE id = ?').run(id); // hold_items go with it (ON DELETE CASCADE)
      return { id: h.id, customerId: h.customer_id, note: h.note, createdAt: h.created_at, items };
    });
  });

  app.delete('/holds/:id', user, async (req, reply) => {
    const r = db.prepare('DELETE FROM holds WHERE id = ?').run(idOf(req));
    if (r.changes === 0) throw E.notFound('Held cart');
    return reply.status(204).send();
  });
}
