import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inWriteTransaction } from '../../db/open';
import { E } from '../../errors';
import { parse } from '../../util/validate';
import { writeAudit } from '../audit/service';
import { activeMethods, recordCashOut, requireOpenSession } from '../registers/service';

// Money the shop spends that is not stock: rent, electricity, a delivery. An expense can be paid out of the till
// (it then also leaves the register balance, so the closing count still agrees) or paid some other way (it is only recorded).
// Like the other money records here it is never edited or deleted; a mistake is answered with a note and a cash movement.

const createBody = z.object({
  title: z.string().trim().min(1, 'Say what it was for').max(200),
  categoryId: z.number().int().positive().nullish(),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['USD', 'LBP']),
  reference: z.string().trim().max(100).default(''),
  note: z.string().trim().max(500).nullish(),
  /** Taken out of this register balance, in the expense's own currency. Leave out when it was paid some other way. */
  payFrom: z.object({ method: z.string().min(1).max(20) }).optional(),
});

const listQuery = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

type Row = {
  id: number;
  category_id: number | null;
  category_name: string | null;
  session_id: number | null;
  title: string;
  reference: string;
  note: string | null;
  amount_minor: number;
  currency: 'USD' | 'LBP';
  created_at: string;
};

const SELECT = `SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id`;

const expenseJson = (r: Row) => ({
  id: r.id,
  title: r.title,
  categoryId: r.category_id,
  categoryName: r.category_name,
  amountMinor: r.amount_minor,
  currency: r.currency,
  reference: r.reference,
  note: r.note,
  paidFromRegister: r.session_id !== null,
  createdAt: r.created_at,
});

export default async function expenseRoutes(app: FastifyInstance) {
  const db = app.db;
  const manager = { preHandler: app.requireRole('manager') };

  app.post('/expenses', manager, async (req, reply) => {
    const b = parse(createBody, req.body);
    if (b.categoryId && !db.prepare('SELECT 1 FROM expense_categories WHERE id = ?').get(b.categoryId))
      throw E.unprocessable('INVALID_REFERENCE', 'That expense category does not exist');
    if (b.payFrom && !activeMethods(db).includes(b.payFrom.method)) throw E.validation('Unknown payment method');

    const id = inWriteTransaction(db, () => {
      // Paying from the drawer needs an open register; the money leaves it in the same transaction as the expense is recorded.
      const session = b.payFrom ? requireOpenSession(db) : null;
      const newId = Number(
        db
          .prepare(
            `INSERT INTO expenses (category_id, session_id, title, reference, note, amount_minor, currency) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(b.categoryId ?? null, session?.id ?? null, b.title, b.reference, b.note ?? null, b.amountMinor, b.currency).lastInsertRowid,
      );
      if (session && b.payFrom) {
        recordCashOut(
          db,
          session.id,
          { method: b.payFrom.method, currency: b.currency },
          b.amountMinor,
          `Expense: ${b.title}`,
          req.auth.id,
        );
      }
      writeAudit(db, {
        userId: req.auth.id,
        action: 'expense.create',
        entity: 'expense',
        entityId: newId,
        after: { title: b.title, amountMinor: b.amountMinor, currency: b.currency, payFrom: b.payFrom?.method ?? null },
      });
      return newId;
    });
    return reply.status(201).send(expenseJson(db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row));
  });

  app.get('/expenses', manager, async (req) => {
    const q = parse(listQuery, req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('e.created_at >= ?', q.from);
    add('e.created_at <= ?', q.to);
    add('e.category_id = ?', q.categoryId);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // The totals cover everything the filters match, not only this page.
    const sums = db
      .prepare(`SELECT e.currency AS currency, SUM(e.amount_minor) AS total FROM expenses e ${filter} GROUP BY e.currency`)
      .all(...params) as { currency: 'USD' | 'LBP'; total: number }[];
    const totals = { USD: 0, LBP: 0 };
    for (const s of sums) totals[s.currency] = s.total;

    add('e.id < ?', q.cursor);
    const rows = db
      .prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`)
      .all(...params, q.limit + 1) as Row[];
    const page = rows.slice(0, q.limit);
    return { data: page.map(expenseJson), totals, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
  });
}
