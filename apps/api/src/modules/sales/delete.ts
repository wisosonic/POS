import { z } from 'zod';
import { consumeDeleteApproval } from '../../auth/approvals';
import { hasRole } from '../../auth/permissions';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError, E } from '../../errors';
import { findReplay, rememberResponse } from '../../util/idempotency';
import { writeAudit } from '../audit/service';
import { computeBreakdown } from '../registers/service';
import type { Actor } from './service';

// Deleting a sale for good (QUESTIONS.md #8, option C). Allowed for a cancelled sale, and for a sale that has had items taken back.
// Everything the sale and its returns did is taken back out in ONE transaction, as if they never happened: the stock they moved
// goes back, the register's expected figures are recomputed from what is left (a counted register's variance changes with them),
// and the customer's balance loses what this sale added. The audit log is never touched: it keeps what the sale was, and who deleted it.
// The database lets these rows go only while the sale has a row in sale_delete_unlock (migration 0014), which exists only in here.

export const DELETE_SCOPE = 'POST /sales/{id}/delete';

export const deleteBody = z.object({
  /** Why. Required: a deleted sale leaves nothing else behind but this and the audit log. */
  reason: z.string().trim().min(1, 'Say why the sale is being deleted').max(200),
  approvalToken: z.string().max(100).optional(),
});
export type DeleteBody = z.infer<typeof deleteBody>;

type SaleRow = {
  id: number;
  ref: number;
  session_id: number | null;
  user_id: number | null;
  customer_id: number;
  total_lbp: number;
  paid_lbp: number;
  rest_lbp: number;
  status: string;
  legacy_id: number | null;
};

