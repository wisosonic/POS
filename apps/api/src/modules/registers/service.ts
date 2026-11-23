import { AppError } from '../../errors';
import type { Queryable } from '../../db/adapter';

export type Currency = 'USD' | 'LBP';
export type Bucket = { method: string; currency: Currency };

export const CURRENCIES: readonly Currency[] = ['USD', 'LBP'];
export const bucketKey = (b: Bucket) => `${b.method}/${b.currency}`;

export type SessionRow = {
  id: number;
  terminal_id: string;
  opened_by: number | null;
  opened_at: string;
  closed_by: number | null;
  closed_at: string | null;
  status: 'open' | 'closed';
};

/** Methods the owner currently accepts. Every register session tracks one balance per method × currency. */
export async function activeMethods(q: Queryable): Promise<string[]> {
  return (await q.all<{ code: string }>('SELECT code FROM payment_methods WHERE active = 1 ORDER BY sort')).map((r) => r.code);
}

export async function allBuckets(q: Queryable): Promise<Bucket[]> {
  return (await activeMethods(q)).flatMap((method) => CURRENCIES.map((currency) => ({ method, currency })));
}

/** The till's open session, if any. There is one till, so there is at most one open session. */
export function getOpenSession(q: Queryable): Promise<SessionRow | undefined> {
  return q.one<SessionRow>(`SELECT * FROM register_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
}

/** Selling needs an open register (decision table #1). */
export async function requireOpenSession(q: Queryable): Promise<SessionRow> {
  const session = await getOpenSession(q);
  if (!session) throw new AppError(409, 'REGISTER_CLOSED', 'Open the register before selling');
  return session;
}

export function getSession(q: Queryable, id: number): Promise<SessionRow | undefined> {
  return q.one<SessionRow>('SELECT * FROM register_sessions WHERE id = ?', [id]);
}

/**
 * Move a bucket's running "expected" balance. Called inside the same write transaction as the sale, payment, refund or
 * movement that causes it. The Z-report recomputes the figure from the rows (see computeBreakdown), so a drift here
 * can never reach the closing report.
 */
export async function bumpExpected(q: Queryable, sessionId: number, bucket: Bucket, delta: number): Promise<void> {
  if (delta === 0) return;
  const r = await q.run('UPDATE register_balances SET expected = expected + ? WHERE session_id = ? AND method = ? AND currency = ?', [
    delta,
    sessionId,
    bucket.method,
    bucket.currency,
  ]);
  if (r.changes === 0) throw new Error(`Register session ${sessionId} has no ${bucketKey(bucket)} balance`);
}

/**
 * Take money out of one balance of an open session (a cash-out movement) and keep its running "expected" figure in step.
 * Call it inside the write transaction of whatever caused it, e.g. an expense paid from the drawer.
 */
export async function recordCashOut(
  q: Queryable,
  sessionId: number,
  from: Bucket,
  amount: number,
  reason: string,
  userId: number,
): Promise<void> {
  await q.run(
    `INSERT INTO register_movements (session_id, type, from_method, from_currency, amount, reason, user_id) VALUES (?, 'out', ?, ?, ?, ?, ?)`,
    [sessionId, from.method, from.currency, amount, reason.slice(0, 200), userId],
  );
  await bumpExpected(q, sessionId, from, -amount);
}

/** Put money into one balance of an open session (a cash-in movement), e.g. a service paid for at the till. Same rules as recordCashOut. */
export async function recordCashIn(
  q: Queryable,
  sessionId: number,
  to: Bucket,
  amount: number,
  reason: string,
  userId: number,
): Promise<void> {
  await q.run(
    `INSERT INTO register_movements (session_id, type, to_method, to_currency, amount, reason, user_id) VALUES (?, 'in', ?, ?, ?, ?, ?)`,
    [sessionId, to.method, to.currency, amount, reason.slice(0, 200), userId],
  );
  await bumpExpected(q, sessionId, to, amount);
}

// ------------------------------------------------------------------ breakdown (the Z-report's arithmetic)

export type BucketBreakdown = Bucket & {
  opening: number;
  /** Received for sales (what the customers handed over, before change). */
  salesIn: number;
  /** Cash handed back as change. Always cash, in LBP. */
  changeOut: number;
  /** Received on customer accounts. */
  customerPaymentsIn: number;
  /** Paid out as refunds. */
  refundsOut: number;
  /** Net of manual cash in/out and transfers between buckets. */
  movementsNet: number;
  expected: number;
};

/** Recompute every bucket from the underlying rows: opening + sales − change + customer payments − refunds ± movements. */
export async function computeBreakdown(q: Queryable, sessionId: number): Promise<BucketBreakdown[]> {
  const rows = await q.all<Bucket & { opening: number }>('SELECT method, currency, opening FROM register_balances WHERE session_id = ?', [
    sessionId,
  ]);
  const map = new Map<string, BucketBreakdown>();
  for (const r of rows) {
    map.set(bucketKey(r), { ...r, salesIn: 0, changeOut: 0, customerPaymentsIn: 0, refundsOut: 0, movementsNet: 0, expected: 0 });
  }
  const at = (b: Bucket) => map.get(bucketKey(b));

  for (const r of await q.all<Bucket & { n: number }>(
    `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.session_id = ? AND s.status <> 'void' GROUP BY p.method, p.currency`,
    [sessionId],
  )) {
    const b = at(r);
    if (b) b.salesIn += r.n;
  }

  const change = (await q.one<{ n: number }>(
    `SELECT COALESCE(SUM(change_lbp), 0) AS n FROM sales WHERE session_id = ? AND status <> 'void'`,
    [sessionId],
  ))!;
  const cashLbp = at({ method: 'cash', currency: 'LBP' });
  if (cashLbp) cashLbp.changeOut += change.n;

  for (const r of await q.all<Bucket & { n: number }>(
    `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN customer_payments cp ON cp.id = p.customer_payment_id
       WHERE cp.session_id = ? GROUP BY p.method, p.currency`,
    [sessionId],
  )) {
    const b = at(r);
    if (b) b.customerPaymentsIn += r.n;
  }

  for (const r of await q.all<Bucket & { n: number }>(
    `SELECT refund_method AS method, refund_currency AS currency, SUM(refund_amount) AS n FROM returns
       WHERE session_id = ? AND refund_amount IS NOT NULL GROUP BY refund_method, refund_currency`,
    [sessionId],
  )) {
    const b = at(r);
    if (b) b.refundsOut += r.n;
  }

  for (const m of await q.all<{
    type: string;
    from_method: string | null;
    from_currency: Currency | null;
    to_method: string | null;
    to_currency: Currency | null;
    amount: number;
  }>('SELECT type, from_method, from_currency, to_method, to_currency, amount FROM register_movements WHERE session_id = ?', [sessionId])) {
    if (m.from_method && m.from_currency) {
      const b = at({ method: m.from_method, currency: m.from_currency });
      if (b) b.movementsNet -= m.amount;
    }
    if (m.to_method && m.to_currency) {
      const b = at({ method: m.to_method, currency: m.to_currency });
      if (b) b.movementsNet += m.amount;
    }
  }

  for (const b of map.values()) b.expected = b.opening + b.salesIn - b.changeOut + b.customerPaymentsIn - b.refundsOut + b.movementsNet;
  return [...map.values()].sort((a, b) => bucketKey(a).localeCompare(bucketKey(b)));
}

// ------------------------------------------------------------------ JSON

type BalanceRow = Bucket & { opening: number; expected: number; counted: number | null; variance: number | null };

export async function sessionJson(q: Queryable, s: SessionRow) {
  const balances = await q.all<BalanceRow>(
    'SELECT method, currency, opening, expected, counted, variance FROM register_balances WHERE session_id = ? ORDER BY method, currency',
    [s.id],
  );
  const closed = s.status === 'closed';
  return {
    id: s.id,
    terminalId: s.terminal_id,
    status: s.status,
    openedBy: s.opened_by,
    openedAt: s.opened_at,
    closedBy: s.closed_by,
    closedAt: s.closed_at,
    balances: balances.map((b) => ({
      method: b.method,
      currency: b.currency,
      opening: b.opening,
      expected: b.expected,
      ...(closed ? { counted: b.counted, variance: b.variance } : {}),
    })),
  };
}

/** The Z-report: every bucket with where its expected figure came from, plus session totals. */
export async function zReport(q: Queryable, s: SessionRow) {
  const breakdown = await computeBreakdown(q, s.id);
  const stored = new Map(
    (
      await q.all<Bucket & { expected: number; counted: number | null; variance: number | null }>(
        'SELECT method, currency, expected, counted, variance FROM register_balances WHERE session_id = ?',
        [s.id],
      )
    ).map((r) => [bucketKey(r), r]),
  );
  const sales = (await q.one<{ n: number; total: number; profit: number; owed: number }>(
    `SELECT count(*) AS n, COALESCE(SUM(total_lbp), 0) AS total, COALESCE(SUM(profit_lbp), 0) AS profit,
              COALESCE(SUM(rest_lbp), 0) AS owed
       FROM sales WHERE session_id = ? AND status <> 'void'`,
    [s.id],
  ))!;
  const customerPayments = (await q.one<{ n: number }>('SELECT count(*) AS n FROM customer_payments WHERE session_id = ?', [s.id]))!;
  const refunds = (await q.one<{ n: number }>('SELECT count(*) AS n FROM returns WHERE session_id = ?', [s.id]))!;
  const movements = (await q.one<{ n: number }>('SELECT count(*) AS n FROM register_movements WHERE session_id = ?', [s.id]))!;

  return {
    id: s.id,
    terminalId: s.terminal_id,
    status: s.status,
    openedBy: s.opened_by,
    openedAt: s.opened_at,
    closedBy: s.closed_by,
    closedAt: s.closed_at,
    balances: breakdown.map((b) => {
      const row = stored.get(bucketKey(b));
      return { ...b, counted: row?.counted ?? null, variance: row?.variance ?? null };
    }),
    totals: {
      salesCount: sales.n,
      salesTotalLbp: sales.total,
      salesProfitLbp: sales.profit,
      owedOnAccountLbp: sales.owed,
      customerPaymentsCount: customerPayments.n,
      refundsCount: refunds.n,
      movementsCount: movements.n,
    },
  };
}
