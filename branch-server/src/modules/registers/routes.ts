import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, E } from '../../errors';
import type { Param } from '../../db/adapter';
import { parse } from '../../util/validate';
import { writeAuditQ } from '../audit/service';
import {
  activeMethods,
  allBuckets,
  bucketKey,
  bumpExpected,
  computeBreakdown,
  getOpenSession,
  getSession,
  sessionJson,
  zReport,
  type Bucket,
  type SessionRow,
} from './service';

const currency = z.enum(['USD', 'LBP']);
const amount = z.number().int().min(0);
const balanceEntry = z.object({ method: z.string().min(1).max(20), currency, amount });

const openBody = z.object({
  /** Optional: the till is known from its device token. If given, it must be this till's own code. */
  terminalId: z.string().trim().min(1).max(32).optional(),
  openingBalances: z.array(balanceEntry).max(20),
});
const closeBody = z.object({ countedBalances: z.array(balanceEntry).max(20) });

const movementBody = z.object({
  type: z.enum(['in', 'out', 'transfer']),
  from: z.object({ method: z.string().min(1).max(20), currency }).optional(),
  to: z.object({ method: z.string().min(1).max(20), currency }).optional(),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(1, 'A reason is required').max(200),
});

const listQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

/** Every bucket must be given exactly once. Returns the entries keyed by bucket, or throws a 400 listing what is wrong. */
function completeBalances(entries: { method: string; currency: 'USD' | 'LBP'; amount: number }[], buckets: Bucket[], label: string) {
  const byKey = new Map<string, number>();
  const problems: { path: string; message: string }[] = [];
  for (const e of entries) {
    const key = bucketKey(e);
    if (!buckets.some((b) => bucketKey(b) === key)) problems.push({ path: label, message: `${key} is not a balance of this register` });
    else if (byKey.has(key)) problems.push({ path: label, message: `${key} was given more than once` });
    else byKey.set(key, e.amount);
  }
  for (const b of buckets) {
    if (!byKey.has(bucketKey(b))) problems.push({ path: label, message: `${bucketKey(b)} is missing` });
  }
  if (problems.length) throw E.validation(`Provide one amount for each of: ${buckets.map(bucketKey).join(', ')}`, problems);
  return byKey;
}

