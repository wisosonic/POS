import { z } from 'zod';
import { consumeVoidApproval } from '../../auth/approvals';
import { hasRole } from '../../auth/permissions';
import { inWriteTransaction, type Db } from '../../db/open';
import { AppError, E } from '../../errors';
import { findReplay, rememberResponse } from '../../util/idempotency';
import { writeAudit } from '../audit/service';
import { bumpExpected, getSession } from '../registers/service';
import type { Actor } from './service';

// Cancelling a sale that was just made (US-14b): everything the sale did is undone in one transaction, with new rows rather than
// edits. Only while the register that took it is still open: after the drawer is counted the money is settled and a return is
// the way back. A cashier asks a manager to approve, with the manager's own name and password, for that one sale.

export const VOID_SCOPE = 'POST /sales/{id}/void';

export const voidBody = z.object({
  /** Why. Required: a void without a reason is how a till gets emptied. */
  reason: z.string().trim().min(1, 'Say why the sale is being cancelled').max(200),
  approvalToken: z.string().max(100).optional(),
});
export type VoidBody = z.infer<typeof voidBody>;

type SaleRow = {
  id: number;
  ref: number;
  session_id: number | null;
  customer_id: number;
  total_lbp: number;
  rest_lbp: number;
  change_lbp: number;
  status: string;
};

export function voidSale(db: Db, actor: Actor, saleId: number, body: VoidBody, idem: { key: string; hash: string }) {
  return inWriteTransaction(db, () => {
    const replay = findReplay(db, VOID_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const sale = db
      .prepare('SELECT id, ref, session_id, customer_id, total_lbp, rest_lbp, change_lbp, status FROM sales WHERE id = ?')
      .get(saleId) as SaleRow | undefined;
    if (!sale) throw E.notFound('Sale');
    if (sale.status === 'void') throw E.unprocessable('SALE_ALREADY_VOID', `Sale ${sale.ref} is already cancelled`);

    const session = sale.session_id === null ? undefined : getSession(db, sale.session_id);
    if (!session || session.status !== 'open') {
      throw E.unprocessable(
        'SALE_NOT_VOIDABLE',
        'A sale can only be cancelled while the register that took it is still open. Use a return to take the goods back.',
      );
    }
    if (db.prepare('SELECT 1 FROM returns WHERE sale_id = ? LIMIT 1').get(sale.id))
      throw E.unprocessable('SALE_HAS_RETURNS', 'Part of this sale was already taken back, so it cannot be cancelled as a whole');
    if (db.prepare('SELECT 1 FROM payment_allocations WHERE sale_id = ? LIMIT 1').get(sale.id))
      throw E.unprocessable(
        'SALE_HAS_ACCOUNT_PAYMENTS',
        'The customer has already paid part of this sale from their account, so it cannot be cancelled',
      );

    // A cashier does not cancel a sale alone. Using the approval is part of this transaction, so a void that fails afterwards
    // rolls it back and the approval can be used again.
    let approvedBy: number | null = null;
    if (!hasRole(actor.role, 'manager')) {
      const approval = body.approvalToken ? consumeVoidApproval(db, body.approvalToken, actor.id, sale.id) : null;
      if (!approval) {
        throw new AppError(403, 'VOID_NEEDS_APPROVAL', "Cancelling a sale needs a manager's approval", {
          saleId: sale.id,
          saleRef: sale.ref,
          totalLbp: sale.total_lbp,
        });
      }
      approvedBy = approval.approvedBy;
    }

    // ---- put everything back
    const items = db.prepare('SELECT product_id, qty_milli FROM sale_items WHERE sale_id = ?').all(sale.id) as {
      product_id: number | null;
      qty_milli: number;
    }[];
    const warehouse = db.prepare('SELECT warehouse_id AS w FROM sales WHERE id = ?').get(sale.id) as { w: number };
    const insertMovement = db.prepare(
      `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
       VALUES (?, ?, ?, 'adjustment', 'void', ?, ?, ?)`,
    );
    const upsertLevel = db.prepare(
      `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
    );
    for (const i of items) {
      if (i.product_id === null) continue;
      insertMovement.run(i.product_id, warehouse.w, i.qty_milli, sale.id, actor.id, `Sale ${sale.ref} cancelled`);
      upsertLevel.run(i.product_id, warehouse.w, i.qty_milli);
    }

    // The money that came in goes back out of the same balances, and the change that went out comes back in.
    const payments = db.prepare('SELECT method, currency, amount FROM payments WHERE sale_id = ?').all(sale.id) as {
      method: string;
      currency: 'USD' | 'LBP';
      amount: number;
    }[];
    for (const p of payments) bumpExpected(db, session.id, p, -p.amount);
    bumpExpected(db, session.id, { method: 'cash', currency: 'LBP' }, sale.change_lbp);

    if (sale.rest_lbp > 0)
      db.prepare('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?').run(sale.rest_lbp, sale.customer_id);

    // The sale keeps every line and payment it had; its status says it no longer counts (reports and the register ignore void
    // sales) and nothing is owed on it any more, so a later payment on the customer's account can never be applied to it.
    db.prepare(`UPDATE sales SET status = 'void', rest_lbp = 0 WHERE id = ?`).run(sale.id);

    writeAudit(db, {
      userId: actor.id,
      action: 'sale.void',
      entity: 'sale',
      entityId: sale.id,
      before: { status: sale.status, totalLbp: sale.total_lbp, restLbp: sale.rest_lbp },
      after: { status: 'void', reason: body.reason, ...(approvedBy !== null && { approvedBy }) },
    });

    const response = { id: sale.id, ref: sale.ref, status: 'void', totalLbp: sale.total_lbp, reason: body.reason };
    rememberResponse(db, VOID_SCOPE, idem.key, idem.hash, 200, response);
    return { statusCode: 200, body: response as unknown, replay: false };
  });
}
