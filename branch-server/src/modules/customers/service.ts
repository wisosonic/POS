import { phoneKey, usdToLbp } from '@pos/shared';
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
  /** Pay the person's debt at the OTHER branches too (docs/15 §7.2): what this branch's own sales do not take is passed to HQ. */
  acrossChain: z.boolean().optional(),
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
  /** What the same person owes at the other branches (HQ's hint; only a connected branch has it). */
  others_lbp?: number;
};

export const customerJson = (c: CustomerRow) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  address: c.address,
  email: c.email,
  balanceLbp: c.balance_lbp,
  othersLbp: c.others_lbp ?? 0,
  isWalkIn: c.is_walk_in === 1,
  createdAt: c.created_at,
});

/** A customer who has not been deleted. A deleted one is as good as not there (their old sales keep pointing at the row). */
export const getCustomer = (q: Queryable, id: number) =>
  q.one<CustomerRow>(
    `SELECT c.*, COALESCE((SELECT h.others_lbp FROM customer_chain h WHERE h.customer_id = c.id), 0) AS others_lbp
       FROM customers c WHERE c.id = ? AND c.deleted_at IS NULL`,
    [id],
  );

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
    // The part this branch's own sales take (applied now, offline-safe), and, when paying across the chain, the part left for HQ to place at other branches.
    let localLbp = amountLbp;
    let chainLbp = 0;
    let key: string | null = null;
    if (body.acrossChain) {
      if (!(await q.one('SELECT 1 AS x FROM hq_link WHERE id = 1')))
        throw E.unprocessable('NOT_CONNECTED', 'This branch is not connected to HQ, so there is no debt at other branches to pay');
      key = phoneKey(customer.phone);
      if (!key) throw E.unprocessable('CUSTOMER_NEEDS_PHONE', 'Only a customer with a phone number can pay a debt at other branches');
      const chain = await q.one<{ o: number }>('SELECT others_lbp AS o FROM customer_chain WHERE customer_id = ?', [customerId]);
      const owed = customer.balance_lbp + (chain?.o ?? 0);
      if (amountLbp > owed) {
        throw E.unprocessable(
          'PAYMENT_EXCEEDS_BALANCE',
          `The customer owes ${owed.toLocaleString('en-US')} LBP across the chain, which is less than this payment`,
        );
      }
      localLbp = Math.min(amountLbp, customer.balance_lbp);
      chainLbp = amountLbp - localLbp;
    } else if (amountLbp > customer.balance_lbp) {
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
    let remaining = localLbp;
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
    await q.run('UPDATE customers SET balance_lbp = balance_lbp - ? WHERE id = ?', [localLbp, customerId]);
    if (chainLbp > 0) {
      await q.run(
        'INSERT INTO chain_payments (customer_id, customer_payment_id, phone_key, amount_lbp, created_at) VALUES (?, ?, ?, ?, ?)',
        [customerId, paymentId, key, chainLbp, new Date().toISOString()],
      );
    }

    const response = {
      id: paymentId,
      customerId,
      method: body.method,
      currency: body.currency,
      amount: body.amount,
      amountLbp,
      allocations,
      balanceLbp: customer.balance_lbp - localLbp,
      chainLbp,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
    };
    await rememberResponseQ(q, CUSTOMER_PAYMENT_SCOPE, idem.key, idem.hash, 201, response);
    return { statusCode: 201, body: response as unknown, replay: false };
  });
}
