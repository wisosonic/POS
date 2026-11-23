import { createHash, randomBytes } from 'node:crypto';
import type { Param, Queryable } from '../db/adapter';

// A manager's approval at the till (US-09, US-14). The token is random, shown once, kept only as a hash, good for one use by
// one cashier, for a few minutes. A discount approval covers up to the percent the manager was shown; a return approval covers
// one sale and up to the value the manager was shown. Using it happens inside the sale's (or return's) own transaction, so
// one that fails does not burn it.

export type ApprovalScope = 'discount' | 'return' | 'void' | 'price' | 'delete';
export const APPROVAL_TTL_MINUTES = 10;
/** Both sides round the percent to the cent of a percent; this much slack stops that rounding refusing an honest sale. */
const PCT_SLACK = 0.011;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type ApprovalGrant = { requestedBy: number; approvedBy: number } & (
  | { scope: 'discount'; maxPct: number }
  | { scope: 'return'; saleId: number; maxLbp: number }
  | { scope: 'void'; saleId: number }
  | { scope: 'delete'; saleId: number }
  | { scope: 'price'; productId: number; priceLbp: number }
);

export async function issueApproval(
  q: Queryable,
  grant: ApprovalGrant,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000).toISOString();
  await q.run(
    'INSERT INTO approvals (token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, product_id, price_lbp, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      sha256(token),
      grant.scope,
      grant.requestedBy,
      grant.approvedBy,
      grant.scope === 'discount' ? grant.maxPct : null,
      grant.scope === 'return' || grant.scope === 'void' || grant.scope === 'delete' ? grant.saleId : null,
      grant.scope === 'return' ? grant.maxLbp : null,
      grant.scope === 'price' ? grant.productId : null,
      grant.scope === 'price' ? grant.priceLbp : null,
      expiresAt,
    ],
  );
  return { token, expiresAt };
}

/**
 * Mark an approval used, in the same statement that checks it, so two requests can never both use it, and a request that asks
 * for more than was approved leaves it untouched. `extra` adds the scope's own conditions (the sale, the value, the product).
 * Returns who approved (and the cap, for a discount), or null.
 */
async function consume(
  q: Queryable,
  scope: ApprovalScope,
  token: string,
  requestedBy: number,
  extra: { sql: string; params: Param[] },
  now: Date,
): Promise<{ approvedBy: number; maxPct: number | null } | null> {
  const hash = sha256(token);
  const used = await q.run(
    `UPDATE approvals SET used_at = ?
     WHERE token_hash = ? AND scope = ? AND requested_by = ? AND used_at IS NULL AND expires_at > ?${extra.sql}`,
    [now.toISOString(), hash, scope, requestedBy, now.toISOString(), ...extra.params],
  );
  if (used.changes !== 1) return null;
  return (await q.one<{ approvedBy: number; maxPct: number | null }>(
    'SELECT approved_by AS approvedBy, max_pct AS maxPct FROM approvals WHERE token_hash = ?',
    [hash],
  ))!;
}

/** Use a discount approval: it must be a discount one for this cashier covering at least this percent. */
export async function consumeApproval(
  q: Queryable,
  token: string,
  requestedBy: number,
  pct: number,
  now: Date = new Date(),
): Promise<{ approvedBy: number; maxPct: number } | null> {
  const r = await consume(q, 'discount', token, requestedBy, { sql: ' AND ? <= max_pct + ?', params: [pct, PCT_SLACK] }, now);
  return r ? { approvedBy: r.approvedBy, maxPct: r.maxPct ?? 0 } : null;
}

/** Use a return approval: for this cashier, this sale, covering at least this value. */
export async function consumeReturnApproval(
  q: Queryable,
  token: string,
  requestedBy: number,
  saleId: number,
  valueLbp: number,
  now: Date = new Date(),
): Promise<{ approvedBy: number } | null> {
  const r = await consume(q, 'return', token, requestedBy, { sql: ' AND sale_id = ? AND ? <= max_lbp', params: [saleId, valueLbp] }, now);
  return r ? { approvedBy: r.approvedBy } : null;
}

/** Use a void approval: for this cashier and this sale. */
export async function consumeVoidApproval(
  q: Queryable,
  token: string,
  requestedBy: number,
  saleId: number,
  now: Date = new Date(),
): Promise<{ approvedBy: number } | null> {
  const r = await consume(q, 'void', token, requestedBy, { sql: ' AND sale_id = ?', params: [saleId] }, now);
  return r ? { approvedBy: r.approvedBy } : null;
}

/** Use a delete approval: for this cashier and this sale. */
export async function consumeDeleteApproval(
  q: Queryable,
  token: string,
  requestedBy: number,
  saleId: number,
  now: Date = new Date(),
): Promise<{ approvedBy: number } | null> {
  const r = await consume(q, 'delete', token, requestedBy, { sql: ' AND sale_id = ?', params: [saleId] }, now);
  return r ? { approvedBy: r.approvedBy } : null;
}

/** Use a price approval: for this cashier, this product and exactly this unit price in LBP. */
export async function consumePriceApproval(
  q: Queryable,
  token: string,
  requestedBy: number,
  productId: number,
  priceLbp: number,
  now: Date = new Date(),
): Promise<{ approvedBy: number } | null> {
  const r = await consume(
    q,
    'price',
    token,
    requestedBy,
    { sql: ' AND product_id = ? AND price_lbp = ?', params: [productId, priceLbp] },
    now,
  );
  return r ? { approvedBy: r.approvedBy } : null;
}