export default async function registerRoutes(app: FastifyInstance) {
  const db = app.database;
  const user = { preHandler: app.authenticate };
  const atTerminal = { preHandler: [app.authenticate, app.withTerminal] };
  const manager = { preHandler: app.requireRole('manager') };

  // ---------------------------------------------------------------- open (US-11)
  app.post('/registers/open', atTerminal, async (req, reply) => {
    // One till: a second session is refused whoever asks, and before the body is even looked at.
    const existing = await getOpenSession(db, req.terminal.code);
    if (existing) throw E.conflict('REGISTER_ALREADY_OPEN', `The register is already open (session ${existing.id})`);

    const b = parse(openBody, req.body);
    if (b.terminalId !== undefined && b.terminalId !== req.terminal.code)
      throw E.validation(`This device is till "${req.terminal.code}", not "${b.terminalId}"`);
    const buckets = await allBuckets(db);
    const opening = completeBalances(b.openingBalances, buckets, 'openingBalances');

    const id = await db.tx(async (tx) => {
      // Checked again inside the transaction: two tills opening at the same moment cannot both get through.
      const again = await getOpenSession(tx, req.terminal.code);
      if (again) throw E.conflict('REGISTER_ALREADY_OPEN', `The register is already open (session ${again.id})`);
      const created = await tx.one<{ id: number }>('INSERT INTO register_sessions (terminal_id, opened_by) VALUES (?, ?) RETURNING id', [
        req.terminal.code,
        req.auth.id,
      ]);
      const sessionId = created!.id;
      for (const bucket of buckets) {
        const amt = opening.get(bucketKey(bucket)) ?? 0;
        await tx.run('INSERT INTO register_balances (session_id, method, currency, opening, expected) VALUES (?, ?, ?, ?, ?)', [
          sessionId,
          bucket.method,
          bucket.currency,
          amt,
          amt,
        ]);
      }
      await writeAuditQ(tx, {
        userId: req.auth.id,
        action: 'register.open',
        entity: 'register',
        entityId: sessionId,
        after: { terminalId: req.terminal.code, opening: Object.fromEntries(opening) },
      });
      return sessionId;
    });
    return reply.status(201).send(await sessionJson(db, (await getSession(db, id))!));
  });

  app.get('/registers/current', atTerminal, async (req) => {
    const s = await getOpenSession(db, req.terminal.code);
    if (!s) throw new AppError(404, 'NO_OPEN_REGISTER', 'The register is not open');
    return sessionJson(db, s);
  });

  // Pre-fills the opening dialog with what was counted at the last close.
  app.get('/registers/suggested-opening', atTerminal, async (req) => {
    // What THIS till counted when it last closed: each till has its own drawer.
    const last = await db.one<{ id: number }>(
      `SELECT id FROM register_sessions WHERE status = 'closed' AND terminal_id = ? ORDER BY id DESC LIMIT 1`,
      [req.terminal.code],
    );
    const counted = new Map<string, number>();
    if (last) {
      for (const r of await db.all<Bucket & { counted: number | null }>(
        'SELECT method, currency, counted FROM register_balances WHERE session_id = ?',
        [last.id],
      )) {
        counted.set(bucketKey(r), r.counted ?? 0);
      }
    }
    return {
      source: last ? 'last-close' : 'default',
      sessionId: last?.id ?? null,
      balances: (await allBuckets(db)).map((b) => ({ ...b, amount: counted.get(bucketKey(b)) ?? 0 })),
    };
  });

  // ---------------------------------------------------------------- cash in / out / transfer (US-13)
  app.post('/registers/:id/cash-movements', manager, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const session = await getSession(db, id);
    if (!session) throw E.notFound('Register session');
    if (session.status !== 'open') throw E.conflict('REGISTER_ALREADY_CLOSED', 'This register session is closed');

    const b = parse(movementBody, req.body);
    const methods = await activeMethods(db);
    const known = (x?: Bucket) => !x || methods.includes(x.method);
    if (b.type === 'in' && (!b.to || b.from)) throw E.validation('An "in" movement needs a destination ("to") and no source');
    if (b.type === 'out' && (!b.from || b.to)) throw E.validation('An "out" movement needs a source ("from") and no destination');
    if (b.type === 'transfer' && (!b.from || !b.to)) throw E.validation('A transfer needs a source ("from") and a destination ("to")');
    if (!known(b.from) || !known(b.to)) throw E.validation('Unknown payment method');
    if (b.type === 'transfer') {
      if (bucketKey(b.from!) === bucketKey(b.to!)) throw E.unprocessable('SAME_BUCKET', 'The source and destination are the same balance');
      if (b.from!.currency !== b.to!.currency) throw E.unprocessable('CURRENCY_MISMATCH', 'A transfer must stay in one currency');
    }

    const movementId = await db.tx(async (tx) => {
      const created = await tx.one<{ id: number }>(
        `INSERT INTO register_movements (session_id, type, from_method, from_currency, to_method, to_currency, amount, reason, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          id,
          b.type,
          b.from?.method ?? null,
          b.from?.currency ?? null,
          b.to?.method ?? null,
          b.to?.currency ?? null,
          b.amount,
          b.reason,
          req.auth.id,
        ],
      );
      if (b.from) await bumpExpected(tx, id, b.from, -b.amount);
      if (b.to) await bumpExpected(tx, id, b.to, b.amount);
      await writeAuditQ(tx, { userId: req.auth.id, action: 'register.cash-movement', entity: 'register', entityId: id, after: b });
      return created!.id;
    });
    return reply
      .status(201)
      .send({ id: movementId, sessionId: id, ...b, balances: (await sessionJson(db, (await getSession(db, id))!)).balances });
  });

  // What moved in and out of the drawer and wallets during a session, newest first (expenses paid from the till show here too).
  app.get('/registers/:id/cash-movements', manager, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!(await getSession(db, id))) throw E.notFound('Register session');
    const rows = await db.all<{
      id: number;
      type: 'in' | 'out' | 'transfer';
      from_method: string | null;
      from_currency: 'USD' | 'LBP' | null;
      to_method: string | null;
      to_currency: 'USD' | 'LBP' | null;
      amount: number;
      reason: string;
      created_at: string;
      user_name: string | null;
    }>(
      `SELECT m.id, m.type, m.from_method, m.from_currency, m.to_method, m.to_currency, m.amount, m.reason, m.created_at, u.name AS user_name
         FROM register_movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.session_id = ? ORDER BY m.id DESC`,
      [id],
    );
    return {
      data: rows.map((m) => ({
        id: m.id,
        type: m.type,
        from: m.from_method && m.from_currency ? { method: m.from_method, currency: m.from_currency } : null,
        to: m.to_method && m.to_currency ? { method: m.to_method, currency: m.to_currency } : null,
        amount: m.amount,
        reason: m.reason,
        userName: m.user_name,
        createdAt: m.created_at,
      })),
    };
  });

  // ---------------------------------------------------------------- close (US-12)
  app.post('/registers/:id/close', user, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const session = await getSession(db, id);
    if (!session) throw E.notFound('Register session');
    if (session.status === 'closed') throw E.conflict('REGISTER_ALREADY_CLOSED', 'This register session is already closed');

    const b = parse(closeBody, req.body);
    const counted = completeBalances(b.countedBalances, await allBuckets(db), 'countedBalances');
    const closedAt = new Date().toISOString();

    await db.tx(async (tx) => {
      // The stored expected figure is recomputed from the rows, so the Z-report never inherits a drifted running total.
      const breakdown = await computeBreakdown(tx, id);
      const variances: Record<string, number> = {};
      for (const bucket of breakdown) {
        const c = counted.get(bucketKey(bucket)) ?? 0;
        const variance = c - bucket.expected;
        await tx.run(
          'UPDATE register_balances SET expected = ?, counted = ?, variance = ? WHERE session_id = ? AND method = ? AND currency = ?',
          [bucket.expected, c, variance, id, bucket.method, bucket.currency],
        );
        if (variance !== 0) variances[bucketKey(bucket)] = variance;
      }
      // Balances first: once the session is closed the database refuses further changes to them.
      await tx.run(`UPDATE register_sessions SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?`, [
        req.auth.id,
        closedAt,
        id,
      ]);
      await writeAuditQ(tx, { userId: req.auth.id, action: 'register.close', entity: 'register', entityId: id, after: { variances } });
    });
    return zReport(db, (await getSession(db, id))!);
  });

  // ---------------------------------------------------------------- history and the Z-report
  app.get('/registers', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: Param[] = [];
    if (q.from) {
      where.push('opened_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('opened_at <= ?');
      params.push(q.to);
    }
    if (q.cursor) {
      where.push('id < ?');
      params.push(q.cursor);
    }
    const rows = await db.all<SessionRow>(
      `SELECT * FROM register_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const data = [];
    for (const s of page) data.push(await sessionJson(db, s));
    return { data, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });

  app.get('/reports/register/:id', manager, async (req) => {
    const s = await getSession(db, Number((req.params as { id: string }).id));
    if (!s) throw E.notFound('Register session');
    return zReport(db, s);
  });
}
