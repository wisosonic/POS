import { usdToLbp } from '@pos/shared';
import { z } from 'zod';
import { inWriteTransaction, type Db } from '../../db/open';
import { E } from '../../errors';
import { findReplay, rememberResponse } from '../../util/idempotency';
import { bumpExpected, requireOpenSession } from '../registers/service';
import { currentRate } from '../settings/context';
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

export const getCustomer = (db: Db, id: number) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined;

/**
 * Take a payment on a customer's account (US-32). The amount reduces their balance and is applied to their oldest open
 * sale first. It goes into the register bucket of the method used. One transaction, idempotent.
 */
export function receiveCustomerPayment(
  db: Db,
  actor: Actor,
  customerId: number,
  body: CustomerPaymentBody,
  idem: { key: string; hash: string },
) {
  return inWriteTransaction(db, () => {
    const replay = findReplay(db, CUSTOMER_PAYMENT_SCOPE, idem.key, idem.hash);
    if (replay) return { ...replay, replay: true };

    const customer = getCustomer(db, customerId);
    if (!customer) throw E.notFound('Customer');
    if (customer.is_walk_in) throw E.unprocessable('WALK_IN_NO_ACCOUNT', 'Walk-In has no account to pay into');

    const session = requireOpenSession(db);
    const rate = currentRate(db);
    const amountLbp = body.currency === 'LBP' ? body.amount : usdToLbp(body.amount, rate);
    if (amountLbp > customer.balance_lbp) {
      throw E.unprocessable(
        'PAYMENT_EXCEEDS_BALANCE',
        `The customer owes ${customer.balance_lbp.toLocaleString('en-US')} LBP, which is less than this payment`,
      );
    }

    const paymentId = Number(
      db
        .prepare('INSERT INTO customer_payments (customer_id, session_id, user_id, amount_lbp, idempotency_key) VALUES (?, ?, ?, ?, ?)')
        .run(customerId, session.id, actor.id, amountLbp, idem.key).lastInsertRowid,
    );
    db.prepare('INSERT INTO payments (customer_payment_id, method, currency, amount, rate_snap) VALUES (?, ?, ?, ?, ?)').run(
      paymentId,
      body.method,
      body.currency,
      body.amount,
      rate,
    );
    bumpExpected(db, session.id, { method: body.method, currency: body.currency }, body.amount);

    // Oldest open sale first.
    const open = db
      .prepare('SELECT id, ref, rest_lbp FROM sales WHERE customer_id = ? AND rest_lbp > 0 ORDER BY created_at, id')
      .all(customerId) as { id: number; ref: number; rest_lbp: number }[];
    let remaining = amountLbp;
    const allocations: { saleId: number; ref: number; amountLbp: number }[] = [];
    for (const sale of open) {
      if (remaining === 0) break;
      const apply = Math.min(sale.rest_lbp, remaining);
      db.prepare(
        `UPDATE sales SET paid_lbp = paid_lbp + ?, rest_lbp = rest_lbp - ?,
                status = CASE WHEN rest_lbp - ? = 0 THEN 'paid' ELSE 'partial' END WHERE id = ?`,
      ).run(apply, apply, apply, sale.id);
      db.prepare('INSERT INTO payment_allocations (customer_payment_id, sale_id, amount_lbp) VALUES (?, ?, ?)').run(
        paymentId,
        sale.id,
        apply,
      );
      allocations.push({ saleId: sale.id, ref: sale.ref, amountLbp: apply });
      remaining -= apply;
    }
    // The balance is the sum of the open sales' rests. If they disagree, the data is corrupt: stop and roll back.
    if (remaining !== 0) throw new Error(`Customer ${customerId} balance does not match their open sales (short by ${remaining})`);
    db.prepare('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?').run(amountLbp, customerId);

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
    rememberResponse(db, CUSTOMER_PAYMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
