import type { Queryable } from '@pos/core/adapter';

// The central stock view's two suggestions (docs/15 §8, P5f). HQ only SUGGESTS: it never buys, ships or moves anything by itself (decision #32). Every
// figure comes from what the branches sent (stock movements, sales, shipments) and from HQ's own orders and requests, so nothing here is stored.

type Key = string;
const k = (productId: number, branchId: number): Key => `${productId}:${branchId}`;

export type BranchKind = { id: number; name: string; kind: 'sale' | 'stock' };

const activeBranches = (q: Queryable) => q.all<BranchKind>(`SELECT id, name, kind FROM branches WHERE active = 1 ORDER BY id`);

/** What each branch holds of each product, from the movements it sent. */
async function onHand(q: Queryable): Promise<Map<Key, number>> {
  const rows = await q.all<{ product_id: number; branch_id: number; qty: number }>(
    'SELECT product_id, branch_id, SUM(qty_milli_delta) AS qty FROM stock_movements GROUP BY product_id, branch_id',
  );
  return new Map(rows.map((r) => [k(r.product_id, r.branch_id), r.qty]));
}

/** Shipped and not yet received, by receiving branch (the same rule as the stock report: a shipment HQ cannot deliver is not counted). */
async function inTransit(q: Queryable): Promise<Map<Key, number>> {
  const rows = await q.all<{ branch_id: number; product_id: number; qty: number }>(
    `SELECT i.to_branch_id AS branch_id, x.product_id, SUM(x.qty_milli) AS qty
       FROM incoming_shipment_items x JOIN incoming_shipments i ON i.id = x.incoming_id
            JOIN branch_directory d ON d.id = i.to_branch_id AND d.active = 1 AND d.id <> i.from_branch_id
      WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.branch_id = i.to_branch_id AND r.incoming_id = i.id)
      GROUP BY i.to_branch_id, x.product_id`,
  );
  return new Map(rows.map((r) => [k(r.product_id, r.branch_id), r.qty]));
}

/** Ordered by HQ and not yet received at a stock branch: what is still to arrive on placed orders (docs/15 §6). */
export async function onOrder(q: Queryable): Promise<Map<Key, number>> {
  const rows = await q.all<{ branch_id: number; product_id: number; outstanding: number }>(
    `SELECT l.stock_branch_id AS branch_id, l.product_id,
            l.qty_milli - COALESCE((SELECT SUM(ri.qty_milli) FROM po_receipt_items ri JOIN expected_delivery_items i ON i.id = ri.item_id
                                     WHERE i.line_id = l.id AND ri.branch_id = l.stock_branch_id), 0) AS outstanding
       FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id
      WHERE o.status = 'ordered'`,
  );
  const m = new Map<Key, number>();
  for (const r of rows)
    if (r.outstanding > 0) m.set(k(r.product_id, r.branch_id), (m.get(k(r.product_id, r.branch_id)) ?? 0) + r.outstanding);
  return m;
}

const products = (q: Queryable) =>
  q.all<{ id: number; name: string; barcode: string; stock_alert_milli: number | null }>(
    'SELECT id, name, barcode, stock_alert_milli FROM products WHERE active = 1 ORDER BY name, id',
  );

// ---------------------------------------------------------------- reorder

export type ReorderRow = {
  productId: number;
  name: string;
  barcode: string;
  branchId: number;
  branch: string;
  alertMilli: number;
  qtyMilli: number;
  inTransitMilli: number;
  onOrderMilli: number;
  /** What would bring the branch back to twice the alert. */
  suggestMilli: number;
  /** What shops asked for in the last 30 days that no stock branch could supply (chain-wide, a reason to buy more). */
  unmetMilli: number;
};

/**
 * Which stock branches should have more, and how much. A stock branch is LOW when what it holds, plus what is on the way to it and on order for it,
 * is at or under the product's alert. The suggestion brings that position back to twice the alert. Products with no alert are never suggested
 * (the alert is how the owner says "tell me").
 */
export async function reorderSuggestions(q: Queryable, opts: { branchId?: number; limit: number; now?: Date }): Promise<ReorderRow[]> {
  const stockBranches = (await activeBranches(q)).filter(
    (b) => b.kind === 'stock' && (opts.branchId === undefined || b.id === opts.branchId),
  );
  if (stockBranches.length === 0) return [];
  const [held, moving, ordered, list] = await Promise.all([onHand(q), inTransit(q), onOrder(q), products(q)]);
  const since = new Date((opts.now ?? new Date()).getTime() - 30 * 86_400_000).toISOString();
  const unmetRows = await q.all<{ product_id: number; n: number }>(
    `SELECT s.product_id, SUM(s.unavailable_milli) AS n FROM request_status s
       JOIN stock_requests r ON r.branch_id = s.for_branch_id AND r.id = s.request_id
      WHERE s.unavailable_milli > 0 AND r.created_at >= ? GROUP BY s.product_id`,
    [since],
  );
  const unmet = new Map(unmetRows.map((r) => [r.product_id, r.n]));
  const out: ReorderRow[] = [];
  for (const p of list) {
    if (p.stock_alert_milli === null) continue;
    for (const b of stockBranches) {
      const qty = held.get(k(p.id, b.id)) ?? 0;
      const moving1 = moving.get(k(p.id, b.id)) ?? 0;
      const ordered1 = ordered.get(k(p.id, b.id)) ?? 0;
      const position = qty + moving1 + ordered1;
      if (position > p.stock_alert_milli) continue;
      out.push({
        productId: p.id,
        name: p.name,
        barcode: p.barcode,
        branchId: b.id,
        branch: b.name,
        alertMilli: p.stock_alert_milli,
        qtyMilli: qty,
        inTransitMilli: moving1,
        onOrderMilli: ordered1,
        suggestMilli: Math.max(0, 2 * p.stock_alert_milli - position),
        unmetMilli: unmet.get(p.id) ?? 0,
      });
    }
  }
  out.sort((a, b) => b.suggestMilli - a.suggestMilli || a.name.localeCompare(b.name) || a.branchId - b.branchId);
  return out.slice(0, opts.limit);
}

