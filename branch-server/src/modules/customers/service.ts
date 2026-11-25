import { usdToLbp } from '@pos/shared';
import { z } from 'zod';
import type { Database, Queryable } from '../../db/adapter';
import { E } from '../../errors';
import { findReplayQ, rememberResponseQ } from '../../util/idempotency';
import { bumpExpected, requireOpenSession } from '../registers/service';
import { currentRateQ } from '../settings/context';
import type { Terminal } from '../terminals/service';
import type { Actor } from '../sales/service';

export const CUSTOMER_PAYMENT_SCOPE = 'POST /customers/payments';

export const customerPaymentBody = z.object({
  method: z.enum(['cash', 'whish', 'omt']),
  currency: z.enum(['USD', 'LBP']),
  amount: z.number().int().positive(),
});
export type CustomerPaymentBody = z.infer<typeof customerPaymentBody>;

export type CustomerRow = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  balance_lbp: number;
  is_walk_in: number;
  created_at: string;
};

export const customerJson = (c: CustomerRow) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  address: c.address,
  email: c.email,
  balanceLbp: c.balance_lbp,
  isWalkIn: c.is_walk_in === 1,
  createdAt: c.created_at,
});

/** A customer who has not been deleted. A deleted one is as good as not there (their old sales keep pointing at the row). */
export const getCustomer = (q: Queryable, id: number) =>
  q.one<CustomerRow>('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [id]);

/**
 * Take a payment on a customer's account (US-32). The amount reduces their balance and is applied to their oldest open
 * sale first. It goes into the register bucket of the method used. One transaction, idempotent.
 */
export function receiveCustomerPayment(
  db: Database,
  actor: Actor,
  terminal: Terminal,
  customerId: number,
  body: CustomerPaymentBody,
  idem: { key: string; hash: string },
) {
  return db.tx(async (q) => {
    const replay = await findReplayQ(q, CUSTOMER_PAYMENT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const customer = await getCustomer(q, customerId);
    if (!customer) throw E.notFound('Customer');
    if (customer.is_walk_in) throw E.unprocessable('WALK_IN_NO_ACCOUNT', 'Walk-In has no account to pay into');

    const session = await requireOpenSession(q, terminal);
    const rate = await currentRateQ(q);
    const amountLbp = body.currency === 'LBP' ? body.amount : usdToLbp(body.amount, rate);
    if (amountLbp > customer.balance_lbp) {
      throw E.unprocessable(
        'PAYMENT_EXCEEDS_BALANCE',
        `The customer owes ${customer.balance_lbp.toLocaleString('en-US')} LBP, which is less than this payment`,
      );
    }

    const created = await q.one<{ id: number }>(
      'INSERT INTO customer_payments (customer_id, session_id, user_id, amount_lbp, idempotency_key) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [customerId, session.id, actor.id, amountLbp, idem.key],
    );
    const paymentId = created!.id;
    await q.run('INSERT INTO payments (customer_payment_id, method, currency, amount, rate_snap) VALUES (?, ?, ?, ?, ?)', [
      paymentId,
      body.method,
      body.currency,
      body.amount,
      rate,
    ]);
    await bumpExpected(q, session.id, { method: body.method, currency: body.currency }, body.amount, {
      kind: 'customer_payment',
      refType: 'customer_payment',
      refId: paymentId,
      userId: actor.id,
    });

    // Oldest open sale first.
    const open = await q.all<{ id: number; ref: number; rest_lbp: number }>(
      'SELECT id, ref, rest_lbp FROM sales WHERE customer_id = ? AND rest_lbp > 0 ORDER BY created_at, id',
      [customerId],
    );
    let remaining = amountLbp;
    const allocations: { saleId: number; ref: number; amountLbp: number }[] = [];
    for (const sale of open) {
      if (remaining === 0) break;
      const apply = Math.min(sale.rest_lbp, remaining);
      await q.run(
        `UPDATE sales SET paid_lbp = paid_lbp + ?, rest_lbp = rest_lbp - ?,
                status = CASE WHEN rest_lbp - ? = 0 THEN 'paid' ELSE 'partial' END WHERE id = ?`,
        [apply, apply, apply, sale.id],
      );
      await q.run('INSERT INTO payment_allocations (customer_payment_id, sale_id, amount_lbp) VALUES (?, ?, ?)', [
        paymentId,
        sale.id,
        apply,
      ]);
      allocations.push({ saleId: sale.id, ref: sale.ref, amountLbp: apply });
      remaining -= apply;
    }
    // The balance is the sum of the open sales' rests. If they disagree, the data is corrupt: stop and roll back.
    if (remaining !== 0) throw new Error(`Customer ${customerId} balance does not match their open sales (short by ${remaining})`);
    await q.run('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?', [amountLbp, customerId]);

    const response = {
      id: paymentId,
      customerId,
      method: body.method,
      currency: body.currency,
      amount: body.amount,
      amountLbp,
      allocations,
      balanceLbp: customer.balance_lbp - amountLbp,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    };
    await rememberResponseQ(q, CUSTOMER_PAYMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
