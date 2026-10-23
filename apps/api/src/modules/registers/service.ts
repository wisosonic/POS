import { AppError } from '../../errors';
import type { Db } from '../../db/open';

export type Currency = 'USD' | 'LBP';
export type Bucket = { method: string; currency: Currency };

export const CURRENCIES: readonly Currency[] = ['USD', 'LBP'];
export const bucketKey = (b: Bucket) => `${b.method}/${b.currency}`;

type SessionRow = {
  id: number;
  terminal_id: string;
  opened_by: number | null;
  opened_at: string;
  closed_by: number | null;
  closed_at: string | null;
  status: 'open' | 'closed';
};

/** Methods the owner currently accepts. Every register session tracks one balance per method × currency. */
export function activeMethods(db: Db): string[] {
  return (db.prepare('SELECT code FROM payment_methods WHERE active = 1 ORDER BY sort').all() as { code: string }[]).map((r) => r.code);
}

export function allBuckets(db: Db): Bucket[] {
  return activeMethods(db).flatMap((method) => CURRENCIES.map((currency) => ({ method, currency })));
}

/** The till's open session, if any. There is one till, so there is at most one open session. */
export function getOpenSession(db: Db): SessionRow | undefined {
  return db.prepare(`SELECT * FROM register_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1`).get() as SessionRow | undefined;
}

/** Selling needs an open register (decision table #1). */
export function requireOpenSession(db: Db): SessionRow {
  const session = getOpenSession(db);
  if (!session) throw new AppError(409, 'REGISTER_CLOSED', 'Open the register before selling');
  return session;
}

export function getSession(db: Db, id: number): SessionRow | undefined {
  return db.prepare('SELECT * FROM register_sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/**
 * Move a bucket's running "expected" balance. Called inside the same write transaction as the sale, payment, refund or
 * movement that causes it. The Z-report recomputes the figure from the rows (see computeBreakdown), so a drift here
 * can never reach the closing report.
 */
export function bumpExpected(db: Db, sessionId: number, bucket: Bucket, delta: number): void {
  if (delta === 0) return;
  const r = db
    .prepare('UPDATE register_balances SET expected = expected + ? WHERE session_id = ? AND method = ? AND currency = ?')
    .run(delta, sessionId, bucket.method, bucket.currency);
  if (r.changes === 0) throw new Error(`Register session ${sessionId} has no ${bucketKey(bucket)} balance`);
}

/**
 * Take money out of one balance of an open session (a cash-out movement) and keep its running "expected" figure in step.
 * Call it inside the write transaction of whatever caused it, e.g. an expense paid from the drawer.
 */
export function recordCashOut(db: Db, sessionId: number, from: Bucket, amount: number, reason: string, userId: number): void {
  db.prepare(
    `INSERT INTO register_movements (session_id, type, from_method, from_currency, amount, reason, user_id) VALUES (?, 'out', ?, ?, ?, ?, ?)`,
  ).run(sessionId, from.method, from.currency, amount, reason.slice(0, 200), userId);
  bumpExpected(db, sessionId, from, -amount);
}

/** Put money into one balance of an open session (a cash-in movement), e.g. a service paid for at the till. Same rules as recordCashOut. */
export function recordCashIn(db: Db, sessionId: number, to: Bucket, amount: number, reason: string, userId: number): void {
  db.prepare(
    `INSERT INTO register_movements (session_id, type, to_method, to_currency, amount, reason, user_id) VALUES (?, 'in', ?, ?, ?, ?, ?)`,
  ).run(sessionId, to.method, to.currency, amount, reason.slice(0, 200), userId);
  bumpExpected(db, sessionId, to, amount);
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
export function computeBreakdown(db: Db, sessionId: number): BucketBreakdown[] {
  const rows = db.prepare('SELECT method, currency, opening FROM register_balances WHERE session_id = ?').all(sessionId) as (Bucket & {
    opening: number;
  })[];
  const map = new Map<string, BucketBreakdown>();
  for (const r of rows) {
    map.set(bucketKey(r), { ...r, salesIn: 0, changeOut: 0, customerPaymentsIn: 0, refundsOut: 0, movementsNet: 0, expected: 0 });
  }
  const at = (b: Bucket) => map.get(bucketKey(b));

  for (const r of db
    .prepare(
      `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.session_id = ? AND s.status <> 'void' GROUP BY p.method, p.currency`,
    )
    .all(sessionId) as (Bucket & { n: number })[]) {
    const b = at(r);
    if (b) b.salesIn += r.n;
  }

  const change = db
    .prepare(`SELECT COALESCE(SUM(change_lbp), 0) AS n FROM sales WHERE session_id = ? AND status <> 'void'`)
    .get(sessionId) as {
    n: number;
  };
  const cashLbp = at({ method: 'cash', currency: 'LBP' });
  if (cashLbp) cashLbp.changeOut += change.n;

  for (const r of db
    .prepare(
      `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN customer_payments cp ON cp.id = p.customer_payment_id
       WHERE cp.session_id = ? GROUP BY p.method, p.currency`,
    )
    .all(sessionId) as (Bucket & { n: number })[]) {
    const b = at(r);
    if (b) b.customerPaymentsIn += r.n;
  }

  for (const r of db
    .prepare(
      `SELECT refund_method AS method, refund_currency AS currency, SUM(refund_amount) AS n FROM returns
       WHERE session_id = ? AND refund_amount IS NOT NULL GROUP BY refund_method, refund_currency`,
    )
    .all(sessionId) as (Bucket & { n: number })[]) {
    const b = at(r);
    if (b) b.refundsOut += r.n;
  }

  for (const m of db
    .prepare('SELECT type, from_method, from_currency, to_method, to_currency, amount FROM register_movements WHERE session_id = ?')
    .all(sessionId) as {
    type: string;
    from_method: string | null;
    from_currency: Currency | null;
    to_method: string | null;
    to_currency: Currency | null;
    amount: number;
  }[]) {
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

export function sessionJson(db: Db, s: SessionRow) {
  const balances = db
    .prepare(
      'SELECT method, currency, opening, expected, counted, variance FROM register_balances WHERE session_id = ? ORDER BY method, currency',
    )
    .all(s.id) as BalanceRow[];
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
export function zReport(db: Db, s: SessionRow) {
  const breakdown = computeBreakdown(db, s.id);
  const stored = new Map(
    (
      db
        .prepare('SELECT method, currency, expected, counted, variance FROM register_balances WHERE session_id = ?')
        .all(s.id) as (Bucket & {
        expected: number;
        counted: number | null;
        variance: number | null;
      })[]
    ).map((r) => [bucketKey(r), r]),
  );
  const sales = db
    .prepare(
      `SELECT count(*) AS n, COALESCE(SUM(total_lbp), 0) AS total, COALESCE(SUM(profit_lbp), 0) AS profit,
              COALESCE(SUM(rest_lbp), 0) AS owed
       FROM sales WHERE session_id = ? AND status <> 'void'`,
    )
    .get(s.id) as { n: number; total: number; profit: number; owed: number };
  const customerPayments = db.prepare('SELECT count(*) AS n FROM customer_payments WHERE session_id = ?').get(s.id) as { n: number };
  const refunds = db.prepare('SELECT count(*) AS n FROM returns WHERE session_id = ?').get(s.id) as { n: number };
  const movements = db.prepare('SELECT count(*) AS n FROM register_movements WHERE session_id = ?').get(s.id) as { n: number };

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
