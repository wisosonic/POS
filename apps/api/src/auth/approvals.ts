import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open';

// A manager's approval at the till (US-09, US-14). The token is random, shown once, kept only as a hash, good for one use by
// one cashier, for a few minutes. A discount approval covers up to the percent the manager was shown; a return approval covers
// one sale and up to the value the manager was shown. Using it happens inside the sale's (or return's) own transaction, so
// one that fails does not burn it.

export type ApprovalScope = 'discount' | 'return' | 'void' | 'price';
export const APPROVAL_TTL_MINUTES = 10;
/** Both sides round the percent to the cent of a percent; this much slack stops that rounding refusing an honest sale. */
const PCT_SLACK = 0.011;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type ApprovalGrant = { requestedBy: number; approvedBy: number } & (
  | { scope: 'discount'; maxPct: number }
  | { scope: 'return'; saleId: number; maxLbp: number }
  | { scope: 'void'; saleId: number }
  | { scope: 'price'; productId: number; priceLbp: number }
);

export function issueApproval(db: Db, grant: ApprovalGrant, now: Date = new Date()): { token: string; expiresAt: string } {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000).toISOString();
  db.prepare(
    'INSERT INTO approvals (token_hash, scope, requested_by, approved_by, max_pct, sale_id, max_lbp, product_id, price_lbp, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    sha256(token),
    grant.scope,
    grant.requestedBy,
    grant.approvedBy,
    grant.scope === 'discount' ? grant.maxPct : null,
    grant.scope === 'return' || grant.scope === 'void' ? grant.saleId : null,
    grant.scope === 'return' ? grant.maxLbp : null,
    grant.scope === 'price' ? grant.productId : null,
    grant.scope === 'price' ? grant.priceLbp : null,
    expiresAt,
  );
  return { token, expiresAt };
}

/**
 * Use a discount approval: it must exist, be a discount one for this cashier, cover at least this percent, be unused and
 * unexpired. Marked used in the same statement that checks it, so two requests can never both use it, and a sale asking for
 * more than was approved leaves it untouched. Returns who approved, or null.
 */
export function consumeApproval(
  db: Db,
  token: string,
  requestedBy: number,
  pct: number,
  now: Date = new Date(),
): { approvedBy: number; maxPct: number } | null {
  const hash = sha256(token);
  const used = db
    .prepare(
      `UPDATE approvals SET used_at = ?
       WHERE token_hash = ? AND scope = 'discount' AND requested_by = ? AND used_at IS NULL AND expires_at > ? AND ? <= max_pct + ?`,
    )
    .run(now.toISOString(), hash, requestedBy, now.toISOString(), pct, PCT_SLACK);
  if (used.changes !== 1) return null;
  return db.prepare('SELECT approved_by AS approvedBy, max_pct AS maxPct FROM approvals WHERE token_hash = ?').get(hash) as {
    approvedBy: number;
    maxPct: number;
  };
}

/**
 * Use a return approval: a return one, for this cashier, for this sale, covering at least this value. Same single-use rules;
 * a return asking for more than was shown leaves the approval untouched. Returns who approved, or null.
 */
export function consumeReturnApproval(
  db: Db,
  token: string,
  requestedBy: number,
  saleId: number,
  valueLbp: number,
  now: Date = new Date(),
): { approvedBy: number } | null {
  const hash = sha256(token);
  const used = db
    .prepare(
      `UPDATE approvals SET used_at = ?
       WHERE token_hash = ? AND scope = 'return' AND requested_by = ? AND sale_id = ? AND used_at IS NULL AND expires_at > ? AND ? <= max_lbp`,
    )
    .run(now.toISOString(), hash, requestedBy, saleId, now.toISOString(), valueLbp);
  if (used.changes !== 1) return null;
  return db.prepare('SELECT approved_by AS approvedBy FROM approvals WHERE token_hash = ?').get(hash) as { approvedBy: number };
}

/** Use a void approval: a void one, for this cashier and this sale, unused and unexpired. Returns who approved, or null. */
export function consumeVoidApproval(
  db: Db,
  token: string,
  requestedBy: number,
  saleId: number,
  now: Date = new Date(),
): { approvedBy: number } | null {
  const hash = sha256(token);
  const used = db
    .prepare(
      `UPDATE approvals SET used_at = ?
       WHERE token_hash = ? AND scope = 'void' AND requested_by = ? AND sale_id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now.toISOString(), hash, requestedBy, saleId, now.toISOString());
  if (used.changes !== 1) return null;
  return db.prepare('SELECT approved_by AS approvedBy FROM approvals WHERE token_hash = ?').get(hash) as { approvedBy: number };
}

/** Use a price approval: for this cashier, this product and exactly this unit price in LBP. Returns who approved, or null. */
export function consumePriceApproval(
  db: Db,
  token: string,
  requestedBy: number,
  productId: number,
  priceLbp: number,
  now: Date = new Date(),
): { approvedBy: number } | null {
  const hash = sha256(token);
  const used = db
    .prepare(
      `UPDATE approvals SET used_at = ?
       WHERE token_hash = ? AND scope = 'price' AND requested_by = ? AND product_id = ? AND price_lbp = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now.toISOString(), hash, requestedBy, productId, priceLbp, now.toISOString());
  if (used.changes !== 1) return null;
  return db.prepare('SELECT approved_by AS approvedBy FROM approvals WHERE token_hash = ?').get(hash) as { approvedBy: number };
}
