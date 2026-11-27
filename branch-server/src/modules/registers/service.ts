import { AppError, E } from '../../errors';
import type { Queryable } from '../../db/adapter';
import { addWalletEntry, walletActivity, type WalletCause } from './wallets';

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

/** Who keeps the money of a payment method: each till (cash) or the branch (a wallet such as Whish or OMT). docs/13-branch-wallets.md */
export type Holder = 'till' | 'branch';

/** Methods the owner currently accepts. */
export async function activeMethods(q: Queryable): Promise<string[]> {
  return (await q.all<{ code: string }>('SELECT code FROM payment_methods WHERE active = 1 ORDER BY sort')).map((r) => r.code);
}

async function bucketsHeldBy(q: Queryable, holder: Holder): Promise<Bucket[]> {
  const methods = await q.all<{ code: string }>('SELECT code FROM payment_methods WHERE active = 1 AND holder = ? ORDER BY sort', [holder]);
  return methods.flatMap((m) => CURRENCIES.map((currency) => ({ method: m.code, currency })));
}

/** The balances every register session tracks, one per method × currency: only the methods a till holds (cash). */
export const tillBuckets = (q: Queryable): Promise<Bucket[]> => bucketsHeldBy(q, 'till');

/** The balances the branch tracks once for all its tills, as a ledger (wallets.ts): the methods the branch holds (Whish, OMT). */
export const walletBuckets = (q: Queryable): Promise<Bucket[]> => bucketsHeldBy(q, 'branch');

/**
 * Every bucket must be given exactly once (an opening, a closing count, a wallet count). Returns the amounts keyed by bucket, or
 * throws a 400 listing what is wrong. `what` finishes the sentence "... is not a balance of this ...".
 */
export function completeBalances(
  entries: { method: string; currency: Currency; amount: number }[],
  buckets: Bucket[],
  label: string,
  what = 'register',
) {
  const byKey = new Map<string, number>();
  const problems: { path: string; message: string }[] = [];
  for (const e of entries) {
    const key = bucketKey(e);
    if (!buckets.some((b) => bucketKey(b) === key)) problems.push({ path: label, message: `${key} is not a balance of this ${what}` });
    else if (byKey.has(key)) problems.push({ path: label, message: `${key} was given more than once` });
    else byKey.set(key, e.amount);
  }
  for (const b of buckets) {
    if (!byKey.has(bucketKey(b))) problems.push({ path: label, message: `${bucketKey(b)} is missing` });
  }
  if (problems.length) throw E.validation(`Provide one amount for each of: ${buckets.map(bucketKey).join(', ')}`, problems);
  return byKey;
}

export async function holderOf(q: Queryable, method: string): Promise<Holder> {
  const row = await q.one<{ holder: Holder }>('SELECT holder FROM payment_methods WHERE code = ?', [method]);
  if (!row) throw new Error(`Unknown payment method ${method}`);
  return row.holder;
}

/** The open session of one terminal, if any. Each terminal has at most one (a unique index in the database says so). */
export function getOpenSession(q: Queryable, terminalCode: string): Promise<SessionRow | undefined> {
  return q.one<SessionRow>(`SELECT * FROM register_sessions WHERE status = 'open' AND terminal_id = ? ORDER BY id DESC LIMIT 1`, [
    terminalCode,
  ]);
}

/** Selling needs an open register on THIS till (decision table #1). */
export async function requireOpenSession(q: Queryable, terminal: { code: string }): Promise<SessionRow> {
  const session = await getOpenSession(q, terminal.code);
  if (!session) throw new AppError(409, 'REGISTER_CLOSED', 'Open the register before selling');
  return session;
}

export function getSession(q: Queryable, id: number): Promise<SessionRow | undefined> {
  return q.one<SessionRow>('SELECT * FROM register_sessions WHERE id = ?', [id]);
}

/**
 * Move a bucket's running balance. Called inside the same write transaction as the sale, payment, refund or movement that causes it.
 * A till's bucket (cash) moves that session's "expected" figure; the Z-report recomputes it from the rows (see computeBreakdown), so a
 * drift here can never reach the closing report. A wallet bucket is the BRANCH's, not the till's: it becomes a row in the wallet ledger
 * (wallets.ts), and `cause` says why (the sale, the refund...). A wallet movement without a cause is a programming error.
 */
export async function bumpExpected(q: Queryable, sessionId: number, bucket: Bucket, delta: number, cause?: WalletCause): Promise<void> {
  if (delta === 0) return;
  if ((await holderOf(q, bucket.method)) === 'branch') {
    if (!cause) throw new Error(`A change of the ${bucketKey(bucket)} wallet needs its cause`);
    await addWalletEntry(q, sessionId, bucket, delta, cause);
    return;
  }
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
  const moved = await q.one<{ id: number }>(
    `INSERT INTO register_movements (session_id, type, from_method, from_currency, amount, reason, user_id) VALUES (?, 'out', ?, ?, ?, ?, ?) RETURNING id`,
    [sessionId, from.method, from.currency, amount, reason.slice(0, 200), userId],
  );
  await bumpExpected(q, sessionId, from, -amount, { kind: 'movement', refType: 'register_movement', refId: moved!.id, userId, reason });
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
  const moved = await q.one<{ id: number }>(
    `INSERT INTO register_movements (session_id, type, to_method, to_currency, amount, reason, user_id) VALUES (?, 'in', ?, ?, ?, ?, ?) RETURNING id`,
    [sessionId, to.method, to.currency, amount, reason.slice(0, 200), userId],
  );
  await bumpExpected(q, sessionId, to, amount, { kind: 'movement', refType: 'register_movement', refId: moved!.id, userId, reason });
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

/** `hideExpected`: a cashier counting blind is not shown what the drawer should hold (it is `null`). A closed session shows everything. */
export async function sessionJson(q: Queryable, s: SessionRow, opts: { hideExpected?: boolean } = {}) {
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
      expected: opts.hideExpected && !closed ? null : b.expected,
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
    // What this till did to the branch's wallets, as information (the wallets are counted by a manager, not at a till's close).
    wallets: await walletActivity(q, s.id),
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
