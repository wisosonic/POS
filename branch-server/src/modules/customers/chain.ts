import type { Queryable } from '../../db/adapter';

// Paying across branches, the receiving side (docs/15 §7.2, P5e step 2). HQ sends this branch a payment order: reduce what the customer owes on ONE of
// its sales by an amount. The money was taken at another branch and counted there, so nothing enters a register here. The order is applied in this
// branch's own transaction, never more than the sale still owes (the sale may have been paid or voided since HQ looked), and the answer (how much
// was really applied) goes up as payment_order_results, written in the same transaction, so HQ can place the difference elsewhere.

/** Apply every order that has no answer yet. Call it inside the transaction that stored the orders. */
export async function applyPaymentOrders(q: Queryable): Promise<number> {
  const orders = await q.all<{ id: number; customer_id: number; sale_id: number; amount_lbp: number }>(
    `SELECT o.id, o.customer_id, o.sale_id, o.amount_lbp FROM payment_orders o
      WHERE NOT EXISTS (SELECT 1 FROM payment_order_results r WHERE r.order_id = o.id) ORDER BY o.id`,
  );
  for (const o of orders) {
    const sale = await q.one<{ rest_lbp: number; status: string }>('SELECT rest_lbp, status FROM sales WHERE id = ? AND customer_id = ?', [
      o.sale_id,
      o.customer_id,
    ]);
    const apply = sale && sale.status !== 'void' ? Math.min(sale.rest_lbp, o.amount_lbp) : 0;
    if (apply > 0) {
      // A payment record with no register and no money line: the cash is in another branch's drawer.
      const payment = await q.one<{ id: number }>(
        'INSERT INTO customer_payments (customer_id, session_id, user_id, amount_lbp, idempotency_key, created_at) VALUES (?, NULL, NULL, ?, ?, ?) RETURNING id',
        [o.customer_id, apply, `chain-order:${o.id}`, new Date().toISOString()],
      );
      await q.run(
        `UPDATE sales SET paid_lbp = paid_lbp + ?, rest_lbp = rest_lbp - ?,
                status = CASE WHEN rest_lbp - ? = 0 THEN 'paid' ELSE 'partial' END WHERE id = ?`,
        [apply, apply, apply, o.sale_id],
      );
      await q.run('INSERT INTO payment_allocations (customer_payment_id, sale_id, amount_lbp) VALUES (?, ?, ?)', [
        payment!.id,
        o.sale_id,
        apply,
      ]);
      await q.run('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?', [apply, o.customer_id]);
    }
    await q.run('INSERT INTO payment_order_results (order_id, applied_lbp, created_at) VALUES (?, ?, ?)', [
      o.id,
      apply,
      new Date().toISOString(),
    ]);
  }
  return orders.length;
}
