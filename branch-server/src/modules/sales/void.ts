import { z } from 'zod';
import { consumeVoidApproval } from '../../auth/approvals';
import { hasRole } from '../../auth/permissions';
import type { Database } from '../../db/adapter';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { writeAuditQ } from '../audit/service';
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
  warehouse_id: number;
};

export function voidSale(db: Database, actor: Actor, saleId: number, body: VoidBody, idem: { key: string; hash: string }) {
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, VOID_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const sale = await q.one<SaleRow>(
      'SELECT id, ref, session_id, customer_id, total_lbp, rest_lbp, change_lbp, status, warehouse_id FROM sales WHERE id = ?',
      [saleId],
    );
    if (!sale) throw E.notFound('Sale');
    if (sale.status === 'void') throw E.unprocessable('SALE_ALREADY_VOID', `Sale ${sale.ref} is already cancelled`);

    const session = sale.session_id === null ? undefined : await getSession(q, sale.session_id);
    if (!session || session.status !== 'open') {
      throw E.unprocessable(
        'SALE_NOT_VOIDABLE',
        'A sale can only be cancelled while the register that took it is still open. Use a return to take the goods back.',
      );
    }
    if (await q.one('SELECT 1 FROM returns WHERE sale_id = ? LIMIT 1', [sale.id]))
      throw E.unprocessable('SALE_HAS_RETURNS', 'Part of this sale was already taken back, so it cannot be cancelled as a whole');
    if (await q.one('SELECT 1 FROM payment_allocations WHERE sale_id = ? LIMIT 1', [sale.id]))
      throw E.unprocessable(
        'SALE_HAS_ACCOUNT_PAYMENTS',
        'The customer has already paid part of this sale from their account, so it cannot be cancelled',
      );

    // A cashier does not cancel a sale alone. Using the approval is part of this transaction, so a void that fails afterwards
    // rolls it back and the approval can be used again.
    let approvedBy: number | null = null;
    if (!hasRole(actor.role, 'manager')) {
      const approval = body.approvalToken ? await consumeVoidApproval(q, body.approvalToken, actor.id, sale.id) : null;
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
    const items = await q.all<{ product_id: number | null; qty_milli: number }>(
      'SELECT product_id, qty_milli FROM sale_items WHERE sale_id = ?',
      [sale.id],
    );
    for (const i of items) {
      if (i.product_id === null) continue;
      await q.run(
        `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id, note)
       VALUES (?, ?, ?, 'adjustment', 'void', ?, ?, ?)`,
        [i.product_id, sale.warehouse_id, i.qty_milli, sale.id, actor.id, `Sale ${sale.ref} cancelled`],
      );
      await q.run(
        `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
        [i.product_id, sale.warehouse_id, i.qty_milli],
      );
    }

    // The money that came in goes back out of the same balances, and the change that went out comes back in.
    const payments = await q.all<{ method: string; currency: 'USD' | 'LBP'; amount: number }>(
      'SELECT method, currency, amount FROM payments WHERE sale_id = ?',
      [sale.id],
    );
    for (const p of payments)
      await bumpExpected(q, session.id, p, -p.amount, {
        kind: 'correction',
        refType: 'sale',
        refId: sale.id,
        userId: actor.id,
        reason: 'Sale cancelled',
      });
    await bumpExpected(q, session.id, { method: 'cash', currency: 'LBP' }, sale.change_lbp);

    if (sale.rest_lbp > 0)
      await q.run('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?', [sale.rest_lbp, sale.customer_id]);

    // The sale keeps every line and payment it had; its status says it no longer counts (reports and the register ignore void
    // sales) and nothing is owed on it any more, so a later payment on the customer's account can never be applied to it.
    await q.run(`UPDATE sales SET status = 'void', rest_lbp = 0 WHERE id = ?`, [sale.id]);

    await writeAuditQ(q, {
      userId: actor.id,
      action: 'sale.void',
      entity: 'sale',
      entityId: sale.id,
      before: { status: sale.status, totalLbp: sale.total_lbp, restLbp: sale.rest_lbp },
      after: { status: 'void', reason: body.reason, ...(approvedBy !== null && { approvedBy }) },
    });

    const response = { id: sale.id, ref: sale.ref, status: 'void', totalLbp: sale.total_lbp, reason: body.reason };
    await rememberResponseQ(q, VOID_SCOPE, idem.key, idem.hash, 200, response);
    return { statusCode: 200, body: response as unknown, replay: false };
  });
}
