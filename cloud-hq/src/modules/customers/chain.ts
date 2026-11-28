import type { Queryable } from '@pos/core/adapter';
import type { Fact } from '@pos/core/sync';

// Paying across branches, HQ's side (docs/15 §7.2, P5e step 2). A branch took a payment, applied it to its own sales for that customer and sent what is
// left (chain_payments). HQ places that remainder on the same person's open sales at OTHER branches, oldest first, and tells each branch with a payment
// order (down, to that branch only). A branch answers with how much it really applied; a shortfall goes back to be placed on the next sale. HQ never
// edits a branch's sale: it asks, and the branch applies it in its own transaction (one writer per row). What cannot be placed yet (nobody owes any
// more, or the sales are not here yet) stays as `unplaced_lbp`, visible, and is tried again whenever sales or customers arrive.

const nowIso = () => new Date().toISOString();
const log = (q: Queryable, tbl: string, pk: number, branchId: number) =>
  q.run('INSERT INTO change_log (tbl, pk, op, created_at, branch_id) VALUES (?, ?, ?, ?, ?)', [tbl, pk, 'u', nowIso(), branchId]);

/** Tell each customer record what the same person owes at the other branches. Writes (and logs) a line only when the figure changed. */
export async function refreshChainViews(q: Queryable, keys: Iterable<string>): Promise<void> {
  for (const key of new Set(keys)) {
    const rows = await q.all<{ branch_id: number; customer_id: number; balance_lbp: number }>(
      `SELECT k.branch_id, k.customer_id, c.balance_lbp FROM customer_keys k
         JOIN customers c ON c.branch_id = k.branch_id AND c.id = k.customer_id
        WHERE k.phone_key = ? AND c.deleted_at IS NULL`,
      [key],
    );
    const total = rows.reduce((n, r) => n + r.balance_lbp, 0);
    for (const r of rows) await setOthers(q, r.branch_id, r.customer_id, total - r.balance_lbp);
  }
}

/** One customer record's "owed elsewhere" figure; a record that never had one and owes nothing elsewhere gets no row. */
export async function setOthers(q: Queryable, branchId: number, customerId: number, others: number): Promise<void> {
  const have = await q.one<{ id: number; others_lbp: number }>(
    'SELECT id, others_lbp FROM customer_chain WHERE branch_id = ? AND customer_id = ?',
    [branchId, customerId],
  );
  if (!have) {
    if (others === 0) return;
    const made = await q.one<{ id: number }>(
      'INSERT INTO customer_chain (branch_id, customer_id, others_lbp) VALUES (?, ?, ?) RETURNING id',
      [branchId, customerId, others],
    );
    await log(q, 'customer_chain', made!.id, branchId);
  } else if (have.others_lbp !== others) {
    await q.run('UPDATE customer_chain SET others_lbp = ? WHERE id = ?', [others, have.id]);
    await log(q, 'customer_chain', have.id, branchId);
  }
}

/** A branch's leftover payments arrive: remember how much of each is still to place. */
export async function registerChainPayments(q: Queryable, branchId: number, facts: Fact[]): Promise<void> {
  for (const f of facts) {
    if (f.tbl !== 'chain_payments' || f.op !== 'u' || !f.row) continue;
    await q.run(
      `INSERT INTO chain_payment_state (branch_id, chain_payment_id, phone_key, unplaced_lbp) VALUES (?, ?, ?, ?)
       ON CONFLICT (branch_id, chain_payment_id) DO NOTHING`,
      [branchId, f.pk, f.row.phone_key as string, f.row.amount_lbp as number],
    );
  }
}

/** A branch says how much of an order it applied: the shortfall goes back to be placed again. A resent answer counts once. */
export async function settleResults(q: Queryable, branchId: number, facts: Fact[]): Promise<void> {
  for (const f of facts) {
    if (f.tbl !== 'payment_order_results' || f.op !== 'u' || !f.row) continue;
    const orderId = f.row.order_id as number;
    const order = await q.one<{ amount_lbp: number; from_branch_id: number; chain_payment_id: number }>(
      'SELECT amount_lbp, from_branch_id, chain_payment_id FROM payment_orders WHERE id = ? AND to_branch_id = ?',
      [orderId, branchId], // a branch can only answer an order that was sent to it
    );
    if (!order) continue;
    const first = await q.run('INSERT INTO payment_order_settled (order_id) VALUES (?) ON CONFLICT (order_id) DO NOTHING', [orderId]);
    if (!first.changes) continue;
    const short = order.amount_lbp - Math.min(order.amount_lbp, Math.max(0, f.row.applied_lbp as number));
    if (short > 0)
      await q.run('UPDATE chain_payment_state SET unplaced_lbp = unplaced_lbp + ? WHERE branch_id = ? AND chain_payment_id = ?', [
        short,
        order.from_branch_id,
        order.chain_payment_id,
      ]);
  }
}

type Open = { branch_id: number; sale_id: number; customer_id: number; free: number };

/** Place what is unplaced, oldest sale first, over the person's sales at the other branches. */
export async function placeUnplaced(q: Queryable, limit = 100): Promise<void> {
  const states = await q.all<{ branch_id: number; chain_payment_id: number; phone_key: string; unplaced_lbp: number }>(
    'SELECT branch_id, chain_payment_id, phone_key, unplaced_lbp FROM chain_payment_state WHERE unplaced_lbp > 0 ORDER BY branch_id, chain_payment_id LIMIT ?',
    [limit],
  );
  for (const st of states) {
    let left = st.unplaced_lbp;
    // What each sale still owes, less what is already ordered for it and not yet answered.
    const open = await q.all<Open>(
      `SELECT s.branch_id, s.id AS sale_id, s.customer_id,
              s.rest_lbp - COALESCE((SELECT SUM(o.amount_lbp) FROM payment_orders o
                                      WHERE o.to_branch_id = s.branch_id AND o.sale_id = s.id
                                        AND NOT EXISTS (SELECT 1 FROM payment_order_settled d WHERE d.order_id = o.id)), 0) AS free
         FROM customer_keys k
         JOIN sales s ON s.branch_id = k.branch_id AND s.customer_id = k.customer_id
        WHERE k.phone_key = ? AND k.branch_id <> ? AND s.rest_lbp > 0 AND s.status <> 'void'
        ORDER BY s.created_at, s.branch_id, s.id`,
      [st.phone_key, st.branch_id],
    );
    for (const sale of open) {
      if (left === 0) break;
      if (sale.free <= 0) continue;
      const amount = Math.min(sale.free, left);
      const now = nowIso();
      const made = await q.one<{ id: number }>(
        `INSERT INTO payment_orders (customer_id, sale_id, amount_lbp, from_branch_id, chain_payment_id, to_branch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [sale.customer_id, sale.sale_id, amount, st.branch_id, st.chain_payment_id, sale.branch_id, now, now],
      );
      await log(q, 'payment_orders', made!.id, sale.branch_id);
      left -= amount;
    }
    if (left !== st.unplaced_lbp)
      await q.run('UPDATE chain_payment_state SET unplaced_lbp = ? WHERE branch_id = ? AND chain_payment_id = ?', [
        left,
        st.branch_id,
        st.chain_payment_id,
      ]);
  }
}