// ---------------------------------------------------------------- rebalance

export type Cover = { windowDays: number; slowDays: number; fastDays: number; targetDays: number };
export const DEFAULT_COVER: Cover = { windowDays: 30, slowDays: 60, fastDays: 7, targetDays: 30 };

export type RebalanceRow = {
  productId: number;
  name: string;
  branchId: number;
  branch: string;
  qtyMilli: number;
  /** Sold per day over the window. */
  perDayMilli: number;
  /** Days the stock lasts at that pace; null when nothing sold. */
  coverDays: number | null;
  /** To send back to a stock branch (`sendBack`) or to ask a stock branch for (`requestMore`). */
  suggestMilli: number;
};

/**
 * Slow at one shop, fast at another (docs/15 §8, decision #32). Stock never moves from shop to shop: a slow shop SENDS BACK what it will not sell to a
 * stock branch, and a fast shop REQUESTS more from the stock branches. HQ lists both; each branch manager decides.
 * - sends back: stock lasts more than `slowDays` at the pace of the window; it keeps `targetDays` of cover (and never less than the product's alert).
 * - requests more: stock lasts `fastDays` or less; the suggestion fills it to `targetDays`, less what is on the way to it or already requested.
 * Sales are gross of returns (a return is not a lower pace of demand worth acting on); sales of voided sales are out.
 */
export async function rebalanceSuggestions(q: Queryable, opts: { cover?: Partial<Cover>; branchId?: number; limit: number; now?: Date }) {
  const c: Cover = { ...DEFAULT_COVER, ...opts.cover };
  const shops = (await activeBranches(q)).filter((b) => b.kind === 'sale' && (opts.branchId === undefined || b.id === opts.branchId));
  if (shops.length === 0) return { sendBack: [] as RebalanceRow[], requestMore: [] as RebalanceRow[] };
  const [held, moving, list] = await Promise.all([onHand(q), inTransit(q), products(q)]);
  const since = new Date((opts.now ?? new Date()).getTime() - c.windowDays * 86_400_000).toISOString();
  const soldRows = await q.all<{ branch_id: number; product_id: number; qty: number }>(
    `SELECT s.branch_id, i.product_id, SUM(i.qty_milli) AS qty
       FROM sale_items i JOIN sales s ON s.branch_id = i.branch_id AND s.id = i.sale_id
      WHERE s.status <> 'void' AND i.product_id IS NOT NULL AND s.created_at >= ?
      GROUP BY s.branch_id, i.product_id`,
    [since],
  );
  const sold = new Map(soldRows.map((r) => [k(r.product_id, r.branch_id), r.qty]));
  // What a shop has asked for and is still waiting for (routing, picking or on its way) is not asked for again.
  const waitingRows = await q.all<{ for_branch_id: number; product_id: number; n: number }>(
    `SELECT for_branch_id, product_id, SUM(wanted_milli - shipped_milli - unavailable_milli) AS n FROM request_status
      WHERE status <> 'done' GROUP BY for_branch_id, product_id`,
  );
  const waiting = new Map(waitingRows.map((r) => [k(r.product_id, r.for_branch_id), Math.max(0, r.n)]));

  const sendBack: RebalanceRow[] = [];
  const requestMore: RebalanceRow[] = [];
  for (const p of list) {
    for (const b of shops) {
      const qty = held.get(k(p.id, b.id)) ?? 0;
      const total = sold.get(k(p.id, b.id)) ?? 0;
      if (qty <= 0 && total === 0) continue;
      const perDay = total / c.windowDays;
      const base: Omit<RebalanceRow, 'suggestMilli'> = {
        productId: p.id,
        name: p.name,
        branchId: b.id,
        branch: b.name,
        qtyMilli: qty,
        perDayMilli: Math.round(perDay),
        coverDays: perDay > 0 ? Math.round((qty / perDay) * 10) / 10 : null,
      };
      const cover = perDay > 0 ? qty / perDay : Infinity;
      if (qty > 0 && cover > c.slowDays) {
        const keep = Math.max(Math.ceil(perDay * c.targetDays), p.stock_alert_milli ?? 0);
        const extra = qty - keep;
        if (extra > 0) sendBack.push({ ...base, suggestMilli: extra });
      } else if (perDay > 0 && cover <= c.fastDays) {
        const coming = (moving.get(k(p.id, b.id)) ?? 0) + (waiting.get(k(p.id, b.id)) ?? 0);
        const need = Math.ceil(perDay * c.targetDays) - qty - coming;
        if (need > 0) requestMore.push({ ...base, suggestMilli: need });
      }
    }
  }
  const order = (a: RebalanceRow, b: RebalanceRow) =>
    b.suggestMilli - a.suggestMilli || a.name.localeCompare(b.name) || a.branchId - b.branchId;
  return { sendBack: sendBack.sort(order).slice(0, opts.limit), requestMore: requestMore.sort(order).slice(0, opts.limit) };
}
