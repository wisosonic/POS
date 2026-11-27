import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parse } from '../../util/validate';
import { resolveTerminal, TERMINAL_HEADER } from '../terminals/service';

/**
 * `GET /ping` (docs/14-connection-and-till-backend.md §3): the till's heartbeat and its change detector in one small call. The answer
 * has no business data: whether the server is up, its clock, its `epoch`, and one version number per topic. A till that cannot get an
 * answer stops selling; one that sees a different number fetches that topic.
 *
 * It is not an open door (rule 19): it needs a **device token** (`X-Terminal-Token`) that belongs to an active till, because the till
 * pings before anyone has signed in. There is no legacy "no token" shortcut here: a till that is to be watched must be enrolled.
 */
type CatalogRow = {
  id: number;
  name: string;
  receipt_name: string | null;
  receipt_name_manual: number;
  barcode: string;
  price_minor: number;
  currency: 'USD' | 'LBP';
  category_id: number | null;
  brand_id: number | null;
  unit_id: number | null;
  image_path: string | null;
  active: number;
  updated_at: string;
  unit_name: string | null;
  fractional: number | null;
};

/**
 * What a till keeps of a product (docs/14 §4). It has the same shape as `GET /products/sync` so the screens read it unchanged, but the
 * fields a till does not need are withheld, not copied: the cost, the stock quantity, the supplier and the alert threshold stay on the
 * branch server (a till PC holds prices only; the copy is read-only and never prices a sale, rule 2).
 */
const catalogJson = (r: CatalogRow) => ({
  id: r.id,
  name: r.name,
  receiptName: r.receipt_name,
  receiptNameManual: r.receipt_name_manual === 1,
  barcode: r.barcode,
  costMinor: 0,
  priceMinor: r.price_minor,
  currency: r.currency,
  categoryId: r.category_id,
  brandId: r.brand_id,
  unitId: r.unit_id,
  supplierId: null,
  stockAlert: null,
  expiryDate: null,
  imagePath: r.image_path,
  active: r.active === 1,
  qty: '0',
  unitName: r.unit_name,
  fractional: r.fractional === 1,
  updatedAt: r.updated_at,
});

const catalogQuery = z.object({
  since: z.string().max(40).optional(),
  afterId: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export default async function pingRoutes(app: FastifyInstance) {
  // The device token is the only credential here (a till pings before anyone has signed in).
  const deviceGuard = {
    preHandler: async (req: FastifyRequest) => {
      const raw = req.headers[TERMINAL_HEADER];
      if (typeof raw !== 'string' || !raw) throw new AppError(401, 'TERMINAL_REQUIRED', 'A till must send its device token');
      req.terminal = await resolveTerminal(app.database, raw);
    },
  };

  app.get('/ping', deviceGuard, async () => ({
    ok: true,
    serverTime: new Date().toISOString(),
    epoch: app.versions.epoch,
    versions: app.versions.snapshot(),
  }));

  /**
   * `GET /terminal/catalog` (docs/14 §4): the paged feed the till's own server copies onto its disk, in the order `(updated_at, id)` like
   * `/products/sync`: ask with `since` and `afterId`, the answer says where the next page starts (`next`, null on the last page).
   * Deactivated products come too (`active: false`), so the copy can drop them. `serverTime` is the moment this page was asked for: the
   * copy keeps the first page's as its watermark. It needs the device token and no sign-in, and answers no cost or stock.
   */
  app.get('/terminal/catalog', deviceGuard, async (req) => {
    const q = parse(catalogQuery, req.query);
    const serverTime = new Date().toISOString();
    const since = q.since ?? '';
    const after = q.afterId === undefined ? 'p.updated_at > ?' : '(p.updated_at, p.id) > (?, ?)';
    const params: (string | number)[] = q.afterId === undefined ? [since] : [since, q.afterId];
    const rows = await app.database.all<CatalogRow>(
      `SELECT p.id, p.name, p.receipt_name, p.receipt_name_manual, p.barcode, p.price_minor, p.currency, p.category_id, p.brand_id,
              p.unit_id, p.image_path, p.active, p.updated_at, u.name AS unit_name, u.fractional AS fractional
         FROM products p LEFT JOIN units u ON u.id = p.unit_id
        WHERE ${after} ORDER BY p.updated_at, p.id LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const next = rows.length > q.limit && last ? { since: last.updated_at, afterId: last.id } : null;
    return { data: page.map(catalogJson), serverTime, next };
  });
}
