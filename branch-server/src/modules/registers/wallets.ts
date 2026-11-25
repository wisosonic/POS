import type { Queryable } from '../../db/adapter';
import type { Bucket, Currency } from './service';

// The branch's wallets (Whish, OMT): one running balance per wallet and currency, kept as a ledger (docs/13-branch-wallets.md).
// Written in the SAME transaction as whatever moved the money, like a stock movement, and never edited: a void or a deleted sale adds
// a negative `correction` row. Only methods whose holder is 'branch' come here; cash stays in register_balances, per till.

export type WalletKind = 'sale' | 'customer_payment' | 'refund' | 'movement' | 'correction';

/** Why a wallet moved. A `movement` and a `correction` must say why in words (the database insists). */
export type WalletCause = {
  kind: WalletKind;
  refType?: string;
  refId?: number;
  userId?: number | null;
  reason?: string;
};

export async function addWalletEntry(
  q: Queryable,
  sessionId: number | null,
  bucket: Bucket,
  delta: number,
  cause: WalletCause,
): Promise<number> {
  const row = await q.one<{ id: number }>(
    `INSERT INTO wallet_entries (method, currency, amount, kind, ref_type, ref_id, session_id, user_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      bucket.method,
      bucket.currency,
      delta,
      cause.kind,
      cause.refType ?? null,
      cause.refId ?? null,
      sessionId,
      cause.userId ?? null,
      cause.reason?.slice(0, 200) ?? null,
      new Date().toISOString(),
    ],
  );
  return row!.id;
}

export type WalletBalance = Bucket & {
  /** The latest count's figure plus everything that moved since it (nothing counted yet: just everything that moved). */
  expected: number;
  /** The latest count of this wallet, or null if it was never counted. */
  lastCount: {
    id: number;
    counted: number;
    expected: number | null;
    variance: number | null;
    purpose: string;
    note: string | null;
    countedAt: string;
    countedBy: number;
    countedByName: string | null;
  } | null;
  /** What moved since that count: money in, money out. */
  inSince: number;
  outSince: number;
};

export type WalletActivity = Bucket & {
  salesIn: number;
  customerPaymentsIn: number;
  refundsOut: number;
  /** Movements in and out (a top-up, an expense paid from the wallet). */
  movementsNet: number;
  /** Voids and deleted sales taking things back. */
  correctionsNet: number;
  net: number;
};

/**
 * What ONE till session did to the branch's wallets, for the Z-report. It is information only: a till has no expected or counted
 * figure for a wallet, because the wallet is the branch's and a manager counts it (docs/13-branch-wallets.md).
 */
export async function walletActivity(q: Queryable, sessionId: number): Promise<WalletActivity[]> {
  const rows = await q.all<{ method: string; currency: Currency; kind: WalletKind; n: number }>(
    `SELECT method, currency, kind, SUM(amount) AS n FROM wallet_entries WHERE session_id = ? GROUP BY method, currency, kind`,
    [sessionId],
  );
  const by = new Map<string, WalletActivity>();
  for (const r of rows) {
    const key = `${r.method}/${r.currency}`;
    const a = by.get(key) ?? {
      method: r.method,
      currency: r.currency,
      salesIn: 0,
      customerPaymentsIn: 0,
      refundsOut: 0,
      movementsNet: 0,
      correctionsNet: 0,
      net: 0,
    };
    if (r.kind === 'sale') a.salesIn += r.n;
    else if (r.kind === 'customer_payment') a.customerPaymentsIn += r.n;
    else if (r.kind === 'refund') a.refundsOut += -r.n;
    else if (r.kind === 'movement') a.movementsNet += r.n;
    else a.correctionsNet += r.n;
    a.net += r.n;
    by.set(key, a);
  }
  return [...by.values()].sort((a, b) => `${a.method}/${a.currency}`.localeCompare(`${b.method}/${b.currency}`));
}

/** Where every wallet stands now. `buckets` are the wallet buckets (see walletBuckets). */
export async function walletBalances(q: Queryable, buckets: Bucket[]): Promise<WalletBalance[]> {
  const out: WalletBalance[] = [];
  for (const b of buckets) {
    const last = await q.one<{
      id: number;
      counted: number;
      expected: number | null;
      variance: number | null;
      entry_mark: number;
      purpose: string;
      note: string | null;
      counted_at: string;
      counted_by: number;
      counted_by_name: string | null;
    }>(
      `SELECT c.id, c.counted, c.expected, c.variance, c.entry_mark, c.purpose, c.note, c.counted_at, c.counted_by, u.name AS counted_by_name
         FROM wallet_counts c LEFT JOIN users u ON u.id = c.counted_by
        WHERE c.method = ? AND c.currency = ? ORDER BY c.id DESC LIMIT 1`,
      [b.method, b.currency],
    );
    const since = (await q.one<{ inn: number; outn: number }>(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS inn, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS outn
         FROM wallet_entries WHERE method = ? AND currency = ? AND id > ?`,
      [b.method, b.currency, last?.entry_mark ?? 0],
    ))!;
    out.push({
      method: b.method,
      currency: b.currency as Currency,
      expected: (last?.counted ?? 0) + since.inn - since.outn,
      lastCount: last
        ? {
            id: last.id,
            counted: last.counted,
            expected: last.expected,
            variance: last.variance,
            purpose: last.purpose,
            note: last.note,
            countedAt: last.counted_at,
            countedBy: last.counted_by,
            countedByName: last.counted_by_name,
          }
        : null,
      inSince: since.inn,
      outSince: since.outn,
    });
  }
  return out;
}