export function deleteSale(db: Db, actor: Actor, saleId: number, body: DeleteBody, idem: { key: string; hash: string }) {
  return inWriteTransaction(db, () => {
    const replay = findReplay(db, DELETE_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const sale = db
      .prepare('SELECT id, ref, session_id, user_id, customer_id, total_lbp, paid_lbp, rest_lbp, status, legacy_id FROM sales WHERE id = ?')
      .get(saleId) as SaleRow | undefined;
    // A cashier sees only their own sales, so someone else's is "not found" to them, as in the sales list.
    if (!sale || (!hasRole(actor.role, 'manager') && sale.user_id !== actor.id)) throw E.notFound('Sale');

    const returns = db.prepare('SELECT id, ref, session_id, refund_lbp FROM returns WHERE sale_id = ?').all(sale.id) as {
      id: number;
      ref: number;
      session_id: number | null;
      refund_lbp: number;
    }[];
    const isVoid = sale.status === 'void';
    if (!isVoid && returns.length === 0)
      throw E.unprocessable('SALE_NOT_DELETABLE', 'Only a cancelled sale, or a sale that has had items taken back, can be deleted');
    // An imported sale's stock and register effects were not recorded the way a new sale's are, so they cannot be reversed here.
    if (!isVoid && sale.legacy_id !== null)
      throw E.unprocessable(
        'SALE_IS_IMPORTED',
        'This sale comes from the old system and has had items returned, so it cannot be deleted here',
      );
    if (db.prepare('SELECT 1 FROM payment_allocations WHERE sale_id = ? LIMIT 1').get(sale.id))
      throw E.unprocessable(
        'SALE_HAS_ACCOUNT_PAYMENTS',
        'The customer has already paid part of this sale from their account, so it cannot be deleted',
      );

    // A cashier does not delete a sale alone. Using the approval is part of this transaction, so a delete that fails afterwards
    // rolls it back and the approval can be used again.
    let approvedBy: number | null = null;
    if (!hasRole(actor.role, 'manager')) {
      const approval = body.approvalToken ? consumeDeleteApproval(db, body.approvalToken, actor.id, sale.id) : null;
      if (!approval) {
        throw new AppError(403, 'DELETE_NEEDS_APPROVAL', "Deleting a sale needs a manager's approval", {
          saleId: sale.id,
          saleRef: sale.ref,
          totalLbp: sale.total_lbp,
        });
      }
      approvedBy = approval.approvedBy;
    }

    // ---- what is there now, for the audit record
    const itemCount = (db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?').get(sale.id) as { n: number }).n;
    const payments = db.prepare('SELECT method, currency, amount FROM payments WHERE sale_id = ?').all(sale.id);
    const refundedLbp = returns.reduce((sum, r) => sum + r.refund_lbp, 0);

    db.prepare('INSERT INTO sale_delete_unlock (sale_id) VALUES (?)').run(sale.id);

    // ---- stock: take out the movements this sale, its cancellation and its returns made, and move the level by the opposite amount
    const movementWhere = `(ref_type IN ('sale', 'void') AND ref_id = @sale)
       OR (ref_type = 'return' AND ref_id IN (SELECT id FROM returns WHERE sale_id = @sale))`;
    const net = db
      .prepare(
        `SELECT product_id AS p, warehouse_id AS w, SUM(qty_milli_delta) AS delta FROM stock_movements WHERE ${movementWhere} GROUP BY product_id, warehouse_id`,
      )
      .all({ sale: sale.id }) as { p: number; w: number; delta: number }[];
    db.prepare(`DELETE FROM stock_movements WHERE ${movementWhere}`).run({ sale: sale.id });
    const upsertLevel = db.prepare(
      `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
    );
    for (const n of net) if (n.delta !== 0) upsertLevel.run(n.p, n.w, -n.delta);

    // ---- the rows themselves, children first
    db.prepare('DELETE FROM approvals WHERE sale_id = ?').run(sale.id); // tokens for this sale (the audit log keeps who approved what)
    db.prepare('DELETE FROM return_items WHERE return_id IN (SELECT id FROM returns WHERE sale_id = ?)').run(sale.id);
    db.prepare('DELETE FROM returns WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM payments WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(sale.id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id);

    // ---- the customer no longer owes what this sale left owing (a cancelled sale already owed nothing)
    if (!isVoid && sale.rest_lbp > 0)
      db.prepare('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?').run(sale.rest_lbp, sale.customer_id);

    // ---- the registers: expected is recomputed from the rows that are left, and a counted register's variance follows it.
    // A cancelled sale had already been taken out of its register, so nothing changes there.
    const sessions = new Set<number>();
    if (!isVoid) {
      if (sale.session_id !== null) sessions.add(sale.session_id);
      for (const r of returns) if (r.session_id !== null) sessions.add(r.session_id);
    }
    const setExpected = db.prepare(
      `UPDATE register_balances SET expected = ?, variance = CASE WHEN counted IS NULL THEN NULL ELSE counted - ? END
       WHERE session_id = ? AND method = ? AND currency = ?`,
    );
    for (const sessionId of sessions)
      for (const b of computeBreakdown(db, sessionId)) setExpected.run(b.expected, b.expected, sessionId, b.method, b.currency);

    writeAudit(db, {
      userId: actor.id,
      action: 'sale.delete',
      entity: 'sale',
      entityId: sale.id,
      before: {
        ref: sale.ref,
        status: sale.status,
        totalLbp: sale.total_lbp,
        paidLbp: sale.paid_lbp,
        restLbp: sale.rest_lbp,
        customerId: sale.customer_id,
        cashierId: sale.user_id,
        sessionId: sale.session_id,
        itemCount,
        payments,
        returns: returns.map((r) => ({ ref: r.ref, refundLbp: r.refund_lbp, sessionId: r.session_id })),
        refundedLbp,
      },
      after: { deleted: true, reason: body.reason, ...(approvedBy !== null && { approvedBy }) },
    });

    db.prepare('DELETE FROM sale_delete_unlock WHERE sale_id = ?').run(sale.id);

    const response = { id: sale.id, ref: sale.ref, deleted: true, reason: body.reason };
    rememberResponse(db, DELETE_SCOPE, idem.key, idem.hash, 200, response);
    return { statusCode: 200, body: response as unknown, replay: false };
  });
}
