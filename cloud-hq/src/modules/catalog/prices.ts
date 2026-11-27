import type { Queryable } from '@pos/core/adapter';
import { AppError } from '@pos/core/errors';
import { hqAudit } from '../branches/service';

// Branch price overrides at HQ (docs/12 §20, P3c). A branch may sell a product at its own price. HQ keeps the override; the branch is never told
// "there is an override": every change writes a change_log line meant for THAT branch only, and the branch then reads the product as it is for it
// (the override if there is one, else the base price: `facts/service.ts`). Setting or removing one writes the row, the line and an audit row in one
// transaction, and changing nothing writes nothing.

const nowIso = () => new Date().toISOString();

export type OverrideRow = {
  branch_id: number;
  product_id: number;
  product_name: string;
  barcode: string;
  currency: 'USD' | 'LBP';
  base_price_minor: number;
  price_minor: number;
  updated_at: string;
};

export const overrideJson = (r: OverrideRow) => ({
  branchId: r.branch_id,
  productId: r.product_id,
  productName: r.product_name,
  barcode: r.barcode,
  currency: r.currency,
  basePriceMinor: r.base_price_minor,
  priceMinor: r.price_minor,
  updatedAt: r.updated_at,
});

async function need(q: Queryable, branchId: number, productId: number): Promise<void> {
  if (!(await q.one('SELECT 1 AS x FROM branches WHERE id = ?', [branchId]))) throw new AppError(404, 'NOT_FOUND', 'No such branch');
  if (!(await q.one('SELECT 1 AS x FROM products WHERE id = ?', [productId]))) throw new AppError(404, 'NOT_FOUND', 'No such product');
}

const line = (q: Queryable, productId: number, branchId: number) =>
  q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [
    'products',
    productId,
    'u',
    nowIso(),
    branchId,
  ]);

/** Set a branch's price for a product (in the product's own currency). Returns false when it already was that price. */
export async function setOverride(q: Queryable, branchId: number, productId: number, priceMinor: number): Promise<boolean> {
  await need(q, branchId, productId);
  const before = await q.one<{ price_minor: number }>('SELECT price_minor FROM branch_prices WHERE branch_id = ? AND product_id = ?', [
    branchId,
    productId,
  ]);
  if (before?.price_minor === priceMinor) return false;
  const now = nowIso();
  await q.run(
    `INSERT INTO branch_prices (branch_id, product_id, price_minor, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (branch_id, product_id) DO UPDATE SET price_minor = excluded.price_minor, updated_at = excluded.updated_at`,
    [branchId, productId, priceMinor, now, now],
  );
  await line(q, productId, branchId);
  await hqAudit(q, 'price.override.set', 'product', productId, { branchId, from: before?.price_minor ?? null, to: priceMinor });
  return true;
}

/** Back to the base price for this branch. Returns false when there was no override. */
export async function removeOverride(q: Queryable, branchId: number, productId: number): Promise<boolean> {
  await need(q, branchId, productId);
  const before = await q.one<{ price_minor: number }>('SELECT price_minor FROM branch_prices WHERE branch_id = ? AND product_id = ?', [
    branchId,
    productId,
  ]);
  if (!before) return false;
  await q.run('DELETE FROM branch_prices WHERE branch_id = ? AND product_id = ?', [branchId, productId]);
  await line(q, productId, branchId);
  await hqAudit(q, 'price.override.remove', 'product', productId, { branchId, from: before.price_minor });
  return true;
}

export async function listOverrides(q: Queryable, branchId: number): Promise<OverrideRow[]> {
  if (!(await q.one('SELECT 1 AS x FROM branches WHERE id = ?', [branchId]))) throw new AppError(404, 'NOT_FOUND', 'No such branch');
  return q.all<OverrideRow>(
    `SELECT b.branch_id, b.product_id, p.name AS product_name, p.barcode, p.currency, p.price_minor AS base_price_minor, b.price_minor, b.updated_at
     FROM branch_prices b JOIN products p ON p.id = b.product_id WHERE b.branch_id = ? ORDER BY p.name, p.id`,
    [branchId],
  );
}

/** Every branch that has its own price for a product (so a person sees what a product costs where). */
export async function overridesOfProduct(q: Queryable, productId: number): Promise<{ branch_id: number; price_minor: number }[]> {
  return q.all('SELECT branch_id, price_minor FROM branch_prices WHERE product_id = ? ORDER BY branch_id', [productId]);
}