/**
 * The same wallet movements worked out again from the rows that caused them (sales that still count, customer payments, refunds, the
 * wallet side of register movements, branch-only movements). The ledger's total per wallet must equal this at all times; a test checks
 * it after every kind of change, the way computeBreakdown guards a till's cash. Returns the ledger total and the derived total per bucket.
 */
export async function walletLedgerCheck(q: Queryable): Promise<{ bucket: string; ledger: number; derived: number }[]> {
  const holders = await q.all<{ code: string }>(`SELECT code FROM payment_methods WHERE holder = 'branch'`);
  const wallet = new Set(holders.map((h) => h.code));
  const derived = new Map<string, number>();
  const add = (method: string | null, currency: string | null, n: number) => {
    if (!method || !currency || !wallet.has(method)) return;
    const key = `${method}/${currency}`;
    derived.set(key, (derived.get(key) ?? 0) + n);
  };

  for (const r of await q.all<{ method: string; currency: string; n: number }>(
    `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.session_id IS NOT NULL AND s.status <> 'void' GROUP BY p.method, p.currency`,
  ))
    add(r.method, r.currency, r.n);
  for (const r of await q.all<{ method: string; currency: string; n: number }>(
    `SELECT p.method, p.currency, SUM(p.amount) AS n FROM payments p JOIN customer_payments cp ON cp.id = p.customer_payment_id
       WHERE cp.session_id IS NOT NULL GROUP BY p.method, p.currency`,
  ))
    add(r.method, r.currency, r.n);
  for (const r of await q.all<{ method: string; currency: string; n: number }>(
    `SELECT refund_method AS method, refund_currency AS currency, SUM(refund_amount) AS n FROM returns
       WHERE session_id IS NOT NULL AND refund_amount IS NOT NULL GROUP BY refund_method, refund_currency`,
  ))
    add(r.method, r.currency, -r.n);
  for (const m of await q.all<{
    from_method: string | null;
    from_currency: string | null;
    to_method: string | null;
    to_currency: string | null;
    amount: number;
  }>('SELECT from_method, from_currency, to_method, to_currency, amount FROM register_movements')) {
    add(m.from_method, m.from_currency, -m.amount);
    add(m.to_method, m.to_currency, m.amount);
  }
  for (const r of await q.all<{ method: string; currency: string; n: number }>(
    `SELECT method, currency, SUM(amount) AS n FROM wallet_entries WHERE kind = 'movement' AND session_id IS NULL GROUP BY method, currency`,
  ))
    add(r.method, r.currency, r.n);

  const ledger = new Map<string, number>();
  for (const r of await q.all<{ method: string; currency: string; n: number }>(
    'SELECT method, currency, SUM(amount) AS n FROM wallet_entries GROUP BY method, currency',
  ))
    ledger.set(`${r.method}/${r.currency}`, r.n);

  const keys = new Set([...ledger.keys(), ...derived.keys()]);
  return [...keys].sort().map((bucket) => ({ bucket, ledger: ledger.get(bucket) ?? 0, derived: derived.get(bucket) ?? 0 }));
}
