import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Param, Queryable } from '../../db/adapter';
import { E } from '../../errors';
import { parse } from '../../util/validate';
import { writeAuditQ } from '../audit/service';
import { bucketKey, completeBalances, walletBuckets } from '../registers/service';
import { addWalletEntry, walletBalances } from '../registers/wallets';

// The branch's wallets (Whish, OMT): one balance per wallet and currency for the whole branch, kept as a ledger that every till's
// payments write to (docs/13-branch-wallets.md). A manager reads the wallet account and counts it here; the difference to what the ledger
// expected is recorded. Counting is never required and never blocks selling. Only managers and admins touch any of this.

const currency = z.enum(['USD', 'LBP']);
const countBody = z.object({
  purpose: z.enum(['opening', 'closing', 'check']).default('check'),
  note: z.string().trim().max(200).optional(),
  balances: z.array(z.object({ method: z.string().min(1).max(20), currency, amount: z.number().int().min(0) })).max(20),
});
const movementBody = z.object({
  bucket: z.object({ method: z.string().min(1).max(20), currency }),
  type: z.enum(['in', 'out']),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(1, 'A reason is required').max(200),
});
const listQuery = z.object({
  method: z.string().max(20).optional(),
  currency: currency.optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

/** Where every wallet stands now, with its latest count and what moved since. */
async function stateJson(q: Queryable) {
  const names = new Map(
    (await q.all<{ code: string; name: string }>('SELECT code, name FROM payment_methods')).map((m) => [m.code, m.name]),
  );
  const balances = await walletBalances(q, await walletBuckets(q));
  return {
    data: balances.map((b) => ({
      method: b.method,
      methodName: names.get(b.method) ?? b.method,
      currency: b.currency,
      expected: b.expected,
      inSince: b.inSince,
      outSince: b.outSince,
      lastCount: b.lastCount,
    })),
    serverTime: new Date().toISOString(),
  };
}

export default async function walletRoutes(app: FastifyInstance) {
  const db = app.database;
  const manager = { preHandler: app.requireRole('manager') };

  // Where the wallets stand: what the ledger expects now, the last count (who, when, how far out it was), and the movement since.
  app.get('/wallets', manager, async () => stateJson(db));

  // A manager's reading of the wallet accounts. Every wallet balance is given, exactly once, like a register's count. The first count
  // of a wallet sets its baseline (nothing to compare with); each later one records what the ledger expected and the difference.
  app.post('/wallets/counts', manager, async (req, reply) => {
    const b = parse(countBody, req.body);
    const buckets = await walletBuckets(db);
    if (buckets.length === 0) throw E.unprocessable('NO_WALLETS', 'This branch has no wallet to count');
    const counted = completeBalances(b.balances, buckets, 'balances', 'branch wallet');

    const variances = await db.tx(async (tx) => {
      const before = await walletBalances(tx, buckets);
      // Everything up to this id is "before the count": the next expected balance starts from what was counted and adds only later rows.
      const mark = (await tx.one<{ m: number | null }>('SELECT MAX(id) AS m FROM wallet_entries'))!.m ?? 0;
      const now = new Date().toISOString();
      const found: Record<string, number> = {};
      const baselines: string[] = [];
      for (const bal of before) {
        const key = bucketKey(bal);
        const amount = counted.get(key) ?? 0;
        const first = bal.lastCount === null;
        const expected = first ? null : bal.expected;
        const variance = first ? null : amount - bal.expected;
        await tx.run(
          `INSERT INTO wallet_counts (method, currency, counted, expected, variance, entry_mark, purpose, note, counted_by, counted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [bal.method, bal.currency, amount, expected, variance, mark, b.purpose, b.note ?? null, req.auth.id, now],
        );
        if (first) baselines.push(key);
        else if (variance !== 0) found[key] = variance!;
      }
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'wallet.count',
        entity: 'wallet',
        after: { purpose: b.purpose, variances: found, baselines },
      });
      return found;
    });
    return reply.status(201).send({ variances, ...(await stateJson(db)) });
  });

  // A change to a wallet that no till caused: a top-up from the bank, a fee the wallet provider took. It needs a reason. (Money moved
  // between a till's cash and a wallet is recorded on the register: POST /registers/{id}/cash-movements.)
  app.post('/wallets/movements', manager, async (req, reply) => {
    const b = parse(movementBody, req.body);
    const buckets = await walletBuckets(db);
    if (!buckets.some((x) => bucketKey(x) === bucketKey(b.bucket)))
      throw E.unprocessable('NOT_A_WALLET', `${bucketKey(b.bucket)} is not a wallet of this branch`);
    const delta = b.type === 'in' ? b.amount : -b.amount;
    const id = await db.tx(async (tx) => {
      const entryId = await addWalletEntry(tx, null, b.bucket, delta, { kind: 'movement', userId: req.auth.id, reason: b.reason });
      await writeAuditQ(tx, { userId: req.auth.id, action: 'wallet.movement', entity: 'wallet', entityId: entryId, after: b });
      return entryId;
    });
    const now = (await walletBalances(db, [b.bucket])).at(0)!;
    return reply.status(201).send({ id, bucket: b.bucket, type: b.type, amount: b.amount, reason: b.reason, expected: now.expected });
  });

  // The ledger, newest first: every sale, refund, payment, movement and correction that moved a wallet, with its cause.
  app.get('/wallets/entries', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: Param[] = [];
    const add = (sql: string, v: Param | undefined) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('e.method = ?', q.method);
    add('e.currency = ?', q.currency);
    add('e.created_at >= ?', q.from);
    add('e.created_at <= ?', q.to);
    add('e.id < ?', q.cursor);
    const rows = await db.all<{
      id: number;
      method: string;
      currency: 'USD' | 'LBP';
      amount: number;
      kind: string;
      ref_type: string | null;
      ref_id: number | null;
      session_id: number | null;
      reason: string | null;
      created_at: string;
      user_name: string | null;
    }>(
      `SELECT e.id, e.method, e.currency, e.amount, e.kind, e.ref_type, e.ref_id, e.session_id, e.reason, e.created_at, u.name AS user_name
         FROM wallet_entries e LEFT JOIN users u ON u.id = e.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((e) => ({
        id: e.id,
        method: e.method,
        currency: e.currency,
        amount: e.amount,
        kind: e.kind,
        refType: e.ref_type,
        refId: e.ref_id,
        sessionId: e.session_id,
        reason: e.reason,
        userName: e.user_name,
        createdAt: e.created_at,
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // The counts so far, newest first.
  app.get('/wallets/counts', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: Param[] = [];
    const add = (sql: string, v: Param | undefined) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('c.method = ?', q.method);
    add('c.currency = ?', q.currency);
    add('c.counted_at >= ?', q.from);
    add('c.counted_at <= ?', q.to);
    add('c.id < ?', q.cursor);
    const rows = await db.all<{
      id: number;
      method: string;
      currency: 'USD' | 'LBP';
      counted: number;
      expected: number | null;
      variance: number | null;
      purpose: string;
      note: string | null;
      counted_at: string;
      user_name: string | null;
    }>(
      `SELECT c.id, c.method, c.currency, c.counted, c.expected, c.variance, c.purpose, c.note, c.counted_at, u.name AS user_name
         FROM wallet_counts c LEFT JOIN users u ON u.id = c.counted_by
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((c) => ({
        id: c.id,
        method: c.method,
        currency: c.currency,
        counted: c.counted,
        expected: c.expected,
        variance: c.variance,
        purpose: c.purpose,
        note: c.note,
        countedAt: c.counted_at,
        countedByName: c.user_name,
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}
