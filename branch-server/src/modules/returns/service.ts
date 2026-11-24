import { parseQtyMilli, roundDiv, usdToLbp } from '@pos/shared';
import { z } from 'zod';
import { consumeReturnApproval } from '../../auth/approvals';
import { hasRole } from '../../auth/permissions';
import type { Database } from '../../db/adapter';
import { nextRefQ } from '../../db/counters';
import { AppError, E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { milliToQty } from '../../util/qty';
import { writeAuditQ } from '../audit/service';
import { bumpExpected, requireOpenSession } from '../registers/service';
import { currentRateQ } from '../settings/context';
import { warehouseOf, type Terminal } from '../terminals/service';
import type { Actor } from '../sales/service';

export const RETURN_SCOPE = 'POST /returns';

const qty = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a positive number with at most 3 decimals')
  .refine((v) => Number(v) > 0, 'Quantity must be greater than zero');

export const returnBody = z.object({
  saleId: z.number().int().positive(),
  items: z
    .array(z.object({ saleItemId: z.number().int().positive(), qty }))
    .min(1)
    .max(200),
  reason: z.string().trim().max(200).default(''),
  /** What is handed back. Required unless the whole value is taken off what the customer still owes. */
  refund: z
    .object({ method: z.enum(['cash', 'whish', 'omt']), currency: z.enum(['USD', 'LBP']), amount: z.number().int().positive() })
    .optional(),
  /** A cashier needs a manager's approval for this sale and this value (POST /auth/approve, scope "return"). */
  approvalToken: z.string().max(100).optional(),
});
export type ReturnBody = z.infer<typeof returnBody>;

type SaleItemRow = { id: number; sale_id: number; product_id: number | null; qty_milli: number; line_total_lbp: number };

/**
 * Return items from a completed sale (US-14). One transaction: the return and its lines, stock back on the shelf, the
 * refund out of a register bucket, and, if the sale was not fully paid, the value first reduces what the customer owes.
 * The original sale is never edited except for how much of it is settled. Stock is informational (R2), so returns add to it.
 */
export function createReturn(db: Database, actor: Actor, terminal: Terminal, body: ReturnBody, idem: { key: string; hash: string }) {
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, RETURN_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const sale = await q.one<{
      id: number;
      ref: number;
      customer_id: number;
      subtotal_lbp: number;
      discount_lbp: number;
      rest_lbp: number;
      status: string;
      rate_lbp_per_usd: number;
    }>('SELECT * FROM sales WHERE id = ?', [body.saleId]);
    if (!sale) throw E.notFound('Sale');
    if (sale.status === 'void') throw E.unprocessable('SALE_VOID', 'A voided sale cannot be returned');

    const session = await requireOpenSession(q, terminal);
    const warehouseId = await warehouseOf(q, terminal);

    // ---- what is being returned, and how much of it can still be returned
    const seen = new Set<number>();
    const lines: { item: SaleItemRow; qtyMilli: number; valueLbp: number }[] = [];
    for (const l of body.items) {
      if (seen.has(l.saleItemId)) throw E.validation('Each sale item may appear only once; combine the quantities');
      seen.add(l.saleItemId);

      const item = await q.one<SaleItemRow>('SELECT id, sale_id, product_id, qty_milli, line_total_lbp FROM sale_items WHERE id = ?', [
        l.saleItemId,
      ]);
      if (!item || item.sale_id !== sale.id)
        throw E.unprocessable('INVALID_REFERENCE', `Item ${l.saleItemId} is not part of sale ${sale.ref}`);

      const returned = (await q.one<{ n: number }>('SELECT COALESCE(SUM(qty_milli), 0) AS n FROM return_items WHERE sale_item_id = ?', [
        item.id,
      ]))!.n;
      const qtyMilli = parseQtyMilli(l.qty);
      if (qtyMilli > item.qty_milli - returned) {
        throw new AppError(422, 'RETURN_EXCEEDS_SOLD', `Only ${milliToQty(item.qty_milli - returned)} of this item can still be returned`, {
          saleItemId: item.id,
          returnable: milliToQty(item.qty_milli - returned),
        });
      }

      // The value of the returned share of the line, after the sale's discount (a discounted sale refunds what was paid).
      let valueLbp = roundDiv(item.line_total_lbp * qtyMilli, item.qty_milli);
      if (sale.discount_lbp > 0 && sale.subtotal_lbp > 0)
        valueLbp = roundDiv(valueLbp * (sale.subtotal_lbp - sale.discount_lbp), sale.subtotal_lbp);
      lines.push({ item, qtyMilli, valueLbp });
    }
    const valueLbp = lines.reduce((sum, l) => sum + l.valueLbp, 0);

    // ---- a cashier does not take goods back alone. Using the approval is part of this transaction, so a return that fails
    // afterwards (say, the refund method is still to be chosen) rolls it back and the approval can be used again.
    let approvedBy: number | null = null;
    if (!hasRole(actor.role, 'manager')) {
      const approval = body.approvalToken ? await consumeReturnApproval(q, body.approvalToken, actor.id, sale.id, valueLbp) : null;
      if (!approval) {
        throw new AppError(403, 'RETURN_NEEDS_APPROVAL', "Taking goods back needs a manager's approval", {
          saleId: sale.id,
          saleRef: sale.ref,
          valueLbp,
        });
      }
      approvedBy = approval.approvedBy;
    }

    // ---- unpaid part first reduces what the customer owes; only the rest is handed back
    const balanceReducedLbp = Math.min(sale.rest_lbp, valueLbp);
    const refundLbp = valueLbp - balanceReducedLbp;

    let refundAmountLbp = 0;
    if (refundLbp > 0) {
      // The amounts travel with the error so a screen can ask "hand back X?" without redoing the discount maths.
      if (!body.refund)
        throw new AppError(422, 'REFUND_REQUIRED', `Choose how to refund ${refundLbp.toLocaleString('en-US')} LBP`, {
          refundLbp,
          balanceReducedLbp,
        });
      const rate = await currentRateQ(q);
      refundAmountLbp = body.refund.currency === 'LBP' ? body.refund.amount : usdToLbp(body.refund.amount, rate);
      // A USD refund cannot match to the lira, so allow up to one cent's worth either way.
      const tolerance = body.refund.currency === 'USD' ? Math.ceil(rate / 100) : 0;
      if (Math.abs(refundAmountLbp - refundLbp) > tolerance) {
        throw new AppError(
          422,
          'REFUND_MISMATCH',
          `The refund must equal the value being returned (${refundLbp.toLocaleString('en-US')} LBP)`,
          { refundLbp },
        );
      }
    } else if (body.refund) {
      throw E.unprocessable('REFUND_NOT_ALLOWED', 'The whole value is taken off what the customer owes; there is nothing to hand back');
    }

    // ---- write
    const ref = await nextRefQ(q, 'return_ref');
    const created = await q.one<{ id: number }>(
      `INSERT INTO returns (ref, sale_id, session_id, user_id, reason, refund_lbp, balance_reduced_lbp, refund_method, refund_currency, refund_amount, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        ref,
        sale.id,
        session.id,
        actor.id,
        body.reason,
        refundLbp,
        balanceReducedLbp,
        body.refund?.method ?? null,
        body.refund?.currency ?? null,
        body.refund?.amount ?? null,
        idem.key,
      ],
    );
    const returnId = created!.id;

    for (const l of lines) {
      await q.run('INSERT INTO return_items (return_id, sale_item_id, qty_milli, amount_lbp) VALUES (?, ?, ?, ?)', [
        returnId,
        l.item.id,
        l.qtyMilli,
        l.valueLbp,
      ]);
      if (l.item.product_id !== null) {
        await q.run(
          `INSERT INTO stock_movements (product_id, warehouse_id, qty_milli_delta, reason, ref_type, ref_id, user_id) VALUES (?, ?, ?, 'return', 'return', ?, ?)`,
          [l.item.product_id, warehouseId, l.qtyMilli, returnId, actor.id],
        );
        await q.run(
          `INSERT INTO stock_levels (product_id, warehouse_id, qty_milli) VALUES (?, ?, ?)
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli`,
          [l.item.product_id, warehouseId, l.qtyMilli],
        );
      }
    }

    if (body.refund) await bumpExpected(q, session.id, { method: body.refund.method, currency: body.refund.currency }, -body.refund.amount);

    if (balanceReducedLbp > 0) {
      // The sale counts the credited value as settled, so paid + rest still equals its total and the customer's
      // balance still equals the sum of their open sales.
      await q.run(
        `UPDATE sales SET paid_lbp = paid_lbp + ?, rest_lbp = rest_lbp - ?,
                status = CASE WHEN rest_lbp - ? = 0 THEN 'paid' ELSE 'partial' END WHERE id = ?`,
        [balanceReducedLbp, balanceReducedLbp, balanceReducedLbp, sale.id],
      );
      await q.run('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?', [balanceReducedLbp, sale.customer_id]);
    }

    await writeAuditQ(q, {
      userId: actor.id,
      action: 'sale.return',
      entity: 'sale',
      entityId: sale.id,
      after: { returnRef: ref, valueLbp, refundLbp, balanceReducedLbp, reason: body.reason, ...(approvedBy !== null && { approvedBy }) },
    });

    const response = {
      id: returnId,
      ref,
      saleId: sale.id,
      saleRef: sale.ref,
      valueLbp,
      refundLbp,
      balanceReducedLbp,
      refund: body.refund ?? null,
      reason: body.reason,
      items: lines.map((l) => ({ saleItemId: l.item.id, qty: milliToQty(l.qtyMilli), amountLbp: l.valueLbp })),
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    };
    await rememberResponseQ(q, RETURN_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
